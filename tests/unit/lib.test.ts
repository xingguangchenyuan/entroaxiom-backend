import assert from "node:assert/strict";
import test from "node:test";
import { assertValidId, isValidId, slugify } from "../../src/lib/ids.js";
import { extractAssetIds, replaceAssetRefs, toPlainExcerpt } from "../../src/lib/markdown.js";
import { buildFrontmatter, parseFrontmatter } from "../../src/lib/frontmatter.js";
import { sanitizeEntryPath } from "../../src/lib/zip.js";
import { contentDispositionAttachment, sanitizeFileName } from "../../src/lib/mime.js";

test("slugify 对中文标题给出稳定 id", () => {
  const id = slugify("关于慢下来的十件小事", "notes");
  assert.ok(isValidId(id), id);
  assert.equal(slugify("关于慢下来的十件小事", "notes"), id);
});

test("slugify 保留拉丁字母与数字，并把空格转成短横线", () => {
  assert.equal(slugify("Hello World 2026", "notes"), "hello-world-2026");
});

test("isValidId 拒绝以短横线开头与路径分隔符", () => {
  assert.equal(isValidId("-abc"), false);
  assert.equal(isValidId("abc/def"), false);
  assert.equal(isValidId("abc_def-1.2"), true);
  assert.throws(() => assertValidId("http://x"));
});

test("extractAssetIds 去重并忽略普通链接", () => {
  const body = "![a](asset:abc123) 和 [b](asset:abc123)，还有 [c](https://x.test/c.png)";
  assert.deepEqual(extractAssetIds(body), ["abc123"]);
});

test("replaceAssetRefs 把私密图片换成占位符、私密链接降级为文字", () => {
  const body = "![封面](asset:priv1)\n\n[下载](asset:priv2)\n\n![公开](asset:pub1)";
  const output = replaceAssetRefs(body, id =>
    id === "pub1" ? "https://example.com/uploads/public/pub1.png" : null
  );
  assert.ok(output.includes("*[图片未公开：封面]*"), output);
  assert.ok(output.includes("下载") && !output.includes("asset:priv2"), output);
  assert.ok(output.includes("https://example.com/uploads/public/pub1.png"), output);
  assert.ok(!output.includes("asset:"), output);
});

test("toPlainExcerpt 按码点截断并压平空白", () => {
  const text = toPlainExcerpt("# 标题\n\n正文  内容", 5);
  assert.equal(text, "标题 正文…");
});

test("frontmatter 往返一致", () => {
  const raw = buildFrontmatter({
    id: "notes-hello",
    title: "带: 冒号的标题",
    summary: null,
    tags: ["a", "b"],
    date: "2026-11-01"
  });
  const parsed = parseFrontmatter(`${raw}\n\n正文`);
  assert.equal(parsed.present, true);
  assert.equal(parsed.data.title, "带: 冒号的标题");
  assert.deepEqual(parsed.data.tags, ["a", "b"]);
  assert.equal(parsed.body.trim(), "正文");
});

test("sanitizeEntryPath 拒绝目录穿越与绝对路径", () => {
  assert.throws(() => sanitizeEntryPath("../etc/passwd"));
  assert.throws(() => sanitizeEntryPath("/etc/passwd"));
  assert.throws(() => sanitizeEntryPath("C:\\Windows\\win.ini"));
  assert.equal(sanitizeEntryPath("a\\b\\c.md"), "a/b/c.md");
});

test("sanitizeFileName 去掉路径与控制字符", () => {
  assert.equal(sanitizeFileName("../../evil.png"), "evil.png");
  assert.equal(sanitizeFileName(""), "未命名文件");
});

test("contentDispositionAttachment 同时给出 ascii 与 UTF-8 文件名", () => {
  const header = contentDispositionAttachment("封面 1.png");
  assert.ok(header.startsWith("attachment;"), header);
  assert.ok(header.includes("filename*=UTF-8''"), header);
});


