"""Windows 注入后端：ctypes 直接调 SendInput。

为什么不用 pynput 的 mouse.move：
  pynput 内部是 SetCursorPos 或绝对 MoveTo，进程 DPI 感知一变，
  GetSystemMetrics 返回的就是缩放后的逻辑坐标，多屏 + 150% 缩放下会漂。
  SendInput 发 MOUSEEVENTF_MOVE 是相对位移，完全绕开坐标系，不累积误差。

另外 SendInput 能用 KEYEVENTF_UNICODE 直接发任意字符，
中文、emoji 都能落到目标程序，这是手机输入法能用的前提。
"""

from __future__ import annotations

import ctypes
import sys
import time
from ctypes import wintypes

from .. import keyboard_map
from ..keyboard_map import ComboError
from .base import ScreenInfo

if sys.platform != "win32":  # pragma: no cover - 只在 Windows 上导入
    raise ImportError("Win32Backend 仅支持 Windows")

user32 = ctypes.WinDLL("user32", use_last_error=True)

ULONG_PTR = ctypes.c_size_t

# ---- 常量 ----
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

WHEEL_DELTA = 120

SM_CXSCREEN = 0
SM_CYSCREEN = 1
SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79
SM_CMONITORS = 80

# 这些键必须带 EXTENDEDKEY，否则方向键会被当成小键盘数字，Delete 会变小数点
EXTENDED_VKS = frozenset(
    {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x2C, 0x5B, 0x5C, 0x5D, 0x90, 0x6F}
    | {0xAD, 0xAE, 0xAF, 0xB0, 0xB1, 0xB2, 0xB3}
)

BUTTON_FLAGS = {
    ("l", "d"): MOUSEEVENTF_LEFTDOWN,
    ("l", "u"): MOUSEEVENTF_LEFTUP,
    ("r", "d"): MOUSEEVENTF_RIGHTDOWN,
    ("r", "u"): MOUSEEVENTF_RIGHTUP,
    ("m", "d"): MOUSEEVENTF_MIDDLEDOWN,
    ("m", "u"): MOUSEEVENTF_MIDDLEUP,
}


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


def _enable_dpi_awareness() -> str:
    """必须在任何坐标查询之前调用，否则 150% 缩放下坐标全错。"""
    try:
        ctx = ctypes.c_void_p(-4)  # PER_MONITOR_AWARE_V2
        if user32.SetProcessDpiAwarenessContext(ctx):
            return "per-monitor-v2"
    except Exception:
        pass
    try:
        shcore = ctypes.WinDLL("shcore")
        if shcore.SetProcessDpiAwareness(2) == 0:  # PROCESS_PER_MONITOR_DPI_AWARE
            return "per-monitor"
    except Exception:
        pass
    try:
        if user32.SetProcessDPIAware():
            return "system"
    except Exception:
        pass
    return "none"


class Win32Backend:
    name = "win32-sendinput"

    def __init__(self) -> None:
        self.dpi_mode = _enable_dpi_awareness()
        self._pressed_buttons: set[str] = set()
        self._pressed_mods: set[str] = set()
        self._type_text_supported = True

        # 自己维护的光标位置。相对移动改为"读当前位置 + 增量 → 绝对定位"。
        # 原因：Windows 的指针加速曲线作用于相对移动，
        # 实测同样发 +420px，系统实际走了 +602px（1.43 倍），
        # 而且倍率随速度变化（5px 是 0.8 倍，80px 是 2.4 倍）。
        # 手机上滑动的手感会被这条曲线彻底带偏，必须绕开。
        # 绝对定位不走那条曲线：同样的 60 次 +7px，误差为 0。
        self._pos: tuple[float, float] | None = None
        self._virtual_rect: tuple[int, int, int, int] | None = None
        self._last_emit: float = 0.0

    # ---------- 底层 ----------

    def _send(self, *inputs: INPUT) -> None:
        count = len(inputs)
        array = (INPUT * count)(*inputs)
        sent = user32.SendInput(count, array, ctypes.sizeof(INPUT))
        if sent != count:
            err = ctypes.get_last_error()
            # 0 通常意味着被 UIPI 拦下（目标窗口权限更高）
            raise OSError(err, f"SendInput 只送入 {sent}/{count} 个事件（Windows 错误 {err}）")

    @staticmethod
    def _mouse_input(flags: int, dx: int = 0, dy: int = 0, data: int = 0) -> INPUT:
        item = INPUT()
        item.type = INPUT_MOUSE
        item.mi = MOUSEINPUT(dx, dy, ctypes.c_ulong(data & 0xFFFFFFFF).value, flags, 0, 0)
        return item

    @staticmethod
    def _key_input(vk: int = 0, scan: int = 0, flags: int = 0) -> INPUT:
        item = INPUT()
        item.type = INPUT_KEYBOARD
        item.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
        return item

    # ---------- 查询 ----------

    def screen_info(self) -> ScreenInfo:
        return ScreenInfo(
            width=user32.GetSystemMetrics(SM_CXSCREEN),
            height=user32.GetSystemMetrics(SM_CYSCREEN),
            monitors=user32.GetSystemMetrics(SM_CMONITORS),
        )

    # ---------- 鼠标 ----------

    def _virtual(self) -> tuple[int, int, int, int]:
        """虚拟桌面的 (x, y, w, h)。多屏时是整个拼接后的大桌面。"""
        if self._virtual_rect is None:
            self._virtual_rect = (
                user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
                user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
                max(1, user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)),
                max(1, user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)),
            )
        return self._virtual_rect

    def _cursor_pos(self) -> tuple[float, float]:
        point = wintypes.POINT()
        if not user32.GetCursorPos(ctypes.byref(point)):
            return (0.0, 0.0)
        return (float(point.x), float(point.y))

    def _base_pos(self) -> tuple[float, float]:
        """取相对移动的起点。

        刚发过指令时用自己记的缓存（GetCursorPos 可能还没跟上队列）；
        隔了一会儿没用过，就重新读一次真实位置——用户可能用物理鼠标动过。
        """
        idle = time.monotonic() - self._last_emit > 0.15
        if self._pos is None or idle:
            self._pos = self._cursor_pos()
        return self._pos

    def _emit_absolute(self, x: float, y: float) -> None:
        vx, vy, vw, vh = self._virtual()
        # 绝对坐标用 0..65535 表示整个虚拟桌面
        ax = int(round((x - vx) / max(1, vw - 1) * 65535))
        ay = int(round((y - vy) / max(1, vh - 1) * 65535))
        ax = max(0, min(65535, ax))
        ay = max(0, min(65535, ay))

        flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
        if user32.GetSystemMetrics(SM_CMONITORS) > 1:
            flags |= MOUSEEVENTF_VIRTUALDESK
        self._send(self._mouse_input(flags, ax, ay))
        self._last_emit = time.monotonic()

    def move_rel(self, dx: float, dy: float) -> None:
        if not dx and not dy:
            return

        base = self._base_pos()
        vx, vy, vw, vh = self._virtual()
        target_x = max(vx, min(vx + vw - 1, base[0] + dx))
        target_y = max(vy, min(vy + vh - 1, base[1] + dy))

        self._emit_absolute(target_x, target_y)
        self._pos = (target_x, target_y)

    def move_abs(self, nx: float, ny: float) -> None:
        vx, vy, vw, vh = self._virtual()
        x = vx + nx * (vw - 1)
        y = vy + ny * (vh - 1)
        self._emit_absolute(x, y)
        self._pos = (x, y)

    def button(self, btn: str, action: str) -> None:
        if action == "c":
            self.button(btn, "d")
            self.button(btn, "u")
            return

        # 孤立的"抬起"必须丢掉。
        #
        # 实测（tests/_probe_bare_rightup.py 的窗口消息版）：
        # 只发一个 MOUSEEVENTF_RIGHTUP，目标窗口照样收到 WM_RBUTTONUP，
        # 而应用就是靠这条消息弹右键菜单的。
        #
        # 所以手机锁屏时前端若盲目补发 r/u，用户就会看到一个右键菜单凭空弹出，
        # 尽管从头到尾没按下过右键。这里按"没按下就不许抬起"兜住，
        # 代价是：如果按下状态因异常丢失，抬起也会被忽略——由 release_all 负责收尾。
        if action == "u" and btn not in self._pressed_buttons:
            return

        try:
            flags = BUTTON_FLAGS[(btn, action)]
        except KeyError:
            raise ValueError(f"未知按键事件 {btn}/{action}") from None
        self._send(self._mouse_input(flags))
        if action == "d":
            self._pressed_buttons.add(btn)
        else:
            self._pressed_buttons.discard(btn)

    def wheel(self, dy: int, dx: int) -> None:
        events = []
        if dy:
            events.append(self._mouse_input(MOUSEEVENTF_WHEEL, data=dy * WHEEL_DELTA))
        if dx:
            events.append(self._mouse_input(MOUSEEVENTF_HWHEEL, data=dx * WHEEL_DELTA))
        if events:
            self._send(*events)

    # ---------- 键盘 ----------

    def key_combo(self, combo: str) -> None:
        try:
            tokens = keyboard_map.parse_combo(combo)
        except ComboError as exc:
            raise ValueError(str(exc)) from None

        mods = [t for t in tokens if t.is_modifier]
        main = [t for t in tokens if not t.is_modifier]
        events: list[INPUT] = []
        held: list[str] = []

        for mod in mods:
            events.append(self._key_input(mod.vk))
            held.append(mod.name)
        if self._pressed_mods & set(held):
            # 手机上重复点同一个修饰键不算错误，直接放行
            pass

        for token in main:
            if token.shift and "shift" not in held:
                events.append(self._key_input(keyboard_map.MODIFIER_VK["shift"]))
                held.append("shift")
            flags = KEYEVENTF_EXTENDEDKEY if token.vk in EXTENDED_VKS else 0
            events.append(self._key_input(token.vk, 0, flags))
            events.append(self._key_input(token.vk, 0, flags | KEYEVENTF_KEYUP))

        # 修饰键逆序抬起
        for name in reversed(held):
            events.append(self._key_input(keyboard_map.MODIFIER_VK[name], 0, KEYEVENTF_KEYUP))

        if events:
            self._send(*events)

    def type_text(self, text: str) -> None:
        """逐 UTF-16 码元发送，代理对（emoji）也能正确落地。"""
        units = text.encode("utf-16-le")
        events: list[INPUT] = []
        for i in range(0, len(units), 2):
            unit = int.from_bytes(units[i : i + 2], "little")
            events.append(self._key_input(0, unit, KEYEVENTF_UNICODE))
            events.append(self._key_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
        if events:
            self._send(*events)

    def media(self, action: str) -> None:
        try:
            vk = keyboard_map.media_vk(action)
        except ComboError as exc:
            raise ValueError(str(exc)) from None
        self._send(
            self._key_input(vk, 0, KEYEVENTF_EXTENDEDKEY),
            self._key_input(vk, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP),
        )

    # ---------- 安全兜底 ----------

    def release_all(self) -> None:
        """断线时调用：放掉所有还按着的键，防止 Ctrl 或左键粘住。"""
        events: list[INPUT] = []
        for btn in list(self._pressed_buttons):
            flags = BUTTON_FLAGS.get((btn, "u"))
            if flags:
                events.append(self._mouse_input(flags))
        self._pressed_buttons.clear()

        for name in list(self._pressed_mods):
            vk = keyboard_map.MODIFIER_VK.get(name)
            if vk:
                events.append(self._key_input(vk, 0, KEYEVENTF_KEYUP))
        self._pressed_mods.clear()

        # 常见修饰键无条件补一次：即使我们没记到，也可能处于按下状态
        for vk in (0x11, 0x10, 0x12, 0x5B):
            events.append(self._key_input(vk, 0, KEYEVENTF_KEYUP))

        if events:
            try:
                self._send(*events)
            except OSError:
                pass
