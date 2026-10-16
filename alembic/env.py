from logging.config import fileConfig

from alembic import context

from app.core.config import get_settings
from app.db.base import Base
from app.db.session import make_engine
import app.models  # noqa: F401  确保所有模型已注册到 Base.metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

DATABASE_URL = get_settings().database_url
target_metadata = Base.metadata

# SQLite 对 ALTER TABLE 支持有限，必须用 batch 模式（"移动并复制"重建表）；PostgreSQL 不需要
IS_SQLITE = DATABASE_URL.startswith("sqlite")


def run_migrations_offline() -> None:
    context.configure(
        url=DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=IS_SQLITE,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = make_engine(DATABASE_URL)  # 与应用使用同一套引擎设置（含 SQLite 的 WAL / 外键）
    try:
        with engine.connect() as connection:
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                render_as_batch=IS_SQLITE,
                compare_type=True,
            )
            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
