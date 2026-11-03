import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { FastifyInstance } from "fastify";
import { ZipFile } from "yazl";

/**
 * 定向验收（对应修复文档 §6）：
 *   §3.1 带 error 的预检不能被消费成一次成功发布；
 *   §3.2 书影音公开封面按 publication_status 取 published_cover；
 *   §3.3 数据库写失败时不能留下"指向不存在文件"的记录，也不能留公开孤儿；
 *   §3.4 ZIP 导入的嵌套目录相对引用要改写成 asset:<id>；
 *   §4.1 refresh 只认 HttpOnly sid，不接受请求体里的 refreshToken；
 *   §4.2 公开文件缓存 5 分钟，且不再声明 immutable；
 *   §4.3 TRUST_PROXY 默认关闭，直连端口伪造 X-Forwarded-For 不影响来源判定。
 */
const PG_PORT = 5589;
const HTTP_PORT = 5588;
const ORIGIN = "http://127.0.0.1:8000";
const PASSWORD = "admin-password-1234";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let app: FastifyInstance;
let workDir: string;
let cookie = "";

async function call(
  method: string,
  url: string,
  opts: { payload?: unknown; cookie?: string } = {}
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    cookie: opts.cookie ?? cookie
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

async function upload(name: string, visibility: "private" | "public"): Promise<{ id: string; revision: number }> {
  const form = new FormData();
  form.append("visibility", visibility);
  form.append(
    "file",
    new Blob([new Uint8Array(Buffer.concat([PNG, Buffer.alloc(512, 0x33)]))], { type: "image/png" }),
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

async function countFiles(...segments: string[]): Promise<number> {
  try {
    return (await readdir(path.join(workDir, "uploads", ...segments))).length;
  } catch {
    return 0;
  }
}

/** 用 CHECK(false) 让某张表的下一次写入确定失败，用完立刻移除。 */
async function withFailingTable<T>(table: string, run: () => Promise<T>): Promise<T> {
  const name = `failing_${table}_check`;
  await pglite.exec(`alter table ${table} add constraint ${name} check (false) not valid`);
  try {
    return await run();
  } finally {
    await pglite.exec(`alter table ${table} drop constraint ${name}`);
  }
}

async function makeZip(entries: Record<string, Buffer | string>): Promise<Buffer> {
  const zip = new ZipFile();
  for (const [name, value] of Object.entries(entries)) {
    zip.addBuffer(typeof value === "string" ? Buffer.from(value, "utf8") : value, name);
  }
  zip.end();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.on("data", chunk => chunks.push(chunk as Buffer));
    zip.outputStream.on("end", () => resolve());
    zip.outputStream.on("error", reject);
  });
  return Buffer.concat(chunks);
}

async function previewZip(zip: Buffer, res: "notes" | "essays") {
  const form = new FormData();
  form.append("type", res);
  form.append("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), "import.zip");
  const response = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/imports/preview`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie },
    body: form
  });
  const body: any = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data;
}

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "entroaxiom-consistency-"));
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

async function createArticle(id: string, body: string, title = "一致性测试"): Promise<number> {
  const created = await call("POST", "/api/admin/articles/notes", {
    payload: {
      id,
      title,
      body,
      summary: "摘要",
      category: null,
      tags: null,
      date: null,
      updated: null
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data.data.revision as number;
}

// ---------------------------------------------------------------- §3.1 预检 error 不可发布

test("§3.1 consumeCheck 拒绝任何带 error 的预检记录，只放行纯 warning", async () => {
  const { getContext } = await import("../../src/context.js");
  const { createCheck, consumeCheck } = await import("../../src/services/checks.js");
  const db = getContext().db;

  const scope = {
    userId: (await db
      .selectFrom("users")
      .select("id")
      .where("username", "=", "admin")
      .executeTakeFirstOrThrow()).id,
    subjectType: "article" as const,
    subjectId: "it-check-guard",
    action: "publish" as const,
    targetVisibility: null,
    baseRevision: 1,
    privateAssetIds: [] as string[]
  };

  const blocked = await createCheck(db, scope, [
    { code: "EMPTY_BODY", severity: "error", message: "正文不能为空" }
  ]);
  await assert.rejects(
    () => consumeCheck(db, { ...scope, checkId: blocked.checkId }),
    (error: any) => error.code === "CHECK_MISMATCH" && /预检未通过/.test(String(error.message))
  );

  // 只有 warning 的预检可以正常消费，说明上面不是"一律拒绝"。
  const allowed = await createCheck(db, scope, [
    { code: "MISSING_SUMMARY", severity: "warning", message: "还没有写摘要" }
  ]);
  await consumeCheck(db, { ...scope, checkId: allowed.checkId });
});

test("§3.1 悬空附件的预检 error 同样挡在发布之前", async () => {
  const revision = await createArticle("it-dangling-ref", "正文引用了一个不存在的附件 ![x](asset:missingfile)");
  const checked = await call("POST", "/api/admin/articles/notes/it-dangling-ref/publication-check", {
    payload: { action: "publish", baseRevision: revision }
  });
  const check = checked.data.data;
  assert.equal(check.canProceed, false);
  assert.ok(check.checks.some((item: any) => item.code === "DANGLING_REF"));

  const published = await call("POST", "/api/admin/articles/notes/it-dangling-ref/publish", {
    payload: { baseRevision: revision, checkId: check.checkId, confirmed: true }
  });
  assert.equal(published.status, 409);
  const publishedView = await call("GET", "/api/admin/articles/notes/it-dangling-ref/published");
  assert.equal(publishedView.status, 404);
});

test("§3.1 书架悬空封面的预检 error 挡在发布之前", async () => {
  const created = await call("POST", "/api/admin/shelf", {
    payload: {
      id: "it-shelf-dangling",
      kind: "book",
      title: "悬空封面",
      creator: "某人",
      year: 2020,
      rating: 4,
      status: "done",
      date: null,
      tags: null,
      quote: null,
      review: null,
      cover: "asset:nosuchfile",
      link: null
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const revision = created.data.data.revision as number;

  const checked = await call("POST", "/api/admin/shelf/it-shelf-dangling/publication-check", {
    payload: { action: "publish", baseRevision: revision }
  });
  const check = checked.data.data;
  assert.equal(check.canProceed, false);
  assert.ok(check.checks.some((item: any) => item.code === "DANGLING_COVER"));

  const published = await call("POST", "/api/admin/shelf/it-shelf-dangling/publish", {
    payload: { baseRevision: revision, checkId: check.checkId, confirmed: true }
  });
  assert.equal(published.status, 409);

  const detail = await call("GET", "/api/admin/shelf/it-shelf-dangling");
  assert.equal(detail.data.data.publicationStatus, "draft");
  assert.equal(detail.data.data.revision, revision);
});

test("§3.1 正常预检仍然可以发布文章与书架", async () => {
  const revision = await createArticle("it-clean-publish", "正文内容足够长，可以正常发布出去。", "正常发布");
  const checked = await call("POST", "/api/admin/articles/notes/it-clean-publish/publication-check", {
    payload: { action: "publish", baseRevision: revision }
  });
  assert.equal(checked.data.data.canProceed, true);
  const published = await call("POST", "/api/admin/articles/notes/it-clean-publish/publish", {
    payload: { baseRevision: revision, checkId: checked.data.data.checkId, confirmed: true }
  });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.data.status, "published");

  const created = await call("POST", "/api/admin/shelf", {
    payload: {
      id: "it-shelf-clean",
      kind: "film",
      title: "正常发布",
      creator: "导演",
      year: 2019,
      rating: 3.5,
      status: "done",
      date: null,
      tags: null,
      quote: null,
      review: null,
      cover: null,
      link: null
    }
  });
  const shelfRevision = created.data.data.revision as number;
  const shelfCheck = await call("POST", "/api/admin/shelf/it-shelf-clean/publication-check", {
    payload: { action: "publish", baseRevision: shelfRevision }
  });
  assert.equal(shelfCheck.data.data.canProceed, true);
  const shelfPublished = await call("POST", "/api/admin/shelf/it-shelf-clean/publish", {
    payload: {
      baseRevision: shelfRevision,
      checkId: shelfCheck.data.data.checkId,
      confirmed: true,
      assetDecisions: []
    }
  });
  assert.equal(shelfPublished.status, 200, JSON.stringify(shelfPublished.data));
  assert.equal(shelfPublished.data.data.publicationStatus, "published");
});

// ---------------------------------------------------------------- §3.2 公开封面字段

test("§3.2 私密封面 copy-public 后公开接口返回公开副本，原件仍私密", async () => {
  const file = await upload("shelf-cover.png", "private");
  const created = await call("POST", "/api/admin/shelf", {
    payload: {
      id: "it-shelf-cover",
      kind: "music",
      title: "封面测试",
      creator: "乐队",
      year: 2021,
      rating: 5,
      status: "done",
      date: null,
      tags: null,
      quote: null,
      review: null,
      cover: `asset:${file.id}`,
      link: null
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const revision = created.data.data.revision as number;

  const checked = await call("POST", "/api/admin/shelf/it-shelf-cover/publication-check", {
    payload: { action: "publish", baseRevision: revision, targetVisibility: "public" }
  });
  const check = checked.data.data;
  assert.equal(check.canProceed, true);
  assert.equal(check.assetDecisions.length, 1);

  const published = await call("POST", "/api/admin/shelf/it-shelf-cover/publish", {
    payload: {
      baseRevision: revision,
      checkId: check.checkId,
      confirmed: true,
      targetVisibility: "public",
      assetDecisions: [{ fileId: file.id, decision: "copy-public" }]
    }
  });
  assert.equal(published.status, 200, JSON.stringify(published.data));

  const detail = await call("GET", "/api/public/shelf/it-shelf-cover");
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  const cover: string = detail.data.data.cover;
  assert.ok(cover.startsWith("/uploads/public/"), `cover 应该是公开副本地址，实际是 ${cover}`);

  // 公开副本可以匿名读取，原私密文件仍然不可通过公开地址访问。
  const publicCopy = await app.inject({ method: "GET", url: cover });
  assert.equal(publicCopy.statusCode, 200);
  const originalPublic = await app.inject({ method: "GET", url: `/uploads/public/${file.id}.png` });
  assert.equal(originalPublic.statusCode, 404);
  const originalAdmin = await app.inject({
    method: "GET",
    url: `/api/admin/files/${file.id}/content`,
    headers: { cookie, origin: ORIGIN }
  });
  assert.equal(originalAdmin.statusCode, 200);

  const list = await call("GET", "/api/public/shelf");
  assert.equal(list.status, 200);
  const listed = list.data.data.find((item: any) => item.id === "it-shelf-cover");
  assert.ok(listed, "公开列表里应该有这个条目");
  assert.equal(listed.cover, cover);
});

test("§3.2 撤回后公开接口不再返回该条目", async () => {
  const detail = await call("GET", "/api/admin/shelf/it-shelf-cover");
  const revision = detail.data.data.revision as number;
  const unpublished = await call("POST", "/api/admin/shelf/it-shelf-cover/unpublish", {
    payload: { baseRevision: revision }
  });
  assert.equal(unpublished.status, 200, JSON.stringify(unpublished.data));

  const publicDetail = await call("GET", "/api/public/shelf/it-shelf-cover");
  assert.equal(publicDetail.status, 404);
  const list = await call("GET", "/api/public/shelf");
  assert.equal(
    list.data.data.some((item: any) => item.id === "it-shelf-cover"),
    false
  );
});

// ---------------------------------------------------------------- §3.3 文件与事务一致性

test("§3.3 发布时数据库写入失败：不留公开孤儿，也不产生快照", async () => {
  const file = await upload("rollback-cover.png", "private");
  const revision = await createArticle("it-rollback-publish", `![p](asset:${file.id})`, "回滚测试");
  const checked = await call("POST", "/api/admin/articles/notes/it-rollback-publish/publication-check", {
    payload: { action: "publish", baseRevision: revision }
  });
  const check = checked.data.data;
  assert.equal(check.assetDecisions.length, 1);

  const publicBefore = await countFiles("public");

  // file_references 是发布事务里较靠后的一步：此时公开副本已经复制完成。
  const failure = await withFailingTable("file_references", async () =>
    call("POST", "/api/admin/articles/notes/it-rollback-publish/publish", {
      payload: {
        baseRevision: revision,
        checkId: check.checkId,
        confirmed: true,
        assetDecisions: [{ fileId: file.id, decision: "copy-public" }]
      }
    })
  );
  assert.ok(failure.status >= 400, JSON.stringify(failure.data));

  assert.equal(await countFiles("public"), publicBefore, "回滚后不应该留下公开副本");
  const publishedView = await call("GET", "/api/admin/articles/notes/it-rollback-publish/published");
  assert.equal(publishedView.status, 404);
  const detail = await call("GET", "/api/admin/articles/notes/it-rollback-publish");
  assert.equal(detail.data.data.status, "draft");
  assert.equal(detail.data.data.revision, revision);

  // 事务回滚后记录仍在，且它指向的私密文件还能读出来（没有指向不存在的文件）。
  const original = await app.inject({
    method: "GET",
    url: `/api/admin/files/${file.id}/content`,
    headers: { cookie, origin: ORIGIN }
  });
  assert.equal(original.statusCode, 200);
});

test("§3.3 删除文件时审计写入失败：记录与磁盘文件都保留", async () => {
  const file = await upload("delete-rollback.png", "private");
  const privateBefore = await countFiles("private");

  const failure = await withFailingTable("audit_logs", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/admin/files/${file.id}`,
      headers: { origin: ORIGIN, cookie, "if-match": "1" }
    });
    return { status: response.statusCode, data: JSON.parse(response.body) };
  });
  assert.ok(failure.status >= 400, JSON.stringify(failure.data));

  assert.equal(await countFiles("private"), privateBefore, "回滚后磁盘文件必须还在");
  const still = await call("GET", `/api/admin/files/${file.id}`);
  assert.equal(still.status, 200);
  assert.equal(still.data.data.id, file.id);
});

test("§3.3 改可见性时审计写入失败：可见性不变且不留下新的公开副本", async () => {
  const file = await upload("visibility-rollback.png", "private");
  const publicBefore = await countFiles("public");

  const failure = await withFailingTable("audit_logs", async () =>
    call("PUT", `/api/admin/files/${file.id}`, {
      payload: { visibility: "public", baseRevision: 1 }
    })
  );
  assert.ok(failure.status >= 400, JSON.stringify(failure.data));

  assert.equal(await countFiles("public"), publicBefore, "回滚后不应该留下新目录里的副本");
  const still = await call("GET", `/api/admin/files/${file.id}`);
  assert.equal(still.data.data.visibility, "private");
});

// ---------------------------------------------------------------- §3.4 ZIP 导入嵌套引用

test("§3.4 根目录的 md 引用根目录资源会改写成 asset:<id>", async () => {
  const zip = await makeZip({
    "root.md": "---\nid: it-zip-root\ntitle: 根目录导入\nsummary: 摘要\n---\n\n![图](pic.png)\n",
    "pic.png": Buffer.concat([PNG, Buffer.alloc(64, 0x44)])
  });
  const preview = await previewZip(zip, "notes");
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.missingCount, 0);
  await call("POST", `/api/admin/imports/${preview.importId}/select`, { payload: { path: "root.md" } });
  const committed = await call("POST", `/api/admin/imports/${preview.importId}/commit`, {
    payload: { mode: "create", draft: { ...preview.draft, id: "it-zip-root" }, includeUnreferencedPaths: [] }
  });
  assert.equal(committed.status, 200, JSON.stringify(committed.data));

  const detail = await call("GET", "/api/admin/articles/notes/it-zip-root");
  const body: string = detail.data.data.body;
  assert.match(body, /asset:[A-Za-z0-9_-]+/);
  assert.equal(body.includes("](pic.png)"), false);
});

test("§3.4 子目录的 md 引用同目录资源与 ../ 资源都会改写成 asset:<id>", async () => {
  const zip = await makeZip({
    "notes/article.md":
      "---\nid: it-zip-nested\ntitle: 子目录导入\nsummary: 摘要\n---\n\n![同目录](assets/pic.png)\n\n![上级](../assets/up.png)\n",
    "notes/assets/pic.png": Buffer.concat([PNG, Buffer.alloc(64, 0x55)]),
    "assets/up.png": Buffer.concat([PNG, Buffer.alloc(64, 0x66)])
  });
  const preview = await previewZip(zip, "notes");
  assert.equal(preview.missingCount, 0, JSON.stringify(preview.warnings));
  const selected = await call("POST", `/api/admin/imports/${preview.importId}/select`, {
    payload: { path: "notes/article.md" }
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.data));
  const refreshed = selected.data.data;
  const committed = await call("POST", `/api/admin/imports/${refreshed.importId}/commit`, {
    payload: { mode: "create", draft: { ...refreshed.draft, id: "it-zip-nested" }, includeUnreferencedPaths: [] }
  });
  assert.equal(committed.status, 200, JSON.stringify(committed.data));

  const detail = await call("GET", "/api/admin/articles/notes/it-zip-nested");
  const body: string = detail.data.data.body;
  assert.equal(body.includes("assets/pic.png"), false, body);
  assert.equal(body.includes("../assets/up.png"), false, body);
  const hits = body.match(/asset:[A-Za-z0-9_-]+/g) ?? [];
  assert.equal(hits.length, 2, body);
});

test("§3.4 缺失资源不会被编造出 asset:<id>", async () => {
  const zip = await makeZip({
    "notes/lonely.md":
      "---\nid: it-zip-missing\ntitle: 缺资源导入\nsummary: 摘要\n---\n\n![缺](assets/none.png)\n"
  });
  const preview = await previewZip(zip, "notes");
  assert.equal(preview.missingCount, 1);
  const selected = await call("POST", `/api/admin/imports/${preview.importId}/select`, {
    payload: { path: "notes/lonely.md" }
  });
  const refreshed = selected.data.data;
  // 缺资源的包不允许提交（422），因此正文不会被写成指向不存在的 asset:<id>。
  const committed = await call("POST", `/api/admin/imports/${preview.importId}/commit`, {
    payload: { mode: "create", draft: { ...refreshed.draft, id: "it-zip-missing" }, includeUnreferencedPaths: [] }
  });
  assert.equal(committed.status, 422, JSON.stringify(committed.data));
  const detail = await call("GET", "/api/admin/articles/notes/it-zip-missing");
  assert.equal(detail.status, 404);
});

// ---------------------------------------------------------------- §4.1 刷新只认 sid

test("§4.1 refresh 只认 sid cookie，请求体里的 refreshToken 不起作用", async () => {
  const fake = await call("POST", "/api/admin/refresh-token", {
    payload: { refreshToken: "definitely-not-a-session" },
    cookie: ""
  });
  assert.equal(fake.status, 401);
  assert.equal(fake.data.error.code, "INVALID_REFRESH_TOKEN");

  const real = await call("POST", "/api/admin/refresh-token", {
    payload: { refreshToken: "still-not-a-session" }
  });
  assert.equal(real.status, 200, JSON.stringify(real.data));
  assert.ok(real.data.data.accessToken);
});

// ---------------------------------------------------------------- §4.2 / §4.3 缓存与来源

test("§4.2 公开文件响应头是 5 分钟缓存且没有 immutable", async () => {
  // 上一节的 refresh 轮换已经吊销了旧 sid，这里重新登录拿一个新会话。
  const relogin = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: JSON.stringify({ username: "admin", password: PASSWORD })
  });
  assert.equal(relogin.statusCode, 200, relogin.body);
  const fresh = relogin.headers["set-cookie"];
  cookie = String(Array.isArray(fresh) ? fresh[0] : fresh).split(";")[0];

  const file = await upload("cache-header.png", "public");
  const response = await app.inject({ method: "GET", url: `/uploads/public/${file.id}.png` });
  assert.equal(response.statusCode, 200);
  const cacheControl = String(response.headers["cache-control"] ?? "");
  assert.match(cacheControl, /max-age=300/);
  assert.equal(cacheControl.includes("immutable"), false);
});

test("§4.3 TRUST_PROXY 默认关闭，伪造 X-Forwarded-For 不改变客户端地址", async () => {
  const { getContext } = await import("../../src/context.js");
  assert.equal(getContext().config.trustProxy, false);

  const spoofed = await app.inject({
    method: "POST",
    url: "/api/public/guestbook",
    headers: {
      origin: ORIGIN,
      "x-requested-with": "entroaxiom",
      "x-forwarded-for": "203.0.113.9",
      "content-type": "application/json"
    },
    payload: JSON.stringify({ name: "路过", body: "伪造来源测试", sigil: "sun" })
  });
  assert.equal(spoofed.statusCode, 201, spoofed.body);
  assert.notEqual(spoofed.headers["x-forwarded-for"], "203.0.113.9");
});