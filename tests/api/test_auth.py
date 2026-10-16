from tests.api.conftest import PASSWORD


def test_envelope_shape_on_success_and_error(env):
    ok = env.client.get("/api/health").json()
    assert ok["success"] is True and ok["data"] == {"status": "ok"} and ok["error"] is None

    bad = env.client.get("/api/admin/notes")
    assert bad.status_code == 401
    body = bad.json()
    assert body["success"] is False and body["data"] is None
    assert body["error"]["code"] == "UNAUTHORIZED" and body["error"]["message"]


def test_unknown_route_uses_envelope(env):
    r = env.client.get("/api/nope")
    assert r.status_code == 404
    assert r.json()["success"] is False


def test_me_reflects_login_state(env):
    assert env.client.get("/api/auth/me").json()["data"] == {"authenticated": False}
    env.login()
    assert env.client.get("/api/auth/me").json()["data"] == {"authenticated": True}
    env.client.post("/api/auth/logout")
    env.client.cookies.clear()
    assert env.client.get("/api/auth/me").json()["data"] == {"authenticated": False}


def test_wrong_password_rejected_without_cookie(env):
    r = env.client.post("/api/auth/login", json={"password": "wrong"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "INVALID_CREDENTIALS"
    assert "set-cookie" not in r.headers


def test_login_cookie_flags(make_env):
    e = make_env(COOKIE_SECURE="true")
    r = e.client.post("/api/auth/login", json={"password": PASSWORD})
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
    assert "max-age=604800" in cookie  # 7 天


def test_session_cookie_is_signed(admin):
    admin.client.cookies.set("entro_session", "forged.value.here")
    assert admin.client.get("/api/auth/me").json()["data"]["authenticated"] is False


def test_changing_secret_invalidates_sessions(make_env):
    e = make_env()
    e.login()
    token = e.client.cookies.get("entro_session")
    e2 = make_env(SECRET_KEY="y" * 48)
    e2.client.cookies.set("entro_session", token)
    assert e2.client.get("/api/admin/notes").status_code == 401


def test_login_rate_limit(env):
    for _ in range(5):
        assert env.client.post("/api/auth/login", json={"password": "bad"}).status_code == 401
    r = env.client.post("/api/auth/login", json={"password": PASSWORD})  # 即使密码正确也被挡
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "TOO_MANY_ATTEMPTS"
    assert int(r.headers["retry-after"]) > 0


def test_successful_login_resets_failures(env):
    for _ in range(3):
        env.client.post("/api/auth/login", json={"password": "bad"})
    env.login()
    env.logout()
    for _ in range(4):
        assert env.client.post("/api/auth/login", json={"password": "bad"}).status_code == 401


def test_admin_not_configured(make_env):
    e = make_env(ADMIN_PASSWORD_HASH="")
    r = e.client.post("/api/auth/login", json={"password": "anything"})
    assert r.status_code == 503


def test_login_validation_error_is_sanitized(env):
    r = env.client.post("/api/auth/login", json={})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_csrf_cross_origin_write_rejected(env):
    r = env.client.post(
        "/api/auth/login", json={"password": PASSWORD}, headers={"Origin": "https://evil.example"}
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "CSRF_REJECTED"


def test_csrf_same_origin_write_allowed(env):
    r = env.client.post(
        "/api/auth/login", json={"password": PASSWORD}, headers={"Origin": "http://testserver"}
    )
    assert r.status_code == 200


def test_csrf_allowlist(make_env):
    e = make_env(ALLOWED_ORIGINS="https://entroaxiom.example")
    ok = e.client.post(
        "/api/auth/login", json={"password": PASSWORD}, headers={"Origin": "https://entroaxiom.example"}
    )
    assert ok.status_code == 200
    bad = e.client.post("/api/auth/login", json={"password": PASSWORD}, headers={"Origin": "http://testserver"})
    assert bad.status_code == 403


def test_admin_responses_not_cacheable_and_security_headers(admin):
    r = admin.client.get("/api/admin/notes")
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["x-content-type-options"] == "nosniff"


def test_docs_disabled_by_default(env):
    assert env.client.get("/api/docs").status_code == 404
    assert env.client.get("/api/openapi.json").status_code == 404


def test_health_rejects_missing_schema(env):
    from app.db.session import get_engine
    from sqlalchemy import text
    with get_engine().begin() as conn:
        conn.execute(text("DROP TABLE notes"))
    response = env.client.get("/api/health")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "DB_SCHEMA_UNAVAILABLE"
