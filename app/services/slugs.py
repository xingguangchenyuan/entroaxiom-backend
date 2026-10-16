"""slug（前端 URL 里的 id）生成。纯函数，不依赖数据库。

规则：转小写；中文转拼音（安装了 pypinyin 时）；非字母数字替换为 "-"；
结果为空（如纯符号标题）时退回 "<前缀>-<6 位随机十六进制>"；重名时追加 -2、-3……
"""

import re
import secrets
import unicodedata
from collections.abc import Callable, Iterator

try:  # 可选依赖：没有它，中文标题会退回到随机 slug，之后在管理页手动改即可
    from pypinyin import lazy_pinyin
except ImportError:  # pragma: no cover
    lazy_pinyin = None

MAX_BASE_LENGTH = 60  # 留出重名后缀的空间（数据库列长 80）
_CJK = re.compile(r"[一-鿿]")


def slugify(text: str, prefix: str = "item") -> str:
    text = (text or "").strip()
    if lazy_pinyin is not None and _CJK.search(text):
        text = " ".join(lazy_pinyin(text))
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if len(text) > MAX_BASE_LENGTH:
        text = text[:MAX_BASE_LENGTH].strip("-")
    return text or f"{prefix}-{secrets.token_hex(3)}"


def candidates(base: str) -> Iterator[str]:
    """base、base-2、base-3……"""
    yield base
    n = 2
    while True:
        yield f"{base}-{n}"
        n += 1


def unique_slug(base: str, exists: Callable[[str], bool], limit: int = 1000) -> str:
    """返回第一个 exists(slug) 为 False 的候选。"""
    for i, candidate in enumerate(candidates(base)):
        if not exists(candidate):
            return candidate
        if i >= limit:
            break
    return f"{base}-{secrets.token_hex(3)}"
