"""Retry cleanup of deleted, non-public files; preserve any DB-referenced bytes."""
import argparse
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.services.storage_lock import storage_lock
from scripts.backup import resolve_paths


def cleanup(db: Path, uploads: Path, *, dry_run: bool = False) -> int:
    with storage_lock(uploads):
        trash = uploads / ".trash"
        if trash.is_symlink():
            raise SystemExit("拒绝清理符号链接形式的隔离目录")
        if not trash.exists():
            return 0
        conn = sqlite3.connect(db.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            active = {row[0] for row in conn.execute("SELECT stored_name FROM files")}
        finally:
            conn.close()
        failed = False
        for path in sorted(trash.iterdir()):
            match = re.fullmatch(r"[0-9a-f]{32}-([0-9a-f]{32}\.[a-z0-9]{1,8})", path.name)
            if not match or path.is_symlink() or not path.is_file():
                print(f"跳过异常条目：{path.name}", file=sys.stderr)
                failed = True
                continue
            if match.group(1) in active:
                print(f"保留数据库仍引用的文件，需人工恢复：{path.name}", file=sys.stderr)
                failed = True
                continue
            if dry_run:
                print(f"待清理：{path.name}")
                continue
            try:
                path.unlink()
                print(f"已清理：{path.name}")
            except OSError:
                print(f"清理失败，文件仍被隔离：{path.name}", file=sys.stderr)
                failed = True
        return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--db")
    parser.add_argument("--uploads")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    db, uploads = resolve_paths(args)
    return cleanup(db, uploads, dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
