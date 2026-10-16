# 导入全部模型，保证 Alembic 与 create_all 能看到它们
from app.models.content import Note, Summary  # noqa: F401
from app.models.file import FileRecord  # noqa: F401
