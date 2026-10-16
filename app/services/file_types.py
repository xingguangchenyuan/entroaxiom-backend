"""允许上传的文件类型：白名单 + 魔数校验（不只看扩展名）。

白名单之外的一律拒绝，尤其是 html / htm / svg / js / 可执行文件等"能在浏览器里执行"的类型，
这样即使放进公开目录也不会变成存储型 XSS。
"""

import codecs
from dataclasses import dataclass
from typing import Callable


class FileTypeMismatch(Exception):
    """扩展名与文件真实内容不符。"""


@dataclass(frozen=True)
class FileType:
    kind: str  # image | pdf | archive | doc | other（与前端 FileKind 一致）
    mime: str
    check: Callable[[bytes], bool]


def _starts(*signatures: bytes) -> Callable[[bytes], bool]:
    return lambda head: any(head.startswith(s) for s in signatures)


def _webp(head: bytes) -> bool:
    return head[:4] == b"RIFF" and head[8:12] == b"WEBP"


def _avif(head: bytes) -> bool:
    return head[4:8] == b"ftyp" and head[8:12] in (b"avif", b"avis")


def _tar(head: bytes) -> bool:
    return len(head) >= 262 and head[257:262] == b"ustar"


def _text(head: bytes) -> bool:
    """文本：不含 NUL，且能按 UTF-8 或 GB18030 解码（兼容常见的中文 GBK 文本）。
    用增量解码器，读取窗口恰好截断在多字节字符中间时不会误判。"""
    if b"\x00" in head:
        return False
    for encoding in ("utf-8", "gb18030"):
        try:
            codecs.getincrementaldecoder(encoding)().decode(head, final=False)
            return True
        except UnicodeDecodeError:
            continue
    return False


_ZIP = _starts(b"PK\x03\x04", b"PK\x05\x06")
_OLE = _starts(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")

ALLOWED_TYPES: dict[str, FileType] = {
    # 图片（不含 svg：svg 可内嵌脚本）
    "png": FileType("image", "image/png", _starts(b"\x89PNG\r\n\x1a\n")),
    "jpg": FileType("image", "image/jpeg", _starts(b"\xff\xd8\xff")),
    "jpeg": FileType("image", "image/jpeg", _starts(b"\xff\xd8\xff")),
    "gif": FileType("image", "image/gif", _starts(b"GIF87a", b"GIF89a")),
    "webp": FileType("image", "image/webp", _webp),
    "avif": FileType("image", "image/avif", _avif),
    # PDF
    "pdf": FileType("pdf", "application/pdf", _starts(b"%PDF-")),
    # 压缩包
    "zip": FileType("archive", "application/zip", _ZIP),
    "7z": FileType("archive", "application/x-7z-compressed", _starts(b"7z\xbc\xaf\x27\x1c")),
    "rar": FileType("archive", "application/vnd.rar", _starts(b"Rar!\x1a\x07")),
    "gz": FileType("archive", "application/gzip", _starts(b"\x1f\x8b")),
    "tgz": FileType("archive", "application/gzip", _starts(b"\x1f\x8b")),
    "tar": FileType("archive", "application/x-tar", _tar),
    # Office 文档
    "docx": FileType("doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", _ZIP),
    "xlsx": FileType("doc", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", _ZIP),
    "pptx": FileType("doc", "application/vnd.openxmlformats-officedocument.presentationml.presentation", _ZIP),
    "doc": FileType("doc", "application/msword", _OLE),
    "xls": FileType("doc", "application/vnd.ms-excel", _OLE),
    "ppt": FileType("doc", "application/vnd.ms-powerpoint", _OLE),
    # 纯文本类
    "txt": FileType("other", "text/plain; charset=utf-8", _text),
    "md": FileType("other", "text/plain; charset=utf-8", _text),
    "csv": FileType("other", "text/csv; charset=utf-8", _text),
    "json": FileType("other", "application/json", _text),
    "log": FileType("other", "text/plain; charset=utf-8", _text),
}


def ext_of(filename: str) -> str:
    """小写扩展名（不含点）；没有扩展名返回空串。"""
    name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if "." not in name:
        return ""
    return name.rsplit(".", 1)[-1].lower()


def validate_ext(ext: str) -> FileType:
    """只检查扩展名是否在白名单内（用于上传前快速拒绝，避免白白读完整个文件）。"""
    if not ext:
        raise FileTypeMismatch("文件缺少扩展名，无法判断类型")
    info = ALLOWED_TYPES.get(ext)
    if info is None:
        shown = ext if len(ext) <= 16 else ext[:16] + "…"
        raise FileTypeMismatch(f"不支持的文件类型：.{shown}")
    return info


def validate_content(ext: str, head: bytes) -> FileType:
    """校验文件开头的字节是否与声明的扩展名一致；通过则返回类型信息。"""
    info = validate_ext(ext)
    if not info.check(head):
        raise FileTypeMismatch(f"文件内容与扩展名 .{ext} 不符")
    return info
