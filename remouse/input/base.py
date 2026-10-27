"""注入后端的公共接口。"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class ScreenInfo:
    width: int
    height: int
    monitors: int = 1


@runtime_checkable
class InputBackend(Protocol):
    name: str

    def screen_info(self) -> ScreenInfo: ...

    def move_rel(self, dx: float, dy: float) -> None: ...

    def move_abs(self, nx: float, ny: float) -> None: ...

    def button(self, btn: str, action: str) -> None: ...

    def wheel(self, dy: int, dx: int) -> None: ...

    def key_combo(self, combo: str) -> None: ...

    def type_text(self, text: str) -> None: ...

    def media(self, action: str) -> None: ...

    def release_all(self) -> None: ...


def get_backend(dry_run: bool = False, record_path=None) -> InputBackend:
    """按平台挑选后端。

    Windows 用 ctypes 直发 SendInput（不受 DPI 影响，支持 Unicode）；
    其它平台用 pynput；都不可用时退回 DryRun，至少不会崩。
    """
    if dry_run:
        from .dryrun import DryRunBackend

        return DryRunBackend(record_path=record_path)

    if sys.platform == "win32":
        try:
            from .win32 import Win32Backend

            return Win32Backend()
        except Exception as exc:  # pragma: no cover - 仅异常路径
            print(f"[remouse] Win32 后端不可用（{exc}），改用 pynput")

    try:
        from .fallback import PynputBackend

        return PynputBackend()
    except Exception as exc:  # pragma: no cover - 仅异常路径
        print(f"[remouse] pynput 后端不可用（{exc}），进入 dry-run 模式")
        from .dryrun import DryRunBackend

        return DryRunBackend(record_path=record_path)
