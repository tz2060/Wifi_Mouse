"""dry-run 后端：把注入意图记成 JSONL，不碰真实鼠标。

测试必须用它——否则跑一次测试，用户的鼠标会被拖到屏幕角落
（或者误点掉某个窗口），这在实际使用中非常扰人。
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from .base import ScreenInfo


class DryRunBackend:
    name = "dry-run"

    def __init__(self, record_path: Path | None = None) -> None:
        self.record_path = record_path
        self.events: list[dict] = []
        self._lock = threading.Lock()
        self._pressed_buttons: set[str] = set()
        if record_path:
            record_path.parent.mkdir(parents=True, exist_ok=True)

    # ---------- 记录 ----------

    def _log(self, kind: str, **args) -> None:
        event = {"ts": round(time.time(), 4), "kind": kind, **args}
        with self._lock:
            self.events.append(event)
            if self.record_path:
                with self.record_path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(event, ensure_ascii=False) + "\n")

    def clear(self) -> None:
        with self._lock:
            self.events.clear()

    # ---------- 接口实现 ----------

    def screen_info(self) -> ScreenInfo:
        return ScreenInfo(width=1920, height=1080, monitors=1)

    def move_rel(self, dx: float, dy: float) -> None:
        self._log("move_rel", dx=dx, dy=dy)

    def move_abs(self, nx: float, ny: float) -> None:
        self._log("move_abs", nx=nx, ny=ny)

    def button(self, btn: str, action: str) -> None:
        # 与 Win32Backend 保持同样的语义：没有对应按下的抬起直接丢弃。
        # 测试都用这个后端，行为不一致会让测试给出虚假的通过。
        if action == "c":
            self.button(btn, "d")
            self.button(btn, "u")
            return
        if action == "u" and btn not in self._pressed_buttons:
            return
        self._log("button", btn=btn, action=action)
        if action == "d":
            self._pressed_buttons.add(btn)
        else:
            self._pressed_buttons.discard(btn)

    def wheel(self, dy: int, dx: int) -> None:
        self._log("wheel", dy=dy, dx=dx)

    def key_combo(self, combo: str) -> None:
        self._log("key", combo=combo)

    def type_text(self, text: str) -> None:
        self._log("text", text=text)

    def media(self, action: str) -> None:
        self._log("media", action=action)

    def release_all(self) -> None:
        self._log("release_all")
        self._pressed_buttons.clear()
