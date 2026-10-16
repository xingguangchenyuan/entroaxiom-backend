from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from pathlib import Path
from types import SimpleNamespace
import sqlite3
import tarfile
import threading

import pytest

from app.core.errors import ApiError
from app.db.session import get_sessionmaker
from app.schemas.admin import FileUpdate
from app.services import files
from app.services.file_storage import FileStorage
from tests.api.test_files import upload
from tests.unit.test_backup import backup


def backup_args(env, **changes):
    return SimpleNamespace(**{
        "project": str(env.root), "db": str(env.root / "test.db"),
        "uploads": str(env.uploads), "dest": str(env.root / "backups"),
        "keep": 2, "push": None, **changes,
    })


def test_stale_status_update_uses_current_visibility(admin):
    item = upload(admin).json()["data"]
    storage = FileStorage(admin.uploads)
    with get_sessionmaker()() as a, get_sessionmaker()() as b:
        first, stale = files.get_row(a, item["id"]), files.get_row(b, item["id"])
        files.update_file(a, storage, first, FileUpdate(visibility="public"))
        row = files.update_file(b, storage, stale, FileUpdate(status="draft"))
        assert row.visibility == "public" and row.status == "draft" and not row.exposed
        assert storage.exists(row.stored_name, False)
        assert not storage.exists(row.stored_name, True)


def test_stale_delete_after_delete_is_not_found(admin):
    item = upload(admin).json()["data"]
    storage = FileStorage(admin.uploads)
    with get_sessionmaker()() as a, get_sessionmaker()() as b:
        first, stale = files.get_row(a, item["id"]), files.get_row(b, item["id"])
        files.delete_file(a, storage, first)
        with pytest.raises(ApiError) as exc:
            files.delete_file(b, storage, stale)
        assert exc.value.status_code == 404


def test_cleanup_failure_never_leaves_public_bytes(make_env, monkeypatch):
    env = make_env(SERVE_PUBLIC_UPLOADS="true")
    env.login()
    item = upload(env, visibility="public").json()["data"]
    original = Path.unlink

    def deny_trash(path, *args, **kwargs):
        if path.parent.name == ".trash":
            raise PermissionError("simulated trash cleanup failure")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", deny_trash)
    response = env.client.delete(f"/api/admin/files/{item['id']}")
    assert response.status_code == 200
    assert response.json()["data"]["cleanup_pending"] is True
    assert len(list((env.uploads / ".trash").iterdir())) == 1
    env.logout()
    assert env.client.get(item["src"]).status_code == 404
    assert env.client.get(f"/api/public/files/{item['id']}").status_code == 404


def test_quarantine_failure_reports_failure_and_keeps_record(admin, monkeypatch):
    item = upload(admin, visibility="public").json()["data"]

    def deny(*args, **kwargs):
        raise PermissionError("simulated move failure")

    monkeypatch.setattr(FileStorage, "quarantine", deny)
    response = admin.client.delete(f"/api/admin/files/{item['id']}")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "FILE_DELETE_FAILED"
    assert admin.client.get(f"/api/admin/files/{item['id']}").status_code == 200
    assert len(admin.stored_files("public")) == 1


@pytest.mark.parametrize("operation", ["delete", "update"])
def test_failed_commit_restores_file_location(admin, monkeypatch, operation):
    item = upload(admin, visibility="public").json()["data"]
    storage = FileStorage(admin.uploads)
    with get_sessionmaker()() as db:
        row = files.get_row(db, item["id"])

        def fail():
            raise RuntimeError("simulated commit failure")

        monkeypatch.setattr(db, "commit", fail)
        with pytest.raises(RuntimeError, match="simulated"):
            if operation == "delete":
                files.delete_file(db, storage, row)
            else:
                files.update_file(db, storage, row, FileUpdate(visibility="private"))
        assert storage.exists(row.stored_name, True)
        assert not storage.exists(row.stored_name, False)
        assert row.visibility == "public"


def test_backup_blocks_file_mutations_until_complete(admin, monkeypatch):
    item = upload(admin).json()["data"]
    stored = admin.stored_files("private")[0].name
    original = backup.pack_dir
    started = threading.Event()
    future = None

    with ThreadPoolExecutor(max_workers=1) as executor:
        def update():
            started.set()
            return admin.client.patch(f"/api/admin/files/{item['id']}", json={"visibility": "public"})

        def pack(directory, dest):
            nonlocal future
            if future is None:
                future = executor.submit(update)
                assert started.wait(2)
                with pytest.raises(FutureTimeout):
                    future.result(timeout=0.2)
            return original(directory, dest)

        monkeypatch.setattr(backup, "pack_dir", pack)
        args = backup_args(admin)
        assert backup.do_backup(args) == 0
        assert future.result(timeout=5).status_code == 200
    dest = Path(args.dest)
    conn = sqlite3.connect(next(dest.glob("*.sqlite3")))
    try:
        assert conn.execute("SELECT visibility FROM files").fetchone()[0] == "private"
    finally:
        conn.close()
    with tarfile.open(next(dest.glob("*-private-*.tar.gz"))) as archive:
        assert archive.getnames() == [stored]
    with tarfile.open(next(dest.glob("*-public-*.tar.gz"))) as archive:
        assert archive.getnames() == []


def test_restore_rejects_legacy_inconsistent_file_layout(admin):
    upload(admin)
    args = backup_args(admin)
    backup.do_backup(args)
    dest = Path(args.dest)
    public = next(dest.glob("*-public-*.tar.gz"))
    private = next(dest.glob("*-private-*.tar.gz"))
    original = admin.stored_files("private")[0]
    with tarfile.open(public, "w:gz") as archive:
        archive.add(original, arcname=original.name)
    with tarfile.open(private, "w:gz"):
        pass
    manifest = next(dest.glob("*.sha256"))
    snapshot = next(dest.glob("*.sqlite3"))
    manifest.write_text("".join(f"{backup.sha256_of(p)}  {p.name}\n" for p in (snapshot, public, private)), encoding="utf-8")
    stamp = manifest.name.removeprefix("entroaxiom-").removesuffix(".sha256")
    restore = SimpleNamespace(**{**args.__dict__, "directory": str(dest), "time": stamp, "force": True})
    with pytest.raises(SystemExit, match="不一致"):
        backup.do_restore(restore)
    assert original.is_file()
    assert admin.stored_files("public") == []
