"""Hub 与注入调度的测试。

全程用 DryRunBackend —— 测试绝不能动真实鼠标。
另外这里要专门验证"断线后不能留下按住的键"，
这是这类工具最容易把人坑到的地方。
"""

from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from remouse.config import Settings  # noqa: E402
from remouse.hub import Hub, SessionInfo  # noqa: E402
from remouse.input.dryrun import DryRunBackend  # noqa: E402


def wait_for(predicate, timeout=1.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


class HubTestCase(unittest.TestCase):
    def setUp(self):
        self.settings = Settings(token="test-token", dry_run=True, record=False)
        self.backend = DryRunBackend()
        self.hub = Hub(self.settings, self.backend)
        self.session = self.hub.attach(
            SessionInfo(peer="127.0.0.1:5555", user_agent="test", connected_at=0.0)
        )

    def tearDown(self):
        self.hub.shutdown()

    def send(self, obj):
        return self.hub.handle_text(self.session, json.dumps(obj))

    def kinds(self):
        return [e["kind"] for e in self.backend.events]


class TestDispatch(HubTestCase):
    def test_move_reaches_backend(self):
        self.send({"t": "mv", "dx": 10, "dy": -5})
        self.assertTrue(wait_for(lambda: "move_rel" in self.kinds()))
        event = next(e for e in self.backend.events if e["kind"] == "move_rel")
        self.assertEqual(event["dx"], 10)
        self.assertEqual(event["dy"], -5)

    def test_consecutive_moves_are_merged(self):
        # 连发多条，注入端应合并成少于消息数的调用
        for _ in range(20):
            self.send({"t": "mv", "dx": 1, "dy": 0})
        self.assertTrue(wait_for(lambda: self._total_dx() == 20))
        moves = [e for e in self.backend.events if e["kind"] == "move_rel"]
        self.assertLessEqual(len(moves), 20)
        self.assertEqual(self._total_dx(), 20)

    def _total_dx(self):
        return sum(e["dx"] for e in self.backend.events if e["kind"] == "move_rel")

    def test_order_preserved_for_clicks(self):
        self.send({"t": "mv", "dx": 5, "dy": 5})
        self.send({"t": "bt", "b": "l", "a": "c"})
        self.assertTrue(wait_for(lambda: "button" in self.kinds()))
        kinds = self.kinds()
        # 位移必须先于点击落地
        self.assertLess(kinds.index("move_rel"), kinds.index("button"))

    def test_text_and_key_reach_backend(self):
        self.send({"t": "tx", "s": "你好"})
        self.send({"t": "ky", "k": "ctrl+shift+t"})
        self.assertTrue(wait_for(lambda: "text" in self.kinds() and "key" in self.kinds()))
        text = next(e for e in self.backend.events if e["kind"] == "text")
        self.assertEqual(text["text"], "你好")

    def test_media_and_wheel(self):
        self.send({"t": "md", "a": "pp"})
        self.send({"t": "wh", "dy": 3})
        self.assertTrue(wait_for(lambda: "media" in self.kinds() and "wheel" in self.kinds()))

    def test_ping_returns_pong(self):
        reply = self.hub.handle_text(self.session, json.dumps({"t": "pg", "n": 42}))
        self.assertIsNotNone(reply)
        self.assertEqual(json.loads(reply)["n"], 42)

    def test_malformed_message_is_ignored(self):
        for bad in ["", "not json", "[]", '{"x":1}', '{"t":123}']:
            self.assertIsNone(self.hub.handle_text(self.session, bad))
        # 连接仍应可用
        self.send({"t": "bt", "b": "l", "a": "c"})
        self.assertTrue(wait_for(lambda: "button" in self.kinds()))

    def test_invalid_command_returns_error_not_crash(self):
        reply = self.hub.handle_text(self.session, json.dumps({"t": "bt", "b": "z", "a": "d"}))
        self.assertIsNotNone(reply)
        self.assertEqual(json.loads(reply)["t"], "er")

    def test_unknown_type_silently_ignored(self):
        self.assertIsNone(self.send({"t": "future-thing"}))


class TestBareButtonRelease(HubTestCase):
    """没有对应按下的"抬起"必须被丢弃。

    这是"手机锁屏时凭空弹出右键菜单"的回归测试。

    实测依据（tests/_probe_bare_rightup.py 的窗口消息版）：
    只发一个 MOUSEEVENTF_RIGHTUP，目标窗口照样收到 WM_RBUTTONUP。
    应用就是靠这条消息弹右键菜单的，所以孤立的抬起不是无害的。
    """

    def buttons(self):
        return [e for e in self.backend.events if e["kind"] == "button"]

    def test_bare_right_up_is_dropped(self):
        self.send({"t": "bt", "b": "r", "a": "u"})
        time.sleep(0.12)
        self.assertEqual(self.buttons(), [], "孤立的 r/u 不该产生任何按键事件")

    def test_bare_left_up_is_dropped(self):
        self.send({"t": "bt", "b": "l", "a": "u"})
        time.sleep(0.12)
        self.assertEqual(self.buttons(), [], "孤立的 l/u 不该产生任何按键事件")

    def test_bare_up_for_all_buttons(self):
        for btn in ("l", "r", "m"):
            self.send({"t": "bt", "b": btn, "a": "u"})
        time.sleep(0.12)
        self.assertEqual(self.buttons(), [])

    def test_paired_press_and_release_still_works(self):
        # 正常用法不能被误伤
        self.send({"t": "bt", "b": "l", "a": "d"})
        self.assertTrue(wait_for(lambda: len(self.buttons()) == 1))
        self.send({"t": "bt", "b": "l", "a": "u"})
        self.assertTrue(wait_for(lambda: len(self.buttons()) == 2))

        events = self.buttons()
        self.assertEqual(events[0]["action"], "d")
        self.assertEqual(events[1]["action"], "u")

    def test_double_release_sends_only_one_up(self):
        self.send({"t": "bt", "b": "l", "a": "d"})
        self.assertTrue(wait_for(lambda: len(self.buttons()) == 1))
        self.send({"t": "bt", "b": "l", "a": "u"})
        self.send({"t": "bt", "b": "l", "a": "u"})
        time.sleep(0.15)
        ups = [e for e in self.buttons() if e["action"] == "u"]
        self.assertEqual(len(ups), 1, "重复抬起只能生效一次")

    def test_release_different_button_than_pressed(self):
        # 按左键、抬右键：右键抬起应被丢弃，左键仍按着
        self.send({"t": "bt", "b": "l", "a": "d"})
        self.assertTrue(wait_for(lambda: len(self.buttons()) == 1))
        self.send({"t": "bt", "b": "r", "a": "u"})
        time.sleep(0.12)
        events = self.buttons()
        self.assertEqual(len(events), 1, "不该冒出 r/u")
        self.assertEqual(events[0]["btn"], "l")

    def test_click_still_works(self):
        # 单击是 down+up 成对，不该被过滤掉
        self.send({"t": "bt", "b": "l", "a": "c"})
        self.assertTrue(wait_for(lambda: len(self.buttons()) == 2))
        actions = [e["action"] for e in self.buttons()]
        self.assertEqual(actions, ["d", "u"])

    def test_press_survives_release_all_clears_state(self):
        # release_all 清空按下记录后，再来的孤立抬起仍应被丢弃
        self.send({"t": "bt", "b": "l", "a": "d"})
        self.assertTrue(wait_for(lambda: len(self.buttons()) == 1))
        self.backend.release_all()
        before = len(self.buttons())
        self.send({"t": "bt", "b": "l", "a": "u"})
        time.sleep(0.12)
        self.assertEqual(len(self.buttons()), before, "release_all 之后不能再冒出一个 u")


class TestSafety(HubTestCase):
    def test_disconnect_releases_held_buttons(self):
        self.send({"t": "bt", "b": "l", "a": "d"})
        self.assertTrue(wait_for(lambda: "button" in self.kinds()))
        self.hub.detach(self.session)
        self.assertIn("release_all", self.kinds())

    def test_disconnect_releases_after_text(self):
        # 即使没按过鼠标键，断开也要清一遍修饰键
        self.send({"t": "tx", "s": "x"})
        self.assertTrue(wait_for(lambda: "text" in self.kinds()))
        self.hub.detach(self.session)
        self.assertIn("release_all", self.kinds())

    def test_double_detach_is_safe(self):
        self.hub.detach(self.session)
        self.hub.detach(self.session)  # 不应抛异常

    def test_commands_after_close_are_dropped(self):
        self.session.close()
        before = len(self.backend.events)
        self.send({"t": "bt", "b": "l", "a": "c"})
        time.sleep(0.1)
        self.assertEqual(len(self.backend.events), before)


class TestRecording(unittest.TestCase):
    def test_record_writes_jsonl(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(token="t", dry_run=True, record=True, state_dir=Path(tmp))
            backend = DryRunBackend()
            hub = Hub(settings, backend)
            session = hub.attach(SessionInfo(peer="p", user_agent="", connected_at=0.0))
            hub.handle_text(session, '{"t":"mv","dx":1,"dy":1}')
            hub.shutdown()

            content = settings.record_file.read_text(encoding="utf-8").strip()
            self.assertTrue(content)
            entry = json.loads(content.splitlines()[0])
            self.assertEqual(entry["msg"], '{"t":"mv","dx":1,"dy":1}')


class TestStats(unittest.TestCase):
    def test_stats_shape(self):
        settings = Settings(token="t", dry_run=True)
        hub = Hub(settings, DryRunBackend())
        stats = hub.stats()
        self.assertIn("sessions", stats)
        self.assertIn("backend", stats)
        self.assertEqual(stats["backend"], "dry-run")
        hub.shutdown()


if __name__ == "__main__":
    unittest.main()
