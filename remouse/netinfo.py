"""内网地址探测与私有网段校验。

手机要连上，二维码里必须是一个手机可达的地址。
一台机器常有多个网卡（VPN、VMware、Hyper-V 虚拟交换机），
探测时把虚拟网卡排到后面，避免二维码印成一个手机访问不到的地段。
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass

# 常见的虚拟/隧道网卡名称片段（Windows 适配器描述，小写比较）
VIRTUAL_HINTS = (
    "vmware",
    "virtualbox",
    "vethernet",
    "hyper-v",
    "loopback",
    "tap-",
    "tun",
    "wintun",
    "wireguard",
    "openvpn",
    "tailscale",
    "zerotier",
    "docker",
    "npcap",
)

PREFERRED_HINTS = ("wi-fi", "wifi", "wlan", "wireless", "以太网", "ethernet")


@dataclass(frozen=True)
class LanAddress:
    ip: str
    interface: str
    is_virtual: bool

    @property
    def score(self) -> int:
        """越小越优先。"""
        score = 0
        if self.is_virtual:
            score += 100
        if self.ip.startswith("169.254."):
            score += 50
        name = self.interface.lower()
        if any(h in name for h in PREFERRED_HINTS):
            score -= 10
        return score


def _iter_ipv4(interface_filter=None):
    """优先用 psutil 拿网卡名，没装则退回 getaddrinfo。"""
    try:
        import psutil  # 可选依赖
    except Exception:
        psutil = None

    if psutil is not None:
        try:
            for name, addrs in psutil.net_if_addrs().items():
                if interface_filter and not interface_filter(name):
                    continue
                for addr in addrs:
                    if addr.family == socket.AF_INET:
                        yield addr.address, name
            return
        except Exception:
            pass

    seen = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in seen:
                seen.add(ip)
                yield ip, hostname
    except Exception:
        return


def is_private_ip(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return False


def _is_usable(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if addr.is_loopback or addr.is_link_local or addr.is_multicast:
        return False
    return True


def primary_ip() -> str:
    """UDP connect 技巧：不实际发包，只是让系统选出默认出口地址。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("223.5.5.5", 80))
        return sock.getsockname()[0]
    except Exception:
        return ""
    finally:
        sock.close()


def list_lan_addresses() -> list[LanAddress]:
    """返回排序后的候选地址，最优的在前。"""
    default_ip = primary_ip()
    result: dict[str, LanAddress] = {}

    for ip, iface in _iter_ipv4():
        if not _is_usable(ip):
            continue
        if ip in result:
            continue
        name = (iface or "").lower()
        result[ip] = LanAddress(
            ip=ip,
            interface=iface or "unknown",
            is_virtual=any(h in name for h in VIRTUAL_HINTS),
        )

    if default_ip and default_ip not in result and _is_usable(default_ip):
        result[default_ip] = LanAddress(ip=default_ip, interface="default-route", is_virtual=False)

    entries = list(result.values())
    # 默认出口地址额外加权：它就是浏览器上网走的那条路
    entries.sort(key=lambda a: (a.ip != default_ip, a.score, a.ip))
    return entries


def best_lan_ip() -> str:
    entries = list_lan_addresses()
    if entries:
        return entries[0].ip
    return "127.0.0.1"


def assert_bindable(host: str, port: int) -> bool:
    """端口是否可绑。用于启动前探测占用。"""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def reserved_ports_present(ports: list[int]) -> list[int]:
    """Windows 上 Hyper-V 会预留端口段，被预留的端口 bind 会失败。
    这里只做信息提示，不阻断启动。"""
    return [p for p in ports if not assert_bindable("0.0.0.0", p)]
