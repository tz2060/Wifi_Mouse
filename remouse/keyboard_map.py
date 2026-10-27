"""把 "ctrl+shift+t" 这样的字符串解析成按键序列。

只做解析，不关心怎么注入——Windows 后端取 vk，pynput 后端取 name。
这样组合键的规则只有一份，两个后端不会跑偏。
"""

from __future__ import annotations

from dataclasses import dataclass

MAX_TOKENS = 6

MODIFIER_ALIASES = {
    "ctrl": "ctrl",
    "control": "ctrl",
    "ctl": "ctrl",
    "shift": "shift",
    "alt": "alt",
    "option": "alt",
    "opt": "alt",
    "win": "win",
    "cmd": "win",
    "command": "win",
    "meta": "win",
    "super": "win",
}

MODIFIER_VK = {
    "ctrl": 0x11,
    "shift": 0x10,
    "alt": 0x12,
    "win": 0x5B,
}

# 命名键 -> (规范名, VK)
NAMED_KEYS = {
    "tab": 0x09,
    "enter": 0x0D,
    "return": 0x0D,
    "esc": 0x1B,
    "escape": 0x1B,
    "space": 0x20,
    "backspace": 0x08,
    "back": 0x08,
    "delete": 0x2E,
    "del": 0x2E,
    "insert": 0x2D,
    "ins": 0x2D,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pgup": 0x21,
    "pagedown": 0x22,
    "pgdn": 0x22,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
    "capslock": 0x14,
    "printscreen": 0x2C,
    "prtsc": 0x2C,
    "menu": 0x5D,
    "contextmenu": 0x5D,
    "pause": 0x13,
    "numlock": 0x90,
    "scrolllock": 0x91,
}

for _i in range(1, 25):
    NAMED_KEYS[f"f{_i}"] = 0x6F + _i

# 有移位的 OEM 符号：(VK, 是否需要 Shift)
SYMBOL_KEYS = {
    ";": (0xBA, False),
    ":": (0xBA, True),
    "=": (0xBB, False),
    "+": (0xBB, True),
    ",": (0xBC, False),
    "<": (0xBC, True),
    "-": (0xBD, False),
    "_": (0xBD, True),
    ".": (0xBE, False),
    ">": (0xBE, True),
    "/": (0xBF, False),
    "?": (0xBF, True),
    "`": (0xC0, False),
    "~": (0xC0, True),
    "[": (0xDB, False),
    "{": (0xDB, True),
    "\\": (0xDC, False),
    "|": (0xDC, True),
    "]": (0xDD, False),
    "}": (0xDD, True),
    "'": (0xDE, False),
    '"': (0xDE, True),
}


@dataclass(frozen=True)
class KeyToken:
    name: str  # 规范名，pynput 后端用它
    vk: int  # Windows 虚拟键码，0 表示未知
    shift: bool = False  # 是否需要额外按 Shift（符号键）
    is_modifier: bool = False


class ComboError(ValueError):
    """组合键字符串不合法。"""


def _parse_token(token: str) -> KeyToken:
    low = token.strip().lower()
    if not low:
        raise ComboError("组合键里存在空片段")

    if low in MODIFIER_ALIASES:
        name = MODIFIER_ALIASES[low]
        return KeyToken(name=name, vk=MODIFIER_VK[name], is_modifier=True)

    if low in NAMED_KEYS:
        return KeyToken(name=low, vk=NAMED_KEYS[low])

    if len(low) == 1:
        ch = low
        if "a" <= ch <= "z":
            return KeyToken(name=ch, vk=ord(ch.upper()))
        if "0" <= ch <= "9":
            return KeyToken(name=ch, vk=ord(ch))
        if ch in SYMBOL_KEYS:
            vk, shift = SYMBOL_KEYS[ch]
            return KeyToken(name=ch, vk=vk, shift=shift)

    raise ComboError(f"无法识别的按键: {token!r}")


def parse_combo(combo: str) -> list[KeyToken]:
    """解析 "ctrl+shift+t"。

    返回顺序即按下顺序：修饰键在前，主键在后。
    最后一个非修饰键视为主键；如果整串都是修饰键（如单按 "ctrl"），也允许。
    """
    if not isinstance(combo, str) or not combo.strip():
        raise ComboError("组合键不能为空")

    raw_tokens = combo.split("+")
    # "ctrl++" 这种写法：末尾空片段代表 '+' 键本身
    if len(raw_tokens) > 1 and raw_tokens[-1] == "":
        raw_tokens = raw_tokens[:-1] + ["+"]

    if len(raw_tokens) > MAX_TOKENS:
        raise ComboError(f"组合键最多 {MAX_TOKENS} 个按键")

    parsed = [_parse_token(t) for t in raw_tokens]

    if any(t.is_modifier for t in parsed):
        mods = [t for t in parsed if t.is_modifier]
        rest = [t for t in parsed if not t.is_modifier]
        seen = set()
        for m in mods:
            if m.name in seen:
                raise ComboError(f"重复的修饰键: {m.name}")
            seen.add(m.name)
        parsed = mods + rest

    return parsed


def canonical(combo: str) -> str:
    """统一成小写、修饰键在前的写法，便于去重和日志。"""
    return "+".join(t.name for t in parse_combo(combo))


# 媒体键动作 -> VK
MEDIA_ACTIONS = {
    "pp": 0xB3,  # 播放/暂停
    "ng": 0xB0,  # 下一曲
    "pv": 0xB1,  # 上一曲
    "vu": 0xAF,  # 音量+
    "vd": 0xAE,  # 音量-
    "mu": 0xAD,  # 静音
}


def media_vk(action: str) -> int:
    try:
        return MEDIA_ACTIONS[action]
    except KeyError:
        raise ComboError(f"未知的媒体动作: {action!r}") from None
