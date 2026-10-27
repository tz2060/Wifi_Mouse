"""运行时配置：端口、令牌、灵敏度等。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_PORT = 8765
PORT_SCAN_LIMIT = 20

# 状态目录（令牌、记录的原始消息流都放这里）
STATE_DIR = Path(__file__).resolve().parent.parent / ".state"
TOKEN_FILE = STATE_DIR / "token"

# 证书目录（根证书 + 服务器证书）
CERT_DIR = STATE_DIR / "certs"


@dataclass
class Settings:
    """一次进程的生命周期内不变的设置。"""

    host: str = "0.0.0.0"
    port: int = DEFAULT_PORT
    token: str = ""
    dry_run: bool = False
    record: bool = False
    allow_public: bool = False
    state_dir: Path = field(default_factory=lambda: STATE_DIR)

    # HTTPS：Android 只在安全上下文里提供陀螺仪、震动、屏幕常亮
    use_https: bool = False
    cert_dir: Path = field(default_factory=lambda: CERT_DIR)

    # 前端默认值，握手时下发，手机端可覆盖
    # 灵敏度：1.0 时手指滑 100px 光标走 100px。手机上单次滑动行程有限，
    # 默认给 3.2 让一次滑动覆盖更远；嫌快可在设置面板往下调。
    default_sensitivity: float = 3.2
    default_acceleration: bool = True
    default_natural_scroll: bool = False
    enable_three_finger: bool = False
    enable_gyro: bool = False
    gyro_max_speed: int = 1600       # 水平满速 px/s
    gyro_max_speed_y: int = 2600     # 垂直满速，屏幕上下来回幅度小于左右，给高一些
    gyro_deadzone: float = 4.0
    # 手机竖持时两轴方向都反，默认都翻转；用户可在面板里改
    gyro_invert_x: bool = True
    gyro_invert_y: bool = True

    # 合帧调度参数
    move_interval_ms: int = 8
    heartbeat_timeout_s: float = 20.0

    @property
    def record_file(self) -> Path:
        return self.state_dir / "messages.jsonl"

    def ensure_state_dir(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}
