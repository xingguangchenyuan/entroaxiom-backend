import importlib.util
from contextlib import closing
import sqlite3
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest

SPEC = importlib.util.spec_from_file_location("backup_script", Path(__file__).resolve().parents[2] / "scripts" / "backup.py")
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


@pytest.fixture
def project(tmp_path):
    db = tmp_path / "data" / "app.db"
    db.parent.mkdir()
    conn = sqlite3.connect(db)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE t (v TEXT)")
    conn.execute("INSERT INTO t VALUES ('hello')")
    conn.commit()  # 故意不关闭连接：模拟站点正在使用（数据还在 WAL 里）
    up = tmp_path / "uploads"
    (up / "public").mkdir(parents=True)
    (up / "private").mkdir()
    (up / "public" / "a.png").write_bytes(b"PUBLIC")
    (up / "private" / "b.pdf").write_bytes(b"PRIVATE")
    (up / "private" / ".x.part").write_bytes(b"partial")
    yield tmp_path, db, up, conn
    conn.close()


def ns(tmp, db, up, **kw):
    return SimpleNamespace(project=str(tmp), db=str(db), uploads=str(up), dest=str(tmp / "bk"), keep=14, push=None, **kw)


def test_backup_and_restore_roundtrip(project):
    tmp, db, up, live_connection = project
    assert backup.do_backup(ns(tmp, db, up)) == 0
    files = sorted(p.name for p in (tmp / "bk").iterdir() if not p.name.startswith("."))
    assert len(files) == 4 and any(f.endswith(".sha256") for f in files)

    pub = next((tmp / "bk").glob("*-public-*.tar.gz"))
    priv = next((tmp / "bk").glob("*-private-*.tar.gz"))
    with tarfile.open(pub) as archive:
        assert archive.getnames() == ["a.png"]
    with tarfile.open(priv) as archive:
        assert archive.getnames() == ["b.pdf"]  # 临时文件不入备份
    snap = next((tmp / "bk").glob("*.sqlite3"))
    with closing(sqlite3.connect(snap)) as conn:
        assert conn.execute("SELECT v FROM t").fetchall() == [("hello",)]
    live_connection.close()  # Restore requires a stopped backend, including on Windows.

    stamp = pub.name.split("-public-")[1].split(".")[0]
    # 模拟灾难：数据全丢
    for p in (up / "public").iterdir():
        p.unlink()
    (up / "private" / "b.pdf").unlink()
    r = SimpleNamespace(project=str(tmp), db=str(db), uploads=str(up), directory=str(tmp / "bk"), time=stamp, force=True)
    assert backup.do_restore(r) == 0
    assert (up / "public" / "a.png").read_bytes() == b"PUBLIC"
    assert (up / "private" / "b.pdf").read_bytes() == b"PRIVATE"
    with closing(sqlite3.connect(db)) as conn:
        assert conn.execute("SELECT v FROM t").fetchall() == [("hello",)]


def test_restore_refuses_without_force_and_detects_corruption(project):
    tmp, db, up, _ = project
    backup.do_backup(ns(tmp, db, up))
    stamp = next((tmp / "bk").glob("*-public-*.tar.gz")).name.split("-public-")[1].split(".")[0]
    r = SimpleNamespace(project=str(tmp), db=str(db), uploads=str(up), directory=str(tmp / "bk"), time=stamp, force=False)
    with pytest.raises(SystemExit):
        backup.do_restore(r)
    (next((tmp / "bk").glob("*-private-*.tar.gz"))).write_bytes(b"corrupted")
    r.force = True
    with pytest.raises(SystemExit, match="校验失败"):
        backup.do_restore(r)


def test_retention_keeps_latest_n(project, monkeypatch):
    tmp, db, up, _ = project
    times = iter(["20260101-000001", "20260101-000002", "20260101-000003"])

    class FakeDT:
        @staticmethod
        def now():
            class N:
                @staticmethod
                def strftime(_):
                    return next(times)

            return N

    monkeypatch.setattr(backup, "datetime", FakeDT)
    for _ in range(3):
        backup.do_backup(ns(tmp, db, up, ) if False else SimpleNamespace(**{**ns(tmp, db, up).__dict__, "keep": 2}))
    stamps = sorted(p.name for p in (tmp / "bk").glob("*.sha256"))
    assert stamps == ["entroaxiom-20260101-000002.sha256", "entroaxiom-20260101-000003.sha256"]
    assert not list((tmp / "bk").glob("*000001*"))


def test_push_failure_reported(project, monkeypatch):
    tmp, db, up, _ = project
    args = ns(tmp, db, up)
    args.push = "false"
    monkeypatch.setattr(backup.subprocess, "run", lambda _: SimpleNamespace(returncode=1))
    assert backup.do_backup(args) == 3
    args.push = "true {dir}"
    monkeypatch.setattr(backup.subprocess, "run", lambda _: SimpleNamespace(returncode=0))
    # Exercise upload result without overwriting an already-complete same-second set.
    monkeypatch.setattr(backup, "datetime", SimpleNamespace(now=lambda: SimpleNamespace(strftime=lambda _: "20990101-000000")))
    assert backup.do_backup(args) == 0


def test_sqlite_url_parsing(tmp_path):
    assert backup.sqlite_path("sqlite:///./data/x.db", tmp_path) == tmp_path / "data/x.db"
    if backup.os.name != "nt":
        assert backup.sqlite_path("sqlite:////abs/x.db", tmp_path) == Path("/abs/x.db")
    else:
        assert backup.sqlite_path("sqlite:///C:/abs/x.db", tmp_path) == Path("C:/abs/x.db")
    with pytest.raises(SystemExit):
        backup.sqlite_path("postgresql://u@h/db", tmp_path)


def test_relative_cli_paths_resolve_against_cwd_not_project(tmp_path, monkeypatch):
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    args = SimpleNamespace(project=str(tmp_path / "elsewhere"), db="./data/a.db", uploads="./uploads")
    db, up = backup.resolve_paths(args)
    assert db == work / "data" / "a.db" and up == work / "uploads"
    # 未显式给出时，取 UPLOAD_DIR 并相对项目根目录
    monkeypatch.setenv("UPLOAD_DIR", "./up")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///./d/x.db")
    args = SimpleNamespace(project=str(tmp_path / "proj"), db=None, uploads=None)
    db, up = backup.resolve_paths(args)
    assert db == tmp_path / "proj" / "d" / "x.db" and up == tmp_path / "proj" / "up"


@pytest.mark.parametrize("times", [
    ["20260101-020000", "20260102-020000", "20260103-020000"],
    ["20260101-230000", "20260102-020000", "20260103-010000"],
])
def test_retention_orders_full_dates(project, monkeypatch, times):
    tmp, db, up, _ = project
    values = iter(times)
    monkeypatch.setattr(backup, "datetime", SimpleNamespace(now=lambda: SimpleNamespace(strftime=lambda _: next(values))))
    args = ns(tmp, db, up)
    args.keep = 2
    for _ in times:
        backup.do_backup(args)
    assert sorted(p.name for p in (tmp / "bk").glob("*.sha256")) == [f"entroaxiom-{s}.sha256" for s in times[1:]]
    assert not list((tmp / "bk").glob(f"*{times[0]}*"))


def test_same_second_backup_refuses_overwrite(project, monkeypatch):
    tmp, db, up, _ = project
    monkeypatch.setattr(backup, "datetime", SimpleNamespace(now=lambda: SimpleNamespace(strftime=lambda _: "20260101-020000")))
    args = ns(tmp, db, up)
    backup.do_backup(args)
    with pytest.raises(SystemExit, match="不会覆盖"):
        backup.do_backup(args)


def test_failed_backup_does_not_publish_manifest(project, monkeypatch):
    tmp, db, up, _ = project
    def fail(*args):
        raise OSError("simulated archive failure")
    monkeypatch.setattr(backup, "pack_dir", fail)
    with pytest.raises(OSError):
        backup.do_backup(ns(tmp, db, up))
    assert not list((tmp / "bk").glob("entroaxiom-*"))


def test_incomplete_manifest_rejected_before_restore(project):
    tmp, db, up, _ = project
    backup.do_backup(ns(tmp, db, up))
    manifest = next((tmp / "bk").glob("*.sha256"))
    stamp = manifest.name.removeprefix("entroaxiom-").removesuffix(".sha256")
    manifest.write_text("", encoding="utf-8")
    args = SimpleNamespace(project=str(tmp), db=str(db), uploads=str(up), directory=str(tmp / "bk"), time=stamp, force=True)
    with pytest.raises(SystemExit, match="不完整"):
        backup.do_restore(args)
    assert (up / "public" / "a.png").is_file()
