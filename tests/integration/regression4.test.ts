import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { FastifyInstance } from "fastify";

/**
 * 第四轮修复的回归（对应 REPAIR-REPORT.md 的 P1/P2 条目）：
 *   P1-1 date 列按日历日原样返回（没装 OID 1082 parser 时会整体差一天）；
 *   P1-3 同一原件的公开副本固定复用 `<fileId>-pub`，重复发布不再堆副本；
 *   P1-4 syncReferences 会清掉 published 作用域的旧引用，被淘汰的文件能删除；
 *   P2-1 越界页仍返回正确 total（不再因为空页返回 0）；
 *   P2-2 搜索关键词里的 % / _ 按字面量匹配，不当通配符。
 */
const PG_PORT = 5601;
const HTTP_PORT = 5600;
const ORIGIN = "http://127.0.0.1:8000";
const PASSWORD = "admin-password-1234";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILLER =
  "这是一段足够长的正文，用来让预检把 SHORT_BODY 降级成提醒而不是报错。" +
  "内容本身没有意义，只是为了让发布流程走到快照生成那一步。";

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let app: FastifyInstance;
let workDir: string;
let cookie = "";

async function call(
  method: string,
  url: string,
  opts: { payload?: unknown; cookie?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    cookie: opts.cookie ?? cookie,
    ...(opts.headers ?? {})
  };
  if (opts.payload !== undefined) headers["content-type"] = "application/json";
  const response = await app.inject({
    method: method as any,
    url,
    headers,
    payload: opts.payload === undefined ? undefined : JSON.stringify(opts.payload)
  });
  return { status: response.statusCode, data: JSON.parse(response.body) };
}

async function uploadPrivate(name: string): Promise<{ id: string; revision: number }> {
  const form = new FormData();
  form.append("visibility", "private");
  form.append(
    "file",
    new Blob([new Uint8Array(Buffer.concat([PNG, Buffer.alloc(256, 0x42)]))], {
      type: "image/png"
    }),
    name
  );
  const response = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/files`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie },
    body: form
  });
  const body: any = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return { id: body.data.id, revision: body.data.revision };
}

async function createNote(
  id: string,
  body: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const created = await call("POST", "/api/admin/articles/notes", {
    payload: { id, title: `回归 ${id}`, body, ...extra }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
}

/** 预检 + 用给定决策发布，返回发布响应。 */
async function publishNote(
  id: string,
  decisions: Array<{ fileId: string; decision: string }>
): Promise<{ status: number; data: any }> {
  const detail = await call("GET", `/api/admin/articles/notes/${id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  const revision = detail.data.data.revision;
  const check = await call("POST", `/api/admin/articles/notes/${id}/publication-check`, {
    payload: { action: "publish", baseRevision: revision }
  });
  assert.equal(check.status, 200, JSON.stringify(check.data));
  return call("POST", `/api/admin/articles/notes/${id}/publish`, {
    payload: {
      checkId: check.data.data.checkId,
      baseRevision: revision,
      assetDecisions: decisions,
      confirmed: true
    }
  });
}

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "entroaxiom-regression4-"));
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, port: PG_PORT, host: "127.0.0.1" });
  await socketServer.start();

  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.PUBLIC_ORIGIN = ORIGIN;
  process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
  process.env.IP_HASH_SECRET = "test-ip-secret-0123456789";
  process.env.UPLOAD_ROOT = path.join(workDir, "uploads");
  process.env.IMPORT_ROOT = path.join(workDir, "imports");
  process.env.BACKUP_ROOT = path.join(workDir, "backups");
  process.env.LOG_LEVEL = "silent";
  process.env.PG_POOL_MAX = "1";

  const { loadConfig } = await import("../../src/config.js");
  const { createPool, installTypeParsers } = await import("../../src/db/index.js");
  const { runMigrations } = await import("../../src/db/migrator.js");
  const { buildApp } = await import("../../src/app.js");
  const { createAdminUser } = await import("../../src/services/users.js");

  installTypeParsers();
  const config = loadConfig();
  const pool = createPool(config);
  await runMigrations(pool, path.resolve(process.cwd(), "src/db/migrations"));
  await pool.end();
  app = await buildApp({ config });
  await app.listen({ host: "127.0.0.1", port: HTTP_PORT });

  const { getContext } = await import("../../src/context.js");
  await createAdminUser(getContext().db, {
    username: "admin",
    password: PASSWORD,
    nickname: "站长",
    memoryKib: 8192
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: JSON.stringify({ username: "admin", password: PASSWORD })
  });
  const setCookie = response.headers["set-cookie"];
  cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
  assert.ok(cookie.startsWith("sid="));
});

after(async () => {
  if (app) await app.close();
  if (socketServer) await socketServer.stop();
  if (pglite) await pglite.close();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function publicFiles(): Promise<Array<{ id: string; storage_key: string }>> {
  const { getContext } = await import("../../src/context.js");
  return getContext()
    .db.selectFrom("files")
    .select(["id", "storage_key"])
    .where("visibility", "=", "public")
    .where("deleted_at", "is", null)
    .execute();
}

async function publicDirCount(): Promise<number> {
  try {
    return (await readdir(path.join(workDir, "uploads", "public"))).length;
  } catch {
    return 0;
  }
}

// -------------------------------------------------- P1-1 date 按日历日返回

test("date 列按写入的日历日返回，存储层也不出现时区偏移", async () => {
  await createNote("it-r4-date", FILLER, { date: "2026-03-01", updated: "2026-03-02" });

  const detail = await call("GET", "/api/admin/articles/notes/it-r4-date");
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.data.date, "2026-03-01");
  assert.equal(detail.data.data.updated, "2026-03-02");

  const list = await call("GET", "/api/admin/articles/notes?keyword=it-r4-date&page_size=5");
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.equal(list.data.data.items[0].date, "2026-03-01");

  // 直连数据库：装了 OID 1082 parser 之后 date 列是原样字符串，
  // 不会变成一个本地零点的 Date 再被格式化回去。
  const { getContext } = await import("../../src/context.js");
  const raw = await getContext()
    .db.selectFrom("articles")
    .select(["date", "updated"])
    .where("id", "=", "it-r4-date")
    .executeTakeFirstOrThrow();
  assert.equal(raw.date, "2026-03-01");
  assert.equal(raw.updated, "2026-03-02");
});

// -------------------------------------------------- P1-3 公开副本复用

test("同一原件的公开副本固定为 <fileId>-pub，重复发布不新增副本", async () => {
  const file = await uploadPrivate("reuse.png");
  await createNote("it-r4-copy", `![图](asset:${file.id})\n\n${FILLER}`);

  const first = await publishNote("it-r4-copy", [{ fileId: file.id, decision: "copy-public" }]);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const publishedFirst = await call("GET", "/api/admin/articles/notes/it-r4-copy/published");
  assert.equal(publishedFirst.status, 200, JSON.stringify(publishedFirst.data));
  assert.equal(
    publishedFirst.data.data.body.includes(`/uploads/public/${file.id}-pub.png`),
    true,
    "线上正文必须指向派生出来的那份公开副本"
  );

  const afterFirst = await publicFiles();
  const afterFirstDisk = await publicDirCount();
  assert.deepEqual(
    afterFirst.map(row => row.id),
    [`${file.id}-pub`]
  );

  // 改一次正文再发一次：副本必须复用，否则每发一次就多一份、旧副本被历史版本钉住
  const detail = await call("GET", "/api/admin/articles/notes/it-r4-copy");
  const put = await call("PUT", "/api/admin/articles/notes/it-r4-copy", {
    payload: {
      baseRevision: detail.data.data.revision,
      title: detail.data.data.title,
      body: `![图](asset:${file.id})\n\n${FILLER}再说一句。`
    }
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));

  const second = await publishNote("it-r4-copy", [{ fileId: file.id, decision: "copy-public" }]);
  assert.equal(second.status, 200, JSON.stringify(second.data));
  const publishedSecond = await call("GET", "/api/admin/articles/notes/it-r4-copy/published");
  assert.equal(publishedSecond.status, 200, JSON.stringify(publishedSecond.data));
  assert.equal(
    publishedSecond.data.data.body.includes(`/uploads/public/${file.id}-pub.png`),
    true,
    "重复发布必须复用同一份公开副本"
  );

  const afterSecond = await publicFiles();
  assert.deepEqual(
    afterSecond.map(row => row.id),
    [`${file.id}-pub`]
  );
  assert.equal(await publicDirCount(), afterFirstDisk, "磁盘上也不应该多出第二份副本");
});

// -------------------------------------------------- P1-4 published 引用清理

test("正文不再引用的文件，published 引用会被清掉，文件可以删除", async () => {
  const kept = await uploadPrivate("kept.png");
  const dropped = await uploadPrivate("dropped.png");
  await createNote(
    "it-r4-refs",
    `![a](asset:${kept.id})\n\n![b](asset:${dropped.id})\n\n${FILLER}`
  );

  const first = await publishNote("it-r4-refs", [
    { fileId: kept.id, decision: "keep-private" },
    { fileId: dropped.id, decision: "keep-private" }
  ]);
  assert.equal(first.status, 200, JSON.stringify(first.data));

  // 正文改成只引用 kept，再发布一次
  const detail = await call("GET", "/api/admin/articles/notes/it-r4-refs");
  const put = await call("PUT", "/api/admin/articles/notes/it-r4-refs", {
    payload: {
      baseRevision: detail.data.data.revision,
      title: detail.data.data.title,
      body: `![a](asset:${kept.id})\n\n${FILLER}`
    }
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));

  const second = await publishNote("it-r4-refs", [
    { fileId: kept.id, decision: "keep-private" }
  ]);
  assert.equal(second.status, 200, JSON.stringify(second.data));

  // dropped 现在既不在工作稿引用里，也不在线上快照引用里
  const del = await call("DELETE", `/api/admin/files/${dropped.id}`, {
    headers: { "if-match": String(dropped.revision) }
  });
  assert.equal(del.status, 200, JSON.stringify(del.data));

  // kept 仍在线上正文里，删除必须继续被挡住（说明上面的清理不是"一律放开"）
  const delKept = await call("DELETE", `/api/admin/files/${kept.id}`, {
    headers: { "if-match": String(kept.revision) }
  });
  assert.equal(delKept.status, 409, JSON.stringify(delKept.data));
  assert.equal(delKept.data.error.code, "FILE_IN_USE");
});

// -------------------------------------------------- P2-1 越界页 total

test("越界页返回空列表，但 total 仍是真实总数", async () => {
  const firstPage = await call("GET", "/api/admin/articles/notes?page=1&page_size=100");
  assert.equal(firstPage.status, 200, JSON.stringify(firstPage.data));
  const total = firstPage.data.data.total;
  assert.ok(total >= 3, `total=${total}`);

  const far = await call("GET", "/api/admin/articles/notes?page=99&page_size=10");
  assert.equal(far.status, 200, JSON.stringify(far.data));
  assert.deepEqual(far.data.data.items, []);
  assert.equal(far.data.data.total, total);
});

// -------------------------------------------------- P2-2 LIKE 字面量

test("关键词里的 % 与 _ 按字面量匹配，不被当成通配符", async () => {
  await createNote("it-r4-like-hit", FILLER, { title: "100%满意的小记" });
  await createNote("it-r4-like-miss", FILLER, { title: "1000 条满意的小记" });
  await createNote("it-r4-underscore-hit", FILLER, { title: "版本 a_b 说明" });
  await createNote("it-r4-underscore-miss", FILLER, { title: "版本 axb 说明" });

  const percent = await call(
    "GET",
    `/api/admin/articles/notes?keyword=${encodeURIComponent("100%满意")}&page_size=20`
  );
  assert.equal(percent.status, 200, JSON.stringify(percent.data));
  assert.deepEqual(
    percent.data.data.items.map((item: any) => item.id),
    ["it-r4-like-hit"]
  );

  const underscore = await call(
    "GET",
    `/api/admin/articles/notes?keyword=${encodeURIComponent("a_b")}&page_size=20`
  );
  assert.equal(underscore.status, 200, JSON.stringify(underscore.data));
  assert.deepEqual(
    underscore.data.data.items.map((item: any) => item.id),
    ["it-r4-underscore-hit"]
  );
});
