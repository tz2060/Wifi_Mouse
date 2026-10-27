"""消息协议：解码、校验、上限。

前端发来的东西一律当作不可信输入。任何解析失败都只丢掉这一条消息，
不能让异常冒到事件循环里——一条畸形消息不该中断整个会控制你鼠标的连接。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

MAX_MESSAGE_BYTES = 64 * 1024
MAX_TEXT_CHARS = 4096
MAX_MOVE_PX = 4000
MAX_SCROLL_LINES = 40

# C -> S
T_MOVE = "mv"
T_MOVE_ABS = "ma"
T_BUTTON = "bt"
T_WHEEL = "wh"
T_KEY = "ky"
T_TEXT = "tx"
T_MEDIA = "md"
T_CONFIG = "cf"
T_PING = "pg"

# S -> C
S_HELLO = "hi"
S_PONG = "po"
S_ERROR = "er"

MOVE_TYPES = frozenset({T_MOVE, T_MOVE_ABS})
BUTTONS = frozenset({"l", "r", "m"})
BUTTON_ACTIONS = frozenset({"d", "u", "c"})


class ProtocolError(ValueError):
    """消息不合法（可预期，丢弃即可）。"""


@dataclass(frozen=True)
class Message:
    type: str
    raw: dict[str, Any]


def _clamp(value: float, low: float, high: float) -> float:
    if value < low:
        return low
    if value > high:
        return high
    return value


def _num(data: dict, key: str, default: float | None = None) -> float:
    value = data.get(key, default)
    if value is None:
        raise ProtocolError(f"缺少字段 {key}")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProtocolError(f"字段 {key} 必须是数字")
    if value != value:  # NaN
        raise ProtocolError(f"字段 {key} 是 NaN")
    return float(value)


def decode(raw_text: str | bytes) -> Message:
    if isinstance(raw_text, bytes):
        if len(raw_text) > MAX_MESSAGE_BYTES:
            raise ProtocolError("消息过大")
        try:
            raw_text = raw_text.decode("utf-8")
        except UnicodeDecodeError:
            raise ProtocolError("消息不是合法 UTF-8") from None

    if len(raw_text.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise ProtocolError("消息过大")

    try:
        data = json.loads(raw_text)
    except (ValueError, RecursionError):
        raise ProtocolError("不是合法 JSON") from None

    if not isinstance(data, dict):
        raise ProtocolError("消息必须是 JSON 对象")

    msg_type = data.get("t")
    if not isinstance(msg_type, str) or not msg_type:
        raise ProtocolError("缺少消息类型 t")

    return Message(type=msg_type, raw=data)


class Command:
    """已校验、可直接执行的指令。构造函数只做数据搬运。"""

    __slots__ = ("kind", "args")

    def __init__(self, kind: str, **args: Any) -> None:
        self.kind = kind
        self.args = args

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"Command({self.kind}, {self.args})"


def to_command(msg: Message) -> Command | None:
    """把消息翻译成指令；需要前台直接处理的消息（握手/配置）返回 None。"""
    t = msg.type
    data = msg.raw

    if t == T_MOVE:
        dx = _clamp(_num(data, "dx"), -MAX_MOVE_PX, MAX_MOVE_PX)
        dy = _clamp(_num(data, "dy"), -MAX_MOVE_PX, MAX_MOVE_PX)
        if abs(dx) < 1 and abs(dy) < 1:
            return None
        return Command("move_rel", dx=dx, dy=dy)

    if t == T_MOVE_ABS:
        nx = _clamp(_num(data, "x"), 0.0, 1.0)
        ny = _clamp(_num(data, "y"), 0.0, 1.0)
        return Command("move_abs", nx=nx, ny=ny)

    if t == T_BUTTON:
        btn = data.get("b")
        action = data.get("a")
        if btn not in BUTTONS:
            raise ProtocolError(f"未知按键 {btn!r}")
        if action not in BUTTON_ACTIONS:
            raise ProtocolError(f"未知按键动作 {action!r}")
        return Command("button", btn=btn, action=action)

    if t == T_WHEEL:
        dy = _clamp(_num(data, "dy", 0.0), -MAX_SCROLL_LINES, MAX_SCROLL_LINES)
        dx = _clamp(_num(data, "dx", 0.0), -MAX_SCROLL_LINES, MAX_SCROLL_LINES)
        lines_y = int(round(dy))
        lines_x = int(round(dx))
        if lines_y == 0 and lines_x == 0:
            return None
        return Command("wheel", dy=lines_y, dx=lines_x)

    if t == T_KEY:
        combo = data.get("k")
        if not isinstance(combo, str):
            raise ProtocolError("k 必须是字符串")
        return Command("key", combo=combo)

    if t == T_TEXT:
        text = data.get("s")
        if not isinstance(text, str):
            raise ProtocolError("s 必须是字符串")
        if not text:
            return None
        if len(text) > MAX_TEXT_CHARS:
            raise ProtocolError(f"文本超过 {MAX_TEXT_CHARS} 字符")
        return Command("text", text=text)

    if t == T_MEDIA:
        action = data.get("a")
        if not isinstance(action, str):
            raise ProtocolError("a 必须是字符串")
        return Command("media", action=action)

    # 握手类、配置类、心跳都由调用方处理
    return None


def encode_hello(host: str, width: int, height: int, version: str, settings: dict) -> str:
    payload = {
        "t": S_HELLO,
        "host": host,
        "w": width,
        "h": height,
        "ver": version,
        "cfg": settings,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def encode_pong(seq: Any) -> str:
    return json.dumps({"t": S_PONG, "n": seq}, separators=(",", ":"))


def encode_error(message: str, code: int = 0) -> str:
    return json.dumps({"t": S_ERROR, "m": message, "code": code}, ensure_ascii=False)
