"""组合键解析测试。

这里最容易出错的是状态：修饰键没抬起、Shift 没带上、
方向键漏了 EXTENDEDKEY 被当成小键盘数字。规则集中在这层，
两个注入后端共用同一份解析结果。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from remouse import keyboard_map  # noqa: E402
from remouse.keyboard_map import ComboError  # noqa: E402


class TestParseCombo(unittest.TestCase):
    def names(self, combo):
        return [t.name for t in keyboard_map.parse_combo(combo)]

    def test_single_letter(self):
        tokens = keyboard_map.parse_combo("t")
        self.assertEqual(tokens[0].vk, ord("T"))
        self.assertFalse(tokens[0].is_modifier)

    def test_uppercase_normalized(self):
        self.assertEqual(self.names("CTRL+SHIFT+T"), ["ctrl", "shift", "t"])

    def test_named_keys(self):
        self.assertEqual(keyboard_map.parse_combo("enter")[0].vk, 0x0D)
        self.assertEqual(keyboard_map.parse_combo("escape")[0].name, "escape")
        self.assertEqual(keyboard_map.parse_combo("f5")[0].vk, 0x74)
        self.assertEqual(keyboard_map.parse_combo("f24")[0].vk, 0x87)

    def test_function_key_out_of_range(self):
        with self.assertRaises(ComboError):
            keyboard_map.parse_combo("f25")

    def test_aliases_collapse(self):
        self.assertEqual(keyboard_map.parse_combo("cmd+t")[0].name, "win")
        self.assertEqual(keyboard_map.parse_combo("control+t")[0].name, "ctrl")
        self.assertEqual(keyboard_map.parse_combo("option+t")[0].name, "alt")

    def test_modifiers_sorted_first(self):
        # 修饰键必须排在前，否则按下顺序是错的
        self.assertEqual(self.names("t+ctrl"), ["ctrl", "t"])
        self.assertEqual(self.names("shift+alt+win+t"), ["shift", "alt", "win", "t"])

    def test_duplicate_modifier_rejected(self):
        with self.assertRaises(ComboError):
            keyboard_map.parse_combo("ctrl+control+t")

    def test_only_modifiers_allowed(self):
        tokens = keyboard_map.parse_combo("ctrl")
        self.assertEqual(len(tokens), 1)
        self.assertTrue(tokens[0].is_modifier)

    def test_empty_rejected(self):
        for bad in ["", "   ", None, 123]:
            with self.assertRaises(ComboError):
                keyboard_map.parse_combo(bad)

    def test_empty_segment_rejected(self):
        with self.assertRaises(ComboError):
            keyboard_map.parse_combo("ctrl++t")

    def test_too_many_tokens(self):
        # 上限 6 个片段；刚好 6 个应通过，7 个拒绝
        self.assertEqual(len(keyboard_map.parse_combo("ctrl+shift+alt+win+t+f1")), 6)
        with self.assertRaises(ComboError):
            keyboard_map.parse_combo("ctrl+shift+alt+win+t+f1+f2")

    def test_unknown_key_rejected(self):
        for bad in ["ctrl+frobnicate", "ctrl+ab"]:
            with self.assertRaises(ComboError):
                keyboard_map.parse_combo(bad)

    def test_symbol_shifts(self):
        # '?' 需要 Shift，'/' 不需要，两者共用同一个 VK
        q = keyboard_map.parse_combo("?")[0]
        s = keyboard_map.parse_combo("/")[0]
        self.assertEqual(q.vk, s.vk)
        self.assertTrue(q.shift)
        self.assertFalse(s.shift)

    def test_digit_and_letters(self):
        self.assertEqual(keyboard_map.parse_combo("9")[0].vk, ord("9"))
        self.assertFalse(keyboard_map.parse_combo("9")[0].shift)

    def test_canonical_roundtrip(self):
        self.assertEqual(keyboard_map.canonical("CMD+T"), "win+t")
        self.assertEqual(keyboard_map.canonical("ctrl+shift+t"), "ctrl+shift+t")


class TestExtendedKeys(unittest.TestCase):
    """方向键和 Delete 必须标成扩展键，否则会被当小键盘。"""

    def test_navigation_vks(self):
        for name, vk in [
            ("up", 0x26),
            ("down", 0x28),
            ("left", 0x25),
            ("right", 0x27),
            ("delete", 0x2E),
            ("home", 0x24),
            ("end", 0x23),
            ("pageup", 0x21),
            ("pagedown", 0x22),
        ]:
            self.assertEqual(keyboard_map.parse_combo(name)[0].vk, vk)


class TestMedia(unittest.TestCase):
    def test_known_actions(self):
        for action in ["pp", "ng", "pv", "vu", "vd", "mu"]:
            self.assertIsInstance(keyboard_map.media_vk(action), int)

    def test_unknown_action(self):
        with self.assertRaises(ComboError):
            keyboard_map.media_vk("boom")

    def test_distinct_vks(self):
        vks = {keyboard_map.media_vk(a) for a in keyboard_map.MEDIA_ACTIONS}
        self.assertEqual(len(vks), len(keyboard_map.MEDIA_ACTIONS))


if __name__ == "__main__":
    unittest.main()
