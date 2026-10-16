"""接口共用的依赖：数据库会话、配置、文件存储、登录限流、管理员鉴权、来源校验。"""

from functools import lru_cache
from pathlib import Path
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.errors import ApiError
from app.core.security import LoginRateLimiter, origin_allowed, verify_session
from app.db.session import get_db, reset_engine
from app.services.file_storage import FileStorage

DbSession = Annotated[Session, Depends(get_db)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


@lru_cache
def _storage_for(root: str) -> FileStorage:
    storage = FileStorage(Path(root))
    storage.ensure_dirs()
    return storage


def get_storage(settings: SettingsDep) -> FileStorage:
    return _storage_for(str(settings.upload_dir))


StorageDep = Annotated[FileStorage, Depends(get_storage)]


@lru_cache
def _limiter_for(max_failures: int, window_seconds: int) -> LoginRateLimiter:
    return LoginRateLimiter(max_failures, window_seconds)


def get_login_limiter(settings: SettingsDep) -> LoginRateLimiter:
    return _limiter_for(settings.login_max_failures, settings.login_window_seconds)


LimiterDep = Annotated[LoginRateLimiter, Depends(get_login_limiter)]


def reset_runtime_caches() -> None:
    """清空配置 / 存储 / 限流 / 数据库引擎的缓存（测试里换环境变量后调用）。"""
    get_settings.cache_clear()
    _storage_for.cache_clear()
    _limiter_for.cache_clear()
    reset_engine()


def csrf_protect(request: Request, settings: SettingsDep) -> None:
    """写操作的来源校验：与 SameSite=Strict 的 Cookie 一起构成两层 CSRF 防护。"""
    if not origin_allowed(
        method=request.method,
        origin=request.headers.get("origin"),
        referer=request.headers.get("referer"),
        host=request.headers.get("host"),
        sec_fetch_site=request.headers.get("sec-fetch-site"),
        allowed_origins=settings.allowed_origin_list,
    ):
        raise ApiError(403, "CSRF_REJECTED", "请求来源不被允许")


def is_admin(request: Request, settings: Settings) -> bool:
    token = request.cookies.get(settings.cookie_name)
    return verify_session(settings.effective_secret, token, settings.session_max_age_seconds)


def require_admin(request: Request, settings: SettingsDep) -> None:
    if not is_admin(request, settings):
        raise ApiError(401, "UNAUTHORIZED", "请先登录")
