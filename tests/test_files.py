"""文件柜：文件名归一化 + 存储层 + HTTP 接口。

重点在安全：文件名来自不可信输入，任何路径穿越都必须被拦住。
命令行：py -3.11 -m unittest tests.test_files -v
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from remouse.files import (  # noqa: E402
    MAX_NAME_LEN,
    FileError,
    FileStore,
    format_size,
    sanitize_name,
)


class TestSanitizeName(unittest.TestCase):
    """文件名归一化。这一层是防目录穿越的第一道也是最重要的一道。"""

    def test_普通文件名原样保留(self):
        self.assertEqual(sanitize_name("photo.jpg"), "photo.jpg")
        self.assertEqual(sanitize_name("文档.pdf"), "文档.pdf")

    def test_去掉所有路径分隔符(self):
        # 不能直接 raises，要把它降级成安全的名字
        for raw in (
            "../../etc/passwd",
            "..\\..\\windows\\system32\\sam",
            "/etc/shadow",
            "a/b/c.txt",
            "C:\\Windows\\notepad.exe",
        ):
            with self.subTest(raw=raw):
                out = sanitize_name(raw)
                self.assertNotIn("/", out)
                self.assertNotIn("\\", out)
                self.assertNotIn("..", out)
                self.assertTrue(len(out) > 0)

    def test_路径穿越只保留最后一段(self):
        self.assertEqual(sanitize_name("../../etc/passwd"), "passwd")
        self.assertEqual(sanitize_name("a/b/c.txt"), "c.txt")

    def test_Windows保留名被前缀修饰(self):
        # CON.txt 在 Windows 上同样不可创建，必须处理主干名
        self.assertEqual(sanitize_name("CON.txt"), "_CON.txt")
        self.assertEqual(sanitize_name("NUL"), "_NUL")
        self.assertEqual(sanitize_name("com1.log"), "_com1.log")

    def test_非法字符被替换(self):
        out = sanitize_name('has:colon?.txt')
        for ch in '<>:"/\\|?*':
            self.assertNotIn(ch, out)

    def test_结尾的点和空格被去掉(self):
        # Windows 会静默丢弃，导致写进去的名字读不出来
        self.assertEqual(sanitize_name("file."), "file")
        self.assertEqual(sanitize_name("file   "), "file")
        self.assertEqual(sanitize_name("a.b..."), "a.b")

    def test_空名与纯点被拒绝(self):
        for raw in ("", "   ", ".", "..", "..."):
            with self.subTest(raw=raw):
                with self.assertRaises(FileError):
                    sanitize_name(raw)

    def test_超长名被截断但保留扩展名(self):
        long_name = "x" * 400 + ".txt"
        out = sanitize_name(long_name)
        self.assertLessEqual(len(out), MAX_NAME_LEN)
        self.assertTrue(out.endswith(".txt"))

    def test_控制字符被清理(self):
        out = sanitize_name("bad\x00name\x1f.txt")
        self.assertNotIn("\x00", out)
        self.assertNotIn("\x1f", out)


class TestFileStore(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tmpdir.name) / "files"
        self.store = FileStore(self.root, max_bytes=1024 * 1024)

    def tearDown(self):
        self.tmpdir.cleanup()

    def _write(self, name: str, data: bytes) -> str:
        tmp, final, final_name = self.store.open_for_write(name)
        tmp.write_bytes(data)
        self.store.commit(tmp, final)
        return final_name

    def test_写入后可列出(self):
        self._write("a.txt", b"hello")
        names = [e.name for e in self.store.list()]
        self.assertIn("a.txt", names)

    def test_列表不含part临时文件(self):
        self._write("done.txt", b"x")
        # 手动造一个未完成的临时文件
        (self.root / "half.bin.part").write_bytes(b"partial")
        names = [e.name for e in self.store.list()]
        self.assertIn("done.txt", names)
        self.assertNotIn("half.bin.part", names)

    def test_同名不覆盖而是追加序号(self):
        first = self._write("dup.txt", b"one")
        second = self._write("dup.txt", b"two")
        self.assertEqual(first, "dup.txt")
        self.assertEqual(second, "dup (2).txt")
        # 原文件内容未被破坏
        self.assertEqual((self.root / "dup.txt").read_bytes(), b"one")

    def test_删除后不可再解析(self):
        self._write("gone.txt", b"x")
        self.store.delete("gone.txt")
        with self.assertRaises(FileError):
            self.store.resolve("gone.txt")

    def test_resolve拒绝逃出根目录(self):
        # 即使 sanitize 被绕过，resolve 还有前缀校验这一道
        self._write("ok.txt", b"x")
        with self.assertRaises(FileError):
            self.store.resolve("../outside.txt")

    def test_resolve不存在的文件报错(self):
        with self.assertRaises(FileError):
            self.store.resolve("nope.txt")

    def test_按修改时间倒序(self):
        import time

        self._write("old.txt", b"1")
        time.sleep(0.02)
        self._write("new.txt", b"2")
        names = [e.name for e in self.store.list()]
        self.assertEqual(names[0], "new.txt")

    def test_总字节数正确(self):
        self._write("a.bin", b"12345")
        self._write("b.bin", b"678")
        self.assertEqual(self.store.total_bytes(), 8)

    def test_根目录自动创建(self):
        self.assertFalse(self.root.exists())
        self.store.list()
        self.assertTrue(self.root.exists())

    def test_中文文件名往返一致(self):
        name = self._write("测试文档.txt", "内容".encode("utf-8"))
        self.assertEqual(name, "测试文档.txt")
        loaded = self.store.resolve("测试文档.txt").read_text(encoding="utf-8")
        self.assertEqual(loaded, "内容")


class TestFormatSize(unittest.TestCase):
    def test_各单位(self):
        self.assertEqual(format_size(0), "0 B")
        self.assertEqual(format_size(512), "512 B")
        self.assertEqual(format_size(1024), "1.0 KB")
        self.assertEqual(format_size(1024 * 1024), "1.0 MB")
        self.assertEqual(format_size(int(1.5 * 1024 ** 3)), "1.5 GB")

    def test_极大值不崩(self):
        self.assertIn("TB", format_size(10 ** 15))


if __name__ == "__main__":
    unittest.main(verbosity=2)
