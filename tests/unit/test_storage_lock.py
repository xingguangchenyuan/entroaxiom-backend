import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
import pytest
from app.services.storage_lock import StorageBusyError, storage_lock


def test_lock_is_reentrant_and_released_on_error(tmp_path):
    with pytest.raises(RuntimeError):
        with storage_lock(tmp_path):
            with storage_lock(tmp_path, timeout=0.1):
                raise RuntimeError("failure")
    with storage_lock(tmp_path, timeout=0.1):
        pass


def test_lock_serializes_threads(tmp_path):
    def other_thread():
        with storage_lock(tmp_path, timeout=0.1):
            pass
    with ThreadPoolExecutor(max_workers=1) as executor:
        with storage_lock(tmp_path):
            with pytest.raises(StorageBusyError):
                executor.submit(other_thread).result(timeout=2)
        executor.submit(other_thread).result(timeout=2)


def test_lock_serializes_processes(tmp_path):
    code = (
        "import sys; from pathlib import Path; "
        "from app.services.storage_lock import storage_lock; "
        "\nwith storage_lock(Path(sys.argv[1]), timeout=0.2): print('acquired')"
    )
    with storage_lock(tmp_path):
        result = subprocess.run([sys.executable, "-c", code, str(tmp_path)], capture_output=True, text=True, timeout=5)
        assert result.returncode != 0 and "StorageBusyError" in result.stderr
    result = subprocess.run([sys.executable, "-c", code, str(tmp_path)], capture_output=True, text=True, timeout=5)
    assert result.returncode == 0 and "acquired" in result.stdout
