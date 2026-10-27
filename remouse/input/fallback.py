"""非 Windows 平台的后端（macOS / Linux），基于 pynput。

功能上与 Win32 后端对齐，但有两个已知差异：
  - 中文等非 ASCII 字符在 Linux 上依赖输入法框架，可能漏字；
  - 相对移动走 pynput 的 move，在多屏高缩放下会有轻微累积误差。
"""

from __future__ import annotations

from .. import keyboard_map
from ..keyboard_map import ComboError
from .base import ScreenInfo

try:
    from pynput.keyboard import Controller as KeyboardController
    from pynput.keyboard import Key
    from pynput.mouse import Button
    from pynput.mouse import Controller as MouseController
except Exception as exc:  # pragma: no cover - 仅非 Windows 路径
    raise ImportError(f"pynput 不可用: {exc}") from exc

BUTTONS = {"l": Button.left, "r": Button.right, "m": Button.middle}

MEDIA_KEYS = {
    "pp": Key.media_play_pause,
    "ng": Key.media_next,
    "pv": Key.media_previous,
    "vu": Key.media_volume_up,
    "vd": Key.media_volume_down,
    "mu": Key.media_volume_mute,
}

SPECIAL = {
    "tab": Key.tab,
    "enter": Key.enter,
    "esc": Key.esc,
    "space": Key.space,
    "backspace": Key.backspace,
    "delete": Key.delete,
    "insert": Key.insert,
    "home": Key.home,
    "end": Key.end,
    "pageup": Key.page_up,
    "pagedown": Key.page_down,
    "up": Key.up,
    "down": Key.down,
    "left": Key.left,
    "right": Key.right,
    "capslock": Key.caps_lock,
    "printscreen": Key.print_screen,
}

for _i in range(1, 13):
    SPECIAL[f"f{_i}"] = getattr(Key, f"f{_i}")

MODS = {
    "ctrl": Key.ctrl,
    "shift": Key.shift,
    "alt": Key.alt,
    "win": Key.cmd,
}


def _to_pynput(token) -> object:
    if token.name in SPECIAL:
        return SPECIAL[token.name]
    if token.name in MODS:
        return MODS[token.name]
    return token.name


class PynputBackend:
    name = "pynput"

    def __init__(self) -> None:
        self._mouse = MouseController()
        self._keyboard = KeyboardController()
        self._pressed_buttons: set[str] = set()
        self._pressed_mods: list[str] = []

    def screen_info(self) -> ScreenInfo:
        try:
            from screeninfo import get_monitors

            monitors = get_monitors()
            if monitors:
                width = max(m.x + m.width for m in monitors)
                height = max(m.y + m.height for m in monitors)
                return ScreenInfo(width=width, height=height, monitors=len(monitors))
        except Exception:
            pass
        return ScreenInfo(width=1920, height=1080)

    def move_rel(self, dx: float, dy: float) -> None:
        x, y = self._mouse.position
        self._mouse.position = (x + dx, y + dy)

    def move_abs(self, nx: float, ny: float) -> None:
        info = self.screen_info()
        self._mouse.position = (int(nx * info.width), int(ny * info.height))

    def button(self, btn: str, action: str) -> None:
        button = BUTTONS.get(btn)
        if button is None:
            raise ValueError(f"未知按键 {btn}")
        if action == "c":
            self._mouse.click(button)
            return
        if action == "d":
            self._mouse.press(button)
            self._pressed_buttons.add(btn)
        else:
            # 没有对应按下的抬起直接忽略，避免凭空产生一次右键/左键事件。
            # 手机锁屏时前端会补发抬起，不挡住就会莫名弹出右键菜单。
            if btn not in self._pressed_buttons:
                return
            self._mouse.release(button)
            self._pressed_buttons.discard(btn)

    def wheel(self, dy: int, dx: int) -> None:
        if dy:
            self._mouse.scroll(0, dy)
        if dx:
            self._mouse.scroll(dx, 0)

    def key_combo(self, combo: str) -> None:
        try:
            tokens = keyboard_map.parse_combo(combo)
        except ComboError as exc:
            raise ValueError(str(exc)) from None

        held = []
        try:
            for token in tokens:
                key = _to_pynput(token)
                if token.is_modifier:
                    self._keyboard.press(key)
                    held.append(token.name)
                    continue
                if token.shift and "shift" not in held:
                    self._keyboard.press(Key.shift)
                    held.append("shift")
                if isinstance(key, str):
                    self._keyboard.press(key)
                    self._keyboard.release(key)
                else:
                    self._keyboard.press(key)
                    self._keyboard.release(key)
        finally:
            for name in reversed(held):
                try:
                    self._keyboard.release(MODS[name])
                except Exception:
                    pass

    def type_text(self, text: str) -> None:
        self._keyboard.type(text)

    def media(self, action: str) -> None:
        key = MEDIA_KEYS.get(action)
        if key is None:
            raise ValueError(f"未知媒体动作 {action}")
        self._keyboard.press(key)
        self._keyboard.release(key)

    def release_all(self) -> None:
        for btn in list(self._pressed_buttons):
            try:
                self._mouse.release(BUTTONS[btn])
            except Exception:
                pass
        self._pressed_buttons.clear()
        for name in ("ctrl", "shift", "alt", "win"):
            try:
                self._keyboard.release(MODS[name])
            except Exception:
                pass
        self._pressed_mods.clear()
