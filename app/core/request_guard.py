"""在 FastAPI 解析请求体前鉴权，并对实际接收的字节计数（含无 Content-Length 请求）。"""

from starlette.formparsers import MultiPartException
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api.deps import csrf_protect, require_admin
from app.core.config import Settings
from app.core.errors import ApiError, error_body


class AdminRequestGuard:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "http" or not (path == "/api/admin" or path.startswith("/api/admin/")):
            await self.app(scope, receive, send)
            return

        request = Request(scope)  # 只读 headers/cookies；不调用 receive，不暂存文件。
        upload = path.rstrip("/") == "/api/admin/files" and request.method == "POST"
        # 为单文件 multipart 字段和边界保留 64 KiB；文件本身仍由存储层严格限额。
        limit = self.settings.max_upload_bytes + 64 * 1024 if upload else 4 * 1024 * 1024
        try:
            csrf_protect(request, self.settings)
            require_admin(request, self.settings)
            lengths = request.headers.getlist("content-length")
            if lengths:
                if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
                    raise ApiError(400, "BAD_REQUEST", "Content-Length 不合法")
                if int(lengths[0]) > limit:
                    raise ApiError(413, "PAYLOAD_TOO_LARGE", "请求体超过服务器大小限制")
        except ApiError as exc:
            response = JSONResponse(
                error_body(exc.code, exc.message, exc.details),
                status_code=exc.status_code,
                headers={"Cache-Control": "no-store", **(exc.headers or {})},
            )
            await response(scope, receive, send)
            return

        received = 0
        too_large = False
        rejected = False

        async def limited_receive() -> Message:
            nonlocal received, too_large
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    too_large = True
                    # 旧版 Starlette 只在 MultiPartException 时关闭 multipart 临时文件。
                    raise MultiPartException("请求体超过服务器大小限制")
            return message

        async def limited_send(message: Message) -> None:
            nonlocal rejected
            if not too_large:
                await send(message)
            elif not rejected:
                rejected = True
                response = JSONResponse(error_body("PAYLOAD_TOO_LARGE", "请求体超过服务器大小限制"),
                                        status_code=413, headers={"Cache-Control": "no-store"})
                # 覆盖表单解析器通常生成的 400；后续原响应消息不再发送。
                await response(scope, receive, send)

        await self.app(scope, limited_receive, limited_send)
