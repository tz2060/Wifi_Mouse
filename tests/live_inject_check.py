"""真实注入联调：起真服务（win32 后端），用 WebSocket 驱动，验证光标真的动了。

需要普通完整性级别（非沙箱低完整性）才能生效，
否则 Windows 的 UIPI 会静默丢弃合成输入。

    python tests/live_inject_check.py
"""

from __future__ import annotations

import asyncio
import ctypes
import json
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn
from websockets.asyncio.client import connect

from remouse import auth
from remouse.app import create_app
from remouse.config import Settings
from remouse.hub import Hub
from remouse.input.base import get_backend

HOST = "127.0.0.1"
user32 = ctypes.WinDLL("user32", use_last_error=True)


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def cursor() -> tuple[int, int]:
    point = POINT()
    user32.GetCursorPos(ctypes.byref(point))
    return point.x, point.y


def free_port() -> int:
    import socket

    probe = socket.socket()
    probe.bind((HOST, 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


def main() -> int:
    port = free_port()
    token = auth.generate_token()
    settings = Settings(token=token, dry_run=False)
    backend = get_backend()
    if backend.name != "win32-sendinput":
        print(f"跳过：当前后端是 {backend.name}，本检查只针对 Windows")
        return 0

    print(f"后端 = {backend.name}  DPI = {getattr(backend, 'dpi_mode', '?')}")

    hub = Hub(settings, backend)
    app = create_app(settings, hub)
    server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=port, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()

    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        time.sleep(0.02)
    if not server.started:
        print("服务未能启动")
        return 1

    info = backend.screen_info()
    print(f"屏幕 = {info.width}x{info.height}")

    original = cursor()
    print(f"原始光标位置 = {original}")

    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, ok, detail))
        print(f"  [{'OK' if ok else 'FAIL'}] {name} {detail}")

    async def drive() -> None:
        async with connect(f"ws://{HOST}:{port}/ws?k={token}") as ws:
            hello = json.loads(await ws.recv())
            check("握手成功", hello.get("t") == "hi", str(hello.get("host")))

            # 绝对定位到屏幕中心
            await ws.send(json.dumps({"t": "ma", "x": 0.5, "y": 0.5}))
            await asyncio.sleep(0.25)
            cx, cy = cursor()
            expect = (info.width // 2, info.height // 2)
            check(
                "绝对定位到中心",
                abs(cx - expect[0]) <= 3 and abs(cy - expect[1]) <= 3,
                f"实际 ({cx},{cy}) 期望 ~{expect}",
            )

            # 相对移动 100px（真机验证加速曲线已被绕开）
            before = cursor()
            await ws.send(json.dumps({"t": "mv", "dx": 100, "dy": 0}))
            await asyncio.sleep(0.25)
            after = cursor()
            dx = after[0] - before[0]
            check("相对移动 +100px 精确", abs(dx - 100) <= 3, f"实际 +{dx}")

            # 连续小步累积，验证不漂移
            before = cursor()
            for _ in range(20):
                await ws.send(json.dumps({"t": "mv", "dx": 5, "dy": 0}))
                await asyncio.sleep(0.012)
            await asyncio.sleep(0.3)
            after = cursor()
            dx = after[0] - before[0]
            check("20 次小步累积 +100px", abs(dx - 100) <= 5, f"实际 +{dx}")

            # 垂直方向
            before = cursor()
            await ws.send(json.dumps({"t": "mv", "dx": 0, "dy": 80}))
            await asyncio.sleep(0.2)
            dy = cursor()[1] - before[1]
            check("垂直移动 +80px", abs(dy - 80) <= 3, f"实际 +{dy}")

            # 滚轮不应改变光标位置
            before = cursor()
            await ws.send(json.dumps({"t": "wh", "dy": 2}))
            await asyncio.sleep(0.2)
            check("滚轮不移动光标", cursor() == before)

    try:
        asyncio.run(drive())
    except Exception as exc:
        check("WebSocket 联调", False, repr(exc))
    finally:
        backend.move_abs(original[0] / max(1, info.width - 1),
                         original[1] / max(1, info.height - 1))
        time.sleep(0.1)
        print(f"光标已还原到 {cursor()}")
        hub.shutdown()
        server.should_exit = True
        time.sleep(0.4)

    failed = [r for r in results if not r[1]]
    print()
    if failed:
        print(f"失败 {len(failed)} 项")
        return 1
    print(f"全部 {len(results)} 项通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
