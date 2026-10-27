"""令牌与地址探测测试。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from remouse import auth, netinfo  # noqa: E402


class TestToken(unittest.TestCase):
    def test_generate_is_urlsafe_and_long(self):
        token = auth.generate_token()
        self.assertGreaterEqual(len(token), 20)
        self.assertTrue(all(c.isalnum() or c in "-_" for c in token))

    def test_tokens_are_unique(self):
        tokens = {auth.generate_token() for _ in range(200)}
        self.assertEqual(len(tokens), 200)

    def test_load_or_create_persists(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "token"
            first = auth.load_or_create_token(path)
            second = auth.load_or_create_token(path)
            self.assertEqual(first, second)
            self.assertTrue(path.exists())

    def test_rotate_changes_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "token"
            first = auth.load_or_create_token(path)
            second = auth.load_or_create_token(path, rotate=True)
            self.assertNotEqual(first, second)

    def test_corrupted_token_file_is_regenerated(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "token"
            path.write_text("short\n", encoding="utf-8")
            token = auth.load_or_create_token(path)
            self.assertGreaterEqual(len(token), 20)

    def test_matches(self):
        self.assertTrue(auth.token_matches("abc", "abc"))
        self.assertFalse(auth.token_matches("abc", "abd"))
        self.assertFalse(auth.token_matches("abc", ""))
        self.assertFalse(auth.token_matches("abc", None))

    def test_mask_hides_middle(self):
        masked = auth.mask("abcdefghijklmnopqrstuv")
        self.assertIn("…", masked)
        self.assertLess(len(masked), 10)


class TestNetInfo(unittest.TestCase):
    def test_private_detection(self):
        self.assertTrue(netinfo.is_private_ip("192.168.1.10"))
        self.assertTrue(netinfo.is_private_ip("10.0.0.5"))
        self.assertTrue(netinfo.is_private_ip("172.16.0.1"))
        self.assertFalse(netinfo.is_private_ip("8.8.8.8"))
        self.assertFalse(netinfo.is_private_ip("not-an-ip"))

    def test_list_returns_something_or_empty(self):
        entries = netinfo.list_lan_addresses()
        self.assertIsInstance(entries, list)
        for entry in entries:
            self.assertIsInstance(entry.ip, str)

    def test_best_ip_is_string(self):
        self.assertIsInstance(netinfo.best_lan_ip(), str)

    def test_virtual_interfaces_rank_lower(self):
        from remouse.netinfo import LanAddress

        real = LanAddress(ip="10.0.0.2", interface="Wi-Fi", is_virtual=False)
        virt = LanAddress(ip="192.168.56.1", interface="VirtualBox Host-Only", is_virtual=True)
        self.assertLess(real.score, virt.score)

    def test_bindable_on_free_port(self):
        import socket

        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        self.assertTrue(netinfo.assert_bindable("127.0.0.1", port))


if __name__ == "__main__":
    unittest.main()
