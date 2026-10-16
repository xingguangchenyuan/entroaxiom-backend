"""Markdown 头部元数据（frontmatter）解析，规则与前端 src/content/frontmatter.ts 一致：
首尾 `---` 之间逐行 `key: value`；支持字符串与 `[a, b]` 数组。纯函数，无第三方依赖。"""

import re

_KEY = re.compile(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$")


def _value(raw: str):
    v = raw.strip()
    if v.startswith("[") and v.endswith("]"):
        items = []
        for part in v[1:-1].split(","):
            part = part.strip().strip("'\"").strip()
            if part:
                items.append(part)
        return items
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    return v


def parse_frontmatter(source: str) -> tuple[dict, str]:
    lines = source.lstrip("﻿").splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, source
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), -1)
    if end == -1:
        return {}, source
    data: dict = {}
    for line in lines[1:end]:
        m = _KEY.match(line)
        if m:
            data[m.group(1)] = _value(m.group(2))
    body = "\n".join(lines[end + 1 :]).lstrip("\n")
    return data, body
