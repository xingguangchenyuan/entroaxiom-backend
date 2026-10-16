"""API 测试的公共夹具：每个测试一个独立的临时 SQLite 库与上传目录。

需要先安装依赖：pip install -r requirements.txt -r requirements-dev.txt
"""

import struct
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PASSWORD = "correct horse battery staple"


def make_png() -> bytes:
    """生成一张合法的 1x1 PNG（用于上传测试）。"""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"\x00\xff\x00\x00"
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


PNG = make_png()
PDF = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"


class Env:
    """一次测试里用到的路径与客户端。"""

    def __init__(self, client: TestClient, root: Path):
        self.client = client
        self.root = root
        self.uploads = root / "uploads"

    def login(self) -> None:
        r = self.client.post("/api/auth/login", json={"password": PASSWORD})
        assert r.status_code == 200, r.text

    def logout(self) -> None:
        self.client.post("/api/auth/logout")
        self.client.cookies.clear()

    def stored_files(self, area: str) -> list[Path]:
        d = self.uploads / area
        return sorted(p for p in d.iterdir() if p.is_file() and not p.name.startswith(".")) if d.exists() else []


@pytest.fixture
def make_env(tmp_path, monkeypatch):
    clients: list[TestClient] = []

    def factory(**overrides: str) -> Env:
        from app.api.deps import reset_runtime_caches
        from app.core.security import hash_password

        values = {
            "APP_ENV": "test",
            "SECRET_KEY": "x" * 48,
            "ADMIN_PASSWORD_HASH": hash_password(PASSWORD),
            "DATABASE_URL": f"sqlite:///{tmp_path / 'test.db'}",
            "UPLOAD_DIR": str(tmp_path / "uploads"),
            "COOKIE_SECURE": "false",  # TestClient 走 http，Secure Cookie 不会被带回
            "ENABLE_DOCS": "false",
            "SERVE_PUBLIC_UPLOADS": "false",
            "TRUST_PROXY": "false",
            "ALLOWED_ORIGINS": "",
            "MAX_UPLOAD_MB": "1",
            "LOGIN_MAX_FAILURES": "5",
            "LOGIN_WINDOW_MINUTES": "15",
            "TIMEZONE": "Asia/Shanghai",
        }
        values.update(overrides)
        for key, val in values.items():
            monkeypatch.setenv(key, val)

        reset_runtime_caches()
        from app.db.base import Base
        from app.db.session import get_engine
        import app.models  # noqa: F401
        from app.main import create_app

        Base.metadata.create_all(get_engine())
        client = TestClient(create_app())
        client.__enter__()
        clients.append(client)
        return Env(client, tmp_path)

    yield factory

    for c in clients:
        c.__exit__(None, None, None)
    from app.api.deps import reset_runtime_caches

    reset_runtime_caches()


@pytest.fixture
def env(make_env) -> Env:
    return make_env()


@pytest.fixture
def admin(env) -> Env:
    env.login()
    return env
