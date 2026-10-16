"""登录 / 登出 / 登录状态。单管理员：只有一个密码，没有用户表、没有注册、没有找回。"""

import logging
import math

from fastapi import APIRouter, Request, Response

from app.api.deps import LimiterDep, SettingsDep, is_admin
from app.core.errors import ApiError, ok
from app.core.security import client_ip, issue_session, verify_password
from app.schemas.admin import LoginRequest
from app.schemas.common import Envelope

logger = logging.getLogger("app.auth")
router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=Envelope[dict[str, bool]])
def login(body: LoginRequest, request: Request, response: Response, settings: SettingsDep, limiter: LimiterDep):
    ip = client_ip(
        request.headers.get("x-real-ip"),
        request.client.host if request.client else None,
        settings.trust_proxy,
    )

    wait = limiter.retry_after(ip)
    if wait:
        raise ApiError(
            429,
            "TOO_MANY_ATTEMPTS",
            f"尝试次数过多，请 {max(1, math.ceil(wait / 60))} 分钟后再试",
            headers={"Retry-After": str(wait)},
        )

    if not settings.admin_password_hash:
        raise ApiError(503, "ADMIN_NOT_CONFIGURED", "服务器尚未配置管理员密码")

    if not verify_password(body.password, settings.admin_password_hash):
        limiter.record_failure(ip)
        logger.warning("登录失败 ip=%s", ip)
        raise ApiError(401, "INVALID_CREDENTIALS", "密码错误")

    limiter.reset(ip)
    response.set_cookie(
        key=settings.cookie_name,
        value=issue_session(settings.effective_secret),
        max_age=settings.session_max_age_seconds,
        httponly=True,  # JS 读不到，XSS 偷不走会话
        secure=settings.cookie_secure,
        samesite="strict",
        path="/",
    )
    logger.info("管理员登录成功 ip=%s", ip)
    return ok({"authenticated": True})


@router.post("/logout", response_model=Envelope[dict[str, bool]])
def logout(response: Response, settings: SettingsDep):
    response.delete_cookie(
        key=settings.cookie_name,
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite="strict",
    )
    return ok({"authenticated": False})


@router.get("/me", response_model=Envelope[dict[str, bool]])
def me(request: Request, settings: SettingsDep):
    """未登录也返回 200（authenticated=false），方便前端判断是否显示管理入口。"""
    return ok({"authenticated": is_admin(request, settings)})
