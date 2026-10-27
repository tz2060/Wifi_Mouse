"""滚动条专项端到端检查。

用真实 WebSocket 连到服务端，按滚动条的语义发 wh 指令，
确认滚轮真的被注入、方向正确、且不影响光标位置。

滚动条的方向约定：
    向下拖 -> wheel dy 为负（内容向下滚，即视口向上）
    "自然滚动"打开时前端会取反，这里测的是协议层原始值。
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

from remouse import auth
from remouse.app import create_app
from remouse.config import Settings
from remouse.hub import Hub
from remouse.input.dryrun import DryRunBackend

HOST = "127.0.0.1"
PASSED = 0
FAILED = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if ok:
        PASSED += 1
        print(f"  OK   {name}")
    else:
        FAILED += 1
        print(f"  FAIL {name}   {detail}")


def free_port() -> int:
    import socket

    with socket.socket() as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


async def run_checks(port: int, token: str, backend: DryRunBackend) -> None:
    from websockets.asyncio.client import connect

    async with connect(f"ws://{HOST}:{port}/ws?k={token}") as ws:
        hi = json.loads(await ws.recv())
        await ws.send(json.dumps({"t": "pg", "n": 1}))
        await asyncio.sleep(0.05)

        print("\n--- 1. 滚动条语义：向下拖 ---")
        backend.clear()
        for _ in range(3):
            await ws.send(json.dumps({"t": "wh", "dy": -1, "dx": 0}))
        await asyncio.sleep(0.25)
        wheels = [e for e in backend.events if e["kind"] == "wheel"]
        check("收到 wheel 事件", len(wheels) > 0, str(backend.events))
        check("方向为负（向下滚）",
              all(w["dy"] == -1 for w in wheels), str(wheels))

        print("\n--- 2. 向上拖 ---")
        backend.clear()
        for _ in range(3):
            await ws.send(json.dumps({"t": "wh", "dy": 1, "dx": 0}))
        await asyncio.sleep(0.25)
        wheels = [e for e in backend.events if e["kind"] == "wheel"]
        check("方向为正（向上滚）",
              len(wheels) > 0 and all(w["dy"] == 1 for w in wheels), str(wheels))

        print("\n--- 3. 滚动不应移动光标 ---")
        backend.clear()
        await ws.send(json.dumps({"t": "wh", "dy": 5, "dx": 0}))
        await asyncio.sleep(0.25)
        moves = [e for e in backend.events if e["kind"] == "move_rel"]
        check("没有产生位移", len(moves) == 0, str(moves))

        print("\n--- 4. 单次大量滚动被限幅 ---")
        backend.clear()
        await ws.send(json.dumps({"t": "wh", "dy": 999, "dx": 0}))
        await asyncio.sleep(0.25)
        wheels = [e for e in backend.events if e["kind"] == "wheel"]
        check("单次不超过 40 行",
              len(wheels) == 1 and abs(wheels[0]["dy"]) <= 40, str(wheels))

        print("\n--- 5. 连续拖动可累积（模拟反复拖动滚条）---")
        backend.clear()
        for _ in range(10):
            await ws.send(json.dumps({"t": "wh", "dy": -1, "dx": 0}))
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.3)
        wheels = [e for e in backend.events if e["kind"] == "wheel"]
        total = sum(w["dy"] for w in wheels)
        check("累计行数正确", total == -10, f"实际 {total}")

        print("\n--- 6. 滚动后点击仍然正常 ---")
        backend.clear()
        await ws.send(json.dumps({"t": "wh", "dy": -1, "dx": 0}))
        await ws.send(json.dumps({"t": "bt", "b": "l", "a": "c"}))
        await asyncio.sleep(0.3)
        kinds = [e["kind"] for e in backend.events]
        check("wheel 与 button 都被处理",
              "wheel" in kinds and "button" in kinds, str(kinds))


def main() -> int:
    port = free_port()
    token = auth.generate_token()
    settings = Settings(token=token, dry_run=True, record=False)
    backend = DryRunBackend()
    hub = Hub(settings, backend)
    app = create_app(settings, hub)

    server = uvicorn.Server(uvicorn.Config(
        app, host=HOST, port=port, log_level="warning",
        ws_ping_interval=None, ws_ping_timeout=None,
    ))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    for _ in range(200):
        if server.started:
            break
        time.sleep(0.02)

    print(f"服务已启动：http://{HOST}:{port}")
    print("=" * 56)

    try:
        asyncio.run(run_checks(port, token, backend))
    finally:
        server.should_exit = True
        thread.join(timeout=3)
        hub.shutdown()

    print("\n" + "=" * 56)
    print(f"通过 {PASSED} 项，失败 {FAILED} 项")
    return 0 if FAILED == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
