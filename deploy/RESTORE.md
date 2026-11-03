# 恢复演练（RTO 4h / RPO 24h）

备份是**快照式**的：每一份都是 `BACKUP_ROOT/daily|weekly/<YYYYMMDD-HHMMSS>/`，
里面同时有 `database.dump`、`uploads/public/`、`uploads/private/`、`manifest.txt`。

**库和文件必须来自同一个时间戳目录**。不要用今天的 dump 配昨天的 uploads，
也不要把备份 rsync 回生产 `/srv/entroaxiom/shared/uploads` 之后再验证 —— 那会污染生产。

## 0. 选一份快照

```bash
SNAP=/srv/entroaxiom/shared/backups/daily/20261101-033000
ls -l "$SNAP"            # 必须有 database.dump、uploads/、manifest.txt
cat "$SNAP/manifest.txt" # 时间戳、库名、PG 版本、文件数、dump 的 sha256
sha256sum "$SNAP/database.dump"   # 应与 manifest 里的 database_dump_sha256 一致
```

## 1. 恢复到独立的测试库（不碰生产库）

```bash
sudo -u postgres createdb entroaxiom_restore
sudo -u entroaxiom pg_restore --no-owner --no-privileges \
  -d "postgres://entroaxiom@127.0.0.1:5432/entroaxiom_restore" \
  "$SNAP/database.dump"
```

## 2. 恢复到临时上传目录（不碰生产目录）

```bash
RESTORE_UPLOADS=/tmp/entroaxiom-restore-uploads
mkdir -p "$RESTORE_UPLOADS"
rsync -a "$SNAP/uploads/public/"  "$RESTORE_UPLOADS/public/"
rsync -a "$SNAP/uploads/private/" "$RESTORE_UPLOADS/private/"
```

## 3. 用隔离环境起一次 API 验证

```bash
# 只改这三个变量，其余照抄生产 env；端口用 18000 避免撞上生产
cd /srv/entroaxiom/api
sudo -u entroaxiom env \
  DATABASE_URL="postgres://entroaxiom@127.0.0.1:5432/entroaxiom_restore" \
  UPLOAD_ROOT="$RESTORE_UPLOADS" \
  PORT=18000 \
  /usr/bin/node --max-old-space-size=384 dist/server.js
```

逐项确认：

1. `curl -fsS http://127.0.0.1:18000/readyz` → `{"status":"ready"}`。
2. 公开文章/书架条数与备份前一致（`/api/public/essays`、`/api/public/shelf`）。
3. `/api/public/files` 里随机挑一个，`curl -I http://127.0.0.1:18000/uploads/public/<id>.<ext>` 返回 200。
   （验证阶段由 Node 直接提供静态文件，正式环境由 Nginx 提供。）
4. 私密文件不能通过任何公开路径读到：`/uploads/public/<私密id>` 必须 404，
   后台 `/api/admin/files/<id>/content` 用管理员 Cookie 能读到。
5. 后台能登录，打开一篇草稿能看到正文与版本列表，发布时间/发布版本号与备份前一致。
6. 抽查一条留言的审核证据仍在（`moderation_evidence` 是快照，不受规则改名影响）。

## 4. 记录

把下面几项写进变更记录（也追加到 `docs/ACCEPTANCE.md` 的演练小节）：

- 用的是哪一份快照（目录名）、manifest 里的 `created_at` 与 `database_dump_sha256`
- 开始与结束时间、总耗时（RTO 目标 4h）
- 与生产环境的差异（条数、缺失文件、时区/编码差异）
- 遇到的问题与改进项

## 5. 真的需要回到生产时

1. 先停 `entroaxiom-api.service`（避免恢复期间有写入）。
2. 生产库先做一次**当前状态**的快照（`systemctl start entroaxiom-backup.service`），
   不要在没有退路的情况下覆盖。
3. 用同一快照恢复生产库与 `/srv/entroaxiom/shared/uploads`（先备份旧目录再替换）。
4. 起服务，重复第 3 节的 1–6 项验证。

## 6. 不要做的事

- 不要用 `pg_dump --clean` 直连生产库；也不要在生产库上 `pg_restore --clean`。
- 不要把 `.env`、cookie、会话数据打进备份（`backup.sh` 会检查并拒绝）。
- 不要把备份目录放在任何 Nginx 可以读到的静态根目录下。
- 不要只恢复数据库而不恢复 uploads —— 引用会全部变成悬空。