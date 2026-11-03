import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { FastifyInstance } from "fastify";

/**
 * §8 并发语义回归。
 *
 * 这里有两类用例：
 *
 * 1. 顺序单次消费（默认就跑）：checkId 重放必须被拒。这条不需要真并发，
 *    验证的是"凭据消费是原子的、不会被重复使用"。
 *
 * 2. 真实竞争（需要 `PG_REAL_INTEGRATION=1` 指向真 PostgreSQL 16）：
 *    同一 Cookie 并发 refresh、同一 revision 并发保存、同一 checkId 并发发布，
 *    都必须"恰好一个成功"。
 *
 * 为什么第 2 类默认跳过：本机验收用的是 PGlite + pglite-socket，它一次只接受
 * 一条连接（多连接会 ECONNRESET），PG_POOL_MAX 只能设 1，所有请求会被串行化，
 * 那样测出来的"并发"是假的。所以真并发必须在真 PG16 上跑，命令见 README：
 *   PG_REAL_INTEGRATION=1 DATABASE_URL=... npm run test:integration
 */
const REAL_PG = process.env.PG_REAL_INTEGRATION === "1";
const POOL_MAX = REAL_PG ? 5 : 1;
const SKIP_REASON =
  "需要真 PostgreSQL 16（PG_REAL_INTEGRATION=1）；PGlite socket 只支持单连接，无法制造真实竞争";

const PG_PORT = Number(process.env.TEST_PG_PORT ?? 5591);
const HTTP_PORT = Number(process.env.TEST_HTTP_PORT ?? 5590);
const ORIGIN = "http://127.0.0.1:8000";
const PASSWORD = "admin-password-1234";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let pglite: PGlite | null = null;
let socketServer: PGLiteSocketServer | null = null;
let app: FastifyInstance;
let workDir: string;
let cookie = "";

async function inject(
  method: string,
  url: string,
  opts: { payload?: unknown; cookie?: string } = {}
): Promise<{ status: number; data: any; setCookie: string | null }> {
  const headers: Record<string, string> = { origin: ORIGIN, cookie: opts.cookie ?? cookie };
  if (opts.payload !== undefined) headers["content-type"] = "application/json";
  const response = await app.inject({
    method: method as any,
    url,
    headers,
    payload: opts.payload === undefined ? undefined : JSON.stringify(opts.payload)
  });
  const raw = response.headers["set-cookie"];
  return {
    status: response.statusCode,
    data: JSON.parse(response.body),
    setCookie: raw ? String(Array.isArray(raw) ? raw[0] : raw).split(";")[0] : null
  };
}

async function login(): Promise<string> {
  const result = await inject("POST", "/api/admin/login", {
    payload: { username: "admin", password: PASSWORD },
    cookie: ""
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(result.setCookie && result.setCookie.startsWith("sid="));
  return result.setCookie;
}

async function uploadPublic(name: string): Promise<{ id: string }> {
  const form = new FormData();
  form.append("visibility", "public");
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
  return { id: body.data.id };
}

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "entroaxiom-concurrency-"));

  if (REAL_PG) {
    assert.ok(process.env.DATABASE_URL, "PG_REAL_INTEGRATION=1 时必须提供 DATABASE_URL");
  } else {
    pglite = await PGlite.create();
    socketServer = new PGLiteSocketServer({ db: pglite, port: PG_PORT, host: "127.0.0.1" });
    await socketServer.start();
    process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`;
  }

  process.env.NODE_ENV = "test";
  process.env.PUBLIC_ORIGIN = ORIGIN;
  process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
  process.env.IP_HASH_SECRET = "test-ip-secret-0123456789";
  process.env.UPLOAD_ROOT = path.join(workDir, "uploads");
  process.env.IMPORT_ROOT = path.join(workDir, "imports");
  process.env.BACKUP_ROOT = path.join(workDir, "backups");
  process.env.LOG_LEVEL = "silent";
  process.env.PG_POOL_MAX = String(POOL_MAX);

  const { loadConfig } = await import("../../src/config.js");
  const { createPool, installTypeParsers } = await import("../../src/db/index.js");
  const { runMigrations } = await import("../../src/db/migrator.js");
  const { buildApp } = await import("../../src/app.js");
  const { createAdminUser, findUserByUsername } = await import("../../src/services/users.js");

  installTypeParsers();
  const config = loadConfig();
  const pool = createPool(config);
  if (REAL_PG) {
    // 真 PG16：库可能是复用的，先确保结构在，再保证管理员存在
    await runMigrations(pool, path.resolve(process.cwd(), "src/db/migrations"));
  } else {
    await runMigrations(pool, path.resolve(process.cwd(), "src/db/migrations"));
  }
  await pool.end();

  app = await buildApp({ config });
  await app.listen({ host: "127.0.0.1", port: HTTP_PORT });

  const { getContext } = await import("../../src/context.js");
  const db = getContext().db;
  if (!(await findUserByUsername(db, "admin"))) {
    await createAdminUser(db, {
      username: "admin",
      password: PASSWORD,
      nickname: "站长",
      memoryKib: 8192
    });
  }
  cookie = await login();
});

after(async () => {
  if (app) await app.close();
  if (socketServer) await socketServer.stop();
  if (pglite) await pglite.close();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

// ------------------------------------------------- 默认就跑：凭据单次消费（顺序）

test("§8 发布 checkId 只能消费一次：重放同一 checkId 被拒", async () => {
  const image = await uploadPublic("once.png");
  const created = await inject("POST", "/api/admin/articles/essays", {
    payload: {
      id: "it-once",
      title: "单次消费测试",
      body: `![图](asset:${image.id})\n\n正文内容足够长，用来触发发布流程。`
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const revision = created.data.data.revision;

  const check = await inject("POST", "/api/admin/articles/essays/it-once/publication-check", {
    payload: { action: "publish", baseRevision: revision }
  });
  assert.equal(check.status, 200, JSON.stringify(check.data));
  const checkId = check.data.data.checkId;

  const first = await inject("POST", "/api/admin/articles/essays/it-once/publish", {
    payload: { baseRevision: revision, checkId, confirmed: true }
  });
  assert.equal(first.status, 200, JSON.stringify(first.data));

  const replay = await inject("POST", "/api/admin/articles/essays/it-once/publish", {
    payload: { baseRevision: revision, checkId, confirmed: true }
  });
  assert.equal(replay.status, 409, JSON.stringify(replay.data));
  assert.ok(
    ["CHECK_MISMATCH", "CHECK_EXPIRED", "REVISION_CONFLICT"].includes(replay.data.error.code),
    `重放应当被拒，实际 code=${replay.data.error.code}`
  );
});

// ------------------------------------------------- 真 PG16 才跑：真实竞争

test("§8 并发两个 refresh：恰好一个成功，另一个 INVALID_REFRESH_TOKEN", { skip: REAL_PG ? false : SKIP_REASON }, async () => {
  const sid = await login();
  const [a, b] = await Promise.all([
    inject("POST", "/api/admin/refresh-token", { payload: {}, cookie: sid }),
    inject("POST", "/api/admin/refresh-token", { payload: {}, cookie: sid })
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 401], JSON.stringify([a.data, b.data]));
  const failed = a.status === 401 ? a : b;
  assert.equal(failed.data.error.code, "INVALID_REFRESH_TOKEN");
  assert.equal(failed.setCookie, null, "失败的一侧不能下发新 Cookie");
});

test("§8 并发保存同一 revision：一个成功，一个 409 REVISION_CONFLICT", { skip: REAL_PG ? false : SKIP_REASON }, async () => {
  const created = await inject("POST", "/api/admin/articles/notes", {
    payload: { id: "it-race-save", title: "并发保存", body: "正文内容足够长，用来触发并发保存。" }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const revision = created.data.data.revision;

  const payload = (title: string) => ({
    id: "it-race-save",
    title,
    body: "正文内容足够长，用来触发并发保存。",
    baseRevision: revision,
    saveMode: "manual"
  });
  const [a, b] = await Promise.all([
    inject("PUT", "/api/admin/articles/notes/it-race-save", { payload: payload("并发 A") }),
    inject("PUT", "/api/admin/articles/notes/it-race-save", { payload: payload("并发 B") })
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.data, b.data]));
  const conflict = a.status === 409 ? a : b;
  assert.equal(conflict.data.error.code, "REVISION_CONFLICT");
  assert.equal(typeof conflict.data.data.currentRevision, "number");

  const detail = await inject("GET", "/api/admin/articles/notes/it-race-save");
  assert.equal(detail.data.data.revision, revision + 1, "只应写入一次");
});

test("§8 并发发布同一 checkId：只发布一次", { skip: REAL_PG ? false : SKIP_REASON }, async () => {
  const image = await uploadPublic("race.png");
  const created = await inject("POST", "/api/admin/articles/notes", {
    payload: {
      id: "it-race-publish",
      title: "并发发布",
      body: `![图](asset:${image.id})\n\n正文内容足够长，用来触发并发发布。`
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const revision = created.data.data.revision;

  const check = await inject("POST", "/api/admin/articles/notes/it-race-publish/publication-check", {
    payload: { action: "publish", baseRevision: revision }
  });
  assert.equal(check.status, 200, JSON.stringify(check.data));
  const checkId = check.data.data.checkId;

  const publish = () =>
    inject("POST", "/api/admin/articles/notes/it-race-publish/publish", {
      payload: { baseRevision: revision, checkId, confirmed: true }
    });
  const [a, b] = await Promise.all([publish(), publish()]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.data, b.data]));

  const detail = await inject("GET", "/api/admin/articles/notes/it-race-publish");
  assert.equal(detail.data.data.status, "published");
  assert.equal(detail.data.data.revision, revision + 1, "重复消费不能把 revision 推两次");
});
