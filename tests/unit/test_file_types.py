import pytest

from app.services.file_types import ALLOWED_TYPES, FileTypeMismatch, ext_of, validate_content

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
PDF = b"%PDF-1.7\n" + b"x" * 32
ZIP = b"PK\x03\x04" + b"\x00" * 32


def test_ext_of():
    assert ext_of("a.PNG") == "png"
    assert ext_of("archive.tar.gz") == "gz"
    assert ext_of("noext") == ""
    assert ext_of("C:\\dir\\x.pdf") == "pdf"
    assert ext_of("../../etc/passwd") == ""


@pytest.mark.parametrize(
    "ext,head,kind",
    [
        ("png", PNG, "image"),
        ("jpg", JPG, "image"),
        ("jpeg", JPG, "image"),
        ("gif", b"GIF89a" + b"\x00" * 10, "image"),
        ("webp", b"RIFF\x00\x00\x00\x00WEBPVP8 ", "image"),
        ("pdf", PDF, "pdf"),
        ("zip", ZIP, "archive"),
        ("docx", ZIP, "doc"),
        ("xlsx", ZIP, "doc"),
        ("doc", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 8, "doc"),
        ("txt", "你好，世界\n".encode("utf-8"), "other"),
        ("md", b"# title\n", "other"),
    ],
)
def test_valid_signatures(ext, head, kind):
    assert validate_content(ext, head).kind == kind


@pytest.mark.parametrize(
    "ext,head",
    [
        ("png", b"<html><script>alert(1)</script></html>"),
        ("png", JPG),
        ("pdf", PNG),
        ("zip", PDF),
        ("docx", PDF),
        ("txt", b"\x00\x01\x02binary"),
        ("jpg", b""),
    ],
)
def test_mismatched_content_is_rejected(ext, head):
    with pytest.raises(FileTypeMismatch):
        validate_content(ext, head)


@pytest.mark.parametrize("ext", ["html", "htm", "svg", "js", "exe", "sh", "php", "xml", "bat", "dll", ""])
def test_dangerous_or_unknown_extensions_are_not_allowed(ext):
    assert ext not in ALLOWED_TYPES
    with pytest.raises(FileTypeMismatch):
        validate_content(ext, b"anything")


def test_gbk_text_is_accepted():
    assert validate_content("txt", "中文内容".encode("gb18030")).kind == "other"


def test_text_cut_in_the_middle_of_a_multibyte_char_is_accepted():
    data = ("你好" * 5000).encode("utf-8")[:8192]  # 8192 不是 3 的倍数：末尾字符被截断
    assert validate_content("txt", data).kind == "other"


def test_tar_signature_needs_offset_257():
    good = b"\x00" * 257 + b"ustar" + b"\x00" * 10
    assert validate_content("tar", good).kind == "archive"
    with pytest.raises(FileTypeMismatch):
        validate_content("tar", b"short")


def test_validate_ext_messages():
    from app.services.file_types import FileTypeMismatch, validate_ext

    assert validate_ext("png").kind == "image"
    with pytest.raises(FileTypeMismatch, match="缺少扩展名"):
        validate_ext("")
    with pytest.raises(FileTypeMismatch, match="不支持"):
        validate_ext("exe")
    with pytest.raises(FileTypeMismatch) as exc:
        validate_ext("x" * 100)
    assert len(str(exc.value)) < 60  # 过长的扩展名不会原样回显
