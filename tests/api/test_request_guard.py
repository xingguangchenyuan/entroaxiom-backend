"""防止未登录/跨站/超限请求在鉴权前落盘。"""

import asyncio

import pytest
import starlette.formparsers

from app.api.deps import get_settings
from app.core.request_guard import AdminRequestGuard
from app.core.security import issue_session
from starlette.formparsers import MultiPartException
from starlette.requests import Request
from starlette.responses import PlainTextResponse


def test_unauthorized_upload_never_opens_temp_file(env, monkeypatch):
    def unexpected_temp_file(*args, **kwargs):
        pytest.fail("未登录请求不应进入 multipart 解析器")

    monkeypatch.setattr(starlette.formparsers, "SpooledTemporaryFile", unexpected_temp_file)
    response = env.client.post("/api/admin/files", files={"file": ("large.txt", b"x" * (2 * 1024 * 1024))})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"
    assert response.headers["cache-control"] == "no-store"


def test_cross_origin_upload_never_opens_temp_file(admin, monkeypatch):
    def unexpected_temp_file(*args, **kwargs):
        pytest.fail("跨站请求不应进入 multipart 解析器")

    monkeypatch.setattr(starlette.formparsers, "SpooledTemporaryFile", unexpected_temp_file)
    response = admin.client.post("/api/admin/files", headers={"Origin": "https://evil.example"},
                                 files={"file": ("test.txt", b"hello")})
    assert response.status_code == 403


def test_declared_oversize_upload_never_opens_temp_file(admin, monkeypatch):
    def unexpected_temp_file(*args, **kwargs):
        pytest.fail("超限请求不应进入 multipart 解析器")

    monkeypatch.setattr(starlette.formparsers, "SpooledTemporaryFile", unexpected_temp_file)
    response = admin.client.post("/api/admin/files", files={"file": ("large.txt", b"x" * (2 * 1024 * 1024))})
    assert response.status_code == 413


def test_chunked_oversize_upload_returns_413_and_closes_spool(admin, monkeypatch):
    opened = []
    original = starlette.formparsers.SpooledTemporaryFile

    def track_temp_file(*args, **kwargs):
        file = original(*args, **kwargs)
        opened.append(file)
        return file

    monkeypatch.setattr(starlette.formparsers, "SpooledTemporaryFile", track_temp_file)

    def chunks():
        yield b'--audit\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\n\r\n'
        for _ in range(20):
            yield b"x" * (64 * 1024)
        yield b"\r\n--audit--\r\n"

    response = admin.client.post("/api/admin/files", content=chunks(),
                                 headers={"Content-Type": "multipart/form-data; boundary=audit"})
    assert response.status_code == 413
    assert all(file.closed for file in opened)
    assert not admin.stored_files("private")


def test_unauthorized_guard_does_not_receive_any_body(env):
    async def run():
        async def downstream(scope, receive, send):
            pytest.fail("未登录请求不得进入应用")

        async def receive():
            pytest.fail("未登录请求不得读取请求体")

        messages = []

        async def send(message):
            messages.append(message)

        guard = AdminRequestGuard(downstream, get_settings())
        await guard({"type": "http", "method": "POST", "path": "/api/admin/files",
                     "headers": [], "query_string": b""}, receive, send)
        assert messages[0]["status"] == 401

    asyncio.run(run())


def test_trailing_slash_upload_is_also_guarded(env):
    response = env.client.post("/api/admin/files/", files={"file": ("x.txt", b"x")}, follow_redirects=False)
    assert response.status_code == 401


def test_regular_upload_still_works(admin):
    response = admin.client.post("/api/admin/files", files={"file": ("hello.txt", b"hello")})
    assert response.status_code == 201
    assert response.json()["data"]["size"] == 5


def test_real_asgi_chunks_close_partial_spool_before_returning_413(env, monkeypatch):
    """TestClient 会合并生成器；直接发送 ASGI 分块，保证确实打开过临时文件。"""
    opened = []
    original = starlette.formparsers.SpooledTemporaryFile

    def track_temp_file(*args, **kwargs):
        file = original(*args, **kwargs)
        opened.append(file)
        return file

    monkeypatch.setattr(starlette.formparsers, "SpooledTemporaryFile", track_temp_file)

    async def run():
        settings = get_settings()
        cookie = f"{settings.cookie_name}={issue_session(settings.effective_secret)}".encode()
        chunks = iter([
            b'--audit\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\n\r\n',
            *[b"x" * (64 * 1024) for _ in range(20)], b"\r\n--audit--\r\n",
        ])

        async def receive():
            return {"type": "http.request", "body": next(chunks), "more_body": True}

        async def parser_app(scope, receive, send):
            try:
                await Request(scope, receive).form()
                pytest.fail("超限流不应完成解析")
            except MultiPartException:
                await PlainTextResponse("parser error", status_code=400)(scope, receive, send)

        messages = []

        async def send(message):
            messages.append(message)

        guard = AdminRequestGuard(parser_app, settings)
        await guard({"type": "http", "method": "POST", "path": "/api/admin/files",
                     "query_string": b"", "headers": [(b"cookie", cookie),
                     (b"content-type", b"multipart/form-data; boundary=audit")]}, receive, send)
        assert messages[0]["status"] == 413

    asyncio.run(run())
    assert opened, "必须实际创建过 multipart 临时文件"
    assert all(file.closed for file in opened)
