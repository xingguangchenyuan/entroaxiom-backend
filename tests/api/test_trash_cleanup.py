from pathlib import Path
import pytest
from app.services.file_storage import FileStorage
from scripts.cleanup_trash import cleanup
from tests.api.test_files import upload


def pending_delete(admin, monkeypatch):
    item = upload(admin, visibility="public").json()["data"]
    original = Path.unlink
    with monkeypatch.context() as scoped:
        def deny(path, *args, **kwargs):
            if path.parent.name == ".trash":
                raise PermissionError("simulated cleanup failure")
            return original(path, *args, **kwargs)
        scoped.setattr(Path, "unlink", deny)
        result = admin.client.delete(f"/api/admin/files/{item['id']}")
        assert result.json()["data"]["cleanup_pending"] is True
    return item


def test_cleanup_retries_pending_delete(admin, monkeypatch):
    pending_delete(admin, monkeypatch)
    assert cleanup(admin.root / "test.db", admin.uploads, dry_run=True) == 0
    assert len(list((admin.uploads / ".trash").iterdir())) == 1
    assert cleanup(admin.root / "test.db", admin.uploads) == 0
    assert list((admin.uploads / ".trash").iterdir()) == []


def test_cleanup_preserves_database_referenced_file(admin):
    upload(admin)
    storage = FileStorage(admin.uploads)
    quarantined = storage.quarantine(admin.stored_files("private")[0].name, exposed=False)
    assert cleanup(admin.root / "test.db", admin.uploads) == 1
    assert quarantined.is_file()


def test_cleanup_failure_is_reported(admin, monkeypatch):
    pending_delete(admin, monkeypatch)
    original = Path.unlink
    def deny(path, *args, **kwargs):
        if path.parent.name == ".trash":
            raise PermissionError("simulated cleanup failure")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "unlink", deny)
    assert cleanup(admin.root / "test.db", admin.uploads) == 1
    assert len(list((admin.uploads / ".trash").iterdir())) == 1


def test_cleanup_preserves_unexpected_entries(admin):
    directory = admin.uploads / ".trash"
    directory.mkdir()
    (directory / "keep.txt").write_text("unknown file", encoding="utf-8")
    assert cleanup(admin.root / "test.db", admin.uploads) == 1
    assert (directory / "keep.txt").is_file()
