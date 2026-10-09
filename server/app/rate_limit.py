"""Anonymous upload identity and quota checks."""

import hashlib
import hmac
import ipaddress
from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class QuotaLimits:
    per_hour: int = 3
    per_day: int = 10
    global_day: int = 200


class QuotaExceeded(Exception):
    def __init__(self, scope: str, retry_after: int):
        super().__init__(f"{scope} upload limit reached")
        self.retry_after = retry_after


def client_key(ip: str, secret: bytes, day: date) -> str:
    """Return a daily rotating keyed digest; callers never persist the IP."""
    normalized = str(ipaddress.ip_address(ip))
    message = f"{day.isoformat()}:{normalized}".encode("ascii")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def resolve_client_ip(peer: str, real_ip_header: str | None, trusted_proxy_cidrs: tuple[str, ...]) -> str:
    """Trust Railway's X-Real-IP only for a configured proxy peer."""
    try:
        peer_address = ipaddress.ip_address(peer)
    except ValueError:
        return "0.0.0.0"
    if real_ip_header and any(peer_address in ipaddress.ip_network(cidr) for cidr in trusted_proxy_cidrs):
        try:
            return str(ipaddress.ip_address(real_ip_header.strip()))
        except ValueError:
            pass
    return str(peer_address)


def enforce_limits(hour_count: int, day_count: int, global_count: int, limits: QuotaLimits) -> None:
    if hour_count >= limits.per_hour:
        raise QuotaExceeded("hourly", 3600)
    if day_count >= limits.per_day:
        raise QuotaExceeded("daily", 86400)
    if global_count >= limits.global_day:
        raise QuotaExceeded("global daily", 86400)
