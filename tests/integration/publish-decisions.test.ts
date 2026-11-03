import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { FastifyInstance } from "fastify";

/**
 * §5 / §6 回归：
 *   - 只有 publish 才返回资源决策，visibility 返回空数组；
 *   - visibility 不复制、不改变文件可见性；
 *   - 书架 sharedWithPrivate 反映"是否还被其它未公开内容引用"（自身 cover 不算）；
 *   - 书架发布对决策做严格校验：未知决策 / 非封面文件 / 重复 fileId 都 4xx，
 *     且失败后文件可见性、磁盘文件、审计都不变。
 */
const PG_PORT = 5593;
const HTTP_PORT = 5592;
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

async function uploadPrivate(name: string): Promise<{ id: string; revision: number }> {
  const form = new FormData();
  form.append("visibility", "private");
  form.append(
    "file",
    new Blob([new Uint8Array(Buffer.concat([PNG, Buffer.alloc(1024, 0x22)]))], { type: "image/png" }),
    name
  );
  const response = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/files`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie },
    body: form
  });
  const body: any = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.data.visibility, "private");
  return { id: body.data.id, revision: body.data.revision };
}

async function storedFileCount(): Promise<number> {
  let total = 0;
  for (const dir of ["public", "private"]) {
    try {
      total += (await readdir(path.join(workDir, "uploads", dir))).length;
    } catch {
      // 目录不存在按 0 计
    }
  }
  return total;
}

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "entroaxiom-decisions-"));
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
  const login = await call("POST", "/api/admin/login", {
    payload: { username: "admin", password: PASSWORD },
    cookie: ""
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const raw = login.data.data;
  assert.ok(raw.accessToken);
  // 真凭证只走 HttpOnly cookie，这里用注入的方式拿不到 set-cookie，改为再发一次拿头
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

// ------------------------------------------------------------ §5 文章可见性 vs 发布

test("§5 文章：publish 预检返回资源决策，visibility 预检返回空数组", async () => {
  const file = await uploadPrivate("article-cover.png");
  const created = await call("POST", "/api/admin/articles/notes", {
    payload: {
      id: "it-decisions",
      title: "决策测试",
      body: `![图](asset:${file.id})\n\n正文内容足够长，用来触发预检流程。`
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const revision = created.data.data.revision;

  const publishCheck = await call("POST", "/api/admin/articles/notes/it-decisions/publication-check", {
    payload: { action: "publish", baseRevision: revision }
  });
  assert.equal(publishCheck.status, 200, JSON.stringify(publishCheck.data));
  assert.equal(publishCheck.data.data.assetDecisions.length, 1);
  assert.equal(publishCheck.data.data.assetDecisions[0].fileId, file.id);
  assert.equal(
    publishCheck.data.data.assetDecisions[0].sharedWithPrivate,
    false,
    "只被自己引用时不应报共享"
  );

  const visibilityCheck = await call(
    "POST",
    "/api/admin/articles/notes/it-decisions/publication-check",
    { payload: { action: "visibility", baseRevision: revision, targetVisibility: "public" } }
  );
  assert.equal(visibilityCheck.status, 200, JSON.stringify(visibilityCheck.data));
  assert.deepEqual(
    visibilityCheck.data.data.assetDecisions,
    [],
    "只改可见范围不应返回资源决策"
  );
  assert.equal(visibilityCheck.data.data.canProceed, true);
});

test("§5 文章：切到 public 后文件仍是 private，公开地址 404（不复制、不公开）", async () => {
  const detail = await call("GET", "/api/admin/articles/notes/it-decisions");
  const revision = detail.data.data.revision;
  const before = await storedFileCount();

  const check = await call("POST", "/api/admin/articles/notes/it-decisions/publication-check", {
    payload: { action: "visibility", baseRevision: revision, targetVisibility: "public" }
  });
  assert.equal(check.status, 200, JSON.stringify(check.data));

  const patch = await call("PATCH", "/api/admin/articles/notes/it-decisions/visibility", {
    payload: {
      visibility: "public",
      baseRevision: revision,
      checkId: check.data.data.checkId
    }
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.data));
  assert.equal(patch.data.data.visibility, "public");

  const assets = patch.data.data.assets;
  assert.equal(assets.length, 1);
  assert.equal(assets[0].visibility, "private", "改可见范围不能顺手把文件转公开");
  assert.equal(assets[0].publicSrc, null);
  assert.equal(assets[0].fileId, assets[0].fileId);

  const fileDetail = await call("GET", `/api/admin/files/${assets[0].fileId}`);
  assert.equal(fileDetail.data.data.visibility, "private");
  assert.equal(fileDetail.data.data.publicSrc, null);
  assert.equal(await storedFileCount(), before, "改可见范围不应产生任何文件副本");
});

// ------------------------------------------------------------ §6 书架 sharedWithPrivate

let shelfSeq = 0;

async function createShelfWithCover(coverId: string): Promise<string> {
  shelfSeq += 1;
  const created = await call("POST", "/api/admin/shelf", {
    payload: {
      id: `it-shelf-${shelfSeq}`,
      kind: "book",
      title: "封面决策测试",
      creator: "某人",
      status: "done",
      cover: `asset:${coverId}`
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data.data.id;
}

let shelfIdForLater = "";

test("§6 书架：只被自己封面引用时 sharedWithPrivate=false", async () => {
  const cover = await uploadPrivate("shelf-cover.png");
  const id = await createShelfWithCover(cover.id);
  shelfIdForLater = id;
  const detail = await call("GET", `/api/admin/shelf/${id}`);

  const check = await call("POST", `/api/admin/shelf/${id}/publication-check`, {
    payload: { action: "publish", baseRevision: detail.data.data.revision }
  });
  assert.equal(check.status, 200, JSON.stringify(check.data));
  assert.equal(check.data.data.assetDecisions.length, 1);
  assert.equal(check.data.data.assetDecisions[0].sharedWithPrivate, false);
  assert.match(String(check.data.data.assetDecisions[0].reason), /私密/);
});

test("§6 书架：同一文件被另一篇私密文章引用时 sharedWithPrivate=true", async () => {
  const cover = await uploadPrivate("shelf-cover-shared.png");
  const id = await createShelfWithCover(cover.id);

  const article = await call("POST", "/api/admin/articles/notes", {
    payload: {
      id: "it-decisions-shared",
      title: "同图文章",
      body: `![共用](asset:${cover.id})\n\n正文内容足够长，用来制造共享引用。`
    }
  });
  assert.equal(article.status, 201, JSON.stringify(article.data));

  const detail = await call("GET", `/api/admin/shelf/${id}`);
  const check = await call("POST", `/api/admin/shelf/${id}/publication-check`, {
    payload: { action: "publish", baseRevision: detail.data.data.revision }
  });
  assert.equal(check.status, 200, JSON.stringify(check.data));
  assert.equal(
    check.data.data.assetDecisions[0].sharedWithPrivate,
    true,
    "还应识别出被其它未公开内容引用"
  );
  assert.match(String(check.data.data.assetDecisions[0].reason), /copy-public/);
});

test("§6 书架：visibility 预检不返回资源决策", async () => {
  const detail = await call("GET", `/api/admin/shelf/${shelfIdForLater}`);
  const check = await call("POST", `/api/admin/shelf/${shelfIdForLater}/publication-check`, {
    payload: { action: "visibility", baseRevision: detail.data.data.revision, targetVisibility: "public" }
  });
  assert.equal(check.status, 200, JSON.stringify(check.data));
  assert.deepEqual(check.data.data.assetDecisions, []);
});

// ------------------------------------------------------------ §6 决策严格校验

test("§6 书架发布：未知决策 4xx，且文件可见性与磁盘文件都不变", async () => {
  const cover = await uploadPrivate("shelf-bad-decision.png");
  const id = await createShelfWithCover(cover.id);
  const detail = await call("GET", `/api/admin/shelf/${id}`);
  const filesBefore = await storedFileCount();

  const check = await call("POST", `/api/admin/shelf/${id}/publication-check`, {
    payload: { action: "publish", baseRevision: detail.data.data.revision }
  });
  const publish = await call("POST", `/api/admin/shelf/${id}/publish`, {
    payload: {
      baseRevision: detail.data.data.revision,
      checkId: check.data.data.checkId,
      confirmed: true,
      assetDecisions: [{ fileId: cover.id, decision: "publish-anyway" }]
    }
  });
  assert.equal(publish.status, 422, JSON.stringify(publish.data));
  assert.equal(publish.data.error.code, "VALIDATION_ERROR");
  assert.match(JSON.stringify(publish.data.error.details), /未知的资源处理方式/);

  const fileDetail = await call("GET", `/api/admin/files/${cover.id}`);
  assert.equal(fileDetail.data.data.visibility, "private", "失败后不能悄悄改文件可见性");
  assert.equal(await storedFileCount(), filesBefore, "失败后不能留下孤儿副本");

  const shelfDetail = await call("GET", `/api/admin/shelf/${id}`);
  assert.equal(shelfDetail.data.data.publicationStatus, "draft", "失败后不能部分提交");
});

test("§6 书架发布：非封面 fileId 4xx", async () => {
  const other = await uploadPrivate("shelf-not-cover.png");
  const detail = await call("GET", `/api/admin/shelf/${shelfIdForLater}`);
  const check = await call("POST", `/api/admin/shelf/${shelfIdForLater}/publication-check`, {
    payload: { action: "publish", baseRevision: detail.data.data.revision }
  });
  const publish = await call("POST", `/api/admin/shelf/${shelfIdForLater}/publish`, {
    payload: {
      baseRevision: detail.data.data.revision,
      checkId: check.data.data.checkId,
      confirmed: true,
      assetDecisions: [{ fileId: other.id, decision: "make-public" }]
    }
  });
  assert.equal(publish.status, 422, JSON.stringify(publish.data));
  assert.match(JSON.stringify(publish.data.error.details), /不是本条目的封面/);
  const otherDetail = await call("GET", `/api/admin/files/${other.id}`);
  assert.equal(otherDetail.data.data.visibility, "private");
});

test("§6 书架发布：同一 fileId 重复决策 4xx", async () => {
  const detail = await call("GET", `/api/admin/shelf/${shelfIdForLater}`);
  const coverId = detail.data.data.cover.slice("asset:".length);
  const check = await call("POST", `/api/admin/shelf/${shelfIdForLater}/publication-check`, {
    payload: { action: "publish", baseRevision: detail.data.data.revision }
  });
  const publish = await call("POST", `/api/admin/shelf/${shelfIdForLater}/publish`, {
    payload: {
      baseRevision: detail.data.data.revision,
      checkId: check.data.data.checkId,
      confirmed: true,
      assetDecisions: [
        { fileId: coverId, decision: "keep-private" },
        { fileId: coverId, decision: "make-public" }
      ]
    }
  });
  assert.equal(publish.status, 422, JSON.stringify(publish.data));
  assert.match(JSON.stringify(publish.data.error.details), /多条处理决策/);
});

test("§6 书架发布：不传 decisions 时封面保持私密，coverUrl 为 null", async () => {
  const cover = await uploadPrivate("shelf-keep-private.png");
  const id = await createShelfWithCover(cover.id);
  const detail = await call("GET", `/api/admin/shelf/${id}`);
  const check = await call("POST", `/api/admin/shelf/${id}/publication-check`, {
    payload: { action: "publish", baseRevision: detail.data.data.revision }
  });
  const publish = await call("POST", `/api/admin/shelf/${id}/publish`, {
    payload: {
      baseRevision: detail.data.data.revision,
      checkId: check.data.data.checkId,
      confirmed: true
    }
  });
  assert.equal(publish.status, 200, JSON.stringify(publish.data));
  assert.equal(publish.data.data.publicationStatus, "published");
  assert.equal(publish.data.data.coverUrl, null, "未给决策时必须按 keep-private 处理");
  assert.equal(publish.data.data.coverVisibility, "private");

  const fileDetail = await call("GET", `/api/admin/files/${cover.id}`);
  assert.equal(fileDetail.data.data.visibility, "private");
});
