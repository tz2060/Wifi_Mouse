"""协议层测试：解码、校验、边界。

重点不是"正常路径能过"，而是"畸形输入不会把服务搞崩"——
这个服务在局域网里能被任何设备访问，输入一律视为不可信。
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from remouse import protocol  # noqa: E402
from remouse.protocol import ProtocolError  # noqa: E402


class TestDecode(unittest.TestCase):
    def test_valid_object(self):
        msg = protocol.decode('{"t":"mv","dx":1,"dy":2}')
        self.assertEqual(msg.type, "mv")
        self.assertEqual(msg.raw["dx"], 1)

    def test_bytes_input(self):
        msg = protocol.decode(b'{"t":"bt","b":"l","a":"c"}')
        self.assertEqual(msg.type, "bt")

    def test_rejects_non_json(self):
        for bad in ["", "not json", "{", "[1,2,3]", "null", '"str"', "42"]:
            with self.assertRaises(ProtocolError):
                protocol.decode(bad)

    def test_rejects_missing_type(self):
        with self.assertRaises(ProtocolError):
            protocol.decode('{"dx":1}')

    def test_rejects_non_string_type(self):
        with self.assertRaises(ProtocolError):
            protocol.decode('{"t":123}')

    def test_rejects_oversized(self):
        huge = json.dumps({"t": "tx", "s": "x" * (protocol.MAX_MESSAGE_BYTES + 10)})
        with self.assertRaises(ProtocolError):
            protocol.decode(huge)

    def test_rejects_invalid_utf8(self):
        with self.assertRaises(ProtocolError):
            protocol.decode(b'{"t":"tx","s":"\xff\xfe"}')

    def test_deep_nesting_does_not_crash(self):
        # 递归深度炸弹：json 解析可能抛 RecursionError，必须被吞掉
        payload = "[" * 200000 + "]" * 200000
        with self.assertRaises(ProtocolError):
            protocol.decode("{" + '"t":"x","a":' + payload + "}")


class TestToCommand(unittest.TestCase):
    def _cmd(self, raw: dict):
        return protocol.to_command(protocol.decode(json.dumps(raw)))

    def test_move_clamped(self):
        cmd = self._cmd({"t": "mv", "dx": 999999, "dy": -999999})
        self.assertEqual(cmd.kind, "move_rel")
        self.assertEqual(cmd.args["dx"], protocol.MAX_MOVE_PX)
        self.assertEqual(cmd.args["dy"], -protocol.MAX_MOVE_PX)

    def test_move_subpixel_dropped(self):
        self.assertIsNone(self._cmd({"t": "mv", "dx": 0, "dy": 0}))

    def test_move_rejects_nan(self):
        with self.assertRaises(ProtocolError):
            self._cmd({"t": "mv", "dx": float("nan"), "dy": 0})

    def test_move_rejects_string(self):
        with self.assertRaises(ProtocolError):
            self._cmd({"t": "mv", "dx": "10", "dy": 0})

    def test_move_abs_clamped_to_unit(self):
        cmd = self._cmd({"t": "ma", "x": 5, "y": -3})
        self.assertEqual(cmd.args["nx"], 1.0)
        self.assertEqual(cmd.args["ny"], 0.0)

    def test_button_valid(self):
        cmd = self._cmd({"t": "bt", "b": "r", "a": "d"})
        self.assertEqual(cmd.kind, "button")
        self.assertEqual(cmd.args["btn"], "r")

    def test_button_rejects_unknown(self):
        with self.assertRaises(ProtocolError):
            self._cmd({"t": "bt", "b": "x", "a": "d"})
        with self.assertRaises(ProtocolError):
            self._cmd({"t": "bt", "b": "l", "a": "z"})

    def test_wheel_rounds(self):
        cmd = self._cmd({"t": "wh", "dy": 2.4})
        self.assertEqual(cmd.args["dy"], 2)
        self.assertEqual(cmd.args["dx"], 0)

    def test_wheel_zero_dropped(self):
        self.assertIsNone(self._cmd({"t": "wh", "dy": 0.2}))

    def test_wheel_clamped(self):
        cmd = self._cmd({"t": "wh", "dy": 9999})
        self.assertEqual(cmd.args["dy"], protocol.MAX_SCROLL_LINES)

    def test_text_requires_string(self):
        with self.assertRaises(ProtocolError):
            self._cmd({"t": "tx", "s": 123})

    def test_text_too_long(self):
        with self.assertRaises(ProtocolError):
            self._cmd({"t": "tx", "s": "字" * (protocol.MAX_TEXT_CHARS + 1)})

    def test_empty_text_dropped(self):
        self.assertIsNone(self._cmd({"t": "tx", "s": ""}))

    def test_media_requires_string(self):
        with self.assertRaises(ProtocolError):
            self._cmd({"t": "md", "a": 1})

    def test_unknown_type_returns_none(self):
        # 未知类型不能抛，只能忽略，否则前端发错一个字段就断连
        self.assertIsNone(self._cmd({"t": "zzz"}))


class TestEncoders(unittest.TestCase):
    def test_hello_roundtrip(self):
        text = protocol.encode_hello("PC", 2560, 1440, "1.0.0", {"sens": 1.6})
        data = json.loads(text)
        self.assertEqual(data["t"], "hi")
        self.assertEqual(data["w"], 2560)
        self.assertEqual(data["cfg"]["sens"], 1.6)

    def test_pong_carries_seq(self):
        self.assertEqual(json.loads(protocol.encode_pong(7))["n"], 7)

    def test_pong_preserves_none(self):
        self.assertIsNone(json.loads(protocol.encode_pong(None))["n"])

    def test_error_keeps_chinese(self):
        data = json.loads(protocol.encode_error("令牌无效", 4401))
        self.assertEqual(data["m"], "令牌无效")
        self.assertEqual(data["code"], 4401)


if __name__ == "__main__":
    unittest.main()
