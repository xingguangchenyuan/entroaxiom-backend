import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ADMIN_PASSWORD_MAX_CHARS,
  ADMIN_PASSWORD_MIN_CHARS,
  generateAdminPassword,
  passwordPolicyProblems
} from "../../src/lib/password-policy.js";

/**
 * 回归来源：线上用 `openssl rand -base64 24` 生成了 32 位口令，
 * 接口能登录，后台登录页的前端校验却只收 8–18 位，人打不开后台。
 */
describe("管理员口令策略（必须与后台登录表单一致）", () => {
  it("接受 16 位、四类字符都有的口令", () => {
    assert.deepEqual(passwordPolicyProblems("Ab3$xY9!qW2#eR7&"), []);
  });

  it("拒绝超过 18 位的口令，并说明原因", () => {
    const problems = passwordPolicyProblems("Ab3$xY9!qW2#eR7&zZ0");
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /最多 18 位/);
    assert.match(problems[0]!, /登录表单/);
  });

  it("拒绝太短的口令", () => {
    assert.match(passwordPolicyProblems("Ab3$")[0]!, /至少 8 位/);
  });

  it("拒绝只有一类字符的口令（表单要求两类）", () => {
    assert.match(passwordPolicyProblems("abcdefghij")[0]!, /两类字符/);
  });

  it("拒绝中文与不可见字符", () => {
    assert.match(passwordPolicyProblems("Abc12345中文")[0]!, /不能包含中文/);
    assert.match(passwordPolicyProblems("Abc12345\tXy")[0]!, /ASCII/);
  });

  it("生成的口令一定落在表单接受的范围内，且每次都不同", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const password = generateAdminPassword();
      assert.ok(password.length >= ADMIN_PASSWORD_MIN_CHARS && password.length <= ADMIN_PASSWORD_MAX_CHARS);
      assert.deepEqual(passwordPolicyProblems(password), [], password);
      seen.add(password);
    }
    assert.equal(seen.size, 200, "生成的口令不应重复");
  });

  it("生成时不允许超过表单上限", () => {
    assert.throws(() => generateAdminPassword(ADMIN_PASSWORD_MAX_CHARS + 1), /8–18 位/);
  });
});
