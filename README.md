# Entroaxiom 后端（2026-11-01 方案实现）

TypeScript + Fastify 5 + PostgreSQL + 本地磁盘的站点后端，同时服务公开站点（`/api/public/*`）与后台管理端（`/api/admin/*`）。
方案原文见上级目录 `ENTROAXIOM-后端执行方案-20261101.md`；两份前端契约 `docs/API.md`、`docs/ADMIN_API.md` 冲突时以前端为准。

## 1. 目录

```
src/
  app.ts              组装（配置 → 日志 → 数据库 → 插件 → 路由）
  server.ts           进程入口（校验配置、监听 127.0.0.1:8000、优雅关闭）
  config.ts           环境变量校验，生产缺失即退出
  context.ts          请求无关的运行时上下文（config/db/pool/logger）
  http/               信封、错误码、字段校验、二进制响应
  plugins/            errors / auth / multipart / security / static
  routes/public/      公开路由（无鉴权）
  routes/admin/       后台路由（除 login/refresh-token 外全部要会话）
  services/           事务、乐观锁、业务规则都在这一层
  lib/                crypto / ids / markdown / frontmatter / mime / zip / time / passwords / rate-limit
  db/                 Kysely 表类型、连接、迁移器、SQL 迁移
  scripts/            migrate.ts、create-admin.ts
tests/unit/           纯函数测试
tests/integration/    PGlite 起的真 PostgreSQL + 真 HTTP 验收
deploy/               nginx / systemd / logrotate / 备份 / 恢复演练
```

## 2. 快速开始

```bash
npm ci
cp .env.example .env          # 改 DATABASE_URL、SESSION_SECRET、IP_HASH_SECRET
npm run migrate               # 建表（只前进，不 drop）
npm run admin:password            # 打印一个 16 位口令（后台登录表单只收 8–18 位）
npm run admin:init -- --username admin --nickname 站长   # 交互式隐藏输入上面那个口令
npm run dev                   # 开发：tsx watch
npm run build && npm start    # 生产：node dist/server.js
```

- 迁移失败会整体回滚并打印 `迁移 <version> 执行失败：…`；已应用迁移的校验和被改动时只告警、不重跑。
- `admin:init` 已存在同名用户时默认拒绝，确需重置口令加 `--force`。
- 管理员口令必须 **8–18 位、至少两类字符**：后台登录页有前端校验，超长口令接口能登但网页提交不上去。
  `npm run admin:password` 生成的就是这个区间内的 16 位随机口令。
- 生产用 `node --max-old-space-size=384 dist/server.js`（2C2G 机器）。

## 3. API 约定

- 基址：生产 `https://<域名>/api`；开发 `http://127.0.0.1:8000/api`。
- 信封：`{"success":true,"data":…,"error":null}` 或 `{"success":false,"data":null,"error":{"code","message","details"}}`。
  业务失败一律使用 4xx/5xx，绝不包成 200。
- 字段 camelCase；分页查询参数是 `page`、`page_size`；日期 `YYYY-MM-DD`；时间为带时区的 ISO 8601。
- 乐观锁：写 JSON 带 `baseRevision`，DELETE 带 `If-Match: <revision>`；
- 删除语义：文章/书架/留言的 `DELETE` 是**硬删除**（直接删行，不留回收站，也没有恢复接口）；
  只有 `files` 表有 `deleted_at` 列。文档不要把它写成软删除。
  冲突返回 409 `REVISION_CONFLICT` 且 `data.currentRevision` 给出当前版本，绝不静默覆盖。
- 错误码：`VALIDATION_ERROR`、`INVALID_CREDENTIALS`、`INVALID_REFRESH_TOKEN`、`UNAUTHORIZED`、`SESSION_EXPIRED`、
  `FORBIDDEN`、`NOT_FOUND`、`REVISION_CONFLICT`、`FILE_IN_USE`、`CONTENT_REJECTED`、`CHECK_EXPIRED`、`CHECK_MISMATCH`、
  `CONFIRM_REQUIRED`、`DUPLICATE_ID`、`DUPLICATE_RULE`、`NOT_PUBLISHED`、`IMPORT_EXPIRED`、`ARCHIVE_TOO_LARGE`、
  `ENTRY_UNREADABLE`、`UNSUPPORTED_TYPE`、`FILE_TOO_LARGE`、`RATE_LIMITED`、`INTERNAL_ERROR`。

## 4. 鉴权与安全

- 唯一凭证是 HttpOnly cookie `sid`（`Secure`、`SameSite=Strict`、`Path=/`），服务端只存 `sha256(sid)`；7 天有效、24 小时空闲失效；刷新即轮换旧会话。
- 服务端**不接受** `Authorization: Bearer`：`/login` 与 `/refresh-token` 返回的 `accessToken`/`refreshToken` 只是给前端存放的占位串，与 `sid` 无关。
- `/api/admin/refresh-token` 只读 Cookie 里的 `sid`：请求体里的 `refreshToken` 不是凭证，伪造一个也刷不出有效会话；空闲过期或已吊销的 `sid` 会直接 401 `INVALID_REFRESH_TOKEN` 且不下发新 Cookie。
- `TRUST_PROXY` 默认 `false`：不在反代后面时不要打开，否则客户端可以伪造 `X-Forwarded-For` 把留言/登录限流换成别的 IP。生产只在 Node 监听 `127.0.0.1` + 本机 Nginx 时设 `true`。
- 后台非 GET 请求校验 `Origin`（缺失退回 `Referer`）必须命中 `PUBLIC_ORIGIN`/`ALLOWED_ORIGINS`；`/api/admin/*` 永不返回 `Access-Control-Allow-Origin: *`。
- 口令 Argon2id（`PASSWORD_HASH_MEMORY_KIB` 控制内存）；用户不存在时也跑一次假校验，避免用时间差枚举账号。
- 登录失败限流 10 次/IP/5 分钟；留言 5 次/10 分钟、30 次/天，10 分钟内重复内容直接拒绝。
- 留言 IP 只存 `HMAC-SHA256(IP_HASH_SECRET, ip)`；公开接口不返回邮箱、IP、审核证据。

## 5. 文件

- 公开文件地址固定为 `/uploads/public/<fileId>.<ext>`；物理文件名是服务端生成的 `storage_key`，从不采用客户端文件名。
- 私密文件放在 `UPLOAD_ROOT/private/`，Nginx 不为该路径建 location（`deploy/nginx.conf` 里显式 `return 404`）。
- 删除仍被引用的文件返回 409 `FILE_IN_USE`，`error.details` 列出引用位置。
- 公开文件的缓存是 `public, max-age=300`（Nginx 与 Node 静态一致）：URL 不随可见性变化，改成私密后浏览器/CDN 可能保留到 TTL 结束，要立即生效需要版本化 URL + CDN purge 或签名 URL。
- 物理文件一律"先准备、后提交、提交后再清理"：数据库事务提交前不删旧文件，提交成功后才清；清理失败只留下孤儿文件并写 `error` 级日志（含 `fileId`/`storageKey`/`operation`，不含口令或 Cookie）。
- 上传超限 413 `FILE_TOO_LARGE`；扩展名/MIME 不在白名单 422 `UNSUPPORTED_TYPE`。

## 6. 发布流程

1. `POST /api/admin/articles/{res}/{id}/publication-check`（或 shelf 同名接口）→ 返回 `checkId`、`checks`、`assetDecisions`、`canProceed`。
2. `checkId` 绑定：用户 + 对象 + 动作 + 目标可见性 + `baseRevision` + 排序后的私密资源集合，5 分钟过期，校验与消费在同一事务内完成。
3. `POST …/publish` 必须带 `confirmed:true`，否则 409 `CONFIRM_REQUIRED`；`checkId` 过期 409 `CHECK_EXPIRED`、不匹配 409 `CHECK_MISMATCH`。
4. 资源三选一：`keep-private`（正文图片变 `*[图片未公开：alt]*`、链接降级为文字）、`copy-public`（生成公开副本，原文件不动）、`make-public`（原文件转公开）。不传决策一律 `keep-private`。
5. 发布在单事务内完成：写快照（`public_body` 已解析 `asset:`）+ 更新发布字段与 revision + 重写引用行 + 审计。

## 7. 导入与导出

- `POST /api/admin/imports/preview` 接受 `.md` 或 `.zip`（≤40MB 归档、≤200MB 展开、≤2000 条目），返回候选、资源匹配状态、冲突与警告。
- 解压只发生在临时目录，拒绝绝对路径、`..`、盘符、符号链接/硬链接、加密与嵌套归档；Markdown 必须可按 UTF-8 读取，否则 422 `ENTRY_UNREADABLE`。
- 默认只导入正文实际引用的资源；`includeUnreferencedPaths` 可显式追加。提交时 create 尊重显式 id，update 必须先存版本再覆盖，导入永不自动发布。
- 导出：`?source=working|published&format=md|zip`，文件名走 `Content-Disposition: attachment; filename*=UTF-8''…`；zip 内含 md、`assets/` 与 `README.txt` 清单；出错仍是 JSON 信封。

## 8. 测试

```bash
npm test               # 纯函数：slug、资源占位符、frontmatter、zip 路径安全、Content-Disposition
npm run test:integration   # PGlite 起真 PostgreSQL，跑完整 HTTP 验收
npm run typecheck
```

集成测试用 `@electric-sql/pglite` + socket 桥接，未修改的 `pg` 驱动直连，覆盖：登录/登出与 HttpOnly cookie、草稿不可见→发布可见→撤回消失、409 版本冲突、公开图片与私密 PDF 的可见性、`FILE_IN_USE`、留言拦截与公开载荷脱敏、Markdown 导出。

> 说明：生产目标是 PostgreSQL 16；本机无法安装 PostgreSQL 服务（`initdb` 在当前环境的权限模型下无法创建数据目录），
> 因此验收跑在 PGlite（PostgreSQL 18 内核的 WASM 构建）上，`pg` 驱动与 SQL 均未做方言适配。差异风险见第 10 节。

## 9. 部署

**完整部署手册见 [`docs/DEPLOY.md`](docs/DEPLOY.md)**（装 PG16、建库与最小权限用户、env、`npm ci`/`migrate`/`admin:init`/`build`、
systemd、两个域名的 Nginx、`/healthz` 与 `/readyz` 验证、备份恢复、以及"正式上线前必须在真 PG16 上重跑集成测试"）。

部署拓扑是**两个域名共用一套后端**：

- 前台 `https://entroaxiom.com` → `/srv/entroaxiom/site`（`npm run build`，history 路由）
- 后台 `https://admin.entroaxiom.com` → `/srv/entroaxiom/admin`（`pnpm build:admin:subdomain`，hash 路由）
- 两个域名都把 `/api/` 反代到同一个 `127.0.0.1:8000`；`PUBLIC_ORIGIN=https://entroaxiom.com`，
  `ALLOWED_ORIGINS` 必须包含 `https://admin.entroaxiom.com`，否则后台写请求会被 403。
- `/uploads/public/` 两个域名都只读提供；`/uploads/private/` 在两边都显式 404。

生产配置**只有一个来源**：`/etc/entroaxiom/api.env`（`600 root:root`，systemd `EnvironmentFile`）。Node 不会自己读 `.env`，
手工跑迁移/初始化时用 `set -a; . /etc/entroaxiom/api.env; set +a` 载入；`ADMIN_PASSWORD` 只用于一次性初始化，不要常驻该文件。

`deploy/` 下：

- `nginx.conf`：两个独立 `server` 块、`/api/` 反代（Host/X-Real-IP/X-Forwarded-For/X-Forwarded-Proto/Cookie、180s 超时）、
  `/uploads/public/` 只读静态且 `autoindex off`、`/uploads/private/` 与 `/uploads/` 直接 404、
  `/uploads/{public,private}/**.svg|svgz` 用正则 location 阻断、其余交 SPA、每个 location 重复声明 `nosniff`。
- `entroaxiom-api.service`：非 root、`Restart=on-failure`、`ProtectSystem=strict`、`UMask=0027`、`--max-old-space-size=384`、
  日志走 `/var/log/entroaxiom`。
- `entroaxiom-backup.service` + `entroaxiom-backup.timer`：每天 03:30 触发一次（`flock` 防重入、`entroaxiom` 用户运行）。
- `backup.sh`：**每次生成一个独立时间戳快照** `BACKUP_ROOT/daily/<YYYYMMDD-HHMMSS>/{database.dump,uploads/public,uploads/private,manifest.txt}`，
  先写临时目录、校验通过后原子改名，失败清理不留伪成功；保留 7 日备 + 4 周备（周备用 `rsync --link-dest` 省空间）。
- `find-legacy-svg.sh`：历史 SVG 只读盘点（Nginx 已阻断，处置见部署手册第 10 节，不自动删除）。
- `RESTORE.md`：从**同一时间戳快照**恢复到隔离环境、逐项验证后再回生产。
- `logrotate.conf`：按日轮转保留 14 天。

`/healthz` 只报告进程存活；`/readyz` 会真的 `select 1`，失败返回 503。

## 10. 与方案的差异、未实现项与风险

差异（均为有意的实现选择，已在代码注释中标注）：

1. 公开私密文件返回 404 而不是 `src:null`：避免通过列表泄露私密文件名。
2. 把文章「可见性改为 public」也要求先做一次 `publication-check`（`action:"visibility"`）；改为 private 同样校验 `checkId`，与后台客户端的调用顺序一致。
3. 留言被规则命中时，公开 POST 响应统一报 `pending`，避免向试探者暴露规则是否生效；后台能看到真实 `blocked` 与证据。
4. 限流是进程内滑动窗口（单进程部署足够），重启清零；多实例部署需换成 Redis 或数据库计数。

未实现/未验证：

- 邮件通知、图片缩略图、全文检索均未实现（方案未要求）。
- `deploy/` 下的 nginx、systemd 未在本机实际加载验证（Windows 环境无 systemd/Nginx），只做静态检查。
- 备份脚本未在真实 2C2G 机器上跑过完整一轮；`RESTORE.md` 是演练步骤而非演练记录。
- 未做真实 PostgreSQL 16 的回归；PGlite 与 PG16 在个别系统函数/权限语义上可能有差异。
- `concurrency.test.ts` 里三条**真实竞争**用例（并发 refresh / 并发保存同一 revision / 并发发布同一 checkId）
  默认跳过：`pglite-socket` 只接受单连接（多连接直接 ECONNRESET），`PG_POOL_MAX` 只能设 1，请求被串行化后测不出竞争。
  它们需要在真 PG16 上用 `PG_REAL_INTEGRATION=1 PG_POOL_MAX=5` 运行；`checkId` 单次消费的顺序重放用例默认就跑。

风险：

- 导出的 zip 会把引用资源整份打包，超大资源会撑大响应；当前只受 `MAX_FILE_BYTES` 约束。
- 版本保留默认 20 份，超出即删；如需长期留档要额外接对象存储。
- `IP_HASH_SECRET` 一旦更换，历史 `ip_hash` 失去可比性（这是有意的不可逆设计）。

## 11. 验收记录

- `npm run typecheck`：0 错误
- `npm test`：10/10 通过（纯函数）
- `npm run test:integration`：53 通过 / 3 跳过 = `acceptance.test.ts` 11 项（方案第 14 节）
  + `repair.test.ts` 17 项（第一轮修复文档的 §2 上传顺序 7 项、§3 导入顺序 4 项、§4 SVG/内容嗅探 4 项、§6 refresh 2 项）
  + `publish-decisions.test.ts` 9 项（第二轮 §5 文章可见性 vs 发布 2 项、§6 书架 `sharedWithPrivate` 3 项、书架决策严格校验 4 项）
  + `concurrency.test.ts` 1 项通过（`checkId` 重放被拒）/ 3 项跳过（真并发需 `PG_REAL_INTEGRATION=1` + 真 PG16）
  + `consistency.test.ts` 15 项（第三轮修复文档的 §3.1 预检 error 4 项、§3.2 书架公开封面 2 项、§3.3 文件/事务一致性 3 项、
    §3.4 ZIP 嵌套引用 3 项、§4.1 refresh 只认 sid 1 项、§4.2 缓存 5 分钟 1 项、§4.3 TRUST_PROXY 默认关闭 1 项）
- `npm run build`：通过

逐项手工验收清单（含 ZIP 导入、备份演练、真 PG16 回归）见 `docs/ACCEPTANCE.md`，部署步骤见 `docs/DEPLOY.md`。

