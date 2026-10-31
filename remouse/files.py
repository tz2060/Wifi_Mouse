"""局域网文件柜：上传、列表、下载、删除。

设计取舍
--------
不用 multipart 上传，改成"请求体就是文件字节，文件名放在查询串里"：
  - 少一个依赖（python-multipart）
  - 省掉 multipart 解析开销，手机传视频时更省内存
  - 逐块流式写入，整个文件从不完整进内存
代价是一次只能传一个文件；前端串行发多次即可。

安全边界
--------
1. 文件名来自不可信输入，必须归一化。Windows 有一堆坑：
   保留名（CON/NUL/COM1）、非法字符、结尾的点和空格。
2. 只允许纯文件名，不允许任何路径分隔符 —— 这是防目录穿越的核心。
3. 写入用 .part 临时文件 + 原子改名，避免传一半的文件出现在列表里。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

# Windows 保留设备名。这些名字即使在 NTFS 上也无法作为普通文件名创建。
_WIN_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

# Windows 文件名里不允许出现的字符
_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

MAX_NAME_LEN = 120


class FileError(Exception):
    """文件名非法、超限或不存在，都归到这里，由路由层翻译成 4xx。"""


@dataclass
class FileEntry:
    name: str
    size: int
    mtime: float

    def to_dict(self) -> dict:
        return {"name": self.name, "size": self.size, "mtime": self.mtime}


def sanitize_name(raw: str) -> str:
    """把不可信的文件名变成一个能安全落在磁盘上的名字。

    返回的字符串保证：
      - 不含任何路径分隔符（不会逃出目标目录）
      - 不含 Windows 非法字符
      - 不是保留名
      - 不以点或空格结尾（Windows 会静默截掉，导致写进去读不出来）
      - 长度受限
    """
    if not raw:
        raise FileError("文件名为空")

    # 先做 Unicode 归一化，避免同一个名字用不同码位绕过冲突检测
    name = unicodedata.normalize("NFC", raw)

    # 只取最后一段。即使传了 ../../etc/passwd，这里也只剩 passwd。
    # 这一步是防穿越的关键，不能省。
    name = name.replace("\\", "/").split("/")[-1]

    name = _ILLEGAL.sub("_", name).strip()

    # Windows 会静默丢弃结尾的点和空格
    name = name.rstrip(". ")

    if not name or name in {".", ".."}:
        raise FileError("文件名非法")

    # 拆出主干名判断保留名（CON.txt 在 Windows 上同样不可用）
    stem = name.split(".")[0].upper()
    if stem in _WIN_RESERVED:
        name = f"_{name}"

    # 长度限制。按字符数算而不是字节数，中文名会宽松些，
    # 但要给扩展名留出空间
    if len(name) > MAX_NAME_LEN:
        suffix = ""
        if "." in name:
            suffix = "." + name.rsplit(".", 1)[1][:16]
        keep = MAX_NAME_LEN - len(suffix)
        name = name[:keep] + suffix

    return name


class FileStore:
    """管理一个落地目录。所有路径都经过 resolve 校验，不允许逃出根目录。"""

    def __init__(self, root: Path, max_bytes: int) -> None:
        self.root = Path(root)
        self.max_bytes = max_bytes

    def ensure(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    # ---------- 查询 ----------

    def list(self) -> list[FileEntry]:
        self.ensure()
        out: list[FileEntry] = []
        for p in self.root.iterdir():
            try:
                if not p.is_file():
                    continue
                # .part 是上传中的临时文件，不该出现在列表里
                if p.name.endswith(".part"):
                    continue
                st = p.stat()
            except OSError:
                continue
            out.append(FileEntry(name=p.name, size=st.st_size, mtime=st.st_mtime))
        out.sort(key=lambda e: e.mtime, reverse=True)
        return out

    def resolve(self, name: str) -> Path:
        """把名字解析成绝对路径，并确保它确实在 root 内。"""
        safe = sanitize_name(name)
        target = (self.root / safe).resolve()
        root = self.root.resolve()
        # 双保险：sanitize 已经去掉了分隔符，这里再校验一次前缀
        if root != target.parent:
            raise FileError("文件路径非法")
        if not target.is_file():
            raise FileError("文件不存在")
        return target

    def _unique(self, name: str) -> str:
        """同名时追加序号，不覆盖已有文件。"""
        candidate = self.root / name
        if not candidate.exists():
            return name
        stem, dot, ext = name.rpartition(".")
        if not dot:
            stem, ext = name, ""
        else:
            ext = "." + ext
        for i in range(2, 1000):
            alt = f"{stem} ({i}){ext}"
            if not (self.root / alt).exists():
                return alt
        raise FileError("同名文件过多")

    # ---------- 写入 ----------

    def open_for_write(self, raw_name: str) -> tuple[Path, Path, str]:
        """返回 (临时文件, 最终文件, 最终文件名)。

        调用方逐块写临时文件，成功后调 commit，失败调 abort。
        """
        self.ensure()
        safe = sanitize_name(raw_name)
        final_name = self._unique(safe)
        final = self.root / final_name
        # 临时文件用 .part 结尾，列表中会被过滤掉
        tmp = self.root / (final_name + ".part")
        return tmp, final, final_name

    def commit(self, tmp: Path, final: Path) -> None:
        tmp.replace(final)

    def abort(self, tmp: Path) -> None:
        try:
            tmp.unlink()
        except OSError:
            pass

    def delete(self, name: str) -> None:
        target = self.resolve(name)
        target.unlink()

    # ---------- 统计 ----------

    def total_bytes(self) -> int:
        return sum(e.size for e in self.list())


def format_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    for unit in ("KB", "MB", "GB", "TB"):
        n /= 1024.0
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}"
    return f"{n:.1f} TB"
