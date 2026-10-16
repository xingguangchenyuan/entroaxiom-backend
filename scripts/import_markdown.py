"""把一批带 frontmatter 的 .md 文件导入数据库（笔记或总结）。

用法：
  python scripts/import_markdown.py notes     ./some/dir
  python scripts/import_markdown.py summaries ./some/dir --publish   # 直接设为 public + published
  python scripts/import_markdown.py notes ./src/content/demo/notes --publish --dry-run

规则：
  - frontmatter 里的 id / title / summary / category / tags / date / updated 照搬；
  - 没有 id 的文件用文件名（去掉 .md）作为 id；
  - id 已存在的跳过（可重复执行，不会覆盖你在网站上改过的内容）；
  - 不加 --publish 时，一律导入为 private + draft（安全默认值）。
"""

import argparse
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _date(value):
    try:
        return date.fromisoformat(value) if value else None
    except ValueError:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("kind", choices=["notes", "summaries"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--publish", action="store_true", help="导入为 public + published")
    parser.add_argument("--dry-run", action="store_true", help="只检查，不写库")
    args = parser.parse_args()

    from app.db.session import get_sessionmaker
    from app.models.content import Note, Summary
    from app.schemas.admin import ContentCreate
    from app.services import content as content_service
    from app.services.frontmatter import parse_frontmatter

    model = Note if args.kind == "notes" else Summary
    files = sorted(args.directory.glob("*.md"))
    if not files:
        print(f"{args.directory} 里没有 .md 文件")
        return 1

    created = skipped = failed = 0
    with get_sessionmaker()() as db:
        for path in files:
            data, body = parse_frontmatter(path.read_text(encoding="utf-8"))
            item_id = str(data.get("id") or path.stem).strip()
            title = str(data.get("title") or "").strip()
            if not title or not SLUG.match(item_id):
                print(f"[跳过-无效] {path.name}：需要 title，且 id 只能含小写字母/数字/连字符")
                failed += 1
                continue
            if content_service.id_exists(db, model, item_id):
                print(f"[跳过-已存在] {item_id}")
                skipped += 1
                continue
            tags = data.get("tags") if isinstance(data.get("tags"), list) else []
            try:
                payload = ContentCreate(
                    id=item_id,
                    title=title,
                    summary=str(data.get("summary") or ""),
                    category=str(data["category"]) if data.get("category") else None,
                    tags=tags,
                    body=body,
                    date=_date(data.get("date")),
                    updated=_date(data.get("updated")),
                    visibility="public" if args.publish else "private",
                    status="published" if args.publish else "draft",
                )
            except ValueError as exc:
                print(f"[跳过-校验失败] {path.name}：{exc}")
                failed += 1
                continue
            if not args.dry_run:
                content_service.create(db, model, payload, date.today())
            print(f"[{'将导入' if args.dry_run else '已导入'}] {item_id}")
            created += 1
    print(f"\n完成：导入 {created}，跳过 {skipped}，无效 {failed}" + ("（dry-run，未写库）" if args.dry_run else ""))
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
