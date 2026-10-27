"""令牌鉴权。

局域网里放一个能控制鼠标键盘的服务，等于把电脑交出去。
最小可行的防护：一个不可猜的令牌，握手必须携带。
令牌落盘，重启后不变，手机只需扫码一次。
"""

from __future__ import annotations

import hmac
import secrets
from pathlib import Path

TOKEN_BYTES = 16  # -> 22 字符 base64url


def generate_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def load_or_create_token(path: Path, rotate: bool = False) -> str:
    if rotate or not path.exists():
        token = generate_token()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(token + "\n", encoding="utf-8")
        _restrict_permissions(path)
        return token

    token = path.read_text(encoding="utf-8").strip()
    if len(token) < 16:
        # 文件被改坏，重新生成比继续用弱令牌安全
        return load_or_create_token(path, rotate=True)
    return token


def _restrict_permissions(path: Path) -> None:
    """Windows 上把文件权限收紧到仅当前用户。失败不致命。"""
    try:
        import subprocess
        import getpass

        user = getpass.getuser()
        subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
            capture_output=True,
            timeout=5,
            check=False,
        )
    except Exception:
        pass


def token_matches(expected: str, provided: str) -> bool:
    """定长比较，避免时序侧信道。"""
    if not provided:
        return False
    return hmac.compare_digest(expected, provided)


def mask(token: str) -> str:
    if len(token) <= 6:
        return "*" * len(token)
    return f"{token[:3]}…{token[-2:]}"
