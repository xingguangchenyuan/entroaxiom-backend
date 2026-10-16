"""Shared advisory lock for file mutations and SQLite/file backups (stdlib only).

The lock file must never be removed: host backup jobs and the container use the
same inode in the mounted uploads directory. Local disks only, not NFS/SMB.
"""

import errno
import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path

_guard = threading.Lock()
_locks: dict[str, threading.RLock] = {}
_local = threading.local()


class StorageBusyError(TimeoutError):
    pass


@contextmanager
def storage_lock(root: Path, timeout: float = 30):
    root = Path(root).resolve()
    key = os.path.normcase(str(root))
    with _guard:
        lock = _locks.setdefault(key, threading.RLock())
    if not lock.acquire(timeout=timeout):
        raise StorageBusyError("文件存储正在备份或修改，请稍后重试")
    held = getattr(_local, "held", set())
    _local.held = held
    try:
        if key in held:
            yield
            return
        root.mkdir(parents=True, exist_ok=True)
        fd = os.open(root / ".storage.lock", os.O_RDWR | os.O_CREAT, 0o600)
        acquired = False
        try:
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
            deadline = time.monotonic() + timeout
            while True:
                try:
                    if os.name == "nt":
                        import msvcrt

                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                    break
                except OSError as exc:
                    if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    if time.monotonic() >= deadline:
                        raise StorageBusyError("文件存储正在备份或修改，请稍后重试") from None
                    time.sleep(0.05)
            held.add(key)
            try:
                yield
            finally:
                held.remove(key)
        finally:
            if acquired:
                if os.name == "nt":
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
    finally:
        lock.release()
