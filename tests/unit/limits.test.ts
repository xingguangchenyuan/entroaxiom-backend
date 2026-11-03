import assert from "node:assert/strict";
import test from "node:test";
import { RateLimiter } from "../../src/lib/rate-limit.js";
import { likePattern } from "../../src/lib/sql-like.js";

/**
 * 第四轮修复的单元回归：
 *   - `RateLimiter` 的键数量有硬上限（留言限流键带内容指纹，不设上限会被撑爆）；
 *   - `likePattern` 把 `%`、`_`、`\` 当字面量，不让站长输入变成通配查询。
 */

test("RateLimiter 在窗口内按上限拦截，窗口过去后放行", () => {
  let clock = 1_000_000;
  const limiter = new RateLimiter(() => clock);
  limiter.record("ip:1");
  const blocked = limiter.check("ip:1", 1, 60_000);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60);
  // 窗口过去后同一条记录不再计入
  clock += 61_000;
  assert.equal(limiter.check("ip:1", 1, 60_000).allowed, true);
});

test("RateLimiter 的键数量不会无界增长", () => {
  let now = 1_000_000;
  const limiter = new RateLimiter(() => now);
  for (let index = 0; index < 20_500; index += 1) {
    now += 1;
    limiter.record(`dup:${index}`);
  }
  // 上限是 20000，超出的键被淘汰，Map 不能继续涨
  assert.ok(limiter.size() <= 20_000, `size=${limiter.size()}`);
  // 最早写入的键被淘汰（等于配额清零），后写入的键还在
  assert.equal(limiter.check("dup:0", 1, 3_600_000).allowed, true);
  limiter.record("dup:20499");
  assert.equal(limiter.check("dup:20499", 1, 3_600_000).allowed, false);
});

test("RateLimiter 先清掉长时间没出现的键", () => {
  let now = 10_000_000;
  const limiter = new RateLimiter(() => now);
  for (let index = 0; index < 20_000; index += 1) {
    limiter.record(`old:${index}`);
  }
  // 一小时后重新来一批新键：旧键全部过期，应被清掉而不是按时间淘汰新键
  now += 3_600_001;
  for (let index = 0; index < 100; index += 1) {
    limiter.record(`fresh:${index}`);
  }
  assert.ok(limiter.size() <= 101, `size=${limiter.size()}`);
});

test("likePattern 转义 % _ 与反斜杠", () => {
  assert.equal(likePattern("100%"), "%100\\%%");
  assert.equal(likePattern("a_b"), "%a\\_b%");
  assert.equal(likePattern("c\\d"), "%c\\\\d%");
  assert.equal(likePattern("普通关键词"), "%普通关键词%");
});
