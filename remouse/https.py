"""本地 HTTPS 证书。

为什么需要这个：
  Chrome for Android 只在安全上下文（HTTPS 或 localhost）里提供
  DeviceMotionEvent。服务跑在 http://10.x.x.x:8765 时，传感器事件
  监听器能注册成功，但一个事件都不会来——静默失败，没有任何报错。

  同样受影响的还有 navigator.vibrate（触觉反馈）和 wakeLock（屏幕常亮）。

做法：
  生成一个本地根证书（CA），再用它签发服务器证书。手机装上根证书后，
  Chrome 就会信任这个地址，不再有警告，传感器数据也能拿到。

  这就是 mkcert 的思路，只是用 Python 自己实现，不额外装工具。

为什么不用纯自签证书：
  自签证书每次访问都会警告，而且 Chrome 会把它当成不可信，
  部分 API 仍然不开放。装一次根证书反而更省事。
"""

from __future__ import annotations

import datetime
import hashlib
import ipaddress
import json
import socket
import sys
from dataclasses import dataclass
from pathlib import Path

CA_CERT_NAME = "remouse-ca.crt"
CA_KEY_NAME = "remouse-ca.key"
SERVER_CERT_NAME = "server.crt"
SERVER_KEY_NAME = "server.key"
SAN_META_NAME = "san.json"

CA_VALID_DAYS = 3650
SERVER_VALID_DAYS = 825  # 超过 825 天浏览器会判定为长期证书而拒绝


class CertError(RuntimeError):
    """证书生成失败。"""


@dataclass
class CertBundle:
    ca_cert: Path
    server_cert: Path
    server_key: Path
    hosts: tuple[str, ...]
    regenerated: bool

    @property
    def exists(self) -> bool:
        return self.server_cert.exists() and self.server_key.exists()


def _require_cryptography():
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    except ImportError as exc:  # pragma: no cover
        raise CertError(
            "生成证书需要 cryptography 库。请安装：\n"
            "    py -3.11 -m pip install cryptography"
        ) from exc
    return x509, hashes, serialization, rsa, NameOID, ExtendedKeyUsageOID


def collect_hosts(extra: list[str] | None = None) -> tuple[str, ...]:
    """收集要写进证书 SAN 的主机名与 IP。

    局域网 IP 会变（换 Wi-Fi、DHCP 重新分配），所以每次启动都要重新算，
    变了就重签服务器证书。
    """
    hosts: list[str] = ["localhost", "127.0.0.1", "::1"]
    try:
        hostname = socket.gethostname()
        if hostname:
            hosts.append(hostname)
            hosts.append(f"{hostname}.local")
    except Exception:
        pass

    try:
        from . import netinfo

        for entry in netinfo.list_lan_addresses():
            hosts.append(entry.ip)
    except Exception:
        pass

    if extra:
        hosts.extend(extra)

    # 去重保序
    seen = set()
    unique = []
    for host in hosts:
        if host and host not in seen:
            seen.add(host)
            unique.append(host)
    return tuple(unique)


def _write_key(path: Path, key, serialization) -> None:
    path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    _lock_down(path)


def _lock_down(path: Path) -> None:
    """私钥只留给当前用户。失败不致命。"""
    if sys.platform != "win32":
        try:
            path.chmod(0o600)
        except Exception:
            pass
        return
    try:
        import getpass
        import subprocess

        user = getpass.getuser()
        subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
            capture_output=True,
            timeout=5,
            check=False,
        )
    except Exception:
        pass


def build_ca(cert_dir: Path, x509, hashes, serialization, rsa, NameOID, EKOU) -> tuple[Path, Path]:
    """生成根证书（如果还没有）。"""
    ca_cert_path = cert_dir / CA_CERT_NAME
    ca_key_path = cert_dir / CA_KEY_NAME

    if ca_cert_path.exists() and ca_key_path.exists():
        return ca_cert_path, ca_key_path

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "reMouse Local CA"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "reMouse"),
            x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "Local development"),
        ]
    )
    now = datetime.datetime.now(datetime.timezone.utc)

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=CA_VALID_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    ca_cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    _write_key(ca_key_path, key, serialization)
    return ca_cert_path, ca_key_path


def _san_fingerprint(hosts: tuple[str, ...]) -> str:
    joined = "|".join(sorted(hosts))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


def _load_ca(ca_cert_path: Path, ca_key_path: Path, serialization):
    from cryptography import x509

    ca_cert = x509.load_pem_x509_certificate(ca_cert_path.read_bytes())
    ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
    return ca_cert, ca_key


def ensure_server_cert(cert_dir: Path, hosts: tuple[str, ...], force: bool = False) -> CertBundle:
    """确保服务器证书存在且覆盖当前的主机名/IP 集合。"""
    x509, hashes, serialization, rsa, NameOID, EKOU = _require_cryptography()

    # 无论如何都带上回环地址：本机自测走 127.0.0.1，
    # 少了它，电脑自己打开页面就会报证书不匹配。
    merged = list(hosts)
    for loopback in ("localhost", "127.0.0.1"):
        if loopback not in merged:
            merged.append(loopback)
    hosts = tuple(merged)

    cert_dir.mkdir(parents=True, exist_ok=True)
    ca_cert_path, ca_key_path = build_ca(
        cert_dir, x509, hashes, serialization, rsa, NameOID, EKOU
    )

    server_cert_path = cert_dir / SERVER_CERT_NAME
    server_key_path = cert_dir / SERVER_KEY_NAME
    meta_path = cert_dir / SAN_META_NAME

    fingerprint = _san_fingerprint(hosts)
    stale = True
    if not force and server_cert_path.exists() and server_key_path.exists() and meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            stale = meta.get("fingerprint") != fingerprint
        except Exception:
            stale = True

    if not stale:
        return CertBundle(
            ca_cert=ca_cert_path,
            server_cert=server_cert_path,
            server_key=server_key_path,
            hosts=hosts,
            regenerated=False,
        )

    ca_cert, ca_key = _load_ca(ca_cert_path, ca_key_path, serialization)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.datetime.now(datetime.timezone.utc)

    san_entries: list = []
    for host in hosts:
        try:
            san_entries.append(x509.IPAddress(ipaddress.ip_address(host)))
        except ValueError:
            san_entries.append(x509.DNSName(host))

    cert = (
        x509.CertificateBuilder()
        .subject_name(
            x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "reMouse")])
        )
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=SERVER_VALID_DAYS))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .add_extension(
            x509.ExtendedKeyUsage([EKOU.SERVER_AUTH]), critical=False
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_cert.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    server_cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    _write_key(server_key_path, key, serialization)
    meta_path.write_text(
        json.dumps(
            {"fingerprint": fingerprint, "hosts": list(hosts)}, ensure_ascii=False, indent=2
        ),
        encoding="utf-8",
    )

    return CertBundle(
        ca_cert=ca_cert_path,
        server_cert=server_cert_path,
        server_key=server_key_path,
        hosts=hosts,
        regenerated=True,
    )


def ca_fingerprint(ca_cert_path: Path) -> str:
    """给用户核对用的 CA 指纹（SHA-256，冒号分隔）。"""
    try:
        data = ca_cert_path.read_bytes()
        digest = hashlib.sha256(data).hexdigest().upper()
        return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))
    except Exception:
        return ""


def print_https_help(cert_dir: Path, bundle: CertBundle, port: int, lan_ip: str) -> None:
    fp = ca_fingerprint(bundle.ca_cert)
    print()
    print("-" * 64)
    print("  HTTPS 已启用")
    print("-" * 64)
    print(f"  服务器证书 : {bundle.server_cert.name}")
    print(f"  根证书     : {bundle.ca_cert}")
    if bundle.regenerated:
        print("  （证书已按当前 IP 重新签发）")
    print()
    print("  Android 上安装根证书（只需一次）：")
    print()
    print("  1. 手机浏览器打开下面这个地址下载证书：")
    print(f"       https://{lan_ip}:{port}/ca.crt")
    print("     （第一次会提示不安全，选「继续前往」）")
    print()
    print("  2. 系统设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书")
    print("     选择刚下载的 remouse-ca.crt")
    print()
    print("  3. Android 会弹出警告，确认后输入锁屏密码即可")
    print()
    print("  4. 回到浏览器，重新打开下面的地址，应当没有警告：")
    print(f"       https://{lan_ip}:{port}/?k=...")
    print()
    if fp:
        print(f"  证书指纹（可选核对）: {fp[:29]}…")
        print()
    print("  备注：装好之后，体感、震动反馈、屏幕常亮这些需要")
    print("       安全上下文的 API 才会真正生效。")
    print("-" * 64)
    print()
