"""reMouse 启动器。

用法：
    python run.py                  # 默认 8765，自动选可用端口
    python run.py --port 9000
    python run.py --dry-run        # 只记录不注入，用来验证连通性
    python run.py --record         # 把原始消息流写进 .state/messages.jsonl
    python run.py --new-token      # 换令牌，所有已信任设备失效
    python run.py --self-test      # 自检注入链路后退出
"""

from __future__ import annotations

import argparse
import os
import sys

from remouse import __version__, auth, netinfo
from remouse.app import create_app, print_banner
from remouse.config import PORT_SCAN_LIMIT, Settings
from remouse.hub import Hub
from remouse.input import get_backend


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="remouse",
        description="把手机浏览器变成电脑触摸板",
    )
    parser.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    parser.add_argument("--port", type=int, default=None, help="端口（默认 8765，被占用时自动顺延）")
    parser.add_argument("--new-token", action="store_true", help="重新生成令牌")
    parser.add_argument("--dry-run", action="store_true", help="不注入真实输入，只打印意图")
    parser.add_argument("--record", action="store_true", help="记录收到的原始消息到 .state/messages.jsonl")
    parser.add_argument("--allow-public", action="store_true", help="允许在非内网地址上启动")
    parser.add_argument("--bind-localhost", action="store_true", help="只监听 127.0.0.1（手机将无法连接）")
    parser.add_argument("--self-test", action="store_true", help="自检注入链路后退出")
    parser.add_argument(
        "--https",
        action="store_true",
        help="启用 HTTPS（Android 的体感/震动/屏幕常亮需要安全上下文）",
    )
    parser.add_argument(
        "--regen-cert", action="store_true", help="强制重新签发服务器证书"
    )
    parser.add_argument(
        "--gyro", action="store_true", help="启动时默认开体感模式（需 HTTPS）"
    )
    parser.add_argument(
        "--files-dir",
        default=None,
        help="手机上传文件的落地目录（默认 .state/files；也可指向桌面某个文件夹）",
    )
    parser.add_argument(
        "--max-file-mb",
        type=int,
        default=512,
        help="单个文件大小上限，单位 MB（默认 512）",
    )
    parser.add_argument("--version", action="version", version=f"reMouse {__version__}")
    return parser


def _force_utf8_stdio() -> None:
    """让中文日志不乱码。

    这里不能无脑设成 UTF-8：老 conhost 的代码页是 936 时，
    Python 用 GBK 输出反而是对的，强设 UTF-8 才会乱码。
    只在"控制台声明的是 UTF-8，但 Python 选了旧代码页"这种
    PowerShell 7 常见配置下纠正一次。
    """
    if os.environ.get("PYTHONIOENCODING"):
        return  # 用户已显式指定，尊重它

    console_cp = ""
    try:
        import ctypes

        console_cp = str(ctypes.windll.kernel32.GetConsoleOutputCP())
    except Exception:
        return

    if console_cp != "65001":
        return

    for stream in (sys.stdout, sys.stderr):
        enc = (getattr(stream, "encoding", "") or "").lower().replace("-", "")
        if enc in ("utf8", "cp65001"):
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def pick_port(host: str, preferred: int | None) -> int:
    from remouse.config import DEFAULT_PORT

    start = preferred or DEFAULT_PORT
    if netinfo.assert_bindable(host, start):
        return start
    if preferred:
        raise SystemExit(f"端口 {preferred} 已被占用，请换一个或去掉 --port 让程序自动选择")

    for offset in range(1, PORT_SCAN_LIMIT + 1):
        candidate = start + offset
        if netinfo.assert_bindable(host, candidate):
            print(f"[remouse] 端口 {start} 被占用，改用 {candidate}")
            return candidate
    raise SystemExit(f"从 {start} 起连续 {PORT_SCAN_LIMIT} 个端口都被占用")


def main(argv: list[str] | None = None) -> int:
    _force_utf8_stdio()
    args = build_parser().parse_args(argv)

    if args.self_test:
        from remouse.diagnostics import self_test

        return self_test()

    host = "127.0.0.1" if args.bind_localhost else args.host
    port = pick_port(host, args.port)

    settings = Settings(
        host=host,
        port=port,
        dry_run=args.dry_run,
        record=args.record,
        allow_public=args.allow_public,
        use_https=args.https and not args.bind_localhost,
        enable_gyro=args.gyro,
        max_file_mb=max(1, args.max_file_mb),
    )
    if args.files_dir:
        from pathlib import Path as _Path

        settings.files_dir = _Path(args.files_dir).expanduser().resolve()
    settings.ensure_state_dir()
    settings.token = auth.load_or_create_token(
        settings.state_dir / "token", rotate=args.new_token
    )

    # 公网地址拒绝启动：这类服务不该出现在公网上
    primary = netinfo.best_lan_ip()
    if not netinfo.is_private_ip(primary) and not args.allow_public:
        print(f"[remouse] 拒绝启动：检测到的地址 {primary} 不是内网地址。")
        print("          如果确实需要，请加 --allow-public。")
        return 2

    backend = get_backend(dry_run=args.dry_run)
    hub = Hub(settings, backend)
    app = create_app(settings, hub)

    ssl_kwargs = _prepare_https(settings, args)

    print_banner(settings, backend.name)

    # 会话不一致时 SendInput 会"成功但不生效"，启动即告警
    if not args.dry_run:
        from remouse.diagnostics import warn_if_not_interactive

        warn_if_not_interactive()

    import uvicorn

    try:
        uvicorn.run(
            app,
            host=settings.host,
            port=settings.port,
            log_level="warning",
            ws_ping_interval=None,  # 心跳由前端 pg/po 自己做
            ws_ping_timeout=None,
            **ssl_kwargs,
        )
    except KeyboardInterrupt:
        pass
    finally:
        hub.shutdown()
        print("\n[remouse] 已停止")
    return 0


def _prepare_https(settings: Settings, args) -> dict:
    """准备证书；不开 HTTPS 就返回空，让 uvicorn 走明文。"""
    if not settings.use_https:
        return {}

    from remouse import https as https_mod

    try:
        hosts = https_mod.collect_hosts()
        bundle = https_mod.ensure_server_cert(
            settings.cert_dir, hosts, force=args.regen_cert
        )
    except https_mod.CertError as exc:
        print(f"\n[remouse] HTTPS 启用失败：{exc}")
        print("          改用 HTTP 继续启动（体感等功能不可用）。\n")
        settings.use_https = False
        return {}

    lan_ip = netinfo.best_lan_ip()
    https_mod.print_https_help(settings.cert_dir, bundle, settings.port, lan_ip)

    return {
        "ssl_certfile": str(bundle.server_cert),
        "ssl_keyfile": str(bundle.server_key),
    }


if __name__ == "__main__":
    sys.exit(main())
