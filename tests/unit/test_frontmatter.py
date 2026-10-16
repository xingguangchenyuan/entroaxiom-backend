from app.services.frontmatter import parse_frontmatter


def test_basic():
    data, body = parse_frontmatter(
        "---\nid: a-b\ntitle: 标题: 带冒号\ntags: [SSH, '运维', \"x\"]\ndate: 2024-05-06\n---\n\n## 正文\n"
    )
    assert data == {"id": "a-b", "title": "标题: 带冒号", "tags": ["SSH", "运维", "x"], "date": "2024-05-06"}
    assert body == "## 正文\n" or body == "## 正文"


def test_no_frontmatter_and_unclosed():
    assert parse_frontmatter("hello") == ({}, "hello")
    assert parse_frontmatter("---\nid: x\nno end") == ({}, "---\nid: x\nno end")


def test_crlf_bom_quotes_and_empty_tags():
    data, body = parse_frontmatter('﻿---\r\ntitle: "引号"\r\ntags: []\r\n---\r\nbody')
    assert data == {"title": "引号", "tags": []} and body == "body"
