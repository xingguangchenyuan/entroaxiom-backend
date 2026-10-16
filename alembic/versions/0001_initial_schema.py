"""initial schema: notes, summaries, files

Revision ID: 0001
Revises:
Create Date: 2026-10-13
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _create_content_table(name: str) -> None:
    """notes 与 summaries 字段完全相同。约束名与 app/db/base.py 的命名规则一致（op.f 表示"已是最终名字"）。"""
    op.create_table(
        name,
        sa.Column("pk", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("id", sa.String(length=80), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("summary", sa.String(length=500), nullable=False),
        sa.Column("category", sa.String(length=50), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("date", sa.Date(), nullable=True),
        sa.Column("updated", sa.Date(), nullable=True),
        sa.Column("visibility", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("visibility IN ('public', 'private')", name=op.f(f"ck_{name}_visibility_valid")),
        sa.CheckConstraint("status IN ('draft', 'published')", name=op.f(f"ck_{name}_status_valid")),
        sa.PrimaryKeyConstraint("pk", name=op.f(f"pk_{name}")),
        sa.UniqueConstraint("id", name=op.f(f"uq_{name}_id")),
    )


def upgrade() -> None:
    _create_content_table("notes")
    _create_content_table("summaries")

    op.create_table(
        "files",
        sa.Column("pk", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("id", sa.String(length=80), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("stored_name", sa.String(length=64), nullable=False),
        sa.Column("ext", sa.String(length=16), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("mime_type", sa.String(length=100), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("description", sa.String(length=1000), nullable=True),
        sa.Column("visibility", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("date", sa.Date(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("visibility IN ('public', 'private')", name=op.f("ck_files_visibility_valid")),
        sa.CheckConstraint("status IN ('draft', 'published')", name=op.f("ck_files_status_valid")),
        sa.CheckConstraint(
            "kind IN ('image', 'pdf', 'archive', 'doc', 'other')", name=op.f("ck_files_kind_valid")
        ),
        sa.PrimaryKeyConstraint("pk", name=op.f("pk_files")),
        sa.UniqueConstraint("id", name=op.f("uq_files_id")),
        sa.UniqueConstraint("stored_name", name=op.f("uq_files_stored_name")),
    )
    op.create_index(op.f("ix_files_sha256"), "files", ["sha256"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_files_sha256"), table_name="files")
    op.drop_table("files")
    op.drop_table("summaries")
    op.drop_table("notes")
