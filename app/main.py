"""应用入口。用工厂函数创建，启动命令：uvicorn app.main:create_app --factory"""

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, text

from app.api import auth, public
from app.api import admin as admin_api
from app.api.deps import csrf_protect, reset_runtime_caches
from app.core.config import get_settings
from app.core.errors import ApiError, ok, register_exception_handlers
from app.core.logging import setup_logging
from app.core.request_guard import AdminRequestGuard
from app.db.session import get_engine
from app.schemas.common import Envelope
from app.services.file_storage import FileStorage

logger = logging.getLogger("app")
access_logger = logging.getLogger("app.access")


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    FileStorage(settings.upload_dir).ensure_dirs()
    try:
        tables = set(inspect(get_engine()).get_table_names())
        if not {"notes", "summaries", "files"} <= tables:
            logger.warning("数据库表尚未创建，请先执行：alembic upgrade head")
    except Exception:  # noqa: BLE001
        logger.exception("无法连接数据库：%s", settings.database_url.split("@")[-1])
    logger.info("entroaxiom backend 已启动（env=%s）", settings.app_env)
    yield
    reset_runtime_caches()


def create_app() -> FastAPI:
    settings = get_settings()
    setup_logging(settings.log_level)
    for warning in settings.validate_for_runtime():  # prod 配置不合格会在这里直接抛错，拒绝启动
        logger.warning(warning)

    app = FastAPI(
        title="entroaxiom backend",
        version="1.0.0",
        docs_url="/api/docs" if settings.enable_docs else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.enable_docs else None,
        lifespan=lifespan,
    )
    register_exception_handlers(app)
    app.add_middleware(AdminRequestGuard, settings=settings)

    @app.middleware("http")
    async def access_log_and_security_headers(request: Request, call_next):
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            access_logger.exception("%s %s -> 异常", request.method, request.url.path)
            raise
        elapsed_ms = (time.perf_counter() - started) * 1000
        path = request.url.path
        headers = response.headers
        headers.setdefault("X-Content-Type-Options", "nosniff")
        headers.setdefault("X-Frame-Options", "SAMEORIGIN")  # 同源页面可以内嵌（PDF 预览）
        headers.setdefault("Referrer-Policy", "same-origin")
        if path.startswith(("/api/admin", "/api/auth")):
            headers["Cache-Control"] = "no-store"
        elif path.startswith("/uploads/public/"):
            headers["Cache-Control"] = "no-store"
        elif path.startswith("/api/"):
            headers.setdefault("Cache-Control", "no-cache")
        # 只记录方法、路径、状态码与耗时；不记录查询串、Cookie、请求体
        access_logger.info("%s %s %s %.1fms", request.method, path, response.status_code, elapsed_ms)
        return response

    api = APIRouter(prefix="/api", dependencies=[Depends(csrf_protect)])
    api.include_router(auth.router)
    api.include_router(public.router)
    api.include_router(admin_api.router)

    @api.get("/health", response_model=Envelope[dict[str, str]], tags=["system"])
    def health():
        try:
            with get_engine().connect() as conn:
                conn.execute(text("SELECT 1"))
                if not {"notes", "summaries", "files"} <= set(inspect(conn).get_table_names()):
                    raise ApiError(503, "DB_SCHEMA_UNAVAILABLE", "数据库结构尚未就绪，请先执行迁移")
        except ApiError:
            raise
        except Exception:  # noqa: BLE001
            raise ApiError(503, "DB_UNAVAILABLE", "数据库不可用") from None
        return ok({"status": "ok"})

    app.include_router(api)

    if settings.serve_public_uploads:
        # 仅开发用：生产环境由 Nginx 只读挂载 uploads/public 并直接提供
        public_dir = Path(settings.upload_dir) / "public"
        public_dir.mkdir(parents=True, exist_ok=True)
        app.mount("/uploads/public", StaticFiles(directory=public_dir), name="public-uploads")

    return app
