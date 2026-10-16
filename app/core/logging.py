"""日志：统一输出到 stdout，由 Docker 的 json-file 驱动做大小轮转（见 deploy/docker-compose.yml）。"""

import logging
import sys


def setup_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    # uvicorn 自带 access 日志已关闭，请求日志由 app.access 统一输出（只含方法/路径/状态/耗时，不含 Cookie 与请求体）
    logging.getLogger("uvicorn.access").disabled = True
