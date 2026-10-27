"""HTTPS 证书测试。

这里要验证的关键点不是"能不能生成文件"，而是：
  - 证书真的能被 OpenSSL 加载（否则 uvicorn 启动时才炸）；
  - SAN 里确实包含局域网 IP（否则手机上还是报警告）；
  - IP 变了会自动重签（换 Wi-Fi 后不重签等于白装）。
"""

from __future__ import annotations

import ssl
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from remouse import https  # noqa: E402


def crypto_available() -> bool:
    try:
        import cryptography  # noqa: F401

        return True
    except ImportError:
        return False


@unittest.skipUnless(crypto_available(), "需要 cryptography")
class TestCertGeneration(unittest.TestCase):
    def test_generates_loadable_cert(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle = https.ensure_server_cert(Path(tmp), ("localhost", "127.0.0.1"))
            self.assertTrue(bundle.server_cert.exists())
            self.assertTrue(bundle.server_key.exists())
            self.assertTrue(bundle.ca_cert.exists())

            # 关键：uvicorn 会调这个，加载失败就等于起不来
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(
                certfile=str(bundle.server_cert), keyfile=str(bundle.server_key)
            )

    def test_san_contains_ip(self):
        from cryptography import x509

        with tempfile.TemporaryDirectory() as tmp:
            bundle = https.ensure_server_cert(
                Path(tmp), ("localhost", "10.1.2.3", "myhost")
            )
            cert = x509.load_pem_x509_certificate(bundle.server_cert.read_bytes())
            san = cert.extensions.get_extension_for_class(
                x509.SubjectAlternativeName
            ).value

            ips = {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}
            names = set(san.get_values_for_type(x509.DNSName))

            self.assertIn("10.1.2.3", ips)
            self.assertIn("127.0.0.1", ips)
            self.assertIn("localhost", names)
            self.assertIn("myhost", names)

    def test_reuses_cert_when_hosts_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            hosts = ("localhost", "127.0.0.1")
            first = https.ensure_server_cert(Path(tmp), hosts)
            self.assertTrue(first.regenerated)
            second = https.ensure_server_cert(Path(tmp), hosts)
            self.assertFalse(second.regenerated, "主机没变不该重签")
            self.assertEqual(
                first.server_cert.read_bytes(), second.server_cert.read_bytes()
            )

    def test_regenerates_when_ip_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            dir_path = Path(tmp)
            https.ensure_server_cert(dir_path, ("localhost", "10.0.0.1"))
            changed = https.ensure_server_cert(dir_path, ("localhost", "10.0.0.2"))
            self.assertTrue(changed.regenerated, "IP 变了必须重签")

            from cryptography import x509

            cert = x509.load_pem_x509_certificate(changed.server_cert.read_bytes())
            san = cert.extensions.get_extension_for_class(
                x509.SubjectAlternativeName
            ).value
            ips = {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}
            self.assertIn("10.0.0.2", ips)
            self.assertNotIn("10.0.0.1", ips)

    def test_force_regenerates(self):
        with tempfile.TemporaryDirectory() as tmp:
            hosts = ("localhost",)
            https.ensure_server_cert(Path(tmp), hosts)
            forced = https.ensure_server_cert(Path(tmp), hosts, force=True)
            self.assertTrue(forced.regenerated)

    def test_reuses_ca_across_regenerations(self):
        with tempfile.TemporaryDirectory() as tmp:
            dir_path = Path(tmp)
            first = https.ensure_server_cert(dir_path, ("localhost", "10.0.0.1"))
            ca_before = first.ca_cert.read_bytes()
            second = https.ensure_server_cert(dir_path, ("localhost", "10.0.0.2"))
            self.assertEqual(
                ca_before, second.ca_cert.read_bytes(), "CA 不能被重签，否则手机上已装的要重装"
            )

    def test_cert_is_actually_signed_by_ca(self):
        from cryptography import x509

        with tempfile.TemporaryDirectory() as tmp:
            bundle = https.ensure_server_cert(Path(tmp), ("localhost", "127.0.0.1"))
            ca = x509.load_pem_x509_certificate(bundle.ca_cert.read_bytes())
            server = x509.load_pem_x509_certificate(bundle.server_cert.read_bytes())
            self.assertEqual(server.issuer, ca.subject)

            # 用 CA 公钥验签
            from cryptography.hazmat.primitives.asymmetric import padding

            ca.public_key().verify(
                server.signature,
                server.tbs_certificate_bytes,
                padding.PKCS1v15(),
                server.signature_hash_algorithm,
            )

    def test_validity_window_within_browser_limits(self):
        from cryptography import x509

        with tempfile.TemporaryDirectory() as tmp:
            bundle = https.ensure_server_cert(Path(tmp), ("localhost",))
            cert = x509.load_pem_x509_certificate(bundle.server_cert.read_bytes())
            days = (cert.not_valid_after_utc - cert.not_valid_before_utc).days
            # Chrome 要求服务器证书不超过 825 天
            self.assertLessEqual(days, 826)

    def test_server_cert_has_server_auth_eku(self):
        from cryptography import x509
        from cryptography.x509.oid import ExtendedKeyUsageOID

        with tempfile.TemporaryDirectory() as tmp:
            bundle = https.ensure_server_cert(Path(tmp), ("localhost",))
            cert = x509.load_pem_x509_certificate(bundle.server_cert.read_bytes())
            eku = cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
            self.assertIn(ExtendedKeyUsageOID.SERVER_AUTH, eku)


@unittest.skipUnless(crypto_available(), "需要 cryptography")
class TestHelpers(unittest.TestCase):
    def test_collect_hosts_includes_loopback(self):
        hosts = https.collect_hosts()
        self.assertIn("localhost", hosts)
        self.assertIn("127.0.0.1", hosts)

    def test_collect_hosts_dedupes(self):
        hosts = https.collect_hosts(extra=["10.9.9.9", "10.9.9.9", "localhost"])
        self.assertEqual(hosts.count("10.9.9.9"), 1)
        self.assertEqual(hosts.count("localhost"), 1)

    def test_fingerprint_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle = https.ensure_server_cert(Path(tmp), ("localhost",))
            fp = https.ca_fingerprint(bundle.ca_cert)
            parts = fp.split(":")
            self.assertEqual(len(parts), 32)
            self.assertTrue(all(len(p) == 2 for p in parts))

    def test_fingerprint_missing_file(self):
        self.assertEqual(https.ca_fingerprint(Path("nope/none.crt")), "")


if __name__ == "__main__":
    unittest.main()
