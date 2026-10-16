"""管理端：文件上传、列表、改名 / 切换可见性、删除，以及（需登录的）内容读取。"""

import re

from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import FileResponse

from app.api.deps import DbSession, SettingsDep, StorageDep
from app.core.errors import ApiError, not_found, ok
from app.schemas.admin import AdminFile, FileUpdate
from app.schemas.common import SLUG_PATTERN, Envelope, Status, Visibility
from app.services import files as file_service

router = APIRouter(prefix="/files", tags=["admin-files"])

_SLUG = re.compile(SLUG_PATTERN)


def _get_or_404(db, item_id: str):
    row = file_service.get_row(db, item_id)
    if row is None:
        raise not_found()
    return row


@router.get("", response_model=Envelope[list[AdminFile]])
def list_files(
    db: DbSession,
    status: Status | None = None,
    visibility: Visibility | None = None,
    q: str | None = Query(default=None, max_length=100),
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    rows = file_service.list_admin(db, status=status, visibility=visibility, q=q, limit=limit, offset=offset)
    return ok([file_service.to_admin(r) for r in rows])


@router.post("", status_code=201, response_model=Envelope[AdminFile])
def upload_file(
    db: DbSession,
    storage: StorageDep,
    settings: SettingsDep,
    file: UploadFile = File(...),
    item_id: str | None = Form(default=None, alias="id"),
    description: str | None = Form(default=None, max_length=1000),
    visibility: Visibility = Form(default="private"),
    status: Status = Form(default="published"),
):
    """multipart/form-data 上传。默认私密：只有把 visibility 设为 public 且 status 为 published，
    文件才会放进对外目录。"""
    item_id = (item_id or "").strip() or None
    if item_id is not None and (len(item_id) > 80 or not _SLUG.match(item_id)):
        raise ApiError(422, "VALIDATION_ERROR", "id 只能包含小写字母、数字和连字符")

    row = file_service.create_file(
        db,
        storage,
        filename=file.filename or "",
        stream=file.file,
        item_id=item_id,
        description=description,
        visibility=visibility,
        status=status,
        max_bytes=settings.max_upload_bytes,
        today=settings.today(),
    )
    return ok(file_service.to_admin(row))


@router.get("/{item_id}", response_model=Envelope[AdminFile])
def get_file(item_id: str, db: DbSession):
    return ok(file_service.to_admin(_get_or_404(db, item_id)))


@router.patch("/{item_id}", response_model=Envelope[AdminFile])
def update_file(item_id: str, data: FileUpdate, db: DbSession, storage: StorageDep):
    row = _get_or_404(db, item_id)
    if not data.model_fields_set:
        raise ApiError(422, "VALIDATION_ERROR", "没有要修改的字段")
    return ok(file_service.to_admin(file_service.update_file(db, storage, row, data)))


@router.delete("/{item_id}", response_model=Envelope[dict[str, str | bool]])
def delete_file(item_id: str, db: DbSession, storage: StorageDep):
    row = _get_or_404(db, item_id)
    cleanup_pending = file_service.delete_file(db, storage, row)
    return ok({"deleted": item_id, "cleanup_pending": cleanup_pending})


@router.get("/{item_id}/content", response_model=None)
def file_content(item_id: str, db: DbSession, storage: StorageDep, download: bool = False):
    """读取文件内容（预览或下载）。私密文件只能通过这里读取，且必须已登录。"""
    row = _get_or_404(db, item_id)
    path = storage.path_for(row.stored_name, row.exposed)
    if not path.is_file():
        raise ApiError(404, "FILE_MISSING", "文件在磁盘上不存在")
    return FileResponse(
        path,
        media_type=row.mime_type,
        filename=row.name,
        content_disposition_type="attachment" if download else "inline",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"},
    )
