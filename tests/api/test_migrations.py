"""Alembic 迁移与模型必须一致：升级到 head 后，再自动比对不应发现任何差异。"""

import pytest
from alembic import command
from alembic.config import Config
from alembic.util.exc import CommandError
from sqlalchemy import inspect


@pytest.fixture
def alembic_cfg(tmp_path, monkeypatch):
    from app.api.deps import reset_runtime_caches

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'mig.db'}")
    monkeypatch.setenv("APP_ENV", "test")
    reset_runtime_caches()
    yield Config("alembic.ini")
    reset_runtime_caches()


def test_upgrade_creates_tables_and_downgrade_removes(alembic_cfg, tmp_path):
    from sqlalchemy import create_engine

    command.upgrade(alembic_cfg, "head")
    engine = create_engine(f"sqlite:///{tmp_path / 'mig.db'}")
    assert {"notes", "summaries", "files"} <= set(inspect(engine).get_table_names())
    command.downgrade(alembic_cfg, "base")
    assert not ({"notes", "summaries", "files"} & set(inspect(engine).get_table_names()))
    engine.dispose()


def test_migrations_match_models(alembic_cfg):
    command.upgrade(alembic_cfg, "head")
    try:
        command.check(alembic_cfg)  # 有未生成迁移的模型改动时抛 CommandError
    except CommandError as exc:  # pragma: no cover
        pytest.fail(f"模型与迁移不一致，请运行 alembic revision --autogenerate：{exc}")
