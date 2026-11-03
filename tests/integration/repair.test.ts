import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { FastifyInstance } from "fastify";

const PG_PORT = 5597;
const HTTP_PORT = 5596;
const ORIGIN = "http://127.0.0.1:8000";
const PASSWORD = "admin-password-1234";
/** 超过 busboy 单块缓冲（实测约 64KB）：这套体积曾经让后置字段整块丢失。 */
const BIG = 300 * 1024;
const MAX_FILE = 1024 * 1024;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP")
]);

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let app: FastifyInstance;
let workDir: string;
let cookie = "";

function pngOf(size: number): Buffer {
  return Buffer.concat([PNG, Buffer.alloc(size - PNG.length, 0x11)]);
}

function envelope(response: { body: string }): any {
  return JSON.parse(response.body);
}

async function jsonCall(
  method: string,
  url: string,
  payload?: unknown,
  opts: { cookie?: string; origin?: string } = {}
): Promise<any> {
  const headers: Record<string, string> = {
    origin: opts.origin ?? ORIGIN,
    cookie: opts.cookie ?? cookie
  };
  if (payload !== undefined) headers["content-type"] = "application/json";
  const response = await app.inject({
    method: method as any,
    url,
    headers,
    payload: payload === undefined ? undefined : JSON.stringify(payload)
  });
  return { status: response.statusCode, headers: response.headers, data: envelope({ body: response.body }) };
}

interface Part {
  name: string;
  value?: string;
  file?: { filename: string; data: Buffer; type?: string };
}

async function upload(url: string, parts: Part[]): Promise<{ status: number; body: any }> {
  const form = new FormData();
  for (const part of parts) {
    if (part.file) {
      form.append(
        part.name,
        new Blob([new Uint8Array(part.file.data)], { type: part.file.type ?? "application/octet-stream" }),
        part.file.filename
      );
    } else {
      form.append(part.name, part.value ?? "");
    }
  }
  const response = await fetch(`http://127.0.0.1:${HTTP_PORT}${url}`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie },
    body: form
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function listFilesTotal(): Promise<number> {
  const result = await jsonCall("GET", "/api/admin/files?page=1&page_size=1");
  return result.data.data.total;
}

async function listArticlesTotal(res: "notes" | "essays"): Promise<number> {
  const result = await jsonCall("GET", `/api/admin/articles/${res}?page=1&page_size=1`);
  return result.data.data.total;
}

async function countStoredFiles(): Promise<number> {
  let total = 0;
  for (const dir of ["public", "private"]) {
    try {
      total += (await readdir(path.join(workDir, "uploads", dir))).length;
    } catch {
      // 目录还不存在就是 0
    }
  }
  return total;
}

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "entroaxiom-repair-"));
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
  process.env.MAX_FILE_BYTES = String(MAX_FILE);

  const { loadConfig } = await import("../../src/config.js");
  const { createPool, installTypeParsers } = await import("../../src/db/index.js");
  const { runMigrations } = await import("../../src/db/migrator.js");
  const { buildApp } = await import("../../src/app.js");
  const { createAdminUser } = await import("../../src/services/users.js");

  installTypeParsers();
  const loaded = loadConfig();
  // 故意把 svg 塞回允许列表：业务层必须仍然拒绝（§4 的核心断言）。
  const config = { ...loaded, allowedExtensions: [...loaded.allowedExtensions, "svg"] };
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

  const login = await jsonCall("POST", "/api/admin/login", { username: "admin", password: PASSWORD }, { cookie: "" });
  assert.equal(login.status, 200);
  const raw = login.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  cookie = String(first).split(";")[0];
  assert.ok(cookie.startsWith("sid="));
});

after(async () => {
  if (app) await app.close();
  if (socketServer) await socketServer.stop();
  if (pglite) await pglite.close();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- §2 上传顺序

test("§2 字段在前 + 300KB：public 上传保持 public 且公开地址可读", async () => {
  const result = await upload("/api/admin/files", [
    { name: "name", value: "字段在前" },
    { name: "description", value: "大文件也要读到 visibility" },
    { name: "visibility", value: "public" },
    { name: "file", file: { filename: "big-front.png", data: pngOf(BIG), type: "image/png" } }
  ]);
  assert.equal(result.status, 201);
  const file = result.body.data;
  assert.equal(file.visibility, "public");
  assert.equal(file.name, "字段在前");
  assert.match(String(file.publicSrc), /^\/uploads\/public\/.+\.png$/);

  const served = await app.inject({ method: "GET", url: String(file.publicSrc) });
  assert.equal(served.statusCode, 200);
  assert.equal(served.rawPayload.length, BIG);
});

test("§2 文件在前 + 300KB：字段后置也能读到（顺序无关）", async () => {
  const result = await upload("/api/admin/files", [
    { name: "file", file: { filename: "big-late.png", data: pngOf(BIG), type: "image/png" } },
    { name: "name", value: "字段在后" },
    { name: "visibility", value: "public" }
  ]);
  assert.equal(result.status, 201);
  const file = result.body.data;
  assert.equal(file.visibility, "public", "字段后置时 visibility 不能被静默降级成 private");
  assert.equal(file.name, "字段在后");
  assert.match(String(file.publicSrc), /^\/uploads\/public\//);
});

test("§2 私密文件仍是 private，且公开地址不可读", async () => {
  const result = await upload("/api/admin/files", [
    { name: "visibility", value: "private" },
    { name: "file", file: { filename: "secret.png", data: pngOf(BIG), type: "image/png" } }
  ]);
  assert.equal(result.status, 201);
  const file = result.body.data;
  assert.equal(file.visibility, "private");
  assert.equal(file.publicSrc, null);
  const served = await app.inject({ method: "GET", url: `/uploads/public/${file.id}.png` });
  assert.equal(served.statusCode, 404);

  const authed = await app.inject({
    method: "GET",
    url: `/api/admin/files/${file.id}/content`,
    headers: { cookie, origin: ORIGIN }
  });
  assert.equal(authed.statusCode, 200);
});

test("§2 不传 visibility 时默认 private", async () => {
  const result = await upload("/api/admin/files", [
    { name: "file", file: { filename: "default-visibility.png", data: pngOf(2048), type: "image/png" } }
  ]);
  assert.equal(result.status, 201);
  assert.equal(result.body.data.visibility, "private");
});

test("§2 非法 visibility 报验证错误，且不留记录、不落盘", async () => {
  const before = { files: await listFilesTotal(), disk: await countStoredFiles() };
  const result = await upload("/api/admin/files", [
    { name: "visibility", value: "secret" },
    { name: "file", file: { filename: "bad-visibility.png", data: pngOf(2048), type: "image/png" } }
  ]);
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, "VALIDATION_ERROR");
  assert.deepEqual(result.body.error.details[0].loc, ["body", "visibility"]);
  assert.equal(await listFilesTotal(), before.files, "被拒的上传不能留下文件记录");
  assert.equal(await countStoredFiles(), before.disk, "被拒的上传不能留下孤儿文件");
});

test("§2 超过大小上限 → 413，且不留半成品", async () => {
  const before = { files: await listFilesTotal(), disk: await countStoredFiles() };
  const result = await upload("/api/admin/files", [
    { name: "visibility", value: "public" },
    { name: "file", file: { filename: "too-big.png", data: pngOf(MAX_FILE + 1024), type: "image/png" } }
  ]);
  assert.equal(result.status, 413);
  assert.equal(result.body.error.code, "FILE_TOO_LARGE");
  assert.equal(await listFilesTotal(), before.files);
  assert.equal(await countStoredFiles(), before.disk);
});

test("§2 一次上传两个文件 → 422，且不留记录", async () => {
  const before = await listFilesTotal();
  const result = await upload("/api/admin/files", [
    { name: "file", file: { filename: "one.png", data: pngOf(1024), type: "image/png" } },
    { name: "file", file: { filename: "two.png", data: pngOf(1024), type: "image/png" } }
  ]);
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, "VALIDATION_ERROR");
  assert.equal(await listFilesTotal(), before);
});

// ---------------------------------------------------------------- §3 导入顺序

function markdown(title: string, id: string): string {
  return ["---", `id: ${id}`, `title: ${title}`, "summary: 导入验证用摘要", "---", "", `这是 ${title} 的正文，长度足够形成一段内容。`, ""].join("\n");
}

test("§3 notes：type 在前 / 在后的预览都能成功", async () => {
  const front = await upload("/api/admin/imports/preview", [
    { name: "type", value: "notes" },
    { name: "file", file: { filename: "front.md", data: Buffer.from(markdown("前 Type", "it-type-front"), "utf8") } }
  ]);
  assert.equal(front.status, 201);
  assert.equal(front.body.data.candidates.length, 1);
  assert.equal(front.body.data.type, "notes");

  const late = await upload("/api/admin/imports/preview", [
    { name: "file", file: { filename: "late.md", data: Buffer.from(markdown("后 Type", "it-type-late"), "utf8") } },
    { name: "type", value: "notes" }
  ]);
  assert.equal(late.status, 201);
  assert.equal(late.body.data.type, "notes");
  assert.equal(late.body.data.candidates.length, 1);
});

test("§3 essays：两种顺序都成功", async () => {
  const front = await upload("/api/admin/imports/preview", [
    { name: "type", value: "essays" },
    { name: "file", file: { filename: "e-front.md", data: Buffer.from(markdown("随笔 前", "it-essay-front"), "utf8") } }
  ]);
  assert.equal(front.status, 201);
  assert.equal(front.body.data.type, "essays");

  const late = await upload("/api/admin/imports/preview", [
    { name: "file", file: { filename: "e-late.md", data: Buffer.from(markdown("随笔 后", "it-essay-late"), "utf8") } },
    { name: "type", value: "essays" }
  ]);
  assert.equal(late.status, 201);
  assert.equal(late.body.data.type, "essays");
});

test("§3 缺 type / 非法 type → 422", async () => {
  const missing = await upload("/api/admin/imports/preview", [
    { name: "file", file: { filename: "no-type.md", data: Buffer.from(markdown("无类型", "it-no-type"), "utf8") } }
  ]);
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.code, "VALIDATION_ERROR");
  assert.deepEqual(missing.body.error.details[0].loc, ["body", "type"]);

  const invalid = await upload("/api/admin/imports/preview", [
    { name: "type", value: "diary" },
    { name: "file", file: { filename: "bad-type.md", data: Buffer.from(markdown("错类型", "it-bad-type"), "utf8") } }
  ]);
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
});

test("§3 预览不建正式文章；提交后仍是草稿/私密且公开 404", async () => {
  const before = await listArticlesTotal("notes");
  const preview = await upload("/api/admin/imports/preview", [
    { name: "type", value: "notes" },
    { name: "file", file: { filename: "commit.md", data: Buffer.from(markdown("待提交", "it-commit"), "utf8") } }
  ]);
  assert.equal(preview.status, 201);
  assert.equal(await listArticlesTotal("notes"), before, "预览阶段不能写正式文章");

  const data = preview.body.data;
  assert.ok(data.draft, "带 frontmatter 的 md 应该解析出草稿");
  const commit = await jsonCall("POST", `/api/admin/imports/${data.importId}/commit`, {
    mode: "create",
    draft: {
      id: "it-commit",
      title: data.draft.title,
      body: data.draft.body,
      summary: data.draft.summary ?? null,
      category: null,
      tags: null,
      date: null
    },
    includeUnreferencedPaths: []
  });
  assert.equal(commit.status, 200);
  assert.equal(commit.data.data.articleId, "it-commit");
  assert.equal(await listArticlesTotal("notes"), before + 1);

  const detail = await jsonCall("GET", "/api/admin/articles/notes/it-commit");
  assert.equal(detail.status, 200);
  assert.equal(detail.data.data.status, "draft");
  assert.equal(detail.data.data.visibility, "private");

  const publicView = await app.inject({ method: "GET", url: "/api/public/notes/it-commit" });
  assert.equal(publicView.statusCode, 404);
});

// ---------------------------------------------------------------- §4 SVG

test("§4 即使配置里写了 svg 也拒绝上传", async () => {
  const before = { files: await listFilesTotal(), disk: await countStoredFiles() };
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");
  const result = await upload("/api/admin/files", [
    { name: "visibility", value: "public" },
    { name: "file", file: { filename: "attack.svg", data: svg, type: "image/svg+xml" } }
  ]);
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, "UNSUPPORTED_TYPE");
  assert.match(String(result.body.error.message), /SVG/);
  assert.equal(await listFilesTotal(), before.files, "被拒的 SVG 不能留下文件记录");
  assert.equal(await countStoredFiles(), before.disk, "被拒的 SVG 不能落盘");
});

test("§4 png/jpg/webp 正常上传", async () => {
  const cases: Array<[string, Buffer]> = [
    ["ok.png", pngOf(4096)],
    ["ok.jpg", Buffer.concat([JPG, Buffer.alloc(4096, 0x22)])],
    ["ok.webp", Buffer.concat([WEBP, Buffer.alloc(4096, 0x33)])]
  ];
  for (const [filename, data] of cases) {
    const result = await upload("/api/admin/files", [
      { name: "visibility", value: "private" },
      { name: "file", file: { filename, data, type: "application/octet-stream" } }
    ]);
    assert.equal(result.status, 201, `${filename} 应该被接受`);
  }
});

test("§4 改名成 .png 的 SVG 也被内容嗅探拦下", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");
  const result = await upload("/api/admin/files", [
    { name: "file", file: { filename: "disguised.png", data: svg, type: "image/png" } }
  ]);
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, "UNSUPPORTED_TYPE");
});

test("§4 存量 svg 不会被自动删除（只做清点建议）", async () => {
  const dir = path.join(workDir, "uploads", "public");
  await mkdir(dir, { recursive: true });
  const legacy = path.join(dir, "legacy-2025.svg");
  await writeFile(legacy, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "utf8");

  // 触发一次正常上传，确认业务运行不会顺手清理历史文件
  await upload("/api/admin/files", [
    { name: "file", file: { filename: "after-legacy.png", data: pngOf(1024), type: "image/png" } }
  ]);
  const still = await readFile(legacy, "utf8");
  assert.match(still, /<svg/);
});

// ---------------------------------------------------------------- §6 刷新并发

test("§6 同一 Cookie 并发两个 refresh：恰好一个成功，另一个 INVALID_REFRESH_TOKEN", async () => {
  const login = await jsonCall("POST", "/api/admin/login", { username: "admin", password: PASSWORD }, { cookie: "" });
  assert.equal(login.status, 200);
  const raw = login.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const raceCookie = String(first).split(";")[0];

  const { getContext } = await import("../../src/context.js");
  const { sql } = await import("kysely");
  const liveBefore = await sql<{ count: string }>`
    select count(*)::text as count from sessions where revoked_at is null and expires_at > now()
  `.execute(getContext().db);

  const fire = () =>
    fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/refresh-token`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: raceCookie, "content-type": "application/json" },
      body: "{}"
    });

  const [a, b] = await Promise.all([fire(), fire()]);
  const bodies = await Promise.all([a.json(), b.json()]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [200, 401], "必须恰好一个成功");

  const failed = [a, b].find(response => response.status === 401)!;
  const failedBody = bodies[[a, b].indexOf(failed)] as any;
  assert.equal(failedBody.error.code, "INVALID_REFRESH_TOKEN");
  assert.equal(failed.headers.get("set-cookie"), null, "失败的 refresh 不能下发 Cookie");

  const okIndex = [a, b].findIndex(response => response.status === 200);
  const okResponse = [a, b][okIndex];
  const okBody = bodies[okIndex] as any;
  assert.ok(okBody.data.accessToken);
  const newCookie = String(okResponse.headers.get("set-cookie")).split(";")[0];
  assert.ok(newCookie.startsWith("sid="));
  assert.notEqual(newCookie, raceCookie, "轮换后必须是新的会话令牌");

  // 旧 Cookie 已吊销
  const withOld = await app.inject({
    method: "GET",
    url: "/api/admin/capabilities",
    headers: { cookie: raceCookie, origin: ORIGIN }
  });
  assert.equal(withOld.statusCode, 401);

  // 新 Cookie 可用
  const withNew = await app.inject({
    method: "GET",
    url: "/api/admin/capabilities",
    headers: { cookie: newCookie, origin: ORIGIN }
  });
  assert.equal(withNew.statusCode, 200);

  // 轮换是"旧的作废 + 新的生效"，有效会话总数不应增加（既没有泄漏，也没有重复下发）
  const live = await sql<{ count: string }>`
    select count(*)::text as count from sessions where revoked_at is null and expires_at > now()
  `.execute(getContext().db);
  assert.equal(live.rows[0]!.count, liveBefore.rows[0]!.count, "并发 refresh 之后有效会话数不应增加");
});

test("§6 过期会话 refresh 仍返回 INVALID_REFRESH_TOKEN", async () => {
  const login = await jsonCall("POST", "/api/admin/login", { username: "admin", password: PASSWORD }, { cookie: "" });
  const raw = login.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const expiredCookie = String(first).split(";")[0];

  const { getContext } = await import("../../src/context.js");
  const { sql } = await import("kysely");
  await sql`update sessions set expires_at = now() - interval '1 hour' where revoked_at is null`.execute(
    getContext().db
  );

  const response = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/admin/refresh-token`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie: expiredCookie, "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(response.status, 401);
  const body = (await response.json()) as any;
  assert.equal(body.error.code, "INVALID_REFRESH_TOKEN");
  assert.equal(response.headers.get("set-cookie"), null);
});

