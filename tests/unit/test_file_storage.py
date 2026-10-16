import hashlib
import io
import os

import pytest

from app.services import file_storage
from app.services.file_storage import EmptyFile, FileStorage, FileTooLarge, clean_filename
from app.services.file_types import FileTypeMismatch, validate_content

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100


@pytest.fixture
def storage(tmp_path):
    s = FileStorage(tmp_path / "uploads")
    s.ensure_dirs()
    return s


def _png_validator(head):
    return validate_content("png", head)


def save(storage, data=PNG, exposed=False, max_bytes=10_000, validator=_png_validator, ext="png"):
    return storage.save_stream(io.BytesIO(data), ext=ext, exposed=exposed, max_bytes=max_bytes, validator=validator)


def test_save_private_and_hash(storage):
    saved = save(storage)
    assert saved.size == len(PNG)
    assert saved.sha256 == hashlib.sha256(PNG).hexdigest()
    assert storage.path_for(saved.stored_name, exposed=False).read_bytes() == PNG
    assert not storage.exists(saved.stored_name, exposed=True)


def test_stored_name_is_uuid_and_ext_only(storage):
    saved = save(storage)
    stem, ext = saved.stored_name.rsplit(".", 1)
    assert len(stem) == 32 and ext == "png"


def test_save_public_goes_to_public_dir(storage):
    saved = save(storage, exposed=True)
    assert (storage.public_dir / saved.stored_name).is_file()
    assert not (storage.private_dir / saved.stored_name).exists()


def test_too_large_is_rejected_and_leaves_nothing_behind(storage):
    with pytest.raises(FileTooLarge):
        save(storage, data=PNG + b"x" * 5000, max_bytes=1000)
    assert list(storage.private_dir.iterdir()) == []


def test_empty_file_is_rejected(storage):
    with pytest.raises(EmptyFile):
        save(storage, data=b"")
    assert list(storage.private_dir.iterdir()) == []


def test_validator_failure_leaves_nothing_behind(storage):
    with pytest.raises(FileTypeMismatch):
        save(storage, data=b"<html>not a png</html>")
    assert list(storage.private_dir.iterdir()) == []
    assert list(storage.public_dir.iterdir()) == []


def test_move_between_private_and_public(storage):
    saved = save(storage)
    storage.move(saved.stored_name, to_exposed=True)
    assert storage.exists(saved.stored_name, exposed=True)
    assert not storage.exists(saved.stored_name, exposed=False)
    storage.move(saved.stored_name, to_exposed=False)
    assert storage.exists(saved.stored_name, exposed=False)
    assert not storage.exists(saved.stored_name, exposed=True)


def test_move_missing_source_raises(storage):
    with pytest.raises(FileNotFoundError):
        storage.move("0" * 32 + ".png", to_exposed=True)


def test_move_never_overwrites(storage):
    saved = save(storage)
    (storage.public_dir / saved.stored_name).write_bytes(b"other")
    with pytest.raises(FileExistsError):
        storage.move(saved.stored_name, to_exposed=True)
    assert storage.path_for(saved.stored_name, exposed=False).read_bytes() == PNG


def test_move_falls_back_to_copy_across_mounts(storage, monkeypatch):
    saved = save(storage)
    real_replace = os.replace
    calls = {"n": 0}

    def flaky_replace(src, dst):
        calls["n"] += 1
        if calls["n"] == 1:  # 第一次（跨挂载点的直接 rename）失败
            raise OSError(18, "Invalid cross-device link")
        return real_replace(src, dst)

    monkeypatch.setattr(file_storage.os, "replace", flaky_replace)
    storage.move(saved.stored_name, to_exposed=True)
    assert storage.path_for(saved.stored_name, exposed=True).read_bytes() == PNG
    assert not storage.exists(saved.stored_name, exposed=False)
    assert [p.name for p in storage.public_dir.iterdir()] == [saved.stored_name]  # 没有遗留 .part


def test_delete(storage):
    saved = save(storage)
    assert storage.delete(saved.stored_name, exposed=False) is True
    assert storage.delete(saved.stored_name, exposed=False) is False  # 已不存在也不报错


@pytest.mark.parametrize("bad", ["../etc/passwd", "a.png", "0" * 32, "0" * 32 + ".PNG", "0" * 32 + "/x.png", "/abs.png"])
def test_path_for_rejects_traversal_and_malformed_names(storage, bad):
    with pytest.raises(ValueError):
        storage.path_for(bad, exposed=False)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("report.pdf", "report.pdf"),
        ("../../etc/passwd", "passwd"),
        ("C:\\Users\\me\\a.txt", "a.txt"),
        ("  spaced   name .txt ", "spaced name .txt"),
        ("tab\tand\nnewline.txt", "tab and newline.txt"),
        ("", "file"),
        ("...", "file"),
        ("2024年度项目.txt", "2024年度项目.txt"),
    ],
)
def test_clean_filename(raw, expected):
    assert clean_filename(raw) == expected


def test_clean_filename_truncates_but_keeps_extension():
    name = clean_filename("a" * 400 + ".pdf")
    assert len(name) == 255 and name.endswith(".pdf")


@pytest.mark.parametrize("ext", ["", "verylongextension", "文件", "pn g", "PNG", "../x"])
def test_odd_extensions_are_rejected_by_validator_never_by_path_building(storage, ext):
    """回归：无扩展名等上传曾在拼路径时抛 ValueError（导致 500）。
    现在 validator 先行，抛的是业务异常 FileTypeMismatch，且不留任何文件。"""
    with pytest.raises(FileTypeMismatch):
        save(storage, ext=ext, validator=lambda head: validate_content(ext, head))
    assert list(storage.private_dir.iterdir()) == []
    assert list(storage.public_dir.iterdir()) == []


def test_temp_name_has_no_user_input_and_final_name_made_after_validation(storage):
    seen = {}

    def spy(head):
        seen["files"] = sorted(p.name for p in storage.private_dir.iterdir())
        return validate_content("png", head)

    saved = save(storage, validator=spy)
    # 校验时磁盘上只有 .<32位hex>.part，还没有最终文件
    assert len(seen["files"]) == 1 and seen["files"][0].startswith(".") and seen["files"][0].endswith(".part")
    assert "png" not in seen["files"][0]
    assert [p.name for p in storage.private_dir.iterdir()] == [saved.stored_name]


def test_delete_does_not_swallow_permission_error(storage, monkeypatch):
    from pathlib import Path
    saved = save(storage)
    original = Path.unlink
    target = storage.path_for(saved.stored_name, False)
    def deny(path, *args, **kwargs):
        if path == target:
            raise PermissionError("simulated failure")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "unlink", deny)
    with pytest.raises(PermissionError):
        storage.delete(saved.stored_name, exposed=False)
    assert target.is_file()


def test_cross_mount_move_removes_destination_when_source_unlink_fails(storage, monkeypatch):
    from pathlib import Path
    saved = save(storage)
    source = storage.path_for(saved.stored_name, False)
    real_replace, real_unlink = os.replace, Path.unlink
    calls = 0
    def cross_mount(src, dst):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError(18, "cross-device link")
        return real_replace(src, dst)
    def deny_source(path, *args, **kwargs):
        if path == source:
            raise PermissionError("simulated source unlink failure")
        return real_unlink(path, *args, **kwargs)
    monkeypatch.setattr(file_storage.os, "replace", cross_mount)
    monkeypatch.setattr(Path, "unlink", deny_source)
    with pytest.raises(PermissionError):
        storage.move(saved.stored_name, to_exposed=True)
    assert source.is_file()
    assert not storage.exists(saved.stored_name, True)
