"""文件柜 HTTP 接口端到端。

起真服务、真 HTTP 请求，验证上传/列表/下载/删除/鉴权/超限。
命令行：py -3.11 tests/e2e_files.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn

from remouse import auth
from remouse.app import create_app
from remouse.config import Settings
from remouse.hub import Hub
from remouse.input.dryrun import DryRunBackend

HOST = "127.0.0.1"
PASSED = 0
FAILED = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if ok:
        PASSED += 1
        print(f"  OK   {name}")
    else:
        FAILED += 1
        print(f"  FAIL {name}   {detail}")


def free_port() -> int:
    import socket

    with socket.socket() as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def urlq(s: str) -> str:
    """URL 编码非 ASCII 与分隔符。中文文件名必须编码后才能进查询串。"""
    return urllib.parse.quote(s, safe="")


def request(url: str, method: str = "GET", data: bytes | None = None):
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/octet-stream")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main() -> int:
    port = free_port()
    token = auth.generate_token()
    tmpdir = tempfile.TemporaryDirectory()
    root = Path(tmpdir.name) / "files"

    settings = Settings(token=token, dry_run=True, max_file_mb=1)
    settings.files_dir = root

    backend = DryRunBackend()
    hub = Hub(settings, backend)
    app = create_app(settings, hub)

    server = uvicorn.Server(uvicorn.Config(
        app, host=HOST, port=port, log_level="warning",
        ws_ping_interval=None, ws_ping_timeout=None,
    ))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.02)

    base = f"http://{HOST}:{port}"
    print(f"服务已启动：{base}   落地目录：{root}")
    print("=" * 60)

    try:
        print("\n--- 1. 无令牌一律拒绝 ---")
        status, _ = request(base + "/api/files")
        check("列表需令牌", status == 403, f"得到 {status}")

        status, _ = request(base + "/api/files?name=x.txt", "POST", b"x")
        check("上传需令牌", status == 403, f"得到 {status}")

        status, _ = request(base + "/api/files/x.txt")
        check("下载需令牌", status == 403, f"得到 {status}")

        status, _ = request(base + "/api/files/x.txt", "DELETE")
        check("删除需令牌", status == 403, f"得到 {status}")

        print("\n--- 2. 错误令牌也拒绝 ---")
        status, _ = request(base + "/api/files?k=wrongtoken123456")
        check("错误令牌拒绝", status == 403, f"得到 {status}")

        print("\n--- 3. 上传与列表 ---")
        payload = "你好，这是测试内容".encode("utf-8")
        status, body = request(
            base + f"/api/files?name={urlq('测试.txt')}&k={token}", "POST", payload
        )
        data = json.loads(body)
        check("上传成功", status == 200 and data.get("ok"), body[:120])
        check("返回实际文件名", data.get("name") == "测试.txt", str(data))
        check("返回字节数", data.get("size") == len(payload), str(data))

        status, body = request(base + f"/api/files?k={token}")
        listing = json.loads(body)
        names = [f["name"] for f in listing["files"]]
        check("列表含该文件", "测试.txt" in names, str(names))
        check("列表返回总量", listing["total"] >= len(payload), str(listing["total"]))
        check("列表返回上限", listing["maxBytes"] == 1024 * 1024, str(listing.get("maxBytes")))

        print("\n--- 4. 下载内容一致 ---")
        status, got = request(
            base + f"/api/files/{urllib.parse.quote('测试.txt')}?k={token}"
        )
        check("下载成功", status == 200, f"得到 {status}")
        check("内容字节一致", got == payload, f"{len(got)} vs {len(payload)}")

        print("\n--- 5. 路径穿越被挡住 ---")
        for bad in ("../secret.txt", "..%2Fsecret.txt", "a/b/c.txt"):
            status, _ = request(base + f"/api/files/{urllib.parse.quote(bad, safe='')}?k={token}")
            check(f"下载拒绝 {bad}", status in (403, 404), f"得到 {status}")

        print("\n--- 6. 同名不覆盖 ---")
        status, body = request(
            base + f"/api/files?name={urlq('测试.txt')}&k={token}", "POST", b"second"
        )
        data = json.loads(body)
        check("同名追加序号", data.get("name") == "测试 (2).txt", str(data))

        status, got = request(
            base + f"/api/files/{urllib.parse.quote('测试.txt')}?k={token}"
        )
        check("原文件未被覆盖", got == payload, f"{len(got)} 字节")

        print("\n--- 7. 超过上限被拒绝 ---")
        big = b"x" * (1024 * 1024 + 100)   # 上限 1MB
        status, body = request(
            base + f"/api/files?name={urlq('big.bin')}&k={token}", "POST", big
        )
        check("超大文件拒绝", status == 413, f"得到 {status}")
        check("超大文件未落盘", not (root / "big.bin").exists())
        check("临时文件已清理", not (root / "big.bin.part").exists())

        print("\n--- 8. 空文件被拒绝 ---")
        status, body = request(
            base + f"/api/files?name={urlq('empty.txt')}&k={token}", "POST", b""
        )
        check("空文件拒绝", status in (413, 400), f"得到 {status}")

        print("\n--- 9. 删除 ---")
        status, body = request(
            base + f"/api/files/{urllib.parse.quote('测试 (2).txt')}?k={token}",
            "DELETE",
        )
        check("删除成功", status == 200, body[:100])

        status, body = request(base + f"/api/files?k={token}")
        names = [f["name"] for f in json.loads(body)["files"]]
        check("删除后不在列表", "测试 (2).txt" not in names, str(names))

        status, _ = request(
            base + f"/api/files/{urllib.parse.quote('测试.txt')}?k={token}"
        )
        check("原文件仍在", status == 200, f"得到 {status}")

        print("\n--- 10. 页面可访问 ---")
        status, body = request(base + "/files")
        check("文件页 200", status == 200, f"得到 {status}")
        check("页面含上传控件", b"picker" in body)

        status, body = request(base + "/static/files.js")
        check("files.js 可加载", status == 200 and b"XMLHttpRequest" in body)

        status, body = request(base + "/static/files.css")
        check("files.css 可加载", status == 200)

    finally:
        server.should_exit = True
        thread.join(timeout=3)
        hub.shutdown()
        tmpdir.cleanup()

    print("\n" + "=" * 60)
    print(f"通过 {PASSED} 项，失败 {FAILED} 项")
    return 0 if FAILED == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
