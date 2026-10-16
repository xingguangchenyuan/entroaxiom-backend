"""笔记 / 总结的查询与增删改（两者字段相同，共用同一套逻辑，传入对应的模型类即可）。"""

from datetime import date

from sqlalchemy import func, nulls_last, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models.content import Note, Summary
from app.schemas.admin import ContentCreate, ContentUpdate
from app.services.slugs import slugify, unique_slug

ContentModel = type[Note] | type[Summary]

# 这些字段被修改时，若调用方没有显式给出 updated，则自动把 updated 记为今天
_EDIT_FIELDS = frozenset({"title", "summary", "category", "tags", "body"})
_COPY_FIELDS = ("title", "summary", "category", "tags", "body", "date", "updated", "visibility", "status")


def _order(model: ContentModel):
    # 与前端一致：updated 优先，其次 date；都没有的排最后。nulls_last 在 SQLite 与 PostgreSQL 上行为一致
    return (
        nulls_last(func.coalesce(model.updated, model.date).desc()),
        model.created_at.desc(),
        model.pk.desc(),
    )


def id_exists(db: Session, model: ContentModel, item_id: str) -> bool:
    return db.scalar(select(model.pk).where(model.id == item_id)) is not None


# ---------------------------------------------------------------- 访客可见


def list_public(db: Session, model: ContentModel) -> list:
    stmt = (
        select(model)
        .where(model.visibility == "public", model.status == "published")
        .order_by(*_order(model))
    )
    return list(db.scalars(stmt))


def get_public(db: Session, model: ContentModel, item_id: str):
    """私密内容与草稿查不到（返回 None），调用方统一回 404。"""
    stmt = select(model).where(
        model.id == item_id,
        model.visibility == "public",
        model.status == "published",
    )
    return db.scalars(stmt).first()


# ---------------------------------------------------------------- 管理端


def get_row(db: Session, model: ContentModel, item_id: str):
    return db.scalars(select(model).where(model.id == item_id)).first()


def list_admin(
    db: Session,
    model: ContentModel,
    *,
    status: str | None,
    visibility: str | None,
    q: str | None,
    limit: int,
    offset: int,
) -> list:
    stmt = select(model)
    if status:
        stmt = stmt.where(model.status == status)
    if visibility:
        stmt = stmt.where(model.visibility == visibility)
    if q:
        stmt = stmt.where(model.title.icontains(q, autoescape=True) | model.summary.icontains(q, autoescape=True))
    stmt = stmt.order_by(*_order(model)).limit(limit).offset(offset)
    return list(db.scalars(stmt))


def create(db: Session, model: ContentModel, data: ContentCreate, today: date):
    explicit = data.id
    if explicit and id_exists(db, model, explicit):
        raise ApiError(409, "ID_CONFLICT", f"id 已存在：{explicit}")

    for _ in range(5):  # 自动生成的 slug 在并发下可能撞车，重试几次
        item_id = explicit or unique_slug(
            slugify(data.title, model.SLUG_PREFIX), lambda s: id_exists(db, model, s)
        )
        row = model(
            id=item_id,
            title=data.title,
            summary=data.summary,
            category=data.category,
            tags=list(data.tags),
            body=data.body,
            date=data.date or today,
            updated=data.updated,
            visibility=data.visibility,
            status=data.status,
        )
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            if explicit:
                raise ApiError(409, "ID_CONFLICT", f"id 已存在：{explicit}") from None
            continue
        db.refresh(row)
        return row
    raise ApiError(409, "ID_CONFLICT", "自动生成 id 失败，请手动指定 id")


def update(db: Session, row, data: ContentUpdate, today: date):
    fields = data.model_fields_set

    if "id" in fields and data.id != row.id:
        if id_exists(db, type(row), data.id):
            raise ApiError(409, "ID_CONFLICT", f"id 已存在：{data.id}")
        row.id = data.id

    for name in _COPY_FIELDS:
        if name in fields:
            value = getattr(data, name)
            setattr(row, name, list(value) if name == "tags" else value)

    if fields & _EDIT_FIELDS and "updated" not in fields:
        row.updated = today

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "ID_CONFLICT", "id 冲突") from None
    db.refresh(row)
    return row


def delete(db: Session, row) -> None:
    db.delete(row)
    db.commit()
