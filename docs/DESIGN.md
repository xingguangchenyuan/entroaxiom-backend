# 设计说明

## 1. 目标与约束

个人网站，访客无需登录即可阅读公开内容；站长登录后管理。数据量小（笔记/总结/文件，几十 GB 以内），单台云服务器。优先级：安全与可恢复 > 简单可维护 > 性能。

## 2. 目录结构

```
app/
  core/      config（环境变量）、errors（统一响应）、security（密码/会话/限流/CSRF 纯函数）、logging
  db/        base（命名规则）、session（引擎，SQLite 的 WAL/外键）
  models/    Note、Summary、FileRecord
  schemas/   public（访客可见字段）、admin（请求/返回）、common
  services/  content、files（业务）、file_storage（磁盘）、file_types（白名单+魔数）、slugs、frontmatter
  api/       auth、public、admin/（content 路由工厂、files）、deps
alembic/     迁移（SQLite 用 batch 模式）
scripts/     hash_password、import_markdown、backup
deploy/      docker-compose、nginx
tests/       unit（纯逻辑）、api（接口 + 迁移）
```

## 3. 数据模型

笔记与总结字段相同、各自一张表（`notes`、`summaries`）：`pk`（内部主键）、`id`（slug，URL 用，表内唯一）、`title`、`summary`、`category`、`tags`（JSON 数组）、`body`（Markdown）、`date`、`updated`、`visibility`、`status`、`created_at`、`updated_at`。

文件表 `files`：`id`（slug）、`name`（原文件名，仅存库）、`stored_name`（`<uuid hex>.<ext>`）、`ext`、`kind`（image/pdf/archive/doc/other）、`size`、`mime_type`、`sha256`、`description`、`visibility`、`status`、`date`。

默认值：笔记/总结 = private + draft；文件 = private + published。**忘记设置也不会意外公开。**

## 4. 权限模型

访客能看到的内容 = `visibility == public` **且** `status == published`。

- 过滤在数据库查询里完成，不是取出后在代码里筛。
- 私密、草稿、不存在 → 完全相同的 404，访客无法探测私密内容是否存在。
- 访客返回模型（`schemas/public.py`）不含 visibility、status、内部主键、磁盘文件名、创建/修改时间。
- `/api/admin/*` 整体由路由级依赖要求登录，新增接口默认受保护，不可能漏写。

## 5. 认证与会话

- 单管理员：只有一个密码，只存 argon2 哈希（环境变量），没有用户表、注册、找回。
- 登录成功设置 HttpOnly + Secure + SameSite=Strict 的签名 Cookie（itsdangerous，7 天过期）。无状态：不存服务端会话；更换 `SECRET_KEY` 即让全部会话失效。
- 登录失败限流：同一 IP 15 分钟内失败 5 次锁定（内存实现，单 worker）；Nginx `limit_req` 再限一层。
- CSRF：SameSite=Strict + 对所有写请求校验 Origin/Referer（带 Origin 必须与 Host 同源或在 `ALLOWED_ORIGINS` 内；`Origin: null` 拒绝；浏览器声明 cross-site 的无 Origin 请求拒绝）。
- `/api/admin`、`/api/auth` 响应 `Cache-Control: no-store`。

## 6. 文件生命周期

不变量：**文件在 `uploads/public/` ⇔ `visibility=public 且 status=published`**，否则在 `uploads/private/`。

- 上传：流式写入目标目录内的临时文件 `.<uuid>.part` → 边写边限制大小并计算 sha256 → 校验扩展名白名单与魔数 → 原子改名为 `<uuid>.<ext>` → 写数据库；数据库失败则删除文件，不留孤儿。
- 文件上传、切换可见性与删除共用本地文件系统上的 `uploads/.storage.lock`，同时串行化线程与进程；修改/删除在锁内结束旧读事务并重新读取当前记录，不能用旧状态决定物理位置。
- 切换可见性：先移动文件，再提交数据库；数据库失败则把文件移回。跨挂载点（EXDEV）退化为复制+删除，源删除失败时撤销目标副本。
- 删除：先移入不对外提供的 `.trash/`，再提交数据库删除；提交失败恢复原位。最后清理失败返回 `cleanup_pending: true` 并保留隔离文件，可用 `scripts/cleanup_trash.py` 重试。无法隔离时返回 503，保留原记录。
- 备份持有同一文件锁直到数据库快照和两个文件包完成，正文写入仍由 SQLite 快照保证时间点一致性。校验清单最后发布；完整日期时间参与保留排序。恢复在改动现有数据前检查校验和、安全条目和数据库/目录对应关系。
- 公开文件由 Nginx 直接读 `uploads/public/`（只读挂载）。**`uploads/private/` 不挂进 Nginx 容器**，私密文件在物理上不可能被静态提供，只能通过 `/api/admin/files/{id}/content`（需登录）。
- 白名单：图片（不含 svg）、pdf、压缩包、Office、纯文本。拒绝 html/svg/js/可执行文件——即使进了公开目录也无法执行脚本。响应带 `nosniff`；不使用 CSP sandbox（会破坏 PDF 内嵌预览）。
- 原文件名只存数据库；展示名会清理路径分隔符、控制字符。

## 7. 统一返回与错误码

成功 `{success:true,data,error:null}`；失败 `{success:false,data:null,error:{code,message,details}}`。主要错误码：`UNAUTHORIZED` 401、`INVALID_CREDENTIALS` 401、`TOO_MANY_ATTEMPTS` 429（带 Retry-After）、`CSRF_REJECTED` 403、`NOT_FOUND` 404、`ID_CONFLICT` 409、`FILE_TOO_LARGE` 413、`UNSUPPORTED_FILE_TYPE` 415、`VALIDATION_ERROR` 422、`INTERNAL_ERROR` 500。校验错误只回传位置与提示，不回显用户输入。

## 8. 前端对接

`src/content/loader.ts` 是前端唯一数据出口：`official` 模式调用 `api.ts`（`/api/public/*`）；`demo` 模式动态加载本地演示数据（正式构建中被剔除）。404 → `undefined`（显示“未找到”），其他失败抛 `ApiRequestError`（显示可重试的错误状态）。后端的 `null` 在 `api.ts` 里统一转成 `undefined`。

**部署形态固定为同源**：浏览器 → 同源 `/api` → Nginx → FastAPI。前端没有可配置的 API 地址，后端也没有 CORS；跨域 API 暂不作为正式部署方案（登录 Cookie 为 SameSite=Strict，跨域本来就跑不通）。演示模式的可见性规则与后端一致：只展示 `visibility: public` 且 `status: published` 的内容。

## 9. 已知限制

- 单 worker + 内存限流 + SQLite：个人站点足够；要多 worker/多实例需换 PostgreSQL 并把限流移到 Redis/Nginx。
- 没有网页管理界面（见 README）。
- 没有评论、搜索全文索引（前端按标题/摘要/标签在浏览器里过滤）。
- Markdown 由前端渲染；后端不处理 HTML 清洗（前端 react-markdown 默认不渲染原始 HTML）。
- 文件系统与数据库无法组成真正的原子事务：断电/强制终止仍可能留下需恢复的隔离文件或不一致状态；恢复脚本会拒绝不一致备份。不要绕过 API 修改上传目录，不要在 NFS/SMB 使用文件锁。
