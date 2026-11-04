# EntroAxiom 后端

站点 <https://entroaxiom.com> 与后台 <https://admin.entroaxiom.com> 共用的 API 服务：TypeScript + Fastify 5 + PostgreSQL 16 + 本地磁盘，一套进程同时提供公开接口 `/api/public/*` 与后台接口 `/api/admin/*`。

![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a)
![TypeScript](https://img.shields.io/badge/typescript-5.9-3178c6)
![Fastify](https://img.shields.io/badge/fastify-5-000000)
![PostgreSQL](https://img.shields.io/badge/postgresql-16-336791)
![Tests](https://img.shields.io/badge/tests-21%20unit%20%2B%2063%20integration-brightgreen)

## 三个仓库

| 仓库 | 作用 | 技术栈 |
| --- | --- | --- |
| **entroaxiom-backend**（本仓库） | 公开 API + 后台 API、业务规则、存储、备份 | TypeScript · Fastify 5 · PostgreSQL 16 |
| [entroaxiom-site](https://github.com/xingguangchenyuan/entroaxiom-site) | 前台站点（星仪主题） | React 18 · Vite · TypeScript |
| [entroaxiom-admin](https://github.com/xingguangchenyuan/entroaxiom-admin) | 内容管理后台 | Vue 3 · Vite · Element Plus |

两个前端只通过 HTTP 与这里交互，没有共享代码。契约以 `entroaxiom-site/docs/API.md`、`entroaxiom-admin/docs/ADMIN_API.md` 为准，两者与本仓库实现冲突时以前端文档为准。

## 能做什么

- **内容**：随笔与学习笔记的草稿、发布、撤回；发布生成不可变快照，撤回后线上正文立刻消失而草稿仍在。
- **版本**：手动保存、发布、导入覆盖、历史恢复各留一份版本，可回滚到任意一版。
- **文件**：公开/私密两种可见性，引用追踪；发布时逐个决定私密资源 `keep-private` / `copy-public` / `make-public`。
- **留言**：IP 只存 HMAC 哈希，滑动窗口限流 + 规则命中审核，站长回复。
- **导入导出**：ZIP/Markdown 导入（沙箱解压、冲突预演），md/zip 导出（含引用资源与清单）。
- **运维**：`/healthz`、`/readyz`、每日 `pg_dump` 备份脚本、systemd 单元、Nginx 配置。

## 技术栈

TypeScript 5 · Fastify 5 · Kysely（类型安全 SQL，无 ORM）· PostgreSQL 16 · Argon2id（`@node-rs/argon2`）· pino 日志 · `node:test` 测试 · PGlite 做无服务端集成测试。

设计约束：路由层只做参数解析与身份映射，事务、乐观锁、业务规则全部在 `src/services/`；迁移是可审阅的纯 SQL，只前进不 drop。

## 目录

```
src/
  app.ts              组装（配置 → 日志 → 数据库 → 插件 → 路由）
  server.ts           进程入口（校验配置、监听 127.0.0.1:8000、优雅关闭）
  config.ts           环境变量校验，生产缺失即退出
  context.ts          请求无关的运行时上下文（config/db/pool/logger）
  http/               信封、错误码、字段校验、二进制响应、multipart 读取
  plugins/            errors / auth / multipart / security / static
  routes/public/      公开路由（无鉴权）
  routes/admin/       后台路由（除 login / refresh-token / logout 外都要会话）
  services/           事务、乐观锁、业务规则都在这一层
  lib/                crypto / ids / markdown / frontmatter / mime / zip / time / password-policy / rate-limit
  db/                 Kysely 表类型、连接、迁移器、SQL 迁移
  scripts/            migrate.ts、create-admin.ts、new-password.ts
tests/unit/           纯函数测试（21 条）
tests/integration/    PGlite 起的真 PostgreSQL + 真 HTTP 验收（63 条）
deploy/               nginx / systemd / logrotate / 备份与恢复演练
docs/                 部署手册、验收清单、上线记录
```

## 快速开始

```bash
npm ci
cp .env.example .env                       # 至少改 DATABASE_URL / SESSION_SECRET / IP_HASH_SECRET
npm run migrate                            # 建表（只前进，不 drop）
npm run admin:password                     # 打印一个 16 位口令（后台登录表单只收 8–18 位）
npm run admin:init -- --username admin --nickname 站长   # 交互式隐藏输入上面那个口令
npm run dev                                # 开发：tsx watch
npm run build && npm start                 # 生产：node dist/server.js
```

- 迁移失败会整体回滚并打印 `迁移 <version> 执行失败：…`；已应用迁移的校验和被改动时只告警、不重跑。
- `admin:init` 遇到同名用户默认拒绝，确需重置口令加 `--force`。
- 口令必须 **8–18 位、至少两类字符**——后台登录页有前端校验，超长口令接口能登但网页提交不上去，所以用 `admin:password` 生成。
- 2C2G 机器上用 `node --max-old-space-size=384 dist/server.js`。

常用脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | `tsx watch src/server.ts` |
| `npm run build` / `npm start` | 编译到 `dist/` / 运行编译产物 |
| `npm run migrate` | 应用 `src/db/migrations/` 下未执行的迁移 |
| `npm run admin:init` / `npm run admin:password` | 建管理员 / 生成合规口令 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` / `npm run test:integration` / `npm run test:all` | 单元 / 集成 / 全部 |

## 配置

生产只有一个来源：`/etc/entroaxiom/api.env`（`600 root:root`，由 systemd `EnvironmentFile` 载入）。Node 不读 `.env`，手工跑迁移时用 `set -a; . /etc/entroaxiom/api.env; set +a`。

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `NODE_ENV` | `development` / `production` / `test` | `development` |
| `PORT` | 监听端口，只绑 `127.0.0.1` | `8000` |
| `PUBLIC_ORIGIN` | 前台地址，决定 cookie `Secure` 与 Origin 校验 | 必填 |
| `ALLOWED_ORIGINS` | 额外允许来源（逗号分隔），后台独立子域时**必须**写 | 空 |
| `DATABASE_URL` | PostgreSQL 连接串 | 必填 |
| `PG_POOL_MAX` | 连接池上限（2C2G 建议 10） | `10` |
| `SESSION_SECRET` | 会话密钥，≥32 字节 | 必填 |
| `SESSION_TTL_HOURS` / `SESSION_IDLE_HOURS` | 会话总时长 / 空闲失效 | `168` / `24` |
| `PASSWORD_HASH_MEMORY_KIB` | Argon2id 内存 | `65536` |
| `UPLOAD_ROOT` / `IMPORT_ROOT` / `BACKUP_ROOT` | 存储根目录 | `./var/*` |
| `MAX_BODY_BYTES` / `MAX_FILE_BYTES` | JSON 体积 / 单文件上限 | 2 MB / 50 MB |
| `MAX_ARCHIVE_BYTES` / `MAX_EXPANDED_BYTES` / `MAX_ARCHIVE_ENTRIES` | ZIP 归档 / 展开 / 条目上限 | 40 MB / 200 MB / 2000 |
| `IP_HASH_SECRET` | 留言 IP 的 HMAC 密钥（换掉即失去历史可比性） | 必填 |
| `TRUST_PROXY` | 是否信任反代传来的 `X-Forwarded-For` | `false` |
| `LOG_LEVEL` | pino 级别 | `info` |

## API 约定

- 基址：生产 `https://<域名>/api`；开发 `http://127.0.0.1:8000/api`。
- 信封：`{"success":true,"data":…,"error":null}` 或 `{"success":false,"data":null,"error":{"code","message","details"}}`，业务失败一律 4xx/5xx，绝不包成 200。
- 字段 camelCase；分页参数是 `page`、`page_size`；日期 `YYYY-MM-DD`；时间为带时区 ISO 8601。
- 乐观锁：写 JSON 带 `baseRevision`，`DELETE` 带 `If-Match: <revision>`；冲突返回 409 `REVISION_CONFLICT` 且 `data.currentRevision` 给出当前版本，绝不静默覆盖。
- 删除语义：文章/书架/留言是**硬删除**（不留回收站）；只有 `files` 表有 `deleted_at`。
- 错误码：`VALIDATION_ERROR`、`INVALID_CREDENTIALS`、`INVALID_REFRESH_TOKEN`、`UNAUTHORIZED`、`SESSION_EXPIRED`、`FORBIDDEN`、`NOT_FOUND`、`REVISION_CONFLICT`、`FILE_IN_USE`、`CONTENT_REJECTED`、`CHECK_EXPIRED`、`CHECK_MISMATCH`、`CONFIRM_REQUIRED`、`DUPLICATE_ID`、`DUPLICATE_RULE`、`NOT_PUBLISHED`、`IMPORT_EXPIRED`、`ARCHIVE_TOO_LARGE`、`ENTRY_UNREADABLE`、`UNSUPPORTED_TYPE`、`FILE_TOO_LARGE`、`RATE_LIMITED`、`INTERNAL_ERROR`。

## 鉴权与安全

- 唯一凭证是 HttpOnly cookie `sid`（`Secure`、`SameSite=Strict`、`Path=/`），服务端只存 `sha256(sid)`；7 天有效、24 小时空闲失效；刷新即轮换旧会话。
- 服务端**不接受** `Authorization: Bearer`：`/login` 与 `/refresh-token` 返回的 `accessToken` / `refreshToken` 只是给前端存放的占位串，与 `sid` 无关。
- `/api/admin/refresh-token` 只读 Cookie 里的 `sid`，请求体里的 `refreshToken` 不是凭证。
- 后台非 GET 请求校验 `Origin`（缺失退回 `Referer`）必须命中 `PUBLIC_ORIGIN` / `ALLOWED_ORIGINS`；`/api/admin/*` 永不返回 `Access-Control-Allow-Origin: *`。
- `TRUST_PROXY` 默认 `false`：不在反代后面时打开它，客户端就能伪造 `X-Forwarded-For` 绕过留言/登录限流。
- 口令 Argon2id；用户不存在时也跑一次假校验，避免用时间差枚举账号。
- 登录失败限流 10 次/IP/5 分钟；留言 5 次/10 分钟、30 次/天，10 分钟内重复内容直接拒绝。
- 留言 IP 只存 `HMAC-SHA256(IP_HASH_SECRET, ip)`；公开接口不返回邮箱、IP、审核证据。

## 文件

- 公开文件地址固定为 `/uploads/public/<fileId>.<ext>`；物理文件名是服务端生成的 `storage_key`，从不采用客户端文件名。
- 私密文件放在 `UPLOAD_ROOT/private/`，Nginx 不为该路径建 location（`deploy/nginx.conf` 里显式 `return 404`）。
- 删除仍被引用的文件返回 409 `FILE_IN_USE`，`error.details` 列出引用位置。
- 公开文件缓存 `public, max-age=300`（Nginx 与 Node 一致）：URL 不随可见性变化，撤回后浏览器/CDN 可能保留到 TTL 结束。
- 物理文件"先准备、后提交、提交后再清理"：事务提交前不删旧文件，提交成功后才清；清理失败只留孤儿文件并写 `error` 日志（含 `fileId`/`storageKey`/`operation`，不含口令或 Cookie）。
- 上传超限 413 `FILE_TOO_LARGE`；扩展名/MIME 不在白名单 422 `UNSUPPORTED_TYPE`；SVG 与伪装成图片的 SVG/HTML 一律拒绝。

## 发布流程

1. `POST /api/admin/articles/{res}/{id}/publication-check`（书架同名接口）→ 返回 `checkId`、`checks`、`assetDecisions`、`canProceed`。
2. `checkId` 绑定：用户 + 对象 + 动作 + 目标可见性 + `baseRevision` + 排序后的私密资源集合，5 分钟过期，校验与消费在同一事务内完成。
3. `POST …/publish` 必须带 `confirmed:true`，否则 409 `CONFIRM_REQUIRED`；`checkId` 过期 409 `CHECK_EXPIRED`、不匹配 409 `CHECK_MISMATCH`。
4. 资源三选一：`keep-private`（正文图片变 `*[图片未公开：alt]*`、链接降级为文字）、`copy-public`（生成公开副本，原文件不动）、`make-public`（原文件转公开）。不传决策一律按 `keep-private`。
5. 发布在单事务内完成：写快照（`public_body` 已解析 `asset:`）+ 更新发布字段与 revision + 重写引用行 + 审计，并留一份 `source=publish` 的版本。

`targetVisibility` 省略时只发快照、不改可见性；改可见性是独立动作，同样要先做预检（`action:"visibility"`）。

## 导入与导出

- `POST /api/admin/imports/preview` 接受 `.md` 或 `.zip`（≤40 MB 归档、≤200 MB 展开、≤2000 条目），返回候选、资源匹配状态、冲突与警告。
- 解压只发生在临时目录，拒绝绝对路径、`..`、盘符、符号链接/硬链接、加密与嵌套归档；Markdown 必须能按 UTF-8 读取，否则 422 `ENTRY_UNREADABLE`。
- 默认只导入正文实际引用的资源；`includeUnreferencedPaths` 可显式追加。提交时 create 尊重显式 id，update 必须先存版本再覆盖，导入永不自动发布。
- 导出：`?source=working|published&format=md|zip`，文件名走 `Content-Disposition: attachment; filename*=UTF-8''…`；zip 内含 md、`assets/` 与 `README.txt` 清单；出错仍是 JSON 信封。

## 测试

```bash
npm test                    # 单元：slug、资源占位符、frontmatter、zip 路径安全、口令策略、限流、LIKE 转义
npm run test:integration    # 集成：PGlite 起真 PostgreSQL + 真 HTTP 全链路
npm run typecheck
```

- 单元 21 条；集成 63 条（本地 60 通过 / 3 跳过）。
- 跳过的 3 条是**真并发**用例（并发刷新、并发保存同一 revision、并发发布同一 checkId）：`pglite-socket` 只接受单连接，`PG_POOL_MAX` 只能设 1，请求被串行化后测不出竞争，需要 `PG_REAL_INTEGRATION=1 PG_POOL_MAX=5` 且后端是真实 PostgreSQL。
- 上线前已在生产机（Node 22 + PostgreSQL 16.15）以 `PG_REAL_INTEGRATION=1` 跑完整集成：61/61 通过、0 跳过（当时用例数 61，之后的版本历史用例只在本地跑过）。
- 覆盖范围：登录/日志与 HttpOnly cookie、草稿不可见→发布可见→撤回消失、409 版本冲突、公开图片与私密 PDF 可见性、`FILE_IN_USE`、留言拦截与公开载荷脱敏、Markdown/zip 导出、发布资源决策、版本历史与恢复、日期列时区、越界分页、ZIP 嵌套引用。

## 部署

完整手册见 [`docs/DEPLOY.md`](docs/DEPLOY.md)，实际生产记录（规格、目录、偏离项、上线后发现并修掉的问题；公网 IP 与运维账号已隐去）见 [`docs/DEPLOYMENT-RECORD.md`](docs/DEPLOYMENT-RECORD.md)。

拓扑：两个域名共用一套后端。

- 前台 `https://entroaxiom.com` → `/srv/entroaxiom/site`（history 路由）
- 后台 `https://admin.entroaxiom.com` → `/srv/entroaxiom/admin`（hash 路由）
- 两个域名都把 `/api/` 反代到 `127.0.0.1:8000`；`PUBLIC_ORIGIN=https://entroaxiom.com`，`ALLOWED_ORIGINS` 必须含 `https://admin.entroaxiom.com`，否则后台写请求全 403。
- `/uploads/public/` 两边只读提供，`/uploads/private/` 与 `/uploads/` 显式 404。

`deploy/` 下：

- `nginx.conf`：两个独立 `server` 块 + `www` 的 301、`/api/` 反代、`/uploads/public/` 只读静态且 `autoindex off`、`/uploads/private/` 与 `/uploads/` 直接 404、`/uploads/**/**.svg|svgz` 正则阻断、SPA 回退、`/assets/`（前台）与 `/static/`（后台）长缓存 + `index.html` 不缓存。
- `entroaxiom-api.service`：非 root、`Restart=on-failure`、`ProtectSystem=strict`、`UMask=0027`、`--max-old-space-size=384`。
- `entroaxiom-backup.service` + `.timer`：每天 03:30 触发（`flock` 防重入、`RuntimeDirectory=entroaxiom` 放锁文件）。
- `backup.sh`：每次生成独立时间戳快照 `BACKUP_ROOT/daily/<YYYYMMDD-HHMMSS>/{database.dump,uploads/public,uploads/private,manifest.txt}`，先写临时目录、校验后原子改名；保留 7 日备 + 4 周备（周备用 `rsync --link-dest`）。
- `RESTORE.md`：从同一时间戳快照恢复到隔离环境、逐项验证后再回生产。
- `logrotate.conf`：按日轮转保留 14 天。

`/healthz` 只报告进程存活；`/readyz` 会真的 `select 1`，失败返回 503。

## 文档

| 文件 | 内容 |
| --- | --- |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | 从空机器到上线：PG16、目录权限、env、构建、systemd、Nginx、证书、备份恢复 |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | 手工验收清单（ZIP 导入、备份演练、可见性矩阵） |
| [`docs/DEPLOYMENT-RECORD.md`](docs/DEPLOYMENT-RECORD.md) | 这台生产机的实际记录：规格、目录、与手册的偏离、上线后修复（公网 IP、账号与密钥文件名已隐去） |

## 与方案的差异、未实现项

有意的实现选择（代码里有注释）：

1. 公开接口读私密文件返回 404 而不是 `src:null`，避免通过列表泄露私密文件名。
2. 把文章可见性改成 public 也要先做一次 `publication-check`（`action:"visibility"`），与后台客户端的调用顺序一致。
3. 留言被规则命中时，公开 POST 响应统一报 `pending`，避免向试探者暴露规则是否生效；后台能看到真实 `blocked` 与证据。
4. 限流是进程内滑动窗口（单进程部署够用，键数上限 2 万自动淘汰），重启清零；多实例部署需换 Redis 或数据库计数。

未实现：邮件通知、缩略图、全文检索（方案未要求）。

风险：

- 导出的 zip 会把引用资源整份打包，超大资源会撑大响应，当前只受 `MAX_FILE_BYTES` 约束。
- 版本保留默认 20 份，超出即删；长期留档要额外接对象存储。
- `IP_HASH_SECRET` 一旦更换，历史 `ip_hash` 失去可比性（有意的不可逆设计）。
- 公开文件缓存 5 分钟，撤回后最长 5 分钟仍可能被 CDN/浏览器命中（Cloudflare 需要在面板把 Browser Cache TTL 设为 Respect Existing Headers，否则它会把 TTL 改写成 4 小时）。

## 许可

个人站点自用代码，未附开源许可证；引用或复用请先联系作者。
