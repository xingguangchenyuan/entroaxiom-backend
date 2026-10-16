from datetime import date as Date
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, String
from sqlalchemy import Date as SADate
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.content import utcnow


class FileRecord(Base):
    __tablename__ = "files"
    __table_args__ = (
        CheckConstraint("visibility IN ('public', 'private')", name="visibility_valid"),
        CheckConstraint("status IN ('draft', 'published')", name="status_valid"),
        CheckConstraint("kind IN ('image', 'pdf', 'archive', 'doc', 'other')", name="kind_valid"),
    )

    pk: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # slug：前端 URL 里的 id（表内唯一）
    id: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    # 展示用文件名（含扩展名）。只存数据库，磁盘上用 stored_name
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # 磁盘文件名：<uuid hex>.<ext>，与原文件名无关，无法被猜测
    stored_name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    ext: Mapped[str] = mapped_column(String(16), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    visibility: Mapped[str] = mapped_column(String(10), nullable=False, default="private")
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="published")
    # 对应前端的 updatedAt（YYYY-MM-DD）
    date: Mapped[Date | None] = mapped_column(SADate, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)

    @property
    def exposed(self) -> bool:
        """是否对外暴露：只有 public 且 published 的文件才物理存放在 uploads/public/。"""
        return self.visibility == "public" and self.status == "published"
