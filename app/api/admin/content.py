"""管理端：笔记与总结的增删改查（两者共用一套路由工厂，路径分别为 /notes 与 /summaries）。"""

from fastapi import APIRouter, Query

from app.api.deps import DbSession, SettingsDep
from app.core.errors import ApiError, not_found, ok
from app.schemas.admin import AdminContent, AdminContentItem, ContentCreate, ContentUpdate
from app.schemas.common import Envelope, Status, Visibility
from app.services import content as content_service


def build_content_router(path: str, model, tag: str) -> APIRouter:
    router = APIRouter(prefix=f"/{path}", tags=[tag])

    def _get_or_404(db, item_id: str):
        row = content_service.get_row(db, model, item_id)
        if row is None:
            raise not_found()
        return row

    @router.get("", response_model=Envelope[list[AdminContentItem]], name=f"admin_list_{path}")
    def list_items(
        db: DbSession,
        status: Status | None = None,
        visibility: Visibility | None = None,
        q: str | None = Query(default=None, max_length=100),
        limit: int = Query(default=200, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
    ):
        rows = content_service.list_admin(
            db, model, status=status, visibility=visibility, q=q, limit=limit, offset=offset
        )
        return ok([AdminContentItem.model_validate(r, from_attributes=True) for r in rows])

    @router.post("", status_code=201, response_model=Envelope[AdminContent], name=f"admin_create_{path}")
    def create_item(data: ContentCreate, db: DbSession, settings: SettingsDep):
        row = content_service.create(db, model, data, settings.today())
        return ok(AdminContent.model_validate(row, from_attributes=True))

    @router.get("/{item_id}", response_model=Envelope[AdminContent], name=f"admin_get_{path}")
    def get_item(item_id: str, db: DbSession):
        return ok(AdminContent.model_validate(_get_or_404(db, item_id), from_attributes=True))

    @router.patch("/{item_id}", response_model=Envelope[AdminContent], name=f"admin_update_{path}")
    def update_item(item_id: str, data: ContentUpdate, db: DbSession, settings: SettingsDep):
        row = _get_or_404(db, item_id)
        if not data.model_fields_set:
            raise ApiError(422, "VALIDATION_ERROR", "没有要修改的字段")
        row = content_service.update(db, row, data, settings.today())
        return ok(AdminContent.model_validate(row, from_attributes=True))

    @router.delete("/{item_id}", response_model=Envelope[dict[str, str]], name=f"admin_delete_{path}")
    def delete_item(item_id: str, db: DbSession):
        row = _get_or_404(db, item_id)
        content_service.delete(db, row)
        return ok({"deleted": item_id})

    return router
