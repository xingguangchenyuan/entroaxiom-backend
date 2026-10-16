"""文件的上传、可见性切换（物理移动）、删除，以及对外 / 管理端返回模型的转换。

关键不变量：文件物理存放位置 == (visibility == public 且 status == published)。
任何改变这个条件的操作，都先移动磁盘文件，再提交数据库；提交失败则把文件移回去。
"""

import logging
from datetime import date
from functools import wraps
from typing import BinaryIO

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ApiError, not_found
from app.models.file import FileRecord
from app.schemas.admin import AdminFile, FileUpdate
from app.schemas.public import PublicFile
from app.services.file_storage import EmptyFile, FileStorage, FileTooLarge, clean_filename
from app.services.file_types import FileTypeMismatch, ext_of, validate_content, validate_ext
from app.services.slugs import slugify, unique_slug
from app.services.storage_lock import StorageBusyError, storage_lock

logger = logging.getLogger("app.files")


def _write_locked(func):
    @wraps(func)
    def wrapped(db, storage, *args, **kwargs):
        try:
            with storage_lock(storage.root):
                return func(db, storage, *args, **kwargs)
        except StorageBusyError as exc:
            raise ApiError(503, "STORAGE_BUSY", str(exc), headers={"Retry-After": "5"}) from None
    return wrapped


def _fresh_row(db: Session, row: FileRecord) -> FileRecord:
    pk = row.pk
    db.rollback()  # End any pre-lock read snapshot, discard stale ORM state.
    fresh = db.scalars(select(FileRecord).where(FileRecord.pk == pk).execution_options(populate_existing=True)).first()
    if fresh is None:
        raise not_found()
    return fresh


# ---------------------------------------------------------------- 转换


def src_of(row: FileRecord) -> str:
    """前端预览 / 下载地址。对外文件由 Nginx 直接提供；其余必须经后端（需登录）。"""
    if row.exposed:
        return f"/uploads/public/{row.stored_name}"
    return f"/api/admin/files/{row.id}/content"


def to_public(row: FileRecord) -> PublicFile:
    return PublicFile(
        id=row.id,
        name=row.name,
        ext=row.ext,
        kind=row.kind,
        size=row.size,
        updatedAt=row.date,
        src=src_of(row),
        description=row.description,
    )


def to_admin(row: FileRecord) -> AdminFile:
    return AdminFile(
        id=row.id,
        name=row.name,
        ext=row.ext,
        kind=row.kind,
        size=row.size,
        mime_type=row.mime_type,
        sha256=row.sha256,
        description=row.description,
        visibility=row.visibility,
        status=row.status,
        date=row.date,
        exposed=row.exposed,
        src=src_of(row),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# ---------------------------------------------------------------- 查询


def id_exists(db: Session, item_id: str) -> bool:
    return db.scalar(select(FileRecord.pk).where(FileRecord.id == item_id)) is not None


def get_row(db: Session, item_id: str) -> FileRecord | None:
    return db.scalars(select(FileRecord).where(FileRecord.id == item_id)).first()


def _order():
    return (FileRecord.created_at.desc(), FileRecord.pk.desc())


def list_public(db: Session) -> list[FileRecord]:
    stmt = (
        select(FileRecord)
        .where(FileRecord.visibility == "public", FileRecord.status == "published")
        .order_by(*_order())
    )
    return list(db.scalars(stmt))


def get_public(db: Session, item_id: str) -> FileRecord | None:
    stmt = select(FileRecord).where(
        FileRecord.id == item_id,
        FileRecord.visibility == "public",
        FileRecord.status == "published",
    )
    return db.scalars(stmt).first()


def list_admin(
    db: Session,
    *,
    status: str | None,
    visibility: str | None,
    q: str | None,
    limit: int,
    offset: int,
) -> list[FileRecord]:
    stmt = select(FileRecord)
    if status:
        stmt = stmt.where(FileRecord.status == status)
    if visibility:
        stmt = stmt.where(FileRecord.visibility == visibility)
    if q:
        stmt = stmt.where(
            FileRecord.name.icontains(q, autoescape=True) | FileRecord.description.icontains(q, autoescape=True)
        )
    return list(db.scalars(stmt.order_by(*_order()).limit(limit).offset(offset)))


# ---------------------------------------------------------------- 上传


@_write_locked
def create_file(
    db: Session,
    storage: FileStorage,
    *,
    filename: str,
    stream: BinaryIO,
    item_id: str | None,
    description: str | None,
    visibility: str,
    status: str,
    max_bytes: int,
    today: date,
) -> FileRecord:
    display_name = clean_filename(filename)
    ext = ext_of(display_name)
    exposed = visibility == "public" and status == "published"

    if item_id and id_exists(db, item_id):
        raise ApiError(409, "ID_CONFLICT", f"id 已存在：{item_id}")

    try:
        validate_ext(ext)  # 不在白名单（含无扩展名）就在读取文件内容之前直接拒绝
    except FileTypeMismatch as exc:
        raise ApiError(415, "UNSUPPORTED_FILE_TYPE", str(exc)) from None

    captured: dict[str, object] = {}

    def validator(head: bytes) -> None:
        captured["info"] = validate_content(ext, head)

    try:
        saved = storage.save_stream(stream, ext=ext, exposed=exposed, max_bytes=max_bytes, validator=validator)
    except FileTooLarge:
        raise ApiError(413, "FILE_TOO_LARGE", f"文件超过大小限制（{max_bytes // (1024 * 1024)} MB）") from None
    except EmptyFile:
        raise ApiError(422, "EMPTY_FILE", "文件是空的") from None
    except FileTypeMismatch as exc:
        raise ApiError(415, "UNSUPPORTED_FILE_TYPE", str(exc)) from None

    info = captured["info"]  # validator 一定已执行（否则 save_stream 会抛异常）

    row: FileRecord | None = None
    try:
        for _ in range(5):
            slug = item_id or unique_slug(
                slugify(display_name.rsplit(".", 1)[0], "file"), lambda s: id_exists(db, s)
            )
            candidate = FileRecord(
                id=slug,
                name=display_name,
                stored_name=saved.stored_name,
                ext=ext,
                kind=info.kind,  # type: ignore[attr-defined]
                size=saved.size,
                mime_type=info.mime,  # type: ignore[attr-defined]
                sha256=saved.sha256,
                description=(description or "").strip() or None,
                visibility=visibility,
                status=status,
                date=today,
            )
            db.add(candidate)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                if item_id:
                    raise ApiError(409, "ID_CONFLICT", f"id 已存在：{item_id}") from None
                continue
            row = candidate
            break
        if row is None:
            raise ApiError(409, "ID_CONFLICT", "自动生成 id 失败，请手动指定 id")
    except BaseException:
        db.rollback()
        # Remove any failed public upload from static serving before cleanup.
        quarantined = storage.quarantine(saved.stored_name, exposed=exposed)
        if quarantined is not None:
            try:
                quarantined.unlink()
            except OSError:
                logger.exception("上传回滚后待清理的隔离文件：%s", quarantined.name)
        raise

    db.refresh(row)
    return row


# ---------------------------------------------------------------- 更新 / 删除


@_write_locked
def update_file(db: Session, storage: FileStorage, row: FileRecord, data: FileUpdate) -> FileRecord:
    row = _fresh_row(db, row)
    fields = data.model_fields_set

    if "id" in fields and data.id != row.id and id_exists(db, data.id):
        raise ApiError(409, "ID_CONFLICT", f"id 已存在：{data.id}")

    old_exposed = row.exposed
    new_visibility = data.visibility if "visibility" in fields else row.visibility
    new_status = data.status if "status" in fields else row.status
    new_exposed = new_visibility == "public" and new_status == "published"

    moved = False
    if new_exposed != old_exposed:
        try:
            storage.move(row.stored_name, to_exposed=new_exposed)
        except FileNotFoundError:
            raise ApiError(409, "FILE_MISSING", "磁盘上找不到该文件，无法切换可见性") from None
        except FileExistsError:
            raise ApiError(409, "FILE_CONFLICT", "目标目录已存在同名文件") from None
        moved = True

    try:
        if "id" in fields:
            row.id = data.id
        if "name" in fields:
            row.name = clean_filename(data.name)
        if "description" in fields:
            row.description = (data.description or "").strip() or None
        if "date" in fields:
            row.date = data.date
        row.visibility = new_visibility
        row.status = new_status
        db.commit()
    except BaseException as exc:
        db.rollback()
        if moved:  # 数据库没提交成功：把文件放回原位，保持"位置 == 状态"
            try:
                storage.move(row.stored_name, to_exposed=old_exposed)
            except Exception:  # noqa: BLE001
                logger.exception("回滚文件位置失败：%s", row.stored_name)
        if isinstance(exc, IntegrityError):
            raise ApiError(409, "ID_CONFLICT", "id 冲突") from None
        raise

    db.refresh(row)
    return row


@_write_locked
def delete_file(db: Session, storage: FileStorage, row: FileRecord) -> bool:
    """Return whether quarantined bytes still need cleanup; never leave public bytes."""
    row = _fresh_row(db, row)
    stored_name, exposed = row.stored_name, row.exposed
    try:
        quarantined = storage.quarantine(stored_name, exposed=exposed)
    except OSError:
        raise ApiError(503, "FILE_DELETE_FAILED", "无法安全移除文件，记录已保留，请稍后重试") from None
    try:
        db.delete(row)
        db.commit()
    except BaseException:
        db.rollback()
        if quarantined is not None:
            storage.restore_quarantined(quarantined, stored_name, exposed=exposed)
        raise
    if quarantined is not None:
        try:
            quarantined.unlink()
        except OSError:
            logger.exception("文件已隔离并删除记录，磁盘清理待重试：%s", quarantined.name)
            return True
    return False
