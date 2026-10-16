# entroaxiom-backend

个人网站 entroaxiom 的后端（FastAPI + SQLite），与前端仓库 `entroaxiom-site` 前后端分离。

- 访客**不需要登录**即可读取公开内容；只有站长登录（单一密码）后才能管理内容和访问私密文件。
- 内容：学习笔记（notes）、文章总结（summaries）、文件库（files）。
- 设计细节、数据流、安全规则见 [docs/DESIGN.md](docs/DESIGN.md)。

## 状态说明（请先读）

2026-10-14 已实际运行后端单元、接口和迁移测试，并修复文件生命周期与备份问题。详见 [FIXES.md](FIXES.md)。

2026-10-16 联调修复版：新增管理接口请求体解析前鉴权和实际字节限额，调整 Nginx 上传转发防止提前完整缓冲。完整后端测试 **199 项通过**（含 8 项请求体保护测试），并与配套前端完成本地浏览器回归。未接触生产数据；没有新增数据库迁移。详见 [REPAIR-20261016.md](REPAIR-20261016.md)。

| 部分 | 验证情况 |
|---|---|
| 纯逻辑、文件存储、跨进程锁、备份与恢复 | 已实际运行回归测试，包含跨日期保留与故障注入 |
| FastAPI 路由、SQLAlchemy 模型、Alembic 迁移 | 已实际运行接口与迁移测试 |
| Docker/Nginx 配置、Linux 文件锁 | 已审阅；仍需在目标 Linux 服务器做部署验收 |
| 配套前端修复版 | TypeScript/Vite 构建与 14 项测试通过；已连接本地真实后端做重点浏览器回归，保留原视觉 |

第一次运行请按下面「本地开发」操作，**先跑 `pytest`**。如果有失败，把完整报错发给我，通常是一两行的修正。

## 本地开发（WSL / Linux / macOS）

```bash
cd entroaxiom-backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt

pytest                                  # 先确认全部通过（单元 + 接口 + 迁移）

cp .env.example .env
python scripts/hash_password.py         # 按提示输入管理员密码，把输出的一行粘进 .env
python -c "import secrets; print(secrets.token_urlsafe(48))"   # 输出填进 .env 的 SECRET_KEY

alembic upgrade head                    # 创建数据库表
uvicorn app.main:create_app --factory --reload --port 8000
```

- 接口文档（仅开发）：<http://127.0.0.1:8000/api/docs>。先在 `POST /api/auth/login` 里登录，之后同一个页面里的管理接口（含文件上传）都可以直接试。
- 前端：在 `entroaxiom-site` 里 `npm run dev`，Vite 会把 `/api` 和 `/uploads` 代理到 8000 端口。

### 导入已有 Markdown

```bash
python scripts/import_markdown.py notes     ./路径/到/笔记目录 --dry-run
python scripts/import_markdown.py notes     ./路径/到/笔记目录 --publish
python scripts/import_markdown.py summaries ./路径/到/总结目录 --publish
```

frontmatter 规则与前端一致。已存在的 id 会跳过，可重复执行。不加 `--publish` 则导入为私密草稿。

### 管理接口速查（curl）

```bash
curl -c jar -X POST http://127.0.0.1:8000/api/auth/login -H 'content-type: application/json' -d '{"password":"你的密码"}'
# 新建笔记（默认 private + draft）
curl -b jar -X POST http://127.0.0.1:8000/api/admin/notes -H 'content-type: application/json' \
  -d '{"title":"SSH 备忘","body":"# 内容","tags":["SSH"],"category":"计算机"}'
# 发布
curl -b jar -X PATCH http://127.0.0.1:8000/api/admin/notes/<id> -H 'content-type: application/json' \
  -d '{"visibility":"public","status":"published"}'
# 上传文件（默认私密）
curl -b jar -F file=@./报告.pdf -F visibility=public http://127.0.0.1:8000/api/admin/files
```

> 配套前端已包含 `/owner` 登录页和 `/console` 管理界面，可管理笔记、总结及上传文件；上面的 curl 和 `/api/docs` 仍可用于开发调试。

## API 一览

统一返回：`{"success": true, "data": ..., "error": null}` / `{"success": false, "data": null, "error": {"code","message","details"}}`

| 分组 | 接口 | 说明 |
|---|---|---|
| auth | `POST /api/auth/login` `POST /api/auth/logout` `GET /api/auth/me` | 登录发 HttpOnly Cookie；`me` 未登录也返回 200 |
| public（无需登录） | `GET /api/public/notes` `/notes/{id}` | 只含 public + published |
| | `GET /api/public/summaries` `/summaries/{id}` | 同上 |
| | `GET /api/public/files` `/files/{id}` | 同上；`src` 指向 `/uploads/public/<uuid>.<ext>` |
| admin（需登录） | `GET/POST /api/admin/notes`，`GET/PATCH/DELETE /api/admin/notes/{id}` | summaries 同构 |
| | `GET/POST /api/admin/files`，`GET/PATCH/DELETE /api/admin/files/{id}` | POST 为 multipart：`file`、`id?`、`description?`、`visibility?`、`status?` |
| | `GET /api/admin/files/{id}/content?download=true` | 读取文件（私密文件只能从这里读） |
| system | `GET /api/health` | 健康检查 |

## 生产部署（Docker Compose：Nginx + FastAPI）

```bash
# 服务器上，目录结构：
#   ~/entroaxiom/entroaxiom-backend   本仓库
#   ~/entroaxiom/entroaxiom-site      前端仓库（需要先 npm run build 得到 dist/）
cd entroaxiom-backend
mkdir -p data uploads/public uploads/private backups
sudo chown -R $(id -u):$(id -g) data uploads        # 与 .env 里的 APP_UID/APP_GID 一致

cd deploy
cp .env.example .env && chmod 600 .env && nano .env  # 填 SECRET_KEY、ADMIN_PASSWORD_HASH、ALLOWED_ORIGINS、APP_UID/GID
docker compose up -d --build
docker compose logs -f backend
```

1. 先用 `nginx/conf.d/site.conf`（HTTP）跑通。
   此阶段只检查公开页面与健康检查；生产 Cookie 为 Secure，管理员登录需等 HTTPS 启用。不要为了 HTTP 验收关闭生产 Cookie 安全设置。
2. 域名解析好后按 `site-https.conf.example` 顶部注释签发证书，把它改名为 `site-https.conf`、移除 `site.conf`，`docker compose restart nginx`。
3. 防火墙只开放 22（建议限制来源 IP）、80、443。**不要**开放 8000：后端只在 compose 内部网络，外界只能经 Nginx。
4. 更新：`git pull && docker compose up -d --build`（容器启动时会自动执行 `alembic upgrade head`）。
5. 前端更新：重新 `npm run build`，Nginx 直接读 `dist/`，无需重启。

生产配置有强制检查：`APP_ENV=prod` 时 SECRET_KEY 少于 32 位、密码哈希不是 argon2、`COOKIE_SECURE` 不是 true，后端会拒绝启动。

## 备份与恢复

```bash
# 每天凌晨 2 点（crontab -e），并推到服务器之外（rclone/rsync/scp 均可）
0 2 * * * cd /home/你/entroaxiom/entroaxiom-backend && python3 scripts/backup.py --db ./data/entroaxiom.db --uploads ./uploads backup --dest ./backups --keep 14 --push "rclone copy {dir} remote:entro-backups" >> backups/backup.log 2>&1
```

备份分三份：SQLite 一致性快照、公开文件包、私密文件包，附 sha256 校验。**只留在本机的备份不算备份。** 私密文件包请只传到你自己控制的位置。

备份与 API 文件写操作共用 `uploads/.storage.lock`。备份期间访客读请求继续工作，文件上传/修改/删除需等待，等待超过 30 秒返回 `503 STORAGE_BUSY`，稍后重试。宿主机备份任务须以与后端相同的 UID/GID 运行，并指定同一个 uploads 目录；不能手工删除锁文件或绕过 API 修改文件。仅支持本地磁盘，不适用于 NFS/SMB。

同一秒重复备份会拒绝覆盖；未完整生成的备份不会发布校验清单。恢复会检查数据库和文件位置是否一致，拒绝不一致的历史备份。

恢复（先在 deploy/ 中执行 `docker compose stop backend nginx`，再回到项目根目录恢复）：

```bash
python3 scripts/backup.py --db ./data/entroaxiom.db --uploads ./uploads restore ./backups --time 20261013-020000 --force
# 回到 deploy/，重建容器以刷新恢复后的目录绑定挂载
docker compose up -d --force-recreate backend nginx
```

恢复会校验 sha256，并把现有数据改名保留为 `.bak-<时间>`，不会直接覆盖。**请在正式使用前演练一次恢复。**

删除文件先移入 `uploads/.trash/`（不对外挂载），再删除数据库记录。若最后的磁盘清理失败，删除响应会明确返回 `cleanup_pending: true`；旧公开链接已不可访问。修复磁盘权限后，可重试清理：

```bash
python3 scripts/cleanup_trash.py --db ./data/entroaxiom.db --uploads ./uploads --dry-run
python3 scripts/cleanup_trash.py --db ./data/entroaxiom.db --uploads ./uploads
```

清理脚本会保留数据库仍引用的隔离文件（可能来自中断的删除），用于人工恢复，不会递归删除目录。

公开文件响应改为 `Cache-Control: no-store`，减少撤回后被缓存继续提供的情况。但任何已公开/下载过的内容都不能保证收回，包括部署旧版本期间已经形成的缓存。

## 常用运维

- 修改密码：`python scripts/hash_password.py`，更新 `.env`，重启后端。
- 强制所有登录失效：更换 `SECRET_KEY` 并重启。
- 日志：`docker compose logs backend`；容器日志已做轮转（每个 10MB × 5）。日志不记录 Cookie、请求体、查询串。
- 将来换 PostgreSQL：改 `DATABASE_URL`，安装 `psycopg[binary]`，`alembic upgrade head`；`backup.py` 改用 `pg_dump`。
