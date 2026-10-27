"""运行环境自检。

有两个坑会让"代码没错但鼠标不动"，而且都没有任何报错：

1. **会话不匹配**：进程在会话 0（服务会话）而桌面在会话 2，
   SendInput 会被丢进一个没有桌面的会话。

2. **完整性级别过低**：Windows 的 UIPI 会静默丢弃低完整性进程发出的合成输入。
   从受限令牌（低完整性）的进程里调 SendInput，返回值是"成功送入 1 个事件"，
   但事件被直接丢弃，光标纹丝不动。

第二种最阴——Windows 根本不报错。所以启动时主动检查并告警，
别让人对着一动不动的鼠标怀疑代码。
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes
from dataclasses import dataclass

INTEGRITY_LEVELS = {
    0x0000: "Untrusted",
    0x1000: "Low",
    0x2000: "Medium",
    0x2100: "Medium Plus",
    0x3000: "High",
    0x4000: "System",
}


@dataclass
class EnvCheck:
    process_session: int = -1
    console_session: int = -1
    integrity: str = "unknown"
    integrity_rid: int = 0
    ok: bool = True
    problems: tuple[str, ...] = ()


def _api():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)

    advapi32.OpenProcessToken.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)
    ]
    advapi32.OpenProcessToken.restype = wintypes.BOOL
    advapi32.GetTokenInformation.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
        wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
    ]
    advapi32.GetTokenInformation.restype = wintypes.BOOL
    advapi32.ConvertSidToStringSidW.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)
    ]
    advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL

    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.WTSGetActiveConsoleSessionId.restype = wintypes.DWORD
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD

    user32.GetProcessWindowStation.restype = wintypes.HANDLE
    user32.GetThreadDesktop.argtypes = [wintypes.DWORD]
    user32.GetThreadDesktop.restype = wintypes.HANDLE
    user32.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    user32.OpenInputDesktop.restype = wintypes.HANDLE
    user32.GetUserObjectInformationW.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
        wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
    ]
    user32.GetUserObjectInformationW.restype = wintypes.BOOL

    return kernel32, advapi32, user32


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]


class TOKEN_MANDATORY_LABEL(ctypes.Structure):
    _fields_ = [("Label", SID_AND_ATTRIBUTES)]


def _token_integrity(advapi32, token) -> tuple[str, int]:
    size = wintypes.DWORD()
    advapi32.GetTokenInformation(token, 25, None, 0, ctypes.byref(size))
    if not size.value:
        return "unknown", 0
    buf = ctypes.create_string_buffer(size.value)
    if not advapi32.GetTokenInformation(token, 25, buf, size.value, ctypes.byref(size)):
        return "unknown", 0

    label = ctypes.cast(buf, ctypes.POINTER(TOKEN_MANDATORY_LABEL)).contents
    sid_str = ctypes.c_wchar_p()
    if not advapi32.ConvertSidToStringSidW(label.Label.Sid, ctypes.byref(sid_str)):
        return "unknown", 0
    try:
        rid = int(sid_str.value.split("-")[-1])
    except (ValueError, AttributeError):
        return "unknown", 0
    return INTEGRITY_LEVELS.get(rid, hex(rid)), rid


def check_environment() -> EnvCheck:
    if sys.platform != "win32":
        return EnvCheck(ok=True)

    try:
        kernel32, advapi32, user32 = _api()
    except Exception:
        return EnvCheck(ok=True)

    result = EnvCheck()
    problems: list[str] = []

    # --- 会话 ---
    token = wintypes.HANDLE()
    if advapi32.OpenProcessToken(
        kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(token)
    ):
        size = wintypes.DWORD()
        advapi32.GetTokenInformation(token, 12, None, 0, ctypes.byref(size))
        if size.value:
            buf = ctypes.create_string_buffer(size.value)
            if advapi32.GetTokenInformation(token, 12, buf, size.value, ctypes.byref(size)):
                result.process_session = ctypes.cast(buf, ctypes.POINTER(wintypes.DWORD))[0]

        level, rid = _token_integrity(advapi32, token)
        result.integrity = level
        result.integrity_rid = rid

        try:
            kernel32.CloseHandle(token)
        except Exception:
            pass

    result.console_session = kernel32.WTSGetActiveConsoleSessionId()

    if result.console_session in (0xFFFFFFFF, 0):
        problems.append("当前没有交互式登录会话（可能无人登录或已断开远程桌面）")
    elif result.process_session == 0:
        problems.append(
            "进程运行在会话 0（服务会话），它没有可见桌面，"
            "SendInput 会静默失效：服务能连、日志正常，但鼠标不动"
        )
    elif result.process_session != result.console_session:
        problems.append(
            f"进程在会话 {result.process_session}，交互桌面在会话 "
            f"{result.console_session}，两者不一致"
        )

    # --- 完整性级别（UIPI）---
    if result.integrity_rid and result.integrity_rid < 0x2000:
        problems.append(
            f"进程完整性级别为 {result.integrity}（低于 Medium），"
            "Windows 的 UIPI 会静默丢弃本进程发出的合成鼠标键盘事件——"
            "SendInput 返回成功，光标却不动"
        )

    result.problems = tuple(problems)
    result.ok = not problems
    return result


def describe(check: EnvCheck) -> str:
    lines = [
        f"  进程会话 : {check.process_session}",
        f"  桌面会话 : {check.console_session}",
        f"  完整性   : {check.integrity} (0x{check.integrity_rid:x})" if check.integrity_rid
        else f"  完整性   : {check.integrity}",
    ]
    return "\n".join(lines)


def warn_if_not_interactive() -> bool:
    """返回 True 表示预期能注入真实输入。"""
    check = check_environment()
    if check.ok:
        return True

    print()
    print("!" * 64)
    print("  注意：当前环境无法向桌面注入输入")
    print("!" * 64)
    print(describe(check))
    print()
    for problem in check.problems:
        print(f"  · {problem}")
    print()
    print("  手机仍可正常连接，命令行也会打印收到的指令，但电脑上的光标不会动。")
    print("  解决：在一个普通的 PowerShell / CMD 窗口（双击打开那种）里运行本程序。")
    print("  自检：python run.py --self-test")
    print("!" * 64)
    print()
    return False


def self_test() -> int:
    print("=" * 64)
    print("  注入自检")
    print("=" * 64)

    check = check_environment()
    print(describe(check))
    print()

    from .input.base import get_backend

    backend = get_backend()
    print(f"  注入后端 : {backend.name}")
    if hasattr(backend, "dpi_mode"):
        print(f"  DPI 模式 : {backend.dpi_mode}")
    info = backend.screen_info()
    print(f"  屏幕     : {info.width}x{info.height}（{info.monitors} 块）")
    print()

    if not check.ok:
        for problem in check.problems:
            print(f"  [!] {problem}")
        print()
        print("  结论：注入链路不可用，请换到普通终端窗口重试。")
        return 2

    if sys.platform != "win32":
        backend.move_rel(40, 0)
        backend.move_rel(-40, 0)
        print("  非 Windows 平台，请手动确认光标是否移动。")
        return 0

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
    user32.SetCursorPos.restype = wintypes.BOOL

    def cursor() -> tuple[int, int]:
        point = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(point))
        return point.x, point.y

    import time

    original = cursor()
    print(f"  原始位置 : {original}")
    print("  即将把光标移到屏幕中央，再右移 60px，然后还原；期间请勿动鼠标。")

    backend.move_abs(0.5, 0.5)
    time.sleep(0.08)
    center = cursor()
    expect_cx, expect_cy = info.width // 2, info.height // 2
    abs_ok = abs(center[0] - expect_cx) <= 3 and abs(center[1] - expect_cy) <= 3
    print(f"  移到中央 : {center}  期望 ~({expect_cx}, {expect_cy})  "
          f"{'OK' if abs_ok else '失败'}")

    backend.move_rel(60, 0)
    time.sleep(0.08)
    shifted = cursor()
    dx = shifted[0] - center[0]
    rel_ok = abs(dx - 60) <= 2
    print(f"  相对 +60 : 实测 {dx}  {'OK' if rel_ok else '失败'}")

    backend.move_abs(original[0] / max(1, info.width - 1), original[1] / max(1, info.height - 1))
    time.sleep(0.05)
    print(f"  还原     : {cursor()}")

    ok = abs_ok and rel_ok
    print()
    if ok:
        print("  自检通过：注入链路正常，光标能被程序驱动。")
        return 0

    print("  自检未通过：SetCursorPos/SendInput 被系统丢弃。")
    print("  常见原因：进程完整性级别低于 Medium（UIPI）、或不在交互式桌面。")
    return 3
