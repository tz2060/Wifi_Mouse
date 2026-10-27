"""FastAPI 装配：静态页 + WebSocket 通道。"""

from __future__ import annotations

import asyncio
import json
import socket
from pathlib import Path

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, auth, netinfo, protocol
from .config import Settings
from .hub import Hub, SessionInfo

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

WS_BAD_TOKEN = 4401
WS_SUPERSEDED = 4409


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

    return app


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
