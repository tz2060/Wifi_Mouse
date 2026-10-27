"""默认参数测试。

这些数值本身不复杂，但一旦改错，用户看到的是"灵敏度没变"这种
极其模糊的现象——所以把默认值和服务端下发的字段都钉死。

背景：灵敏度默认从 1.6 提到 3.2（提高一倍）。
老用户浏览器里存着旧值，必须在配置版本升级时丢掉，
否则新默认值永远不会生效。
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from remouse import protocol  # noqa: E402
from remouse.config import Settings  # noqa: E402


class TestDefaultSensitivity(unittest.TestCase):
    def test_sensitivity_is_doubled(self):
        self.assertAlmostEqual(Settings().default_sensitivity, 3.2, places=6)

    def test_defaults_are_consistent_across_fields(self):
        s = Settings()
        # 灵敏度是最常调的那个，别被顺手改回去
        self.assertGreater(s.default_sensitivity, 1.6)
        self.assertTrue(s.default_acceleration)
        self.assertFalse(s.default_natural_scroll)


class TestHelloPayload(unittest.TestCase):
    """握手报文必须把前端需要的默认值都带上。"""

    def _cfg(self, settings: Settings) -> dict:
        settings.token = "t"
        from remouse.app import create_app  # noqa: F401  (导入即验证无副作用)

        # 直接构造与 app.py 相同结构的 cfg
        return {
            "sens": settings.default_sensitivity,
            "acc": settings.default_acceleration,
            "nat": settings.default_natural_scroll,
            "three": settings.enable_three_finger,
            "gyro": settings.enable_gyro,
            "gyroMax": settings.gyro_max_speed,
            "gyroMaxY": settings.gyro_max_speed_y,
            "gyroDz": settings.gyro_deadzone,
            "gyroInvX": settings.gyro_invert_x,
            "gyroInvY": settings.gyro_invert_y,
        }

    def test_hello_carries_sensitivity(self):
        s = Settings()
        text = protocol.encode_hello("PC", 2560, 1440, "1.0.0", self._cfg(s))
        cfg = json.loads(text)["cfg"]
        self.assertAlmostEqual(cfg["sens"], 3.2)
        self.assertIn("gyroMaxY", cfg)
        self.assertIn("gyroInvX", cfg)

    def test_hello_keeps_chinese_hostname(self):
        text = protocol.encode_hello("我的电脑", 1920, 1080, "1.0.0", {})
        self.assertEqual(json.loads(text)["host"], "我的电脑")


class TestAppHandshakeUsesSettings(unittest.TestCase):
    """确认 app.py 里真的读的是 settings 的字段，而不是写死的常量。"""

    def test_app_source_reads_settings_sensitivity(self):
        app_path = Path(__file__).resolve().parent.parent / "remouse" / "app.py"
        source = app_path.read_text(encoding="utf-8")
        self.assertIn("settings.default_sensitivity", source)
        # 防止有人把数值直接写死进握手代码
        self.assertNotIn('"sens": 1.6', source)
        self.assertNotIn('"sens": 3.2', source)


class TestFrontendDefaults(unittest.TestCase):
    """前端兜底值必须和服务端一致，否则握手前的那一瞬间会跳一下。"""

    def test_app_js_default_matches_server(self):
        js_path = Path(__file__).resolve().parent.parent / "web" / "app.js"
        source = js_path.read_text(encoding="utf-8")
        self.assertIn("sens: 3.2", source, "前端兜底灵敏度应与服务端一致")
        self.assertNotIn("sens: 1.6", source)

    def test_index_html_slider_matches(self):
        html = (
            Path(__file__).resolve().parent.parent / "web" / "index.html"
        ).read_text(encoding="utf-8")
        self.assertIn('id="sens-val">3.2<', html)
        self.assertIn('value="3.2"', html)
        # 滑块上限必须能容纳默认值，否则控件会显示成被夹住的位置
        self.assertIn('max="6"', html)

    def test_cfg_version_bumped(self):
        js_path = Path(__file__).resolve().parent.parent / "web" / "app.js"
        source = js_path.read_text(encoding="utf-8")
        self.assertIn("const CFG_VERSION = 3", source,
                      "改了默认值必须递增 CFG_VERSION，否则老用户不会生效")

    def test_old_config_drops_sens(self):
        js_path = Path(__file__).resolve().parent.parent / "web" / "app.js"
        source = js_path.read_text(encoding="utf-8")
        self.assertIn("delete state.cfg.sens", source,
                      "版本升级时必须丢掉旧的 sens，让新默认值生效")


if __name__ == "__main__":
    unittest.main()
