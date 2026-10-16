from datetime import date as Date
from datetime import datetime, timezone
from typing import ClassVar

from sqlalchemy import JSON, CheckConstraint, DateTime, String, Text
from sqlalchemy import Date as SADate
from sqlalchemy.orm import Mapped, declared_attr, mapped_column

from app.db.base import Base


def utcnow() -> datetime:
    """UTC 当前时间（不带时区信息，SQLite 与 PostgreSQL 行为一致）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class ContentMixin:
    """学习笔记与文章总结共用的字段（前端两者结构完全一致，各存一张表）。"""

    SLUG_PREFIX: ClassVar[str] = "item"

    pk: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # slug：前端 URL 里的 id（kebab-case，表内唯一）
    id: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    summary: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    category: Mapped[str | None] = mapped_column(String(50), nullable=True)
    tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # 展示用日期（YYYY-MM-DD）：date 为发布日期，updated 为最近更新日期
    date: Mapped[Date | None] = mapped_column(SADate, nullable=True)
    updated: Mapped[Date | None] = mapped_column(SADate, nullable=True)
    # 访客能否看到由 visibility 和 status 共同决定：必须 public 且 published
    visibility: Mapped[str] = mapped_column(String(10), nullable=False, default="private")
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="draft")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)

    @declared_attr.directive
    def __table_args__(cls) -> tuple:  # noqa: N805
        return (
            CheckConstraint("visibility IN ('public', 'private')", name="visibility_valid"),
            CheckConstraint("status IN ('draft', 'published')", name="status_valid"),
        )


class Note(ContentMixin, Base):
    __tablename__ = "notes"
    SLUG_PREFIX: ClassVar[str] = "note"


class Summary(ContentMixin, Base):
    __tablename__ = "summaries"
    SLUG_PREFIX: ClassVar[str] = "summary"
