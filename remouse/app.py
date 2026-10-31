"""FastAPI 装配：静态页 + WebSocket 通道 + 文件柜。"""

from __future__ import annotations

import asyncio
import json
import socket
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles

from . import __version__, auth, netinfo, protocol
from .config import Settings
from .files import FileError, format_size
from .hub import Hub, SessionInfo

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

WS_BAD_TOKEN = 4401
WS_SUPERSEDED = 4409

# 上传分块大小。64KB 是常见折中：太小 syscall 多，太大占内存。
UPLOAD_CHUNK = 64 * 1024


def _check_token(settings: Settings, k: str) -> None:
    """文件和 WebSocket 用同一套令牌。校验失败直接 403。"""
    if not auth.token_matches(settings.token, k):
        raise HTTPException(status_code=403, detail="令牌无效")


def create_app(settings: Settings, hub: Hub) -> FastAPI:
    app = FastAPI(title="reMouse", version=__version__, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.hub = hub

    # 静态资源一律不缓存。
    #
    # 这是个开发期频繁改动的项目，而手机上排查缓存问题极其困难：
    # 改了前端，手机刷新后行为没变，看起来像"改动没生效"，
    # 实际上是浏览器还在用旧的 app.js。用 no-store 直接绕开这个问题。
    # 代价是每次多传几十 KB，局域网内可以忽略。
    @app.middleware("http")
    async def no_cache(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static/") or request.url.path == "/":
            response.headers["Cache-Control"] = "no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
        return response

    @app.get("/", response_class=HTMLResponse)
    async def index() -> HTMLResponse:
        page = WEB_DIR / "index.html"
        return HTMLResponse(page.read_text(encoding="utf-8"))

    @app.get("/manifest.webmanifest")
    async def manifest() -> JSONResponse:
        data = {
            "name": "reMouse 触摸板",
            "short_name": "reMouse",
            "start_url": "/",
            "display": "fullscreen",
            "orientation": "any",
            "background_color": "#111318",
            "theme_color": "#111318",
            "icons": [{"src": "/icon.svg", "sizes": "any", "type": "image/svg+xml"}],
        }
        return JSONResponse(data, media_type="application/manifest+json")

    @app.get("/icon.svg")
    async def icon() -> Response:
        svg = WEB_DIR / "icon.svg"
        return Response(svg.read_text(encoding="utf-8"), media_type="image/svg+xml")

    @app.get("/ca.crt")
    async def ca_cert() -> Response:
        """把根证书发给手机安装。

        装一次之后，体感（DeviceMotionEvent）、震动反馈、屏幕常亮
        这些需要安全上下文的 API 才会真正生效。
        """
        path: Path = settings.cert_dir / "remouse-ca.crt"
        if not path.exists():
            return Response(
                "未启用 HTTPS，没有根证书可供下载。\n"
                "请用 --https 参数启动服务后重试。",
                status_code=404,
                media_type="text/plain; charset=utf-8",
            )
        return Response(
            path.read_bytes(),
            media_type="application/x-x509-ca-cert",
            headers={
                "Content-Disposition": 'attachment; filename="remouse-ca.crt"',
                "Cache-Control": "no-store",
            },
        )

    @app.get("/healthz")
    async def healthz() -> JSONResponse:
        return JSONResponse(
            {
                "ok": True,
                "ver": __version__,
                "https": settings.use_https,
                "secure": settings.use_https,
                **hub.stats(),
            }
        )

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket, k: str = Query(default="")) -> None:
        client = websocket.client
        peer = f"{client.host}:{client.port}" if client else "unknown"

        if not auth.token_matches(settings.token, k):
            # 先接受再关闭，才能把 4401 送到客户端
            await websocket.accept()
            await websocket.send_text(protocol.encode_error("令牌无效", 4401))
            await websocket.close(code=WS_BAD_TOKEN)
            print(f"[remouse] 拒绝无效令牌的连接：{peer}")
            return

        await websocket.accept()
        info = SessionInfo(
            peer=peer,
            user_agent=websocket.headers.get("user-agent", ""),
            connected_at=asyncio.get_running_loop().time(),
        )
        screen = hub.backend.screen_info()
        session = hub.attach(info)

        try:
            await websocket.send_text(
                protocol.encode_hello(
                    host=socket.gethostname(),
                    width=screen.width,
                    height=screen.height,
                    version=__version__,
                    settings={
                        "sens": settings.default_sensitivity,
                        "acc": settings.default_acceleration,
                        "nat": settings.default_natural_scroll,
                        "three": settings.enable_three_finger,
                        "gyro": settings.enable_gyro,
                        "gyroMax": settings.gyro_max_speed,
                        "gyroMaxY": settings.gyro_max_speed_y,
                        "gyroDz": settings.gyro_deadzone,
                        "gyroInvX": settings.gyro_invert_x,
                        "gyroInvY": settings.gyro_invert_y,
                        "https": settings.use_https,
                        "backend": hub.backend.name,
                    },
                )
            )
            await _pump(websocket, hub, session)
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # pragma: no cover - 网络异常路径
            print(f"[remouse] 连接异常（{peer}）: {exc}")
        finally:
            hub.detach(session)

    async def _pump(websocket: WebSocket, hub: Hub, session) -> None:
        while True:
            raw = await websocket.receive()
            kind = raw.get("type")
            if kind == "websocket.disconnect":
                return
            text = raw.get("text")
            if text is None:
                data = raw.get("bytes")
                if data is None:
                    continue
                text = data
            reply = hub.handle_text(session, text)
            if reply:
                await websocket.send_text(reply)

    if WEB_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

    # ---------- 文件柜 ----------
    #
    # 为什么复用同一个端口和令牌：
    # 手机已经扫过码、装过证书，文件页就是复用这条通道，
    # 不用再开一个服务、再扫一次码。
    _register_files(app, settings)

    return app


def _register_files(app: FastAPI, settings: Settings) -> None:
    @app.get("/files")
    async def file_page() -> HTMLResponse:
        return HTMLResponse((WEB_DIR / "files.html").read_text(encoding="utf-8"))

    @app.get("/api/files")
    async def api_list(k: str = Query(default="")) -> JSONResponse:
        _check_token(settings, k)
        store = settings.file_store()
        entries = store.list()
        return JSONResponse(
            {
                "ok": True,
                "dir": str(store.root),
                "files": [e.to_dict() for e in entries],
                "total": store.total_bytes(),
                "totalText": format_size(store.total_bytes()),
                "maxBytes": store.max_bytes,
            }
        )

    @app.post("/api/files")
    async def api_upload(request: Request, name: str = Query(...), k: str = Query(default="")) -> JSONResponse:
        _check_token(settings, k)
        store = settings.file_store()

        # 先看声明长度，能在写盘前就拒绝超大文件。
        #
        # 但直接 return 会让客户端"还在发数据、服务端已经关连接"，
        # TCP 层表现为 ConnectionReset，浏览器报"网络错误"而不是
        # 我们精心写的"超过上限"。所以超限时要把剩余请求体读完再回，
        # 让连接正常收尾。丢弃而不是落盘，所以不占磁盘。
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > store.max_bytes:
            drained = 0
            async for chunk in request.stream():
                drained += len(chunk)
                if drained > store.max_bytes * 4:
                    # 对方声称一个小值却猛发，不值得陪它耗。
                    # 这时候断开是合理的，反正不是正常客户端。
                    break
            return JSONResponse(
                {
                    "ok": False,
                    "error": f"文件超过上限（{format_size(store.max_bytes)}）",
                },
                status_code=413,
            )

        try:
            tmp, final, final_name = store.open_for_write(name)
        except FileError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

        written = 0
        exceeded = False
        try:
            with open(tmp, "wb") as fh:
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    written += len(chunk)
                    # Content-Length 可能是假的或被省略，边写边验。
                    # 超了就停止写盘，但仍要把剩余数据读掉再回响应，
                    # 否则客户端发到一半被 RST，看到的是"网络错误"。
                    if written > store.max_bytes:
                        exceeded = True
                        continue
                    fh.write(chunk)
            if exceeded:
                raise FileError(f"文件超过上限（{format_size(store.max_bytes)}）")
            if written == 0:
                raise FileError("文件为空")
            store.commit(tmp, final)
        except FileError as exc:
            store.abort(tmp)
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=413)
        except Exception as exc:  # 断连、磁盘满
            store.abort(tmp)
            return JSONResponse(
                {"ok": False, "error": f"上传失败：{exc}"}, status_code=500
            )

        return JSONResponse(
            {"ok": True, "name": final_name, "size": written, "sizeText": format_size(written)}
        )

    @app.get("/api/files/{name:path}")
    async def api_download(name: str, k: str = Query(default="")) -> Response:
        _check_token(settings, k)
        store = settings.file_store()
        try:
            target = store.resolve(name)
        except FileError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=404)
        return FileResponse(
            target,
            filename=target.name,
            media_type="application/octet-stream",
            headers={"Cache-Control": "no-store"},
        )

    @app.delete("/api/files/{name:path}")
    async def api_delete(name: str, k: str = Query(default="")) -> JSONResponse:
        _check_token(settings, k)
        store = settings.file_store()
        try:
            store.delete(name)
        except FileError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=404)
        return JSONResponse({"ok": True, "name": name})


def print_banner(settings: Settings, backend_name: str) -> None:
    addrs = netinfo.list_lan_addresses()
    primary = netinfo.best_lan_ip()
    scheme = "https" if settings.use_https else "http"
    url = f"{scheme}://{primary}:{settings.port}/?k={settings.token}"

    print()
    print("=" * 62)
    print("  reMouse —— 手机浏览器当触摸板")
    print("=" * 62)
    print(f"  注入后端 : {backend_name}")
    print(f"  本机名称 : {socket.gethostname()}")
    print(f"  协议     : {'HTTPS（体感/震动可用）' if settings.use_https else 'HTTP（体感不可用）'}")
    print(f"  令牌     : {auth.mask(settings.token)}  （文件 .state/token）")
    print()
    print("  手机扫码或在浏览器输入：")
    print(f"    {url}")
    print()
    files_url = f"{scheme}://{primary}:{settings.port}/files?k={settings.token}"
    print("  传文件（与触摸板同一令牌）：")
    print(f"    {files_url}")
    store = settings.file_store()
    print(f"    落地目录 {store.root}　单文件上限 {format_size(store.max_bytes)}")
    print()
    if len(addrs) > 1:
        print("  其它可用地址（主地址连不上时试试）：")
        for entry in addrs[1:]:
            tag = "虚拟网卡" if entry.is_virtual else entry.interface
            print(f"    {scheme}://{entry.ip}:{settings.port}/?k={settings.token}   [{tag}]")
        print()
    print(f"  本机自测： {scheme}://127.0.0.1:{settings.port}/?k={settings.token}")
    print("  关闭窗口或 Ctrl+C 停止服务")
    print("=" * 62)
    print()

    if not settings.use_https:
        print("  提示：当前是 HTTP，Android 浏览器会禁用陀螺仪、震动和屏幕常亮。")
        print("        想要体感控制，用 --https 启动并装一次根证书。")
        print()

    if not netinfo.is_private_ip(primary) and not settings.allow_public:
        print(f"[!] 检测到的地址 {primary} 不是内网地址。若这是真实出口，")
        print("    服务会暴露到公网。确认要用请加 --allow-public。")
        print()

    _print_qr(url)


def _print_qr(url: str) -> None:
    try:
        import qrcode  # 可选依赖
    except Exception:
        print("  （装了 qrcode 就能在这里直接打印二维码：pip install qrcode）")
        print()
        return

    try:
        code = qrcode.QRCode(border=1)
        code.add_data(url)
        code.make(fit=True)
        code.print_ascii(invert=True)
    except Exception:
        pass
