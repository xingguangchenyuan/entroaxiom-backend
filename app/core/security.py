"""认证与请求安全的纯函数 / 小工具。

刻意不依赖 FastAPI 与应用配置（参数都显式传入），便于单元测试：
  - 密码哈希（argon2，惰性导入）
  - 会话 Cookie 的签名与校验（itsdangerous，带过期时间）
  - 登录失败限流（内存，按 IP）
  - 写操作的来源校验（防 CSRF，作为 SameSite=Strict 之外的第二层）
"""

import math
import threading
import time
from collections import deque
from typing import Callable
from urllib.parse import urlsplit

from itsdangerous import BadSignature, URLSafeTimedSerializer

# ---------------------------------------------------------------- 密码


def hash_password(password: str) -> str:
    from argon2 import PasswordHasher

    return PasswordHasher().hash(password)


def verify_password(password: str, hashed: str) -> bool:
    """校验失败、哈希损坏、未配置哈希一律返回 False，不抛异常。"""
    if not hashed:
        return False
    from argon2 import PasswordHasher
    from argon2.exceptions import InvalidHashError, VerificationError

    try:
        return bool(PasswordHasher().verify(hashed, password))
    except (VerificationError, InvalidHashError):
        return False


# ---------------------------------------------------------------- 会话 Cookie

_SESSION_SALT = "entroaxiom.admin-session.v1"


def _serializer(secret: str) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(secret, salt=_SESSION_SALT)


def issue_session(secret: str) -> str:
    """签发管理员会话令牌（无服务端状态；更换 SECRET_KEY 即可让全部会话失效）。"""
    return _serializer(secret).dumps({"role": "admin"})


def verify_session(secret: str, token: str | None, max_age_seconds: int) -> bool:
    if not token:
        return False
    try:
        data = _serializer(secret).loads(token, max_age=max_age_seconds)
    except BadSignature:  # 含签名错误与过期（SignatureExpired 是其子类）
        return False
    return isinstance(data, dict) and data.get("role") == "admin"


# ---------------------------------------------------------------- 登录限流


class LoginRateLimiter:
    """滑动窗口失败计数：窗口内失败达到上限后，在最早一次失败过期前拒绝该 key。"""

    def __init__(self, max_failures: int, window_seconds: int, clock: Callable[[], float] = time.monotonic) -> None:
        self._max = max_failures
        self._window = window_seconds
        self._clock = clock
        self._fails: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque[float]:
        dq = self._fails.get(key)
        if dq is None:
            return deque()
        while dq and now - dq[0] >= self._window:
            dq.popleft()
        if not dq:
            self._fails.pop(key, None)
        return dq

    def retry_after(self, key: str) -> int:
        """还需等待的秒数；0 表示允许尝试。"""
        with self._lock:
            now = self._clock()
            dq = self._prune(key, now)
            if len(dq) < self._max:
                return 0
            return max(1, math.ceil(dq[0] + self._window - now))

    def record_failure(self, key: str) -> None:
        with self._lock:
            now = self._clock()
            dq = self._prune(key, now)
            dq.append(now)
            self._fails[key] = dq
            if len(self._fails) > 10_000:  # 防止被海量不同 IP 撑爆内存
                for k in list(self._fails):
                    self._prune(k, now)

    def reset(self, key: str) -> None:
        with self._lock:
            self._fails.pop(key, None)


# ---------------------------------------------------------------- 客户端 IP


def client_ip(x_real_ip: str | None, peer: str | None, trust_proxy: bool) -> str:
    """位于 Nginx 之后时信任 X-Real-IP（由 Nginx 写入）；否则用直连地址。"""
    if trust_proxy and x_real_ip:
        return x_real_ip.strip()[:64]
    return peer or "unknown"


# ---------------------------------------------------------------- 来源校验（CSRF）

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _origin_of(url: str | None) -> str | None:
    if not url:
        return None
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}".lower()


def origin_allowed(
    *,
    method: str,
    origin: str | None,
    referer: str | None,
    host: str | None,
    sec_fetch_site: str | None,
    allowed_origins: list[str],
) -> bool:
    """写操作的来源是否允许。

    - GET/HEAD/OPTIONS 不检查（本服务的读接口没有副作用）。
    - 带 Origin（或 Referer）时：配置了 ALLOWED_ORIGINS 就必须在名单内，否则必须与 Host 同源。
    - 两者都没有（curl、脚本等非浏览器客户端）：只要浏览器没声明 cross-site 就放行。
      浏览器发起的跨站写请求一定会带 Origin，因此挡得住 CSRF。
    """
    if method.upper() in SAFE_METHODS:
        return True
    if origin is not None and origin.strip().lower() == "null":
        return False
    candidate = _origin_of(origin) or _origin_of(referer)
    if candidate is not None:
        if allowed_origins:
            return candidate in allowed_origins
        if not host:
            return False
        return urlsplit(candidate).netloc == host.strip().lower()
    return (sec_fetch_site or "").strip().lower() != "cross-site"
