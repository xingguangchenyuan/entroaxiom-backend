#!/bin/sh
set -e

# 先迁移数据库到最新结构（幂等；已是最新则什么也不做），再启动服务。
alembic upgrade head

# 单 worker：SQLite 只允许一个写者，登录限流也在进程内存里。个人站点完全够用。
exec uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000 --workers 1 --no-access-log
