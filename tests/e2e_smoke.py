"""端到端联调：真的把服务跑起来，用真的 WebSocket 打进去。

不依赖 pytest，直接 python tests/e2e_smoke.py 就能跑。
用 dry-run 后端，所以不会动你的鼠标。
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn
from websockets.asyncio.client import connect

from remouse import auth
from remouse.app import create_app
from remouse.config import Settings
from remouse.hub import Hub
from remouse.input.dryrun import DryRunBackend

HOST = "127.0.0.1"


def free_port() -> int:
    import socket

    probe = socket.socket()
    probe.bind((HOST, 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


def start_server(settings: Settings, backend: DryRunBackend, port: int):
    hub = Hub(settings, backend)
    app = create_app(settings, hub)
    config = uvicorn.Config(app, host=HOST, port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        time.sleep(0.02)
    if not server.started:
        raise RuntimeError("服务未能在 10 秒内启动")
    return server, hub


async def recv_json(ws, timeout=2.0):
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    return json.loads(raw) if isinstance(raw, str) else raw


async def drain(ws, seconds=0.3):
    """读干所有待处理消息，返回列表。"""
    out = []
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            out.append(await recv_json(ws, timeout=max(0.01, deadline - time.time())))
        except (asyncio.TimeoutError, TimeoutError):
            break
        except Exception:
            break
    return out


PASS = []
FAIL = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        PASS.append(name)
        print(f"  [OK] {name}")
    else:
        FAIL.append(name)
        print(f"  [FAIL] {name} {detail}")


async def run(port: int, token: str) -> None:
    base = f"ws://{HOST}:{port}/ws"
    print("\n--- 1. 无令牌连接应被拒 ---")
    async with connect(base) as ws:
        try:
            msg = await recv_json(ws)
            check("无令牌返回 er/4401", msg.get("t") == "er" and msg.get("code") == 4401, str(msg))
        except Exception as exc:
            check("无令牌被关闭", True, str(exc))
        try:
            await asyncio.wait_for(ws.recv(), timeout=1.0)
            check("无令牌连接被服务端关闭", False, "连接仍然开着")
        except Exception:
            check("无令牌连接被服务端关闭", True)

    print("\n--- 2. 错误令牌应被拒 ---")
    async with connect(f"{base}?k=wrong-token-here") as ws:
        try:
            msg = await recv_json(ws)
            check("错误令牌返回 4401", msg.get("code") == 4401, str(msg))
        except Exception as exc:
            check("错误令牌被拒", True, str(exc))

    print("\n--- 3. 正确令牌应完成握手 ---")
    async with connect(f"{base}?k={token}") as ws:
        hello = await recv_json(ws)
        check("收到 hi", hello.get("t") == "hi", str(hello))
        check("hi 带分辨率", hello.get("w", 0) > 0 and hello.get("h", 0) > 0, str(hello))
        check("hi 带配置", isinstance(hello.get("cfg"), dict), str(hello))
        check("三指默认关闭", hello.get("cfg", {}).get("three") is False, str(hello.get("cfg")))

        print("\n--- 4. 心跳往返 ---")
        await ws.send(json.dumps({"t": "pg", "n": 12345}))
        pong = await recv_json(ws)
        check("pong 回传序号", pong.get("t") == "po" and pong.get("n") == 12345, str(pong))

        print("\n--- 5. 鼠标消息 ---")
        await ws.send(json.dumps({"t": "mv", "dx": 12, "dy": -4}))
        await ws.send(json.dumps({"t": "bt", "b": "l", "a": "c"}))
        await ws.send(json.dumps({"t": "wh", "dy": 2}))
        await ws.send(json.dumps({"t": "md", "a": "pp"}))
        await ws.send(json.dumps({"t": "ky", "k": "ctrl+shift+t"}))
        await ws.send(json.dumps({"t": "tx", "s": "端到端测试 中文 + emoji 🚀"}))
        await asyncio.sleep(0.4)

        print("\n--- 6. 畸形消息不应断开连接 ---")
        for bad in ["not json", "[]", '{"t":123}', '{"t":"mv","dx":"x"}', ""]:
            await ws.send(bad)
        await asyncio.sleep(0.2)
        # 先读干：其中 '{"t":"mv","dx":"x"}' 会正常收到一条 er 回复，
        # 这里要的是"连接还活着"，不能把那条 er 误当成 pong
        replies = await drain(ws, 0.3)
        got_err = any(r.get("t") == "er" for r in replies if isinstance(r, dict))
        check("非法字段收到 er 提示", got_err, str(replies))

        await ws.send(json.dumps({"t": "pg", "n": 9}))
        pong = await recv_json(ws)
        check("畸形消息后连接仍可用", pong.get("t") == "po" and pong.get("n") == 9, str(pong))

        print("\n--- 7. 超大消息不应崩溃 ---")
        huge = json.dumps({"t": "tx", "s": "x" * 200000})
        await ws.send(huge)
        await asyncio.sleep(0.2)
        await drain(ws, 0.2)
        await ws.send(json.dumps({"t": "pg", "n": 10}))
        pong = await recv_json(ws)
        check("超大消息后连接仍可用", pong.get("t") == "po" and pong.get("n") == 10, str(pong))

        print("\n--- 8. 非法指令返回 er 而非崩溃 ---")
        await ws.send(json.dumps({"t": "bt", "b": "zzz", "a": "d"}))
        reply = await recv_json(ws, timeout=1.0)
        check("非法指令返回 er", reply.get("t") == "er", str(reply))
        await ws.send(json.dumps({"t": "pg", "n": 11}))
        pong = await recv_json(ws)
        check("非法指令后连接仍可用", pong.get("t") == "po" and pong.get("n") == 11, str(pong))

        print("\n--- 9. 断开时释放按键 ---")
        await ws.send(json.dumps({"t": "bt", "b": "l", "a": "d"}))
        await asyncio.sleep(0.3)

    await asyncio.sleep(0.6)


def assert_backend(backend: DryRunBackend) -> None:
    print("\n--- 10. 校验注入后端收到的事件 ---")
    events = backend.events
    kinds = [e["kind"] for e in events]
    check("收到 move_rel", "move_rel" in kinds, str(kinds))
    check("收到 button", "button" in kinds, str(kinds))
    check("收到 wheel", "wheel" in kinds, str(kinds))
    check("收到 media", "media" in kinds, str(kinds))
    check("收到 key", "key" in kinds, str(kinds))
    check("收到 text", "text" in kinds, str(kinds))
    check("断开时触发 release_all", "release_all" in kinds, str(kinds))

    texts = [e for e in events if e["kind"] == "text"]
    check("中文与 emoji 完整送达", any("端到端测试" in t["text"] for t in texts), str(texts))

    keys = [e for e in events if e["kind"] == "key"]
    check("组合键原样送达", any(k["combo"] == "ctrl+shift+t" for k in keys), str(keys))

    moves = [e for e in events if e["kind"] == "move_rel"]
    total_dx = sum(m["dx"] for m in moves)
    check("位移总量正确（12）", abs(total_dx - 12) < 0.01, f"实际 {total_dx}")

    # 关键安全项：不能有按下的左键没有对应的抬起
    downs = [e for e in events if e["kind"] == "button" and e["action"] == "d"]
    ups = [e for e in events if e["kind"] == "button" and e["action"] == "u"]
    check(
        "没有未释放的鼠标按下",
        len(downs) <= len(ups) or any(e["kind"] == "release_all" for e in events),
        f"down={len(downs)} up={len(ups)}",
    )


def main() -> int:
    port = free_port()
    token = auth.generate_token()
    settings = Settings(token=token, dry_run=True, record=False)
    backend = DryRunBackend()
    server, hub = start_server(settings, backend, port)

    print(f"服务已启动：http://{HOST}:{port}  令牌={auth.mask(token)}")

    # 静态资源
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/", timeout=5) as resp:
            html = resp.read().decode("utf-8")
        check("GET / 返回页面", "reMouse" in html, f"长度 {len(html)}")
        check("页面引用了手势脚本", "gesture.js" in html)
    except Exception as exc:
        check("GET / 返回页面", False, str(exc))

    for path, needle in [
        ("/static/app.js", "WebSocket"),
        ("/static/gesture.js", "GestureEngine"),
        ("/static/style.css", "--bg"),
        ("/manifest.webmanifest", "fullscreen"),
        ("/healthz", "ok"),
    ]:
        try:
            with urllib.request.urlopen(f"http://{HOST}:{port}{path}", timeout=5) as resp:
                body = resp.read().decode("utf-8")
            check(f"GET {path}", needle in body, f"未找到 {needle}")
        except Exception as exc:
            check(f"GET {path}", False, str(exc))

    try:
        asyncio.run(run(port, token))
    except Exception as exc:
        check("WebSocket 联调", False, repr(exc))

    assert_backend(backend)

    hub.shutdown()
    server.should_exit = True
    time.sleep(0.5)

    print()
    print("=" * 50)
    print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
    if FAIL:
        print("失败项：")
        for name in FAIL:
            print(f"  - {name}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
