# EntroAxiom 部署记录（2026-11-02）

本文件记录这次**真实部署**的落地事实：机器、版本、路径、验证结果与偏离手册之处。
它补充 `docs/DEPLOY.md`（那是通用步骤），两者冲突时以本文件为准。

## 1. 主机与拓扑

| 项 | 值 |
| --- | --- |
| 主机 | Azure VM（公网 IP 已隐去），Ubuntu 24.04.4 LTS，内核 6.17 |
| 规格 | 2 vCPU / 892 MB RAM / 61 GB 盘（+ 部署时新增 2 GB swap） |
| 登录 | 运维账号（`sudo` 免密），仅密钥登录；账号名与密钥文件名不入库 |
| 域名 | `entroaxiom.com`、`www.entroaxiom.com`、`admin.entroaxiom.com`，DNS 全部走 Cloudflare 代理（橙云） |
| 证书 | Let's Encrypt 单张多 SAN 证书，`/etc/letsencrypt/live/entroaxiom.com/`，有效期至 2027-01-27，webroot 自动续期 |
| 反代 | 主机 nginx 1.24：`/etc/nginx/conf.d/entroaxiom.conf`，两个 `server`（主域 + admin 子域）各自代理 `/api/` |
| 应用 | Fastify 5 / Node v22.23.4，systemd `entroaxiom-api.service`，只监听 `127.0.0.1:8000` |
| 数据库 | PostgreSQL 16.15（PGDG），库 `entroaxiom`，owner `entroaxiom`，仅监听 localhost |
| 备份 | `entroaxiom-backup.timer`（每日 03:32 UTC）→ `entroaxiom-backup.service`（`flock` 防重入） |

进程与端口：nginx 占 80/443，Node 占 127.0.0.1:8000，PG 占 127.0.0.1:5432。
三个进程都由 systemd 托管（`enable` 已开）。

## 2. 目录与文件

```
/srv/entroaxiom/api            后端源码 + dist/server.js + node_modules（root 拥有，chmod a+rX 供 entroaxiom 只读运行）
/srv/entroaxiom/site           前台构建产物（150 文件）
/srv/entroaxiom/admin          后台构建产物（157 文件，VITE_PUBLIC_PATH=/ 独立子域名）
/srv/entroaxiom/shared/uploads/{public,private}   UPLOAD_ROOT
/srv/entroaxiom/shared/imports                    IMPORT_ROOT（临时目录，ZIP 导入用）
/srv/entroaxiom/shared/backups/{daily,weekly}     BACKUP_ROOT
/etc/entroaxiom/api.env        600 root:root，服务与备份共用
/etc/systemd/system/entroaxiom-{api,backup}.service + entroaxiom-backup.timer
/etc/logrotate.d/entroaxiom    按日轮转，留 14 天
/var/log/entroaxiom/{api,backup}.log
/root/entroaxiom-secrets.txt   600，DB_PASSWORD / SESSION_SECRET / IP_HASH_SECRET / ADMIN_PASSWORD
```

管理员账号：运维自定（昵称「站长」，权限 `*:*:*`），用户名不入库。
**初始口令在 `/root/entroaxiom-secrets.txt`**，登录后请自行改掉（改法见 README：
`npm run admin:init -- --username <名字> --force` 会重置口令）。

`api.env` 关键值：`NODE_ENV=production`、`PORT=8000`、
`PUBLIC_ORIGIN=https://entroaxiom.com`、`ALLOWED_ORIGINS=https://admin.entroaxiom.com`、
`TRUST_PROXY=true`（nginx 与 Node 同机，`X-Forwarded-For` 由 nginx 用 `$remote_addr` 覆写）。

## 3. 数据库

已应用迁移：`0001_init`、`0002_shelf_published_cover`。
`users` 实际列：`id / username / password_hash / nickname / avatar / roles(jsonb) / permissions(jsonb) / disabled_at / created_at / updated_at`
（**没有** `role`、`is_active` 两列，写 SQL 时别照旧结构猜）。

## 4. 与手册的偏离（有意为之）

1. **PG 参数更保守**：手册按 2 GB 内存给 `shared_buffers=256MB`、`max_connections=30`；
   本机实测只有 892 MB，故用 `shared_buffers=128MB`、`max_connections=20`、
   `effective_cache_size=384MB`、`work_mem=4MB`、`maintenance_work_mem=64MB`，
   并新增 2 GB swap 兜底。
2. **构建以 root 执行**：`api.env` 是 600 root:root，`entroaxiom` 用户读不到；
   且 `npm ci` 需要 `/root/.npm` 缓存。因此 `npm ci` / `migrate` / `admin:init` / `build`
   统一以 root 执行，产物 `chmod -R a+rX`，运行仍由 `entroaxiom` 用户承担。
   注意 `npm ci` 必须 `env -u NODE_ENV ... --include=dev`，否则会跳过 devDependencies，
   `tsx`/`tsc` 缺失导致迁移与构建失败。
3. **备份锁文件**：`/run` 是 root 所有，`entroaxiom` 用户无法在里建锁文件，
   故 unit 增加 `RuntimeDirectory=entroaxiom`，锁文件改到 `/run/entroaxiom/backup.lock`。
4. **nginx**：三个域名共用一张证书；`www` 301 到主域；每个 80 端口的 `server` 里保留
   `/.well-known/acme-challenge/`（webroot 续期用）。
5. **ufw 保持关闭**：云厂商安全组已经限制了入站，额外开 ufw 反而有把自己关在门外的风险。
6. **旧栈已删除（2026-11-02 上午，应用户要求）**：原 Docker 栈（`deploy-nginx-1` /
   `deploy-backend-1`，FastAPI + SQLite）先 `docker stop` 观察了一段时间，确认新站稳定后已
   `docker rm -f` 删除容器与 `deploy_default` 网络，`entroaxiom-backend:latest` 与
   `nginx:1.27-alpine` 镜像、旧构建缓存一并清理，旧项目目录
   `/home/<user>/WebProjects/entroaxiom-backend`（98 MB，含 .venv 与 .git）已删除。
   删除前先 `sha256sum -c` 校验过旧数据备份：`/var/backups/entroaxiom-legacy/20261102-013817/`
   （200 KB，`entroaxiom.db` + `files/` + `docker-inspect.json`），**该备份保留**，如需找回旧内容只能靠它。
   同一批还删掉了旧前端的工作副本
   `/home/<user>/WebProjects/entroaxiom-site`（110 MB，含 `node_modules`）；
   删前确认过 `git rev-parse HEAD` 与 `origin/main` 一致（`21cdd22`），
   代码本来就在 `github.com/<user>/entroaxiom-site`，服务器上那份只是构建副本。
   因此**不再保留一键回滚**：回滚新栈要靠 `docs/RESTORE.md` 的备份恢复流程。
   `certbot/certbot` 镜像（293 MB）未删，属于证书工具而非旧站，留着备用。
   清理后根分区占用 7.5 GB → 6.8 GB，`/home/<user>/WebProjects` 已不存在。

## 5. 验证结果（本机实跑）

| 项 | 结果 |
| --- | --- |
| `npm test`（Node 22.23.4，服务器上） | 14/14 通过 |
| `npm run test:integration`（真实 PG 16.15，`--test-concurrency=1`） | **61/61 通过，0 跳过**（含 4 条真并发用例） |
| 上线验收脚本（34 项，含登录/Cookie 属性/CSRF 拒绝/乐观锁/预检发布/撤回/公开可见性/文件可见性/留言/登出幂等） | **34/34 通过** |
| `/healthz` `/readyz` | 200，`ready` |
| 公开 API（经 Cloudflare） | `notes`/`shelf`/`guestbook` 均 200 且信封结构正确 |
| 后台 API 未登录（经 Cloudflare） | 401 `UNAUTHORIZED` |
| `/uploads/private/*` | 404 |
| `www` → 主域 | 301 |
| 备份 | 手动跑过一次：`daily/20261102-020200`，`database.dump` 44559 B + `manifest.txt`（含 sha256）+ `uploads/` |
| 证书续期演练 | `certbot renew --dry-run` 成功 |

跑集成测试的两个前提（否则会出现"假失败"）：

- 测试库要干净：`dropdb/createdb entroaxiom_test`，否则上一轮残留数据会让"建稿"返回 409。
- 不要 `source /etc/entroaxiom/api.env` 再跑测试：里面的 `TRUST_PROXY=true` 会污染
  §4.3「TRUST_PROXY 默认关闭」用例。用 `env -i` 只传 `DATABASE_URL` 与 `PG_REAL_INTEGRATION=1`。

## 6. 剩余风险

- 并发用例虽然已在真实 PG 16 上通过，但只在 2 vCPU/892 MB 上跑过，未做大流量压测。
- 进程内限流（登录、留言）在单实例下有效，多实例部署会失效——本机是单实例，符合预期。
- `<fileId>-pub` 公开副本是"每文件一份"：发布后若再改源文件字节，公开副本仍是旧字节。
- 管理端没有组件级自动化测试，只有 `mock-smoke` / `render-smoke` / `v3-regression` 三个脚本。
- Fastify 的 `disableRequestLogging` 弃用警告（FSTDEP023）仍在，不影响功能。

## 7. 上线后修复（2026-11-02 上午）

**现象**：欢迎层还在显示时，星海左边就飘着首页星系的模块名（随笔 / 学习笔记 / 留言区…）。

**根因**：`site/src/components/home/Orrery.tsx` 为了「转到背面就点不到」给标签写了行内
`el.style.visibility = 'visible'`。而欢迎层期间舞台是靠 `.stage[inert] { visibility: hidden }`
藏起来的，行内 `visibility: visible` 会把这个继承顶穿——首页还没露面，标签已经能显示。
（星系 canvas 也被藏了，于是只剩文字飘在星海上。）

**修法**：行内不再碰 `visibility`，改用 `el.style.pointerEvents = 'none' | 'auto'` 做命中测试，
透明度继续由 `opacity` 控制。新增回归用例
`site/tests/regressions.test.cjs`「没有组件用行内 visibility 顶穿 .stage[inert] 的隐藏」，
扫描 `src/**/*.{ts,tsx}` 禁止再出现行内 visibility 赋值。

**顺带补的缓存策略**（`deploy/nginx.conf`，已同步到线上并 reload）：
`/assets/`（前台）与 `/static/`（后台）带 hash，给 `max-age=31536000, immutable`；
`location = /index.html` 给 `no-cache`。之前两者都没有 `Cache-Control`，
发版后浏览器可能拿着旧 index 去请求已删除的 xxx.js 而白屏。

**验证**：重新构建前台（150 文件）→ 覆盖 `/srv/entroaxiom/site/` →
Chrome 无头拉真实 DOM，`gx__slot` 只剩 `transform/opacity/pointer-events`、全页 0 处
`visibility`；`index.html` 返回 `cache-control: no-cache`，`/assets/*.js` 返回
`max-age=31536000, immutable`；`/static/` 同样生效。
## 8. 上线后体检修掉的问题（2026-11-02 下午）

上线后用「灌真实内容 + 无头 Chrome 逐页核对」的方式做了一轮全站体检（前台 15 条路由 ×
桌面/移动、后台 9 个页面、真实 UI 走一遍上传/发布/回复/版本/书架），修掉 4 个真问题、
记录 1 个需要面板操作的缓存注意点。

### 8.1 所有公开图片 403（P0）

**现象**：`https://entroaxiom.com/uploads/public/*.png` 全部 403，页面里图片全裂。
`/var/log/nginx/error.log`：`open() "/srv/entroaxiom/shared/uploads/public/..." failed (13: Permission denied)`。

**根因**：目录链是 `shared 750 entroaxiom:entroaxiom` → `uploads/public 750` → 文件 `640`，
而 nginx worker 跑在 `www-data`，它不在 `entroaxiom` 组里，连 `shared/` 都进不去。
首次验收打的是 `127.0.0.1:8000`（Node 直连），完全绕过了 nginx 静态服务，所以没暴露。

**修法**（不放松权限，保持 750/640 与 `UMask=0027`）：

```bash
sudo usermod -aG entroaxiom www-data
sudo systemctl restart nginx   # 必须 restart：reload 不会重算 worker 的补充组
```

### 8.2 `/uploads/` 下的错误路径返回 SPA 的 200 HTML

`location = /uploads/` 只精确匹配裸路径，`/uploads/nope.png` 会落到 `location /` 返回
`index.html`（200 text/html）。两个 server 块各补 `location /uploads/ { return 404; }`
（前缀匹配，`/uploads/public/` 仍优先）和 `location /media/ { return 404; }`（旧方案遗留前缀），
已同步线上与仓库 `deploy/nginx.conf`。

### 8.3 管理员口令在后台登录页根本提交不了（P1）

**现象**：用部署脚本 `openssl rand -base64 24` 生成的 20 位口令，接口能登（curl 200），
但后台登录页直接拦下：「密码格式应为 8-18 位数字、字母、符号的任意两种组合」。

**根因**：前端校验 `admin/src/views/login/utils/rule.ts` 的 `REGEXP_PWD` 写死 8–18 位、
至少两类字符、不含中文；后端 `create-admin.ts` 只要求 ≥12 位，两者对不上，生成的口令注定登不进。

**修法**（以真实的登录表单约束为准）：

- 新增 `src/lib/password-policy.ts`：`ADMIN_PASSWORD_MIN_CHARS = 8`、`MAX = 18`、
  推荐 16，`passwordPolicyProblems()` 给出中文原因，`generateAdminPassword()` 四类字符各一 + 洗牌。
- 新增 `npm run admin:password`（`src/scripts/new-password.ts`）生成合规口令。
- `create-admin.ts` 改用同一套判定，用法说明与交互提示改成 8–18 位，拒绝时提示去用 `admin:password`。
- 新增 `tests/unit/password-policy.test.ts`（7 条）。
- README / `docs/DEPLOY.md` 同步：不要再 `openssl rand -base64 24`。
- 线上已用新脚本把管理员口令重置成 16 位，`/root/entroaxiom-secrets.txt` 已更新。

### 8.4 「历史版本」永远是空的（P1）

**现象**：后台编辑器 →「更多」→「历史版本」显示「还没有历史版本」，
而生产库 `select count(*) from article_versions` 就是 0；文章却发布过 1–3 次。

**根因**：`insertVersion` 只在手动保存、导入覆盖、历史恢复三处被调用，
`publishArticle` 从不写版本——与抽屉里那句「手动保存、发布、导入覆盖、历史恢复各留一份」相反，
撤回发布后想找回上次线上正文就没路可走。

**修法**：

- `publishArticle` 在快照 upsert 与文章更新之后 `insertVersion(trx, updated, "publish", actor.userId, { skipIfSame: true })`。
- `insertVersion` 新增 `skipIfSame`：最新一条版本的来源、标题、摘要、正文都相同时不重复写
  （「更新发布」连点两次不会堆两条；但手动保存后紧接发布仍各留一份，所以必须比较来源）。
- `restoreVersion` 保留的那份来源从 `manual` 改成 `restore`。
- 连带修：版本会写 `usage="version"` 的引用行，而删除文件只要"有任何引用"就 409，
  于是发布过的文章引用过的文件永远删不掉。改成只有 `working / published / cover` 阻止删除，
  `version` 行随文件级联删除（`file_references.file_id … on delete cascade`）。
- 新增 `tests/integration/versions.test.ts`（2 条）。

### 8.5 Cloudflare 会改写静态资源的 Cache-Control（需面板操作，未改）

经 Cloudflare 访问时，`/uploads/public/*` 的 `Cache-Control` 被改写成 `max-age=14400`（4 小时），
与「撤回发布后公开图片最多 5 分钟消失」的设计不符。建议在 Cloudflare 面板把
**Browser Cache TTL** 设为 **Respect Existing Headers**；这一步属于账号面板操作，未在服务器上改。

### 8.6 本轮回归结果

- 后端：`npx tsc --noEmit` 0；`npm test` **21/21**；`npm run test:integration`
  **63 tests / 60 pass / 3 skipped / 0 fail**；`npm run build` 0。
- 线上实测：`qa-essay-8e75aa` 发布后 `GET /versions` 返回 `[(1, "publish")]`，
  后台「历史版本」抽屉显示「v1 发布 …579 B」（此前恒为空）。
- 前台 15 条路由（1440 / 390 两档）：0 控制台报错、0 破图、0 横向溢出、0 `asset:` 泄漏。
- 后台 9 个页面：0 控制台报错、0 4xx、0 破图；发布弹窗未逐项决策时「确认发布」为 disabled。
### 8.7 体检用的测试内容已清空

体检时往线上灌了 13 篇 `qa-*` 文章、若干测试图片/PDF、1 个书架条目和 2 条测试留言。
这些是造出来的数据，不是真实内容，已全部删除：

```sql
delete from file_references;
delete from published_article_snapshots where article_id like 'qa-%';
delete from article_versions where article_id like 'qa-%';
delete from articles where id like 'qa-%';
delete from shelf_items where id = '熵-一种新的世界观';
delete from guestbook where email = 'qa@example.com';
delete from files;
```

`/srv/entroaxiom/shared/uploads` 下的物理文件也一并清空（目录与权限保留）。
清理后 `articles / shelf_items / guestbook / files / article_versions` 全为 0，
`/api/public/{notes,essays,shelf,files}` 返回 `{"success":true,"data":[],"error":null}`，
`/api/public/guestbook` 返回 `{"items":[],"total":0}`，首页与各列表页的空状态正常。
验收脚本 `accept.py` 在清理后复跑 **34/34 通过**（它自己建的稿件/文件/留言会自行删除）。

> 站点现在是一张白纸，等你录入真实内容；首页各个模块会显示 0 篇/0 条的空状态。

### 8.8 关于体检脚本的三处「误报」

这三个现象一开始被脚本报成 bug，逐个查证后确认是脚本判断太粗，不是站点问题，记录备查：

1. **欢迎层没点「越过视界」时，舞台整体 `inert` + `visibility: hidden`**
   （`src/App.tsx` 的 `stageHidden = !entered`，配合 `layout.css` 的 `.stage[inert] { visibility: hidden }`）。
   脚本不点按钮直接取样，就会把整页文字都判成"不可见"。修法：取样前先点掉欢迎层。
   移动端实测按钮在 390×844 下位于 (117, 685)、可点、点后 `inert` 移除、导航与 H1 立刻可见。
2. **列表页 H1 的 `color` 是 `rgba(0,0,0,0)`**：标题用的是 `background-clip: text` 渐变字
   （`linear-gradient(100deg, #efe8da 30%, #ef8456)`），颜色由渐变画出来，透明是正常写法。
   脚本改为：`background-clip: text` 且有背景图时不算不可见。
3. **移动端 `.nav__sub`（熵 · 公理）与 `.nav__search-label`（检索星空）是 `display: none`**：
   窄屏按设计只留图标和主标题，脚本把"按设计隐藏"也算成了不可见，现已跳过 `display: none`。

修完这三处判断后，前台 11 条路由 × 桌面/移动两档复检只剩 2 条故意访问已删详情的 404 记录
（用于验证详情页 404 兜底），没有其它 error；后台 9 个页面在空库下同样 0 报错。
