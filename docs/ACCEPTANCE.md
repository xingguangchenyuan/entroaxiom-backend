# 验收记录（2026-11-01，含同日修复回归）

## 1. 自动化验收（本机实测）

环境：Windows 11 / Node v24.18.0 / npm 11.16.0；**无本地 PostgreSQL 服务**，因此集成测试用
`@electric-sql/pglite`（PostgreSQL 18 内核的 WASM 构建）+ `pglite-socket` 起在 127.0.0.1，
由未修改的 `pg` 驱动直连，迁移脚本与业务 SQL 未做任何方言适配。

```
npm run typecheck           → 无错误
npm test                    → 10 passed / 0 failed
npm run test:integration    → 38 passed / 3 skipped / 0 failed
                              （acceptance 11 + repair 17 + publish-decisions 9 + concurrency 1）
npm run build               → 通过
```

> 3 个 skipped 是 `concurrency.test.ts` 里要求**真实并发**的用例：本机 `pglite-socket` 只接受单连接
> （多连接直接 `ECONNRESET`），`PG_POOL_MAX` 只能设 1，请求被串行化，测不出竞争。它们必须在真 PG16 上
> 用 `PG_REAL_INTEGRATION=1 PG_POOL_MAX=5` 运行（见 §2 第 4 条），否则不能声称并发语义已验收。

### 1.1 方案第 14 节逐项（`tests/integration/acceptance.test.ts`）

| 方案条目 | 用例 | 结果 |
| --- | --- | --- |
| 1 登录/会话 | `登录成功并拿到 HttpOnly 会话 cookie`、`错误口令返回 401 INVALID_CREDENTIALS`、`登出后 cookie 失效，后台接口 401` | 通过 |
| 2 建稿→发布→撤回 | `建稿后公开接口看不到，发布后才出现，撤回后消失` | 通过 |
| 3 私密文章公开 404 | 同上（发布前 `GET /api/public/notes/it-note-1` = 404） | 通过 |
| 4 revision 冲突 | `并发保存触发 409 并返回 currentRevision` | 通过 |
| 5 公开图片 / 私密 PDF | `上传公开图片与私密 PDF，公开地址只对公开文件有效` | 通过 |
| 6 删除被引用文件 | `删除被正文引用的文件返回 409 FILE_IN_USE` | 通过 |
| 7 三种资源决策 | 单测覆盖 `replaceAssetRefs` 的占位符与链接降级；发布链路见第 2 项 | 部分（见 §3） |
| 8 留言正常/被拦 | `留言命中规则后被拦下，公开载荷不含邮箱与证据` | 通过 |
| 9 ZIP 导入 | `ZIP 导入：预览 → 提交建稿，资源改写成 asset 引用且不自动发布` | 通过（含缩小断言，见 §3） |
| 10 md 导出 | `导出 Markdown 带 frontmatter 与下载文件名` | 通过 |
| 11 备份恢复演练 | 未执行（无生产 PostgreSQL 与 Linux 主机） | 未执行 |

### 1.2 修复文档逐项（`tests/integration/repair.test.ts`，全部为真实 HTTP + 真实 multipart 解析）

环境约束写在文件头：PGlite 起在 5597、`app.listen` 在 5596、用 `fetch`/`FormData` 发真请求
（`app.inject` 传 multipart 会触发 dicer 的 `Unexpected end of multipart data`）。

| 修复章节 | 用例 | 结果 |
| --- | --- | --- |
| §2 上传顺序 | 字段在前的 300KB 公开上传、字段在后的 300KB 公开上传、私密文件公开 404 而 `/content` 200、缺省 visibility→private、非法 visibility→422 且不留记录/不留盘、超大小→413 且无半成品、一次两个文件→422 | 7/7 通过 |
| §3 导入顺序 | notes type 在前/在后、essays type 在前/在后、缺 type→422、非法 type→422、预览不建正式文章、commit 后仍草稿+私密 | 4/4 通过 |
| §4 SVG | 即使 `allowedExtensions` 含 `svg` 也拒（422 `UNSUPPORTED_TYPE`）、png/jpg/webp 正常、把 SVG 改名成 `.png` 被内容嗅探拦下、存量 `legacy-2025.svg` 不被自动删除 | 4/4 通过 |
| §6 refresh 原子轮换 | 同一 Cookie 并发两次 refresh 恰好一个成功（失败侧不下发 Cookie）、旧 Cookie 失效而新 Cookie 可用、有效会话数不增加、过期会话 refresh→401 | 2/2 通过（含多断言） |

> 关键设计：§2/§3 的体积用 **300KB**，刻意超过 busboy 约 64KB 的单块缓冲阈值——真正的缺陷只在
> "文件大于一个 chunk 且普通字段排在文件之后"时出现，8 字节的小文件是假通过。§4 的用例把
> `allowedExtensions` 人为加上 `svg` 再跑，证明拒绝发生在业务校验而不是配置默认值。

### 1.3 第二轮修复文档逐项

`tests/integration/publish-decisions.test.ts`（9/9 通过，真 HTTP）：

| 章节 | 用例 | 结果 |
| --- | --- | --- |
| §5 文章 | publish 预检返回资源决策（`sharedWithPrivate=false`）；`action:"visibility"` 预检 `assetDecisions` 为空数组 | 2/2 通过 |
| §5 可见性不改文件 | 切到 public 后 `assets[].visibility` 仍 private、`publicSrc===null`、磁盘文件数不变 | 通过（与上一行同一用例） |
| §6 `sharedWithPrivate` | 只被自身 cover 引用→false；再被另一篇私密文章引用→true 且 reason 含 `copy-public`；书架 visibility 预检空决策 | 3/3 通过 |
| §6 决策严格校验 | 未知决策→422 `未知的资源处理方式` 且文件仍 private、无孤儿副本、`publicationStatus==="draft"`；非封面 fileId→422 `不是本条目的封面`；重复 fileId→422 `多条处理决策`；不传 decisions→发布成功但 `coverUrl===null`、`coverVisibility==="private"` | 4/4 通过 |

`tests/integration/concurrency.test.ts`（1 通过 / 3 跳过）：

| 用例 | 默认 | 真 PG16 |
| --- | --- | --- |
| 发布 `checkId` 只能消费一次（顺序重放→409 `CHECK_MISMATCH`/`CHECK_EXPIRED`/`REVISION_CONFLICT`） | 通过 | 通过 |
| 并发两个 refresh：恰好一个 200、另一个 401 `INVALID_REFRESH_TOKEN` 且不下发 Cookie | 跳过 | 待跑 |
| 并发保存同一 revision：一个 200、一个 409 `REVISION_CONFLICT` 且 `data.currentRevision` 是数字 | 跳过 | 待跑 |
| 并发发布同一 checkId：一个 200、一个 409，最终 revision 只 +1 | 跳过 | 待跑 |

### 1.4 第三轮修复文档逐项

`tests/integration/consistency.test.ts`（15/15 通过，PGlite + 真 HTTP）：

| 章节 | 用例 | 结果 |
| --- | --- | --- |
| §3.1 预检 error | 直接构造带 `severity:"error"` 的预检 → `consumeCheck` 抛 `CHECK_MISMATCH`（消息含「预检未通过」）；只有 warning 的预检可正常消费 | 通过 |
| §3.1 悬空附件 | 正文引用不存在的 `asset:` → 预检 `canProceed=false`、发布 409、无快照 | 通过 |
| §3.1 书架悬空封面 | `DANGLING_COVER` → 发布 409，`publicationStatus` 仍 draft、revision 不变 | 通过 |
| §3.1 正常路径不回归 | 正常预检仍可发布文章与书架 | 通过 |
| §3.2 公开封面 | 私密封面 `copy-public` 发布后公开详情/列表都返回 `/uploads/public/...`，公开副本 200、原件公开地址 404、原件后台可读 200 | 通过 |
| §3.2 撤回 | 撤回后公开详情 404、公开列表不再包含该条目 | 通过 |
| §3.3 发布回滚 | `file_references` 写入注入失败 → 发布失败但公开目录文件数不变（副本已清）、无快照、仍旧 draft、原私密文件仍可读 | 通过 |
| §3.3 删除回滚 | `audit_logs` 写入注入失败 → 文件记录仍在、磁盘文件仍在 | 通过 |
| §3.3 可见性回滚 | 同上注入 → `visibility` 仍 private，公开目录无新副本 | 通过 |
| §3.4 ZIP 根目录 | 根 md 引用根资源 → 正文变 `asset:<id>` | 通过 |
| §3.4 ZIP 子目录 | `notes/article.md` 引用 `assets/pic.png` 与 `../assets/up.png` → 两处都变 `asset:<id>` | 通过 |
| §3.4 缺资源 | `missingCount=1` 时提交 422，不会编造 `asset:<id>`、也不会建文章 | 通过 |
| §4.1 refresh | 无 cookie 只带 body `refreshToken` → 401 `INVALID_REFRESH_TOKEN`；有 sid 时正常 200 | 通过 |
| §4.2 缓存 | `/uploads/public/<id>.png` 的 `Cache-Control` 含 `max-age=300` 且不含 `immutable` | 通过 |
| §4.3 trustProxy | `config.trustProxy === false`，伪造 `X-Forwarded-For` 不改变客户端地址 | 通过 |

> 说明：`EMPTY_BODY` 在 API 层不可达（保存草稿时正文为空会被 422 拒绝），所以「带 error 的预检」用
> 直接构造的 `publication_checks` 记录 + 悬空引用两条路径证明拦截有效。

纯函数单测（`tests/unit/lib.test.ts`）：slug 稳定性与非法 id、`asset:` 提取、私密图片占位符与链接降级、
frontmatter 往返、zip 路径穿越/绝对路径/盘符、文件名清洗、`Content-Disposition` 的 UTF-8 文件名。

## 2. 手工待办（需要在真实部署上做）

1. **备份恢复演练**：按 `deploy/RESTORE.md` 在测试库上完整走一遍，记录耗时（目标 RTO 4h）。
2. **Nginx / systemd 实机加载**：`nginx -t`、`systemctl daemon-reload && systemctl restart entroaxiom-api`，
   确认 `/uploads/private/` 返回 404、`/uploads/public/` 不列目录、`/api/` 反代带上真实 IP；
   两个域名（`entroaxiom.com` / `admin.entroaxiom.com`）都要验证，详见 `docs/DEPLOY.md`。
3. **2C2G 机器压测**：`node --max-old-space-size=384` 下并发上传 50MB 文件与 40MB zip 导入，确认不 OOM。
4. **PostgreSQL 16 回归 + 并发用例**：在真实 PG16 上
   `PG_REAL_INTEGRATION=1 PG_POOL_MAX=5 npm run test:all`，确认 `concurrency.test.ts` 的三条并发用例不再跳过且全过
   （当前只在 PGlite/PG18 内核上验证，PGlite 不能冒充 PG16 实机验收）。
5. **备份 timer 实机**：`systemctl start entroaxiom-backup.service` 后检查
   `BACKUP_ROOT/daily/<时间戳>/` 里 `database.dump` + `uploads/{public,private}` + `manifest.txt` 四件齐全、
   第二次快照不覆盖第一次、`systemctl list-timers entroaxiom-backup.timer` 有下次触发时间。
6. **历史 SVG 阻断实机**：两个域名分别请求 `/uploads/public/xxx.svg` → 404，`/uploads/public/xxx.png` → 200，
   站点根 `favicon.svg` 仍 200。
7. **子域名构建产物实机验证**：`pnpm build:admin:subdomain` 的 `dist/` 放到 `admin.entroaxiom.com` 根目录，
   确认 `sid` Cookie 为 `HttpOnly; Secure; SameSite=Strict`、`/static/...` 全部 200、`/admin/` 无残留引用。

## 3. 已知差异与缩小断言的说明

- 「三种资源决策」的**服务层行为**已由 `publish-decisions.test.ts` 覆盖（决策只对 publish 返回、可见性不改文件、
  未知/非封面/重复决策被拒）；但 `copy-public` / `make-public` 成功后公开正文的资源改写与磁盘副本数量，
  端到端用例只断言了"不产生副本"的负向场景，正向场景需在实机后台点一遍。
- ZIP 导入的**相对路径改写**已由 `consistency.test.ts` 覆盖（根目录、子目录、`../` 三种），
  `assets/pic.png` 这类引用现在会按 md 所在目录归一化后再改写；早期 `repair.test.ts` 里那条窄断言保留不动。
- 公开的私密文件返回 404（而非 `src:null`），与 `docs/API.md` 的措辞略有出入，理由是避免泄露私密文件名。
- 把文章改为 public 之前必须先用 `action:"visibility"` 做一次预检并获得 `checkId`，与后台客户端的调用顺序一致。
- Nginx 的两个 `server` 块都提供 `/uploads/public/`（文档原文只说前台提供）：接口返回的是同源相对地址，
  后台若不给这个路径，图片与附件会全部裂开；公开文件本身即公开，不构成越权。`/uploads/private/` 两边都 404。
