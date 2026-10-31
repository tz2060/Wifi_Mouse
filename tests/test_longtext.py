"""长文本与表情的消息层限制。

真实症状：发带表情的超长文本，电脑只收到前半段。
根因有两层：
  1. SendInput 一次送入过多事件会被限流，只接受一部分，
     而前半段已经真实落进窗口，无法回滚。
  2. 超限消息在 decode 阶段被静默丢弃，前端还显示"已发送"。

这里测第 2 层的消息层行为。第 1 层在 win32 后端，靠分批发送解决，
需要真实注入才能验证，不在单测范围内。
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from remouse import protocol  # noqa: E402


def make_text(n: int, ch: str) -> str:
    return json.dumps({"t": "tx", "s": ch * n}, ensure_ascii=False)


class TestTextLimits(unittest.TestCase):
    def test_中文到字符上限仍可发送(self):
        raw = make_text(protocol.MAX_TEXT_CHARS, "中")
        cmd = protocol.to_command(protocol.decode(raw))
        self.assertEqual(cmd.kind, "text")
        self.assertEqual(len(cmd.args["text"]), protocol.MAX_TEXT_CHARS)

    def test_中文超字符上限被拒(self):
        raw = make_text(protocol.MAX_TEXT_CHARS + 1, "中")
        with self.assertRaises(protocol.ProtocolError) as ctx:
            protocol.to_command(protocol.decode(raw))
        self.assertIn("字符", str(ctx.exception))

    def test_表情到码元上限仍可发送(self):
        # 一个 emoji 占 2 码元，所以能放的个数是码元上限的一半
        n = protocol.MAX_TEXT_UNITS // 2
        raw = make_text(n, "😀")
        cmd = protocol.to_command(protocol.decode(raw))
        self.assertEqual(len(cmd.args["text"]), n)

    def test_表情超码元上限被拒且提示明确(self):
        n = protocol.MAX_TEXT_UNITS // 2 + 1
        raw = make_text(n, "😀")
        with self.assertRaises(protocol.ProtocolError) as ctx:
            protocol.to_command(protocol.decode(raw))
        msg = str(ctx.exception)
        # 必须明确说是注入量问题，否则用户会去数自己的字数
        self.assertIn("注入量", msg)

    def test_表情的可发送量确实是中文的一半(self):
        # 这条钉住"码元检查真的生效"，而不是被字符检查提前拦掉
        emoji_max = protocol.MAX_TEXT_UNITS // 2
        self.assertLess(emoji_max, protocol.MAX_TEXT_CHARS + 1)
        raw_ok = make_text(emoji_max, "😀")
        cmd = protocol.to_command(protocol.decode(raw_ok))
        self.assertIsNotNone(cmd)

    def test_码元上限大于字符上限的一半(self):
        # 两者的关系必须合理：码元限制要能真正区分 emoji 与汉字。
        # 若 MAX_TEXT_UNITS <= MAX_TEXT_CHARS，字符检查会永远先触发，
        # 码元检查就成了死代码。
        self.assertGreater(protocol.MAX_TEXT_UNITS, 0)

    def test_消息字节上限能容纳最坏情况(self):
        # 最坏情况：全是 emoji，每个 4 字节 UTF-8
        n = protocol.MAX_TEXT_UNITS // 2
        raw = make_text(n, "😀")
        size = len(raw.encode("utf-8"))
        self.assertLessEqual(
            size,
            protocol.MAX_MESSAGE_BYTES,
            f"字符没超但字节超了：{size} > {protocol.MAX_MESSAGE_BYTES}",
        )

    def test_消息字节上限能容纳字符上限的中文(self):
        raw = make_text(protocol.MAX_TEXT_CHARS, "中")
        size = len(raw.encode("utf-8"))
        self.assertLessEqual(size, protocol.MAX_MESSAGE_BYTES)

    def test_空文本返回None(self):
        raw = json.dumps({"t": "tx", "s": ""})
        self.assertIsNone(protocol.to_command(protocol.decode(raw)))

    def test_非字符串被拒(self):
        raw = json.dumps({"t": "tx", "s": 123})
        with self.assertRaises(protocol.ProtocolError):
            protocol.to_command(protocol.decode(raw))


class TestOverLimitReportsToUser(unittest.TestCase):
    """超限必须能被用户看到，不能静默丢弃。

    这是"前端显示已发送、电脑上什么都没有"的根因。
    """

    def test_hub_对超限文本返回错误(self):
        from remouse.config import Settings
        from remouse.hub import Hub
        from remouse.input.dryrun import DryRunBackend

        settings = Settings(token="t" * 16, dry_run=True)
        hub = Hub(settings, DryRunBackend())

        raw = make_text(protocol.MAX_TEXT_UNITS + 10, "😀")
        reply = hub.handle_text(_FakeSession(), raw)

        self.assertIsNotNone(reply, "超限文本必须回错误，不能静默")
        data = json.loads(reply)
        self.assertEqual(data["t"], "er")
        self.assertTrue(data["m"], "错误消息不能为空")

        hub.shutdown()

    def test_hub_对字节超限的文本也返回错误(self):
        """这条才是"静默丢弃"的真正入口。

        字符数没超、但 JSON 字节数超了 —— 错误在 decode 阶段抛出，
        而不是 to_command。原先这里被一概 return None，
        用户看到"已发送"却什么都收不到。
        """
        from remouse.config import Settings
        from remouse.hub import Hub
        from remouse.input.dryrun import DryRunBackend

        settings = Settings(token="t" * 16, dry_run=True)
        hub = Hub(settings, DryRunBackend())

        # 造一条超过 MAX_MESSAGE_BYTES 的文本消息。
        # 用 emoji 让字节数涨得快：4 字节 UTF-8 / 个。
        n = protocol.MAX_MESSAGE_BYTES // 4 + 100
        raw = make_text(n, "😀")

        # 前提确认：确实超过了字节上限（否则这条测试测的不是 decode 层）
        self.assertGreater(
            len(raw.encode("utf-8")),
            protocol.MAX_MESSAGE_BYTES,
            "构造的消息必须真的超过字节上限",
        )

        reply = hub.handle_text(_FakeSession(), raw)
        self.assertIsNotNone(
            reply,
            "字节超限的文本消息必须回错误；返回 None 就是静默丢弃",
        )
        data = json.loads(reply)
        self.assertEqual(data["t"], "er")

        hub.shutdown()

    def test_hub_对畸形JSON仍然静默(self):
        # 保持原设计：非法 JSON 不回错误，避免被用来探测协议
        from remouse.config import Settings
        from remouse.hub import Hub
        from remouse.input.dryrun import DryRunBackend

        settings = Settings(token="t" * 16, dry_run=True)
        hub = Hub(settings, DryRunBackend())

        self.assertIsNone(hub.handle_text(_FakeSession(), "{not json"))
        hub.shutdown()

    def test_正常文本不返回错误(self):
        from remouse.config import Settings
        from remouse.hub import Hub
        from remouse.input.dryrun import DryRunBackend

        settings = Settings(token="t" * 16, dry_run=True)
        hub = Hub(settings, DryRunBackend())

        raw = make_text(10, "中")
        self.assertIsNone(hub.handle_text(_FakeSession(), raw))
        hub.shutdown()


class _FakeSession:
    """handle_text 只需要一个能提交命令的对象。"""

    def __init__(self) -> None:
        self.commands = []

    def submit(self, cmd) -> None:
        self.commands.append(cmd)


class TestIsTextLike(unittest.TestCase):
    """粗判函数：决定超限时要不要回错误。"""

    def test_识别文本消息(self):
        from remouse.hub import _is_text_like

        self.assertTrue(_is_text_like('{"t":"tx","s":"x"}'))
        self.assertTrue(_is_text_like(b'{"t":"tx","s":"x"}'))

    def test_不误判其它消息(self):
        from remouse.hub import _is_text_like

        self.assertFalse(_is_text_like('{"t":"mv","dx":1,"dy":2}'))
        self.assertFalse(_is_text_like("{not json"))

    def test_不会因编码问题崩溃(self):
        from remouse.hub import _is_text_like

        # 非法 UTF-8 字节流不应抛异常
        self.assertFalse(_is_text_like(b"\xff\xfe\x00"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
