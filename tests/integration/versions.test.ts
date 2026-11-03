import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { FastifyInstance } from "fastify";

/**
 * 版本历史的回归（对应 REPAIR-REPORT.md 第五轮）：
 *   1. 发布要在历史里留一份（source=publish）——否则「撤回发布后找回上次线上正文」无路可走；
 *   2. 内容没变的重复发布不再堆一模一样的版本；
 *   3. 手动保存照旧留版本，历史恢复保留的那份 source=restore 而不是 manual。
 */
const PG_PORT = 5603;
const HTTP_PORT = 5602;
const ORIGIN = "http://127.0.0.1:8000";
const PASSWORD = "admin-password-1234";
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
  payload?: unknown
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { origin: ORIGIN, cookie };
  if (payload !== undefined) headers["content-type"] = "application/json";
  const response = await app.inject({
    method: method as any,
    url,
    headers,
    payload: payload === undefined ? undefined : JSON.stringify(payload)
  });
  return { status: response.statusCode, data: JSON.parse(response.body) };
}

async function revisionOf(id: string): Promise<number> {
  const detail = await call("GET", `/api/admin/articles/notes/${id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  return detail.data.data.revision;
}

async function publish(id: string): Promise<void> {
  const revision = await revisionOf(id);
  const check = await call("POST", `/api/admin/articles/notes/${id}/publication-check`, {
    action: "publish",
    baseRevision: revision
  });
  assert.equal(check.status, 200, JSON.stringify(check.data));
  const published = await call("POST", `/api/admin/articles/notes/${id}/publish`, {
    checkId: check.data.data.checkId,
    baseRevision: revision,
    assetDecisions: [],
    confirmed: true
  });
  assert.equal(published.status, 200, JSON.stringify(published.data));
}

async function versions(id: string): Promise<Array<{ version: number; source: string }>> {
  const response = await call("GET", `/api/admin/articles/notes/${id}/versions`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.data as Array<{ version: number; source: string }>;
}

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "entroaxiom-versions-"));
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
  await app?.close();
  await socketServer?.stop();
  await pglite?.close();
  await rm(workDir, { recursive: true, force: true });
});

test("发布写一条 source=publish 的版本，内容不变时不重复写", async () => {
  const created = await call("POST", "/api/admin/articles/notes", {
    id: "ver-note",
    title: "版本回归",
    summary: "版本回归用的摘要。",
    body: FILLER,
    date: "2026-11-02",
    tags: ["回归"]
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  assert.deepEqual(await versions("ver-note"), [], "新建的文章还没有历史版本");

  await publish("ver-note");
  const first = await versions("ver-note");
  assert.equal(first.length, 1, `发布后应有一条版本：${JSON.stringify(first)}`);
  assert.equal(first[0].source, "publish");

  // 内容没改，再点一次「更新发布」：不该多出一条一模一样的版本。
  await publish("ver-note");
  const second = await versions("ver-note");
  assert.equal(second.length, 1, `重复发布不该新增版本：${JSON.stringify(second)}`);
});

test("手动保存、发布、历史恢复各留一份，恢复的那份 source=restore", async () => {
  const detail = await call("GET", "/api/admin/articles/notes/ver-note");
  const revision = detail.data.data.revision;

  // 手动保存一版新正文（历史里应留下改动前的内容）。
  const saved = await call("PUT", "/api/admin/articles/notes/ver-note", {
    baseRevision: revision,
    title: "版本回归",
    summary: "版本回归用的摘要。",
    body: `${FILLER}\n\n第二次手动保存追加的一段。`,
    date: "2026-11-02",
    tags: ["回归"],
    saveMode: "manual"
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const afterManual = await versions("ver-note");
  assert.equal(afterManual.length, 2, JSON.stringify(afterManual));
  assert.equal(afterManual[0].source, "manual");

  // 再发布一次：正文变了，所以这次应当新增一条 publish。
  await publish("ver-note");
  const afterPublish = await versions("ver-note");
  assert.equal(afterPublish.length, 3, JSON.stringify(afterPublish));
  assert.equal(afterPublish[0].source, "publish");

  // 恢复到最早那一版（发布时的那份）。
  const oldest = afterPublish.find(row => row.version === 1);
  assert.ok(oldest, "应当能找到 version=1");
  const current = await revisionOf("ver-note");
  const restored = await call(
    "POST",
    `/api/admin/articles/notes/ver-note/versions/${oldest.version}/restore`,
    { baseRevision: current }
  );
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.data.article.body, FILLER, "正文应回到第一次发布时的内容");

  const afterRestore = await versions("ver-note");
  assert.equal(afterRestore.length, 4, JSON.stringify(afterRestore));
  assert.equal(afterRestore[0].source, "restore", "恢复前保留的那份应标成 restore");
});
