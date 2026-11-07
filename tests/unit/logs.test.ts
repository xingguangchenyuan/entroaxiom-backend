import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import {
  flushPending,
  isSuspectPath,
  isSuspectStatus,
  listLogs,
  parseAccessLine,
  parseAppLine,
  parseErrorLine,
  parseNginxTime,
  readLogTail,
  type AppPendingRequest,
  type LogSource
} from "../../src/services/logs.js";

const ACCESS: LogSource = { id: "nginx-access", label: "Web 访问", kind: "access", path: "/dev/null" };
const ERROR: LogSource = { id: "nginx-error", label: "Web 错误", kind: "error", path: "/dev/null" };
const API: LogSource = { id: "api", label: "程序日志", kind: "app", path: "/dev/null" };

test("parseNginxTime 把 nginx 的本地时间换算成 ISO", () => {
  assert.equal(parseNginxTime("06/Nov/2026:00:01:52 +0000"), "2026-11-06T00:01:52.000Z");
  assert.equal(parseNginxTime("06/Nov/2026:08:01:52 +0800"), "2026-11-06T00:01:52.000Z");
  assert.equal(parseNginxTime("not a time"), null);
});

test("parseAccessLine 解析 combined 日志并标记普通请求", () => {
  const line =
    '122.51.236.174 - - [06/Nov/2026:00:01:52 +0000] "GET / HTTP/1.1" 301 178 "-" "Mozilla/5.0 (iPhone)"';
  const entry = parseAccessLine(line, ACCESS, 3);
  assert.ok(entry);
  assert.equal(entry.ip, "122.51.236.174");
  assert.equal(entry.method, "GET");
  assert.equal(entry.path, "/");
  assert.equal(entry.status, 301);
  assert.equal(entry.suspect, false);
  assert.equal(entry.id, "nginx-access:3");
});

test("扫描 /api/.env 的请求被标记为疑似攻击", () => {
  const line =
    '81.171.72.93 - - [06/Nov/2026:02:43:13 +0000] "GET /api/.env HTTP/1.1" 404 21 "-" "curl/8.5.0"';
  const entry = parseAccessLine(line, ACCESS, 0);
  assert.ok(entry);
  assert.equal(entry.suspect, true);
});

test("isSuspectPath / isSuspectStatus 的边界", () => {
  assert.equal(isSuspectPath("/api/.env"), true);
  assert.equal(isSuspectPath("/wp-admin/setup.php"), true);
  assert.equal(isSuspectPath("/essays/hello"), false);
  assert.equal(isSuspectPath(null), false);
  assert.equal(isSuspectStatus(403), true);
  assert.equal(isSuspectStatus(429), true);
  assert.equal(isSuspectStatus(404), false);
});

test("parseErrorLine 保留级别与消息", () => {
  const entry = parseErrorLine(
    '2026/11/06 00:01:52 [error] 1234#5678: *9 open() "/var/www/x" failed (2: No such file or directory)',
    ERROR,
    0
  );
  assert.ok(entry);
  assert.equal(entry.level, "error");
  assert.ok(entry.message.includes("open()"));
});

test("parseAppLine 把 incoming / completed 两行合并成一条请求", () => {
  const pending = new Map<string, AppPendingRequest>();
  const incoming = parseAppLine(
    '{"level":30,"time":"2026-11-06T02:43:13.662Z","reqId":"req-5h","req":{"method":"GET","url":"/api/.env","remoteAddress":"81.171.72.93"},"msg":"incoming request"}',
    API,
    0,
    pending
  );
  // incoming 只登记，不单独产出记录：否则每条请求会在界面上出现两次，其中一次没有状态码
  assert.equal(incoming, null);
  assert.equal(pending.size, 1);
  assert.equal(pending.get("req-5h")?.url, "/api/.env");

  const completed = parseAppLine(
    '{"level":30,"time":"2026-11-06T02:43:13.663Z","reqId":"req-5h","res":{"statusCode":404},"responseTime":0.695,"msg":"request completed"}',
    API,
    1,
    pending
  );
  assert.ok(completed);
  assert.equal(completed.method, "GET");
  assert.equal(completed.path, "/api/.env");
  assert.equal(completed.status, 404);
  assert.equal(pending.size, 0);
  // 404 本身不算攻击，但路径命中了扫描特征
  assert.equal(completed.suspect, true);
});

test("flushPending 把没等到 completed 的请求放出来，标成未完成", () => {
  const pending = new Map<string, AppPendingRequest>();
  parseAppLine(
    '{"level":30,"time":"2026-11-06T02:43:13.662Z","reqId":"req-9","req":{"method":"POST","url":"/api/admin/logs","remoteAddress":"10.0.0.9"},"msg":"incoming request"}',
    API,
    0,
    pending
  );
  assert.equal(pending.size, 1);

  const rest = flushPending(API, pending, 10);
  assert.equal(pending.size, 0);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].level, "warn");
  assert.equal(rest[0].status, null);
  assert.equal(rest[0].method, "POST");
  assert.equal(rest[0].path, "/api/admin/logs");
  assert.equal(rest[0].ip, "10.0.0.9");
  assert.ok(rest[0].message.includes("未完成"));
});

test("readLogTail 只读尾部且丢掉被切断的半行", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "entries-logs-"));
  try {
    const file = path.join(dir, "app.log");
    const lines = Array.from({ length: 400 }, (_, i) => `line-${i} ${"x".repeat(40)}`);
    await writeFile(file, lines.join("\n"), "utf8");
    const tail = await readLogTail(file, 512);
    assert.equal(tail.truncated, true);
    assert.ok(!tail.text.includes("line-0 "));
    assert.ok(tail.text.includes("line-399"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLogTail 对不存在的文件返回空而不是抛错", async () => {
  const result = await readLogTail(path.join(tmpdir(), "definitely-missing-xyz.log"));
  assert.deepEqual(result, { text: "", truncated: false });
});

test("listLogs 按状态过滤、按关键词过滤，并拒绝未知来源", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "entries-logs-"));
  try {
    const accessFile = path.join(dir, "access.log");
    const lines = Array.from({ length: 100 }, (_, i) => {
      const status = i % 2 === 0 ? 404 : 200;
      return `${i}.1.1.1 - - [06/Nov/2026:00:01:52 +0000] "GET /p${i} HTTP/1.1" ${status} 10 "-" "ua"`;
    });
    await writeFile(accessFile, lines.join("\n"), "utf8");
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_ACCESS_PATH: accessFile,
      LOG_ERROR_PATH: path.join(dir, "none.log"),
      LOG_API_PATH: path.join(dir, "none2.log"),
      LOG_BACKUP_PATH: path.join(dir, "none3.log")
    });

    const all = await listLogs(config, { source: "nginx-access", tail: 200 });
    assert.equal(all.total, 100);
    assert.equal(all.items.length, 100);

    const notFound = await listLogs(config, { tail: 200, status: 404 });
    assert.equal(notFound.total, 50);

    const keyword = await listLogs(config, { tail: 200, keyword: "/p9 " });
    assert.equal(keyword.total, 1);

    await assert.rejects(() => listLogs(config, { source: "../../etc/passwd", tail: 10 }), /未知的日志来源/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
