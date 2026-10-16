"""访客可见的返回模型。

字段与前端 src/content/types.ts 的 Note / Summary / FileItem 一一对应。
刻意不含 visibility、status、内部主键、磁盘文件名、创建/修改时间，避免泄露内部信息。
"""

from datetime import date as Date

from pydantic import BaseModel


class PublicContentItem(BaseModel):
    """列表项（不含正文，对应前端列表页）。"""

    id: str
    title: str
    summary: str
    category: str | None = None
    tags: list[str] = []
    date: Date | None = None
    updated: Date | None = None


class PublicContent(PublicContentItem):
    """详情（含 Markdown 正文）。"""

    body: str


class PublicFile(BaseModel):
    id: str
    name: str
    ext: str
    kind: str
    size: int
    updatedAt: Date | None = None
    # 前端用来预览与下载：公开文件指向 /uploads/public/<uuid>.<ext>
    src: str
    description: str | None = None
