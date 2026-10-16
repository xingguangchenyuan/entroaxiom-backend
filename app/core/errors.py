"""统一返回格式与错误处理。

所有 /api 响应结构一致：
    成功  {"success": true,  "data": ...,  "error": null}
    失败  {"success": false, "data": null, "error": {"code": "...", "message": "...", "details": ...}}
"""

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("app.errors")

_STATUS_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    422: "VALIDATION_ERROR",
    429: "TOO_MANY_REQUESTS",
}


class ApiError(Exception):
    """业务错误：在任何位置抛出，由统一处理器转换成标准响应。"""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: Any = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details
        self.headers = headers


def ok(data: Any = None) -> dict[str, Any]:
    return {"success": True, "data": data, "error": None}


def error_body(code: str, message: str, details: Any = None) -> dict[str, Any]:
    return {"success": False, "data": None, "error": {"code": code, "message": message, "details": details}}


def not_found(message: str = "内容不存在") -> ApiError:
    """私密内容、草稿和真正不存在的内容都返回同样的 404，不暴露"它存在"。"""
    return ApiError(404, "NOT_FOUND", message)


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def handle_api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(exc.code, exc.message, exc.details),
            headers=exc.headers,
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "HTTP_ERROR")
        message = exc.detail if isinstance(exc.detail, str) else "请求失败"
        if exc.status_code == 404 and message == "Not Found":
            message = "资源不存在"
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(code, message),
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # 只回传位置与提示，避免把 ctx 里不可序列化的对象或用户输入原样带出
        details = [
            {"loc": ".".join(str(p) for p in err.get("loc", ())), "msg": str(err.get("msg", ""))}
            for err in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content=error_body("VALIDATION_ERROR", "请求参数不合法", details),
        )

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("未处理的异常：%s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content=error_body("INTERNAL_ERROR", "服务器内部错误"),
        )
