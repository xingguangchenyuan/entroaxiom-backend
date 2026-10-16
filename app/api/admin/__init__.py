from fastapi import APIRouter, Depends

from app.api.admin import files
from app.api.admin.content import build_content_router
from app.api.deps import require_admin
from app.models.content import Note, Summary

# 整个 /api/admin/* 都要求已登录
router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])
router.include_router(build_content_router("notes", Note, "admin-notes"))
router.include_router(build_content_router("summaries", Summary, "admin-summaries"))
router.include_router(files.router)
