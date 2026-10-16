"""备份与恢复（只用 Python 标准库，不依赖应用代码）。

备份内容（对应三类数据，分开打包，便于单独恢复）：
  entroaxiom-db-<时间>.sqlite3          SQLite 在线一致性快照（备份期间站点可继续使用）
  entroaxiom-public-<时间>.tar.gz       uploads/public
  entroaxiom-private-<时间>.tar.gz      uploads/private（私密文件，务必只放在你自己控制的地方！）
  entroaxiom-<时间>.sha256              校验和

用法：
  python scripts/backup.py backup  [--dest ./backups] [--keep 14] [--push "rclone copy {dir} remote:entro-backups"]
  python scripts/backup.py restore <备份目录> --time 20261013-020000 [--force]

--push：备份完成后执行的命令，{dir} 会替换成本次备份目录。用于把备份传到服务器之外
（rclone / rsync / scp / aws s3 cp 均可）。**只放在同一台服务器上的备份不算备份。**
恢复前请先停止后端容器，避免恢复过程中有写入。
"""

import argparse
import hashlib
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.services.storage_lock import storage_lock

_STAMP = re.compile(r"[0-9]{8}-[0-9]{6}")
_MANIFEST = re.compile(r"entroaxiom-([0-9]{8}-[0-9]{6})\.sha256")


def _read_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                values[key.strip()] = val.strip().strip("'\"")
    return values


def sqlite_path(database_url: str, base: Path) -> Path:
    prefix = "sqlite:///"
    if not database_url.startswith(prefix):
        raise SystemExit("backup.py 只支持 SQLite（sqlite:///...）。换成 PostgreSQL 后请改用 pg_dump。")
    raw = database_url[len(prefix):]
    p = Path(raw)
    return p if p.is_absolute() else (base / p)


def resolve_paths(args) -> tuple[Path, Path]:
    """--db / --uploads 相对"当前目录"解析；取自 .env / 环境变量的值相对项目根目录解析。"""
    base = Path(args.project).resolve()
    env = {**_read_dotenv(base / ".env"), **os.environ}
    if args.db:
        db = Path(args.db).resolve()
    else:
        db = sqlite_path(env.get("DATABASE_URL", "sqlite:///./data/entroaxiom.db"), base)
    if args.uploads:
        up = Path(args.uploads).resolve()
    else:
        up = Path(env.get("UPLOAD_DIR", "./uploads"))
        if not up.is_absolute():
            up = base / up
    return db, up


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def snapshot_db(src: Path, dest: Path) -> None:
    """用 SQLite 的在线备份 API，而不是直接 cp（WAL 模式下 cp 可能得到不一致的文件）。"""
    if not src.is_file():
        raise SystemExit(f"找不到数据库文件：{src}")
    source = sqlite3.connect(src.resolve().as_uri() + "?mode=ro", uri=True)
    target = sqlite3.connect(dest)
    try:
        source.backup(target)
        if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit("备份的数据库未通过 integrity_check，已中止")
    finally:
        target.close()
        source.close()


def pack_dir(directory: Path, dest: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    with tarfile.open(dest, "w:gz") as tar:
        for item in sorted(directory.iterdir()):
            if item.name.startswith("."):  # 跳过上传中的临时文件 .xxx.part
                continue
            if item.is_symlink() or not item.is_file():
                raise SystemExit(f"上传目录包含异常条目：{item.name}")
            tar.add(item, arcname=item.name)
    os.chmod(dest, 0o600)


def do_backup(args) -> int:
    if args.keep < 1:
        raise SystemExit("--keep 必须至少为 1")
    db, uploads = resolve_paths(args)
    dest = Path(args.dest).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    os.chmod(dest, 0o700)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    db_file = dest / f"entroaxiom-db-{stamp}.sqlite3"
    pub_file = dest / f"entroaxiom-public-{stamp}.tar.gz"
    priv_file = dest / f"entroaxiom-private-{stamp}.tar.gz"

    sums = dest / f"entroaxiom-{stamp}.sha256"
    # Same mounted lock file as API file mutations. SQLite's own snapshot handles
    # concurrent note edits; files cannot move while this complete set is captured.
    with storage_lock(uploads), storage_lock(dest):
        targets = (db_file, pub_file, priv_file, sums)
        if any(p.exists() for p in targets):
            raise SystemExit("同一秒已有备份，请稍后重试（不会覆盖已有备份）")
        with tempfile.TemporaryDirectory(prefix=".backup-", dir=dest) as pending:
            staged = [Path(pending) / p.name for p in targets]
            snapshot_db(db, staged[0])
            os.chmod(staged[0], 0o600)
            pack_dir(uploads / "public", staged[1])
            pack_dir(uploads / "private", staged[2])
            with tarfile.open(staged[1], "r:gz") as pub, tarfile.open(staged[2], "r:gz") as priv:
                _validate_layout(staged[0], set(pub.getnames()), set(priv.getnames()))
            staged[3].write_text("".join(f"{sha256_of(p)}  {p.name}\n" for p in staged[:3]), encoding="utf-8")
            os.chmod(staged[3], 0o600)
            # Publish the manifest last: failed/incomplete sets are never restored.
            for source, target in zip(staged, targets):
                os.replace(source, target)
        _prune_backups(dest, args.keep)
    print(f"备份完成：{dest}（{stamp}）")

    if args.push:
        cmd = shlex.split(args.push.replace("{dir}", str(dest)))
        print("执行：", " ".join(shlex.quote(c) for c in cmd))
        if subprocess.run(cmd).returncode != 0:
            print("异地传输失败！本地备份已生成，但尚未离开服务器。", file=sys.stderr)
            return 3
    else:
        print("提示：没有设置 --push，备份仍只在这台服务器上。")
    return 0


def _prune_backups(dest: Path, keep: int) -> None:
    stamps = sorted((m.group(1) for p in dest.glob("entroaxiom-*.sha256")
                     if (m := _MANIFEST.fullmatch(p.name))), reverse=True)
    for stamp in stamps[keep:]:
        # Exact names only; do not delete unrelated files matching a broad glob.
        for name in (f"entroaxiom-db-{stamp}.sqlite3", f"entroaxiom-public-{stamp}.tar.gz",
                     f"entroaxiom-private-{stamp}.tar.gz", f"entroaxiom-{stamp}.sha256"):
            (dest / name).unlink(missing_ok=True)
        print(f"已清理旧备份：{stamp}")


def _validate_layout(db: Path, public_names: set[str], private_names: set[str]) -> None:
    """Reject incomplete or misclassified file sets, including legacy bad backups."""
    conn = sqlite3.connect(db.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit("备份数据库未通过完整性检查")
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='files'").fetchone():
            return  # Also usable with small generic SQLite databases in unit tests.
        public, private = set(), set()
        for name, visibility, status in conn.execute("SELECT stored_name, visibility, status FROM files"):
            if not re.fullmatch(r"[0-9a-f]{32}\.[a-z0-9]{1,8}", name):
                raise SystemExit("备份数据库包含非法文件名")
            (public if visibility == "public" and status == "published" else private).add(name)
        if public != public_names or private != private_names:
            raise SystemExit("备份数据库与文件位置不一致或存在缺失/孤儿文件，已中止")
    finally:
        conn.close()


def _safe_extract(archive: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        seen = set()
        for member in tar.getmembers():
            if (not member.isfile() or "/" in member.name or "\\" in member.name
                    or ":" in member.name or member.name.startswith(".") or member.name in seen):
                raise SystemExit(f"备份包含不安全或异常的条目：{member.name}")
            seen.add(member.name)
        for member in tar.getmembers():
            with tar.extractfile(member) as src, (target / member.name).open("wb") as out:  # type: ignore[union-attr]
                shutil.copyfileobj(src, out)


def do_restore(args) -> int:
    db, uploads = resolve_paths(args)
    with storage_lock(uploads):
        return _restore_locked(args, db, uploads)


def _restore_locked(args, db: Path, uploads: Path) -> int:
    src = Path(args.directory).resolve()
    stamp = args.time
    if not _STAMP.fullmatch(stamp):
        raise SystemExit("备份时间戳必须是 YYYYMMDD-HHMMSS")
    files = {
        "db": src / f"entroaxiom-db-{stamp}.sqlite3",
        "public": src / f"entroaxiom-public-{stamp}.tar.gz",
        "private": src / f"entroaxiom-private-{stamp}.tar.gz",
    }
    sums = src / f"entroaxiom-{stamp}.sha256"
    for p in (*files.values(), sums):
        if not p.is_file():
            raise SystemExit(f"缺少备份文件：{p}")

    expected = {p.name for p in files.values()}
    checked = set()
    for line in sums.read_text(encoding="utf-8").splitlines():
        digest, _, name = line.partition("  ")
        if name not in expected or name in checked or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise SystemExit("校验失败：备份清单包含异常或重复条目")
        if sha256_of(src / name) != digest:
            raise SystemExit(f"校验失败，备份可能已损坏：{name}")
        checked.add(name)
    if checked != expected:
        raise SystemExit("校验失败：备份清单不完整")
    print("校验通过。")

    if not args.force and (db.exists() or any((uploads / d).exists() and any((uploads / d).iterdir()) for d in ("public", "private") if (uploads / d).exists())):
        raise SystemExit("目标位置已有数据。确认要覆盖请加 --force（会先把现有数据改名保留为 .bak-<时间>）。")

    # Fully validate and stage before touching any current data.
    with tempfile.TemporaryDirectory(prefix=".restore-", dir=uploads) as staging:
        staged = Path(staging)
        for area in ("public", "private"):
            _safe_extract(files[area], staged / area)
        _validate_layout(files["db"], {p.name for p in (staged / "public").iterdir()},
                         {p.name for p in (staged / "private").iterdir()})
        stash = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(4).hex()
        if db.exists():
            preserved_db = db.with_name(db.name + f".bak-{stash}")
            db.rename(preserved_db)
            for suffix in ("-wal", "-shm"):
                extra = db.with_name(db.name + suffix)
                if extra.exists():
                    extra.rename(preserved_db.with_name(preserved_db.name + suffix))
        db.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(files["db"], db)
        for area in ("public", "private"):
            d = uploads / area
            if d.exists():
                d.rename(uploads / f"{area}.bak-{stash}")
            os.replace(staged / area, d)
    print(f"恢复完成：{db}、{uploads}/public、{uploads}/private")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default=str(Path(__file__).resolve().parent.parent), help="项目根目录（含 .env）")
    parser.add_argument("--db", help="SQLite 文件路径（默认取 DATABASE_URL）")
    parser.add_argument("--uploads", help="uploads 目录（默认取 UPLOAD_DIR）")
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("backup")
    b.add_argument("--dest", default="./backups")
    b.add_argument("--keep", type=int, default=14, help="本地保留最近几次")
    b.add_argument("--push", help='备份后执行的异地传输命令，如 "rclone copy {dir} remote:entro"')

    r = sub.add_parser("restore")
    r.add_argument("directory")
    r.add_argument("--time", required=True, help="备份时间戳，如 20261013-020000")
    r.add_argument("--force", action="store_true")

    args = parser.parse_args()
    return do_backup(args) if args.command == "backup" else do_restore(args)


if __name__ == "__main__":
    raise SystemExit(main())
