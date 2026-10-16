import pytest

from app.core.security import (
    LoginRateLimiter,
    client_ip,
    issue_session,
    origin_allowed,
    verify_session,
)

SECRET = "x" * 40


# ---------------------------------------------------------------- 会话 Cookie


def test_session_roundtrip():
    token = issue_session(SECRET)
    assert verify_session(SECRET, token, max_age_seconds=60) is True


def test_session_wrong_secret_is_rejected():
    assert verify_session("y" * 40, issue_session(SECRET), max_age_seconds=60) is False


def test_session_tampered_is_rejected():
    token = issue_session(SECRET)
    assert verify_session(SECRET, token[:-2] + ("AA" if not token.endswith("AA") else "BB"), 60) is False


def test_session_expired_is_rejected():
    assert verify_session(SECRET, issue_session(SECRET), max_age_seconds=-1) is False


@pytest.mark.parametrize("token", [None, "", "garbage", "a.b.c"])
def test_session_garbage_is_rejected(token):
    assert verify_session(SECRET, token, 60) is False


# ---------------------------------------------------------------- 登录限流


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def test_limiter_blocks_after_max_failures_then_recovers():
    clock = FakeClock()
    limiter = LoginRateLimiter(max_failures=3, window_seconds=600, clock=clock)
    for _ in range(3):
        assert limiter.retry_after("1.1.1.1") == 0
        limiter.record_failure("1.1.1.1")
    assert limiter.retry_after("1.1.1.1") == 600
    clock.now += 100
    assert limiter.retry_after("1.1.1.1") == 500
    clock.now += 500
    assert limiter.retry_after("1.1.1.1") == 0  # 最早的失败已过期


def test_limiter_is_per_key():
    limiter = LoginRateLimiter(max_failures=1, window_seconds=60, clock=FakeClock())
    limiter.record_failure("a")
    assert limiter.retry_after("a") > 0
    assert limiter.retry_after("b") == 0


def test_limiter_reset_on_success():
    limiter = LoginRateLimiter(max_failures=2, window_seconds=60, clock=FakeClock())
    limiter.record_failure("a")
    limiter.record_failure("a")
    assert limiter.retry_after("a") > 0
    limiter.reset("a")
    assert limiter.retry_after("a") == 0


def test_limiter_sliding_window_drops_old_failures():
    clock = FakeClock()
    limiter = LoginRateLimiter(max_failures=2, window_seconds=100, clock=clock)
    limiter.record_failure("a")
    clock.now += 90
    limiter.record_failure("a")
    clock.now += 20  # 第一次失败已滑出窗口，只剩 1 次
    assert limiter.retry_after("a") == 0


# ---------------------------------------------------------------- 客户端 IP


def test_client_ip():
    assert client_ip("9.9.9.9", "10.0.0.2", trust_proxy=True) == "9.9.9.9"
    assert client_ip("9.9.9.9", "10.0.0.2", trust_proxy=False) == "10.0.0.2"  # 不信任代理头，防伪造
    assert client_ip(None, "10.0.0.2", trust_proxy=True) == "10.0.0.2"
    assert client_ip(None, None, trust_proxy=False) == "unknown"


# ---------------------------------------------------------------- 来源校验


def allowed(**kw):
    base = dict(method="POST", origin=None, referer=None, host="example.com", sec_fetch_site=None, allowed_origins=[])
    base.update(kw)
    return origin_allowed(**base)


def test_safe_methods_are_never_blocked():
    assert allowed(method="GET", origin="https://evil.example") is True


def test_same_origin_post_is_allowed():
    assert allowed(origin="https://example.com") is True
    assert allowed(origin="http://localhost:5173", host="localhost:5173") is True


def test_cross_origin_post_is_blocked():
    assert allowed(origin="https://evil.example") is False
    assert allowed(origin="null") is False
    assert allowed(origin="https://example.com.evil.example") is False


def test_referer_is_used_when_origin_is_missing():
    assert allowed(referer="https://example.com/admin") is True
    assert allowed(referer="https://evil.example/x") is False


def test_no_origin_info():
    assert allowed() is True  # curl / 脚本
    assert allowed(sec_fetch_site="same-origin") is True
    assert allowed(sec_fetch_site="cross-site") is False


def test_allowed_origins_list_is_strict():
    lst = ["https://example.com"]
    assert allowed(origin="https://example.com", allowed_origins=lst) is True
    assert allowed(origin="https://EXAMPLE.com", allowed_origins=lst) is True
    assert allowed(origin="http://example.com", allowed_origins=lst) is False
    assert allowed(origin="https://other.example", host="other.example", allowed_origins=lst) is False
