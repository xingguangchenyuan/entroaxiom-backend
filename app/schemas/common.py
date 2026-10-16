from typing import Annotated, Any, Generic, Literal, TypeVar

from pydantic import BaseModel, StringConstraints

SLUG_PATTERN = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"

Visibility = Literal["public", "private"]
Status = Literal["draft", "published"]

# 前端 URL 用的 id：小写字母、数字、连字符
Slug = Annotated[str, StringConstraints(pattern=SLUG_PATTERN, min_length=1, max_length=80)]


class ErrorBody(BaseModel):
    code: str
    message: str
    details: Any | None = None


T = TypeVar("T")


class Envelope(BaseModel, Generic[T]):
    """统一返回结构：success / data / error。"""

    success: bool = True
    data: T | None = None
    error: ErrorBody | None = None
