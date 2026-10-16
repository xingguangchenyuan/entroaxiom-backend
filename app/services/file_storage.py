"""上传文件的磁盘存储。纯标准库，不依赖数据库与 Web 框架。

目录结构：
    <upload_dir>/public/   对外暴露（public 且 published 的文件），由 Nginx 只读挂载提供
    <upload_dir>/private/  永不对外，只能经后端接口（需登录）读取
    tmp 文件直接写在目标目录内（.<uuid>.part），保证最终的 rename 是同一文件系统内的原子操作

磁盘文件名是 <uuid hex>.<ext>，与原文件名无关；原文件名只保存在数据库里。
"""

import errno
import hashlib
import logging
import os
import re
import shutil
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

logger = logging.getLogger("app.storage")

_STORED_NAME = re.compile(r"^[0-9a-f]{32}\.[a-z0-9]{1,8}$")
CHUNK_SIZE = 1024 * 1024
HEAD_SIZE = 8192


class FileTooLarge(Exception):
    pass


class EmptyFile(Exception):
    pass


@dataclass(frozen=True)
class SavedFile:
    stored_name: str
    size: int
    sha256: str


def clean_filename(name: str, max_length: int = 255) -> str:
    """展示用文件名：去掉路径、控制字符，限制长度（保留扩展名）。只用于数据库展示，从不用于磁盘路径。"""
    name = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"\s+", " ", name)  # 先把制表符、换行等空白统一成单个空格
    name = "".join(ch for ch in name if ch.isprintable())  # 再去掉其余控制字符
    name = name.strip().strip(".").strip()
    if not name:
        return "file"
    if len(name) > max_length:
        stem, dot, ext = name.rpartition(".")
        if dot and 0 < len(ext) <= 16:
            name = stem[: max_length - len(ext) - 1] + "." + ext
        else:
            name = name[:max_length]
    return name


class FileStorage:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.public_dir = self.root / "public"
        self.private_dir = self.root / "private"
        self.trash_dir = self.root / ".trash"

    def ensure_dirs(self) -> None:
        self.public_dir.mkdir(parents=True, exist_ok=True)
        self.private_dir.mkdir(parents=True, exist_ok=True)

    def _dir(self, exposed: bool) -> Path:
        return self.public_dir if exposed else self.private_dir

    def path_for(self, stored_name: str, exposed: bool) -> Path:
        # 磁盘文件名必须是 <32 位十六进制>.<扩展名>，从根本上杜绝路径穿越
        if not _STORED_NAME.match(stored_name):
            raise ValueError("非法的存储文件名")
        return self._dir(exposed) / stored_name

    def exists(self, stored_name: str, exposed: bool) -> bool:
        return self.path_for(stored_name, exposed).is_file()

    # ---------------------------------------------------------------- 写入

    def save_stream(
        self,
        stream: BinaryIO,
        *,
        ext: str,
        exposed: bool,
        max_bytes: int,
        validator: Callable[[bytes], object],
    ) -> SavedFile:
        """流式写入：边读边算 sha256、边限大小；写完后用文件头调用 validator（不通过则抛异常并清理）。

        临时文件名与最终文件名是分离的：先写 `.<uuid>.part`（名字里没有任何来自用户的内容），
        validator 通过之后才用校验过的扩展名生成最终名 `<uuid>.<ext>` 并原子改名。
        所以无扩展名、扩展名过长/含奇怪字符的上传，只会被 validator 以业务异常拒绝，
        不会在拼路径阶段抛 ValueError。
        """
        self.ensure_dirs()
        directory = self._dir(exposed)
        token = uuid.uuid4().hex
        tmp = directory / f".{token}.part"
        sha = hashlib.sha256()
        size = 0
        head = b""
        try:
            with open(tmp, "wb") as out:
                while True:
                    chunk = stream.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise FileTooLarge()
                    if len(head) < HEAD_SIZE:
                        head += chunk[: HEAD_SIZE - len(head)]
                    sha.update(chunk)
                    out.write(chunk)
            if size == 0:
                raise EmptyFile()
            validator(head)  # 不通过会抛业务异常（如 FileTypeMismatch），由调用方转成 415
            stored_name = f"{token}.{ext}"
            target = self.path_for(stored_name, exposed)  # 仍会再校验一次格式，作为最后一道防线
            os.replace(tmp, target)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        return SavedFile(stored_name=stored_name, size=size, sha256=sha.hexdigest())

    # ---------------------------------------------------------------- 移动 / 删除

    def move(self, stored_name: str, *, to_exposed: bool) -> None:
        """在 public/ 与 private/ 之间移动。目标已存在或源文件缺失都会抛错，不覆盖。"""
        src = self.path_for(stored_name, not to_exposed)
        dst = self.path_for(stored_name, to_exposed)
        if not src.is_file():
            raise FileNotFoundError(f"源文件不存在：{src.name}")
        if dst.exists():
            raise FileExistsError(f"目标位置已存在同名文件：{dst.name}")
        self.ensure_dirs()
        self._move_path(src, dst)

    @staticmethod
    def _move_path(src: Path, dst: Path) -> None:
        try:
            os.replace(src, dst)
        except OSError as exc:
            if exc.errno != errno.EXDEV:  # 跨挂载点（如 public/ private/ 分开挂载）改用复制 + 删除
                raise
            tmp = dst.with_name(f".{dst.name}.{uuid.uuid4().hex}.part")
            try:
                shutil.copy2(src, tmp)
                os.replace(tmp, dst)
            except BaseException:
                tmp.unlink(missing_ok=True)
                raise
            try:
                src.unlink()
            except BaseException:
                # Copy succeeded but source removal failed: do not leave two
                # copies, especially a public copy of a still-private record.
                dst.unlink()
                raise

    def quarantine(self, stored_name: str, *, exposed: bool) -> Path | None:
        src = self.path_for(stored_name, exposed)
        if not src.is_file():
            return None
        self.trash_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        target = self.trash_dir / f"{uuid.uuid4().hex}-{stored_name}"
        self._move_path(src, target)
        return target

    def restore_quarantined(self, path: Path, stored_name: str, *, exposed: bool) -> None:
        target = self.path_for(stored_name, exposed)
        if target.exists():
            raise FileExistsError(target.name)
        self._move_path(path, target)

    def delete(self, stored_name: str, *, exposed: bool) -> bool:
        """删除磁盘文件；文件已不存在也视为成功。返回是否真的删除了文件。"""
        path = self.path_for(stored_name, exposed)
        try:
            path.unlink()
            return True
        except FileNotFoundError:
            return False
        # Other filesystem errors must propagate; they are not successful deletes.
