# 生产部署手册（Node.js 22+ / Fastify 5 / PostgreSQL 16 / Kysely / systemd）

本文是**当前有效**的部署说明。仓库里任何提到 FastAPI / uvicorn / Python 后端的文字都属于历史说明或对错误格式的描述
（`error.details` 沿用 FastAPI 风格的 `[{loc,msg}]`），不是本项目的运行时依赖。

## 0. 拓扑

| 域名 | 静态根 | 说明 |
| --- | --- | --- |
| `https://entroaxiom.com` | `/srv/entroaxiom/site` | 前台站点（Vite/React 产物，history 路由） |
| `https://admin.entroaxiom.com` | `/srv/entroaxiom/admin` | 后台（`pnpm build:admin:subdomain` 产物，hash 路由） |

- 两个域名的 `/api/` 都反代到同一个 `127.0.0.1:8000`（Node/Fastify 只监听本机）。
- `/uploads/public/` 在两个域名下都只读提供；`/uploads/private/` 在两个域名下都直接 404。
- 会话 Cookie `sid` 是 **host-only**（后端不设 `Domain`），所以两个域名各自持有自己的会话，但指向同一份数据。
- 后端 `PUBLIC_ORIGIN=https://entroaxiom.com`，`ALLOWED_ORIGINS=https://admin.entroaxiom.com`（否则后台写请求会被 403）。
- Node 只监听 `127.0.0.1:8000`，公网入口只有 Nginx。

## 1. 目录、属主与权限（先建好，再装服务）

后端 systemd 单元用了 `ProtectSystem=strict` + `ReadWritePaths`，**下面这些路径必须提前存在**，否则服务会因为沙箱无法挂载/写入而启动失败。

| 路径 | 属主:属组 | 权限 | 用途 |
| --- | --- | --- | --- |
| `/etc/entroaxiom` | `root:root` | `750` | 存放生产 env 文件，只有 root 可进 |
| `/etc/entroaxiom/api.env` | `root:root` | `600` | **唯一**的生产配置来源（systemd `EnvironmentFile`） |
| `/srv/entroaxiom/api` | `entroaxiom:entroaxiom` | `750` | 后端源码 + `dist/` + `node_modules/` + `deploy/` |
| `/srv/entroaxiom/site` | `root:root`（Nginx 只读） | `755` | 前台静态产物 |
| `/srv/entroaxiom/admin` | `root:root`（Nginx 只读） | `755` | 后台静态产物 |
| `/srv/entroaxiom/shared/uploads/public` | `entroaxiom:entroaxiom` | `750` | 公开上传（Nginx 只读提供） |
| `/srv/entroaxiom/shared/uploads/private` | `entroaxiom:entroaxiom` | `700` | 私密上传（Nginx 永不提供，只走鉴权接口） |
| `/srv/entroaxiom/shared/imports` | `entroaxiom:entroaxiom` | `750` | ZIP/单文件导入的临时解包目录 |
| `/srv/entroaxiom/shared/backups` | `entroaxiom:entroaxiom` | `700` | 备份快照根目录 |
| `/var/log/entroaxiom` | `entroaxiom:entroaxiom` | `750` | api.log / backup.log（logrotate 目标） |

```bash
sudo install -d -m 750 -o root -g root /etc/entroaxiom
sudo useradd --system --home /srv/entroaxiom --shell /usr/sbin/nologin entroaxiom
sudo install -d -m 750 -o entroaxiom -g entroaxiom /srv/entroaxiom/api
sudo install -d -m 755 -o root -g root /srv/entroaxiom/site /srv/entroaxiom/admin
sudo install -d -m 750 -o entroaxiom -g entroaxiom /srv/entroaxiom/shared
sudo install -d -m 750 -o entroaxiom -g entroaxiom /srv/entroaxiom/shared/uploads/public
sudo install -d -m 700 -o entroaxiom -g entroaxiom /srv/entroaxiom/shared/uploads/private
sudo install -d -m 750 -o entroaxiom -g entroaxiom /srv/entroaxiom/shared/imports
sudo install -d -m 700 -o entroaxiom -g entroaxiom /srv/entroaxiom/shared/backups
sudo install -d -m 750 -o entroaxiom -g entroaxiom /var/log/entroaxiom
touch /tmp/_check && sudo install -m 640 -o entroaxiom -g entroaxiom /dev/null /var/log/entroaxiom/api.log && rm /tmp/_check
sudo install -m 640 -o entroaxiom -g entroaxiom /dev/null /var/log/entroaxiom/backup.log
```

> `UPLOAD_ROOT` / `IMPORT_ROOT` / `BACKUP_ROOT` 都指向 `/srv/entroaxiom/shared/*`，
> 所以单元里的 `ReadWritePaths=/srv/entroaxiom/shared /var/log/entroaxiom` 已经覆盖它们，
> **不需要**再给 `/srv/entroaxiom/api/var` 开写权限（那个目录不存在时沙箱会让服务起不来）。

## 2. 安装 PostgreSQL 16

```bash
# Debian/Ubuntu，使用 PGDG 官方源，确保拿到 16.x 而不是发行版自带的旧版本
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt update && sudo apt install -y postgresql-16 postgresql-client-16
```

2C2G 机器的建议参数（`/etc/postgresql/16/main/conf.d/entroaxiom.conf`）：

```ini
shared_buffers = 256MB
max_connections = 30
effective_cache_size = 768MB
work_mem = 8MB
maintenance_work_mem = 64MB
```

## 3. 建库与最小权限用户

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE entroaxiom LOGIN PASSWORD '换成强口令';
CREATE DATABASE entroaxiom OWNER entroaxiom ENCODING 'UTF8' TEMPLATE template0;
\c entroaxiom
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO entroaxiom;
SQL
```

> 本项目**不做** SQLite → PostgreSQL 的数据迁移。旧 SQLite 只做离线备份（`sqlite3 old.db ".backup old-$(date).db"` 并记下
> `sha256sum`），旧后端与旧上传目录保持原样，不删除、不覆盖。

## 4. 生产 env：`/etc/entroaxiom/api.env`

```bash
sudo install -m 600 -o root -g root /dev/null /etc/entroaxiom/api.env
sudoedit /etc/entroaxiom/api.env
```

以仓库 `.env.example` 为模板，生产**必须**显式设置的项：

```ini
NODE_ENV=production
PORT=8000
PUBLIC_ORIGIN=https://entroaxiom.com
ALLOWED_ORIGINS=https://admin.entroaxiom.com
DATABASE_URL=postgres://entroaxiom:强口令@127.0.0.1:5432/entroaxiom
SESSION_SECRET=<openssl rand -base64 48>
IP_HASH_SECRET=<openssl rand -base64 32>
UPLOAD_ROOT=/srv/entroaxiom/shared/uploads
IMPORT_ROOT=/srv/entroaxiom/shared/imports
BACKUP_ROOT=/srv/entroaxiom/shared/backups
LOG_LEVEL=info
# 只有 Node 只监听 127.0.0.1、前面确实是本机 Nginx 时才打开（代码默认 false）
TRUST_PROXY=true
```

- 生产缺失 `SESSION_SECRET` / `IP_HASH_SECRET` / `DATABASE_URL` 时进程直接退出（`src/config.ts` 启动即校验），不会用开发默认值顶替。
- `ADMIN_PASSWORD` **不要**常驻在这个文件里：它只用于一次性初始化，用完就删（见第 5 步）。
- `TRUST_PROXY` 代码默认 `false`：直连 Node 端口时客户端可以随便写 `X-Forwarded-For`，
  一旦被信任，留言与登录限流就会按伪造 IP 计数。生产环境因为 Node 只监听 `127.0.0.1`
  且请求一定经过本机 Nginx，才显式设成 `true`；不要在没有反代的机器上打开。
- 刷新凭证只认 HttpOnly 的 `sid`：`/api/admin/refresh-token` 读的是 Cookie，
  不接受请求体里的 `refreshToken`；`/login` 返回的 `accessToken`/`refreshToken`
  只是给前端存放的占位串，与 `sid` 无关，也不是服务端凭证。
- 公开上传目录的缓存是 `Cache-Control: public, max-age=300`（Nginx 与 Node 静态一致）。
  公开文件的 URL 不随可见性变化，所以把文件改回私密后，浏览器/CDN 里可能还会保留到
  TTL 结束；要立即生效需要版本化 URL + CDN purge 或签名 URL。
- 文章删除是**硬删除**（直接删行），不提供回收站/恢复接口；只有 `files` 表有
  `deleted_at` 这一列。文档里不要把它描述成软删除。
- Node 不会自己读取 `.env`。systemd 通过 `EnvironmentFile=/etc/entroaxiom/api.env` 注入；
  手工执行命令时用第 5 步的 `set -a; . /etc/entroaxiom/api.env; set +a` 载入，不要以为在 `/srv/entroaxiom/api` 放个 `.env` 就生效。

## 5. 放置源码、装依赖、迁移、建管理员、构建

```bash
# 1) 把后端源码放到 /srv/entroaxiom/api（git clone 或解压 zip 均可）
sudo -u entroaxiom -s /bin/bash -c 'cd /srv/entroaxiom/api && git clone <仓库地址> .'   # 或 unzip 后 chown
sudo -u entroaxiom -s /bin/bash

cd /srv/entroaxiom/api
node --version                 # 建议 >= 22.13（package.json engines >= 22.0.0）
npm ci                         # 含 devDependencies：迁移 / admin:init / build 都要 tsx

set -a; . /etc/entroaxiom/api.env; set +a      # 把所有生产配置载入当前 shell
npm run migrate                # 建表；可重复执行，已应用的迁移按 checksum 跳过
npm run admin:password          # 生成一个 16 位口令（表单只收 8–18 位，别用 openssl rand -base64）
npm run admin:init -- --username 站长用户名     # 交互式隐藏输入口令（不回显、不进 shell 历史）
npm run build                  # tsc → dist/
```

- 迁移与 `admin:init` 需要 `tsx`，所以必须先 `npm ci`（**不要**写成 `npm ci --omit=dev=false` 那种自相矛盾的写法）。
- 只有当你确定以后不再在原目录执行迁移/初始化脚本时，才可以 `npm prune --omit=dev` 收缩 `node_modules`；
  否则请保留 devDependencies，`dist/` 本身运行时不依赖它们。
- **不要**为了让某个迁移"重新跑"去修改已发布的 `src/db/migrations/*.sql`。迁移版本 + checksum 记录在 `schema_migrations` 表里，
  改内容只会被检测为"已应用但校验和不一致"并告警跳过。需要改结构就新增一个迁移文件。
- 口令长度必须落在 **8–18 位**、至少两类字符：后台登录页的表单校验比接口更严，
  `openssl rand -base64 24` 得到的 32 位口令接口能登、网页却提交不上去（这是线上真实踩过的坑）。
  用 `npm run admin:password` 生成；`admin:init` 也会直接拒绝超长口令并说明原因。
- `npm run admin:init` 支持 `--username/--nickname/--force`；不给 `--password` 时在 TTY 里**隐藏输入并二次确认**。
  非交互环境（CI/脚本）没有口令会直接报错退出，不会创建弱口令账号；`--force` 只重置已存在账号的口令。

## 6. systemd：API 服务 + 备份定时器

```bash
sudo cp /srv/entroaxiom/api/deploy/entroaxiom-api.service /etc/systemd/system/
sudo cp /srv/entroaxiom/api/deploy/entroaxiom-backup.service /etc/systemd/system/
sudo cp /srv/entroaxiom/api/deploy/entroaxiom-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now entroaxiom-api
sudo systemctl enable --now entroaxiom-backup.timer
sudo systemctl status entroaxiom-api --no-pager
systemctl list-timers entroaxiom-backup.timer
```

- 服务以非 root 的 `entroaxiom` 用户运行、`Restart=on-failure`、`UMask=0027`、`--max-old-space-size=384`（2C2G）。
- 单元里的 `ExecStart=/usr/bin/node` 是 Debian/Ubuntu 上 `apt` 安装的路径；换机器前先 `command -v node` 确认，
  用 nvm/asdf 安装的 Node 路径不同，需要同步修改单元。
- 日志写 `/var/log/entroaxiom/api.log`、`/var/log/entroaxiom/backup.log`；`deploy/logrotate.conf` 按日轮转保留 14 天：
  `sudo cp /srv/entroaxiom/api/deploy/logrotate.conf /etc/logrotate.d/entroaxiom`
- `entroaxiom-backup.timer` 每天 03:30（`RandomizedDelaySec=600`）触发 `entroaxiom-backup.service`，
  后者用 `flock` 防重入。排查备份失败：`journalctl -u entroaxiom-backup -n 100` + `tail /var/log/entroaxiom/backup.log`。

## 7. 前端产物与 Nginx

```bash
# 前台（在 site 仓库里）
npm ci && npm run build          # 产物 dist/ → /srv/entroaxiom/site
sudo rsync -a --delete dist/ /srv/entroaxiom/site/

# 后台（在 admin 仓库里）
pnpm install --frozen-lockfile
pnpm build:admin:subdomain       # 独立子域名：VITE_PUBLIC_PATH=/、hash 路由，产物 dist/ → /srv/entroaxiom/admin
sudo rsync -a --delete dist/ /srv/entroaxiom/admin/
# 若改为 https://entroaxiom.com/admin/ 子路径：改用 pnpm build:admin（VITE_PUBLIC_PATH=/admin/）
```

> `rsync --delete` **只对各自的静态目录**使用，绝对不要对 `/srv/entroaxiom/shared` 使用 `--delete`——那里是上传与备份。

```bash
sudo cp /srv/entroaxiom/api/deploy/nginx.conf /etc/nginx/conf.d/entroaxiom.conf
sudo nginx -t && sudo systemctl reload nginx
```

Nginx 要点（已写在 `deploy/nginx.conf` 里）：

- 两个独立 `server` 块，各自代理 `/api/`，保留 `Host` / `X-Real-IP` / `X-Forwarded-For` / `X-Forwarded-Proto` / `Cookie`，
  `proxy_read_timeout 180s` 以覆盖导入预览。
- `/uploads/public/` 只读静态、`autoindex off`；`/uploads/private/` 与 `/uploads/` 显式 `return 404`。
- `/uploads/{public,private}/**.svg|svgz` 用正则 location 直接 `return 404`（正则优先于前缀 location），
  所以历史遗留 SVG 即使还在磁盘上也拿不到；站点根自己的 `favicon.svg` 不受影响。
- 任何 location 里只要写了 `add_header`，就不会再继承上层的头，所以 `X-Content-Type-Options: nosniff` 在每个 location 里重复声明。
- 不给 `/api/` 配 `Access-Control-Allow-Origin: *`。

### 证书（Cloudflare 代理场景）

源站前面挂了 Cloudflare 代理（橙云）时，HTTP-01 照样能用：Cloudflare 会把
`/.well-known/acme-challenge/` 透传到源站。所以用 webroot 签发与续期最省事，
不需要 DNS 插件，也不要去动 Cloudflare 的 API Token。

```bash
sudo mkdir -p /var/www/html/.well-known/acme-challenge
sudo certbot certonly --webroot -w /var/www/html \
  -d entroaxiom.com -d www.entroaxiom.com -d admin.entroaxiom.com \
  --cert-name entroaxiom.com --non-interactive --agree-tos
# 演练续期（真正验证 .well-known 能被公网拿到）
sudo certbot renew --cert-name entroaxiom.com --webroot -w /var/www/html --dry-run
```

一张多 SAN 证书即可覆盖三个域名，`deploy/nginx.conf` 里三个 `server` 块共用
`/etc/letsencrypt/live/entroaxiom.com/`。续期由 certbot 自带的 snap timer 完成，
签发命令会被记进 `/etc/letsencrypt/renewal/entroaxiom.com.conf`。
## 8. 验证

```bash
curl -fsS http://127.0.0.1:8000/healthz   # {"status":"ok",...}
curl -fsS http://127.0.0.1:8000/readyz    # {"status":"ready","database":"ok"}；数据库不可用时 503

curl -fsS https://entroaxiom.com/api/public/notes | head -c 200
curl -fsSI https://entroaxiom.com/uploads/private/anything.png     # 期望 404
curl -fsSI https://admin.entroaxiom.com/uploads/private/anything.png  # 期望 404
curl -fsSI https://entroaxiom.com/uploads/public/图片.svg          # 期望 404（历史 SVG 被阻断）
curl -fsS https://admin.entroaxiom.com/ | head -c 200              # 后台 HTML，资源引用 /static/...
```

浏览器验收：前台能读文章/书架/留言；后台登录后 cookie `sid` 为 `HttpOnly; Secure; SameSite=Strict`；
上传 >64KB 的图片时 `visibility` 与请求一致（这是 2026-11-01 修复的 P0 回归点）。

## 9. 备份与恢复

备份由 `entroaxiom-backup.timer` 驱动，**每次生成一个独立时间戳快照**：

```text
/srv/entroaxiom/shared/backups/daily/20261101-033000/
├── database.dump        # pg_dump --format=custom，含 schema 与数据
├── uploads/public/      # 与该时间点一致的公开上传
├── uploads/private/     # 与该时间点一致的私密上传
└── manifest.txt         # 时间戳 / 库名 / PG 版本 / 上传源路径 / 文件数 / sha256 / result=ok
```

- 只有 `database.dump` 通过 `pg_restore --list`、`sha256sum` 校验、`manifest.txt` 写完，临时目录才会原子改名成正式快照；
  中途失败会清理临时目录，不会留下"看起来成功"的半成品。
- 保留 `KEEP_DAILY=7` 个日备 + `KEEP_WEEKLY=4` 个周备（周日用 `rsync --link-dest` 生成硬链接快照省空间），按快照目录整体清理。
- 备份目录里**不放** `.env`、Cookie、私钥；脚本最后会自检并报错退出。
- 手动跑一次（验证 timer 配置正确）：
  ```bash
  sudo systemctl start entroaxiom-backup.service
  sudo systemctl status entroaxiom-backup.service --no-pager
  sudo ls -l /srv/entroaxiom/shared/backups/daily/
  sudo cat /srv/entroaxiom/shared/backups/daily/<最新>/manifest.txt
  ```
- 恢复步骤见 `deploy/RESTORE.md`（库与文件必须来自**同一个时间戳快照**，先恢复到隔离环境验证再回生产）。RTO 4h / RPO 24h。
- 若不用 systemd timer，也可以用 crontab，但必须自己提供环境变量并避开重入：
  `30 3 * * * set -a; . /etc/entroaxiom/api.env; set +a; /usr/bin/flock -w 3600 /run/entroaxiom-backup.lock /srv/entroaxiom/api/deploy/backup.sh >> /var/log/entroaxiom/backup.log 2>&1`

**一致性边界**：`pg_dump` 与 `rsync` 不是同一个原子事务。忙时上传的文件可能出现在 dump 里但文件还没落盘（或反之），
表现为极少数快照里"正文引用了某张图但文件缺失"。要做到严格一致需要停写或应用级锁，本项目**没有**做这件事；
如果你需要零差异快照，请在低峰期备份，或在备份窗口内把服务切到维护模式。

## 10. 历史 SVG 的处理

上传接口已经拒收 SVG（`UNSUPPORTED_TYPE`），旧上传目录里可能还留着 2026-11-01 之前的 `.svg` / `.svgz`。

```bash
# 只读盘点（不会删改任何文件）
sudo UPLOAD_ROOT=/srv/entroaxiom/shared/uploads /srv/entroaxiom/api/deploy/find-legacy-svg.sh
```

处置顺序：

1. **先备份**：`sudo rsync -a /srv/entroaxiom/shared/uploads/ /path/to/offline-backup/uploads/`
2. Nginx 已经在两个域名上把所有 `/uploads/**/**.svg|svgz` 返回 404，所以这些文件无法被当作同源文档执行——这一步不需要额外操作。
3. 有业务引用的（正文/封面里还能点开的）：转成 PNG/WebP 后重新上传，并把引用改成新的 `asset:<fileId>`。
4. 无法安全转换的（含脚本、外部引用、字体等）：保持隔离（继续 404），把文件清单登记进工单人工处理。
5. **不要**批量删除：这些是用户的历史内容，删除应由内容所有者决定。

## 11. 正式上线前必须在真 PG16 上重跑

本仓库的集成测试默认跑在 PGlite（PostgreSQL 18 内核的 WASM 构建）上，因为开发机无法创建 PostgreSQL 数据目录；
`concurrency.test.ts` 里三条真实竞争用例在 PGlite 下会自动跳过（`pglite-socket` 只支持单连接，无法制造竞争）。
PGlite 不能冒充 PG16 实机验收。上线前请在目标机器的 PG16 上执行：

```bash
cd /srv/entroaxiom/api
set -a; . /etc/entroaxiom/api.env; set +a
DATABASE_URL=postgres://entroaxiom:...@127.0.0.1:5432/entroaxiom_test \
PG_REAL_INTEGRATION=1 PG_POOL_MAX=5 \
npm run test:all
```

期望：`unit` 全过、`acceptance`/`repair`/`publish-decisions` 全过、`concurrency` 的三条并发用例**不再跳过**且全过。
若要在 CI 里加真实 PG16，可用 `services: postgres:16` 的 GitHub Actions job，命令同上（另需 `npm ci`）。