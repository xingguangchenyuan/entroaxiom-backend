from app.services.slugs import candidates, slugify, unique_slug


def test_ascii_title():
    assert slugify("Database Index Internals") == "database-index-internals"


def test_symbols_and_spacing_collapse():
    assert slugify("  Hello,   World!! (v2)  ") == "hello-world-v2"


def test_filename_stem():
    assert slugify("demo-image-1") == "demo-image-1"
    assert slugify("Report_Final.v2") == "report-final-v2"


def test_empty_result_falls_back_to_prefix_with_random_suffix():
    a = slugify("!!!", prefix="note")
    b = slugify("!!!", prefix="note")
    assert a.startswith("note-") and len(a) == len("note-") + 6
    assert a != b


def test_cjk_without_pinyin_falls_back_or_transliterates():
    result = slugify("数据库索引", prefix="note")
    # 装了 pypinyin 得到拼音，没装则是随机 slug；两种情况都必须是合法 slug
    import re

    assert re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", result)


def test_mixed_cjk_keeps_ascii_part():
    result = slugify("SSH 快速备忘", prefix="note")
    assert result.startswith("ssh")


def test_length_is_capped():
    result = slugify("a " * 100)
    assert len(result) <= 60
    assert not result.endswith("-")


def test_candidates_sequence():
    gen = candidates("x")
    assert [next(gen) for _ in range(4)] == ["x", "x-2", "x-3", "x-4"]


def test_unique_slug_skips_taken():
    taken = {"post", "post-2"}
    assert unique_slug("post", lambda s: s in taken) == "post-3"
    assert unique_slug("fresh", lambda s: s in taken) == "fresh"
