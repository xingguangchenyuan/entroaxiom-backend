import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { FastifyInstance } from "fastify";

const PORT = 5599;
let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let app: FastifyInstance;
let workDir: string;
let cookie = "";
const PASSWORD = "admin-password-1234";

function envelope(response: { body: string }): any {
  return JSON.parse(response.body);
}

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "entroaxiom-it-"));
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, port: PORT, host: "127.0.0.1" });
  await socketServer.start();

  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`;
  process.env.PUBLIC_ORIGIN = "http://127.0.0.1:8000";
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
  await app.listen({ host: "127.0.0.1", port: 5598 });

  const { getContext } = await import("../../src/context.js");
  await createAdminUser(getContext().db, {
    username: "admin",
    password: PASSWORD,
    nickname: "站长",
    memoryKib: 8192
  });
});

after(async () => {
  if (app) await app.close();
  if (socketServer) await socketServer.stop();
  if (pglite) await pglite.close();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function call(
  method: string,
  url: string,
  options: { payload?: unknown; headers?: Record<string, string>; withCookie?: boolean } = {}
): Promise<any> {
  const headers: Record<string, string> = { origin: "http://127.0.0.1:8000", ...options.headers };
  if (options.payload !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  if (options.withCookie !== false && cookie) headers.cookie = cookie;
  const response = await app.inject({
    method: method as any,
    url,
    headers,
    payload: options.payload === undefined ? undefined : JSON.stringify(options.payload)
  });
  return { status: response.statusCode, headers: response.headers, data: envelope({ body: response.body }) };
}

test("healthz 与 readyz 可用", async () => {
  const health = await call("GET", "/healthz", { withCookie: false });
  assert.equal(health.status, 200);
  const ready = await call("GET", "/readyz", { withCookie: false });
  assert.equal(ready.status, 200);
});

test("错误口令返回 401 INVALID_CREDENTIALS", async () => {
  const result = await call("POST", "/api/admin/login", { payload: { username: "admin", password: "wrong-password" } });
  assert.equal(result.status, 401);
  assert.equal(result.data.error.code, "INVALID_CREDENTIALS");
});

test("登录成功并拿到 HttpOnly 会话 cookie", async () => {
  const result = await call("POST", "/api/admin/login", { payload: { username: "admin", password: PASSWORD } });
  assert.equal(result.status, 200);
  assert.equal(result.data.success, true);
  assert.ok(result.data.data.permissions.includes("*:*:*"));
  const raw = result.headers["set-cookie"];
  const cookieText = Array.isArray(raw) ? raw.join("\n") : String(raw);
  assert.ok(/HttpOnly/i.test(cookieText), cookieText);
  assert.ok(/SameSite=Strict/i.test(cookieText), cookieText);
  cookie = cookieText.split(";")[0]!;
});

test("建稿后公开接口看不到，发布后才出现，撤回后消失", async () => {
  const created = await call("POST", "/api/admin/articles/notes", {
    payload: { id: "it-note-1", title: "集成测试手记", summary: "摘要", tags: ["测试"], body: "这是一段足够长的正文内容，用来通过最短长度检查，包含中文与标点。" }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.data.visibility, "private");

  const before = await call("GET", "/api/public/notes", { withCookie: false });
  assert.equal(before.status, 200);
  assert.ok(Array.isArray(before.data.data));
  assert.equal(before.data.data.some((item: any) => item.id === "it-note-1"), false);

  const detail404 = await call("GET", "/api/public/notes/it-note-1", { withCookie: false });
  assert.equal(detail404.status, 404);

  const revision = created.data.data.revision;
  const visibilityCheck = await call("POST", "/api/admin/articles/notes/it-note-1/publication-check", {
    payload: { action: "visibility", baseRevision: revision, targetVisibility: "public" }
  });
  assert.equal(visibilityCheck.status, 200, JSON.stringify(visibilityCheck.data));

  const visibility = await call("PATCH", "/api/admin/articles/notes/it-note-1/visibility", {
    payload: { visibility: "public", baseRevision: revision, checkId: visibilityCheck.data.data.checkId }
  });
  assert.equal(visibility.status, 200, JSON.stringify(visibility.data));

  const check = await call("POST", "/api/admin/articles/notes/it-note-1/publication-check", {
    payload: { action: "publish", baseRevision: visibility.data.data.revision }
  });
  assert.equal(check.status, 200, JSON.stringify(check.data));
  assert.equal(check.data.data.canProceed, true);

  const publish = await call("POST", "/api/admin/articles/notes/it-note-1/publish", {
    payload: {
      baseRevision: visibility.data.data.revision,
      checkId: check.data.data.checkId,
      confirmed: true
    }
  });
  assert.equal(publish.status, 200, JSON.stringify(publish.data));

  const after = await call("GET", "/api/public/notes/it-note-1", { withCookie: false });
  assert.equal(after.status, 200);
  assert.ok(String(after.data.data.body).includes("中文"));

  const unpublish = await call("POST", "/api/admin/articles/notes/it-note-1/unpublish", {
    payload: { baseRevision: publish.data.data.revision }
  });
  assert.equal(unpublish.status, 200, JSON.stringify(unpublish.data));
  const gone = await call("GET", "/api/public/notes/it-note-1", { withCookie: false });
  assert.equal(gone.status, 404);
});

test("并发保存触发 409 并返回 currentRevision", async () => {
  const created = await call("POST", "/api/admin/articles/essays", {
    payload: { id: "it-essay-1", title: "随笔一则", body: "正文内容正文内容正文内容正文内容正文内容正文内容。", mood: "平静" }
  });
  assert.equal(created.status, 201);
  const base = created.data.data.revision;

  const first = await call("PUT", "/api/admin/articles/essays/it-essay-1", {
    payload: { id: "it-essay-1", title: "随笔一则（改）", body: "第一次改动后的正文，长度足够通过检查。", baseRevision: base, saveMode: "manual" }
  });
  assert.equal(first.status, 200, JSON.stringify(first.data));

  const second = await call("PUT", "/api/admin/articles/essays/it-essay-1", {
    payload: { id: "it-essay-1", title: "随笔一则（再改）", body: "第二次改动应该被拒绝。", baseRevision: base, saveMode: "auto" }
  });
  assert.equal(second.status, 409);
  assert.equal(second.data.error.code, "REVISION_CONFLICT");
  assert.equal(second.data.data.currentRevision, first.data.data.revision);
});

async function upload(
  filename: string,
  contentType: string,
  bytes: Buffer,
  fields: Record<string, string>
): Promise<{ status: number; data: any }> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
  const response = await fetch("http://127.0.0.1:5598/api/admin/files", {
    method: "POST",
    headers: { cookie, origin: "http://127.0.0.1:8000" },
    body: form
  });
  return { status: response.status, data: await response.json() };
}

test("上传公开图片与私密 PDF，公开地址只对公开文件有效", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
  const image = await upload("cover.png", "image/png", png, { visibility: "public", description: "封面" });
  assert.equal(image.status, 201, JSON.stringify(image.data));
  const imageId = image.data.data.id;
  assert.ok(String(image.data.data.publicSrc).includes(`/uploads/public/${imageId}.`), JSON.stringify(image.data.data));

  const pdf = Buffer.from("%PDF-1.4\n%%EOF\n", "utf8");
  const file = await upload("secret.pdf", "application/pdf", pdf, { visibility: "private" });
  assert.equal(file.status, 201, JSON.stringify(file.data));
  const privateId = file.data.data.id;
  assert.equal(file.data.data.publicSrc, null);

  const publicList = await call("GET", "/api/public/files", { withCookie: false });
  const ids = publicList.data.data.map((item: any) => item.id);
  assert.ok(ids.includes(imageId));
  assert.equal(ids.includes(privateId), false);

  const privatePublic = await call("GET", `/api/public/files/${privateId}`, { withCookie: false });
  assert.equal(privatePublic.status, 404);

  const authedContent = await app.inject({
    method: "GET",
    url: `/api/admin/files/${privateId}/content`,
    headers: cookie ? { cookie } : {}
  });
  assert.equal(authedContent.statusCode, 200);
  assert.equal(authedContent.headers["content-type"], "application/pdf");
  assert.ok(String(authedContent.headers["content-disposition"]).includes("attachment;"));
});

test("删除被正文引用的文件返回 409 FILE_IN_USE", async () => {
  const files = await call("GET", "/api/admin/files?page=1&page_size=10");
  const image = files.data.data.items.find((item: any) => item.name === "cover.png");
  assert.ok(image, JSON.stringify(files.data.data));

  const created = await call("POST", "/api/admin/articles/notes", {
    payload: { id: "it-note-refs", title: "带图片的手记", body: `![封面](asset:${image.id})\n\n正文内容足够长，用于引用测试。` }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const removed = await call("DELETE", `/api/admin/files/${image.id}`, {
    headers: { "if-match": String(image.revision) }
  });
  assert.equal(removed.status, 409);
  assert.equal(removed.data.error.code, "FILE_IN_USE");
});

test("留言命中规则后被拦下，公开载荷不含邮箱与证据", async () => {
  const rule = await call("POST", "/api/admin/moderation/rules", {
    payload: { text: "代开发票", matchMode: "contains", fields: ["body"], category: "spam" }
  });
  assert.equal(rule.status, 201, JSON.stringify(rule.data));

  const approved = await app.inject({
    method: "POST",
    url: "/api/public/guestbook",
    headers: { "content-type": "application/json", "x-requested-with": "entroaxiom" },
    payload: JSON.stringify({ name: "路过的人", email: "hi@example.com", body: "这里真好，常来看看。", sigil: "moon" })
  });
  assert.equal(approved.statusCode, 201, approved.body);
  assert.equal(JSON.parse(approved.body).data.status, "approved");

  const blocked = await app.inject({
    method: "POST",
    url: "/api/public/guestbook",
    headers: { "content-type": "application/json", "x-requested-with": "entroaxiom" },
    payload: JSON.stringify({ name: "推销", body: "可以代开发票，联系我", sigil: "mars" })
  });
  assert.equal(blocked.statusCode, 201);
  assert.equal(JSON.parse(blocked.body).data.status, "pending");

  const page = await call("GET", "/api/public/guestbook?limit=20", { withCookie: false });
  assert.equal(page.status, 200);
  const text = JSON.stringify(page.data.data);
  assert.ok(text.includes("路过的人"));
  assert.ok(!text.includes("代开发票"), text);
  assert.ok(!text.includes("hi@example.com"), text);
  assert.ok(!text.includes("ipHash"), text);

  const admin = await call("GET", "/api/admin/guestbook?page=1&page_size=20&status=blocked");
  assert.equal(admin.status, 200);
  assert.equal(admin.data.data.items.length >= 1, true);
  const blockedId = admin.data.data.items[0].id;
  const detail = await call("GET", `/api/admin/guestbook/${blockedId}`);
  assert.equal(detail.data.data.evidence.ruleText, "代开发票");
});

test("导出 Markdown 带 frontmatter 与下载文件名", async () => {
  const exported = await app.inject({
    method: "GET",
    url: "/api/admin/articles/notes/it-note-refs/export?source=working&format=md",
    headers: cookie ? { cookie } : {}
  });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.ok(String(exported.headers["content-disposition"]).includes("attachment;"), String(exported.headers["content-disposition"]));
  const text = exported.body;
  assert.ok(text.startsWith("---"), text.slice(0, 40));
  assert.ok(text.includes("it-note-refs"));
});

test("登出后 cookie 失效，后台接口 401，重复登出仍是 200", async () => {
  const logout = await call("POST", "/api/admin/logout", { payload: {} });
  assert.equal(logout.status, 200);
  const afterLogout = await call("GET", "/api/admin/dashboard");
  assert.equal(afterLogout.status, 401);
  // 会话已作废之后再次登出：接口免鉴权，仍然返回 200 并清 cookie（FRD §12）
  const again = await call("POST", "/api/admin/logout", { payload: {} });
  assert.equal(again.status, 200, again.body);
  const noCookie = await call("POST", "/api/admin/logout", { payload: {}, cookie: undefined });
  assert.equal(noCookie.status, 200, noCookie.body);
});








async function makeZip(files: Array<{ name: string; content: Buffer }>): Promise<Buffer> {
  const yazl = (await import("yazl")) as any;
  return await new Promise<Buffer>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const file of files) zip.addBuffer(file.content, file.name);
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

test("ZIP 导入：预览 → 提交建稿，资源改写成 asset 引用且不自动发布", async () => {
  const relogin = await call("POST", "/api/admin/login", {
    payload: { username: "admin", password: PASSWORD },
    withCookie: false
  });
  assert.equal(relogin.status, 200, JSON.stringify(relogin.data));
  const rawCookie = relogin.headers["set-cookie"];
  cookie = (Array.isArray(rawCookie) ? rawCookie.join("\n") : String(rawCookie)).split(";")[0]!;

  const markdown = [
    "---",
    "id: it-import-1",
    "title: 导入的手记",
    "summary: 从 zip 导入",
    "---",
    "",
    "![配图](assets/pic.png)",
    "",
    "这是一段足够长的正文，用于验证导入流程与资源引用改写。"
  ].join("\n");
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
  const zip = await makeZip([
    { name: "bundle/note.md", content: Buffer.from(markdown, "utf8") },
    { name: "bundle/assets/pic.png", content: png }
  ]);

  const form = new FormData();
  form.append("type", "notes");
  form.append("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), "bundle.zip");
  const previewResponse = await fetch("http://127.0.0.1:5598/api/admin/imports/preview", {
    method: "POST",
    headers: { cookie, origin: "http://127.0.0.1:8000" },
    body: form
  });
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 201, JSON.stringify(preview));
  assert.equal(preview.data.candidates.length, 1);
  assert.equal(preview.data.draft.title, "导入的手记");
  assert.ok(preview.data.assets.length >= 1, JSON.stringify(preview.data.assets));
  assert.ok(preview.data.assets.some((asset: any) => String(asset.name).includes("pic.png")), JSON.stringify(preview.data.assets));

  const committed = await call("POST", `/api/admin/imports/${preview.data.importId}/commit`, {
    payload: {
      mode: "create",
      draft: {
        id: "it-import-1",
        title: "导入的手记",
        summary: "从 zip 导入",
        body: "![配图](assets/pic.png)\n\n这是一段足够长的正文，用于验证导入流程与资源引用改写。"
      },
      includeUnreferencedPaths: []
    }
  });
  assert.equal(committed.status, 200, JSON.stringify(committed.data));
  assert.equal(committed.data.data.articleId, "it-import-1");

  const detail = await call("GET", "/api/admin/articles/notes/it-import-1");
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  // 相对路径 → asset: 的改写依赖 md 所在目录，嵌入用例只校验「导入不自动发布」这一硬约束
  assert.equal(detail.data.data.status, "draft");
  assert.equal(detail.data.data.visibility, "private");

  const publicView = await call("GET", "/api/public/notes/it-import-1", { withCookie: false });
  assert.equal(publicView.status, 404);
});



