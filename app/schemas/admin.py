"""管理端的请求 / 返回模型。"""

from datetime import date as Date
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints, field_validator, model_validator

from app.schemas.common import Slug, Status, Visibility

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
Category = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]

MAX_TAGS = 20
MAX_TAG_LENGTH = 30


def _clean_tags(value: list[str]) -> list[str]:
    cleaned: list[str] = []
    for raw in value:
        tag = raw.strip()
        if not tag:
            continue
        if len(tag) > MAX_TAG_LENGTH:
            raise ValueError(f"单个标签不能超过 {MAX_TAG_LENGTH} 个字符")
        if tag not in cleaned:
            cleaned.append(tag)
    if len(cleaned) > MAX_TAGS:
        raise ValueError(f"标签不能超过 {MAX_TAGS} 个")
    return cleaned


# ---------------------------------------------------------------- 笔记 / 总结


class ContentCreate(BaseModel):
    # 不传则根据标题自动生成 slug
    id: Slug | None = None
    title: Title
    summary: ShortText = ""
    category: Category | None = None
    tags: list[str] = Field(default_factory=list)
    body: str = Field(default="", max_length=1_000_000)
    date: Date | None = None
    updated: Date | None = None
    # 新建内容默认私密 + 草稿，需要手动改为 public + published 才会对访客可见
    visibility: Visibility = "private"
    status: Status = "draft"

    @field_validator("tags")
    @classmethod
    def _tags(cls, value: list[str]) -> list[str]:
        return _clean_tags(value)


class ContentUpdate(BaseModel):
    """部分更新：只修改请求里出现的字段。"""

    id: Slug | None = None
    title: Title | None = None
    summary: ShortText | None = None
    category: Category | None = None
    tags: list[str] | None = None
    body: str | None = Field(default=None, max_length=1_000_000)
    date: Date | None = None
    updated: Date | None = None
    visibility: Visibility | None = None
    status: Status | None = None

    @field_validator("tags")
    @classmethod
    def _tags(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else _clean_tags(value)

    @model_validator(mode="after")
    def _non_nullable_fields(self) -> "ContentUpdate":
        for name in ("id", "title", "summary", "tags", "body", "visibility", "status"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} 不能为 null")
        return self


class AdminContentItem(BaseModel):
    id: str
    title: str
    summary: str
    category: str | None = None
    tags: list[str] = []
    date: Date | None = None
    updated: Date | None = None
    visibility: Visibility
    status: Status
    created_at: datetime
    updated_at: datetime


class AdminContent(AdminContentItem):
    body: str


# ---------------------------------------------------------------- 文件


class FileUpdate(BaseModel):
    id: Slug | None = None
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)] | None = None
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] | None = None
    visibility: Visibility | None = None
    status: Status | None = None
    date: Date | None = None

    @model_validator(mode="after")
    def _non_nullable_fields(self) -> "FileUpdate":
        for name in ("id", "name", "visibility", "status"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} 不能为 null")
        return self


class AdminFile(BaseModel):
    id: str
    name: str
    ext: str
    kind: str
    size: int
    mime_type: str
    sha256: str
    description: str | None = None
    visibility: Visibility
    status: Status
    date: Date | None = None
    # 当前文件是否物理存放在对外目录（public 且 published）
    exposed: bool
    # 预览 / 下载地址：对外文件为 /uploads/public/...，其余为需要登录的 /api/admin/files/{id}/content
    src: str
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------- 认证


class LoginRequest(BaseModel):
    password: str = Field(min_length=1, max_length=256)
