"""访客接口：无需登录，只返回 visibility=public 且 status=published 的内容。

私密内容、草稿与不存在的内容一律返回同样的 404，访客无法探测私密内容是否存在。
过滤发生在数据库查询里，而不是取出后再在 Python / 前端里过滤。
"""

from fastapi import APIRouter

from app.api.deps import DbSession
from app.core.errors import not_found, ok
from app.models.content import Note, Summary
from app.schemas.common import Envelope
from app.schemas.public import PublicContent, PublicContentItem, PublicFile
from app.services import content as content_service
from app.services import files as file_service

router = APIRouter(prefix="/public", tags=["public"])


def _register_content(path: str, model) -> None:
    @router.get(f"/{path}", response_model=Envelope[list[PublicContentItem]], name=f"public_list_{path}")
    def list_items(db: DbSession):
        rows = content_service.list_public(db, model)
        return ok([PublicContentItem.model_validate(r, from_attributes=True) for r in rows])

    @router.get(f"/{path}/{{item_id}}", response_model=Envelope[PublicContent], name=f"public_get_{path}")
    def get_item(item_id: str, db: DbSession):
        row = content_service.get_public(db, model, item_id)
        if row is None:
            raise not_found()
        return ok(PublicContent.model_validate(row, from_attributes=True))


_register_content("notes", Note)
_register_content("summaries", Summary)


@router.get("/files", response_model=Envelope[list[PublicFile]])
def list_files(db: DbSession):
    return ok([file_service.to_public(r) for r in file_service.list_public(db)])


@router.get("/files/{item_id}", response_model=Envelope[PublicFile])
def get_file(item_id: str, db: DbSession):
    row = file_service.get_public(db, item_id)
    if row is None:
        raise not_found()
    return ok(file_service.to_public(row))
