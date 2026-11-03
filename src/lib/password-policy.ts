import { randomInt } from "node:crypto";

/**
 * 管理员口令策略。
 *
 * 后端本身对长度没有硬上限，但**后台登录表单**先做了一次前端校验：
 * `admin/src/views/login/utils/rule.ts` 里的 REGEXP_PWD 要求
 * 「8–18 位、至少两类字符、不含中文」。
 * 一旦初始化出来的是 20 位口令，命令行能建、接口能登，但人打不开网页后台
 * ——线上真的踩过这个坑（`openssl rand -base64 24` 出来的就是 32 位）。
 * 所以生成与校验都收在这个区间里，两边不会再有第二个真相。
 */
export const ADMIN_PASSWORD_MIN_CHARS = 8;
export const ADMIN_PASSWORD_MAX_CHARS = 18;
export const ADMIN_PASSWORD_RECOMMENDED_CHARS = 16;

const ASCII_PRINTABLE = /^[\x20-\x7E]+$/;
const CHINESE = /[\u4E00-\u9FA5]/;
const CLASSES: ReadonlyArray<readonly [string, RegExp]> = [
  ["数字", /[0-9]/],
  ["小写字母", /[a-z]/],
  ["大写字母", /[A-Z]/],
  ["符号", /[^0-9A-Za-z]/]
];

/** 返回口令不符合后台登录表单要求的原因；空数组表示可以登录。 */
export function passwordPolicyProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < ADMIN_PASSWORD_MIN_CHARS) {
    problems.push(`口令至少 ${ADMIN_PASSWORD_MIN_CHARS} 位`);
  }
  if (password.length > ADMIN_PASSWORD_MAX_CHARS) {
    problems.push(
      `口令最多 ${ADMIN_PASSWORD_MAX_CHARS} 位：后台登录表单只接受 ${ADMIN_PASSWORD_MIN_CHARS}–${ADMIN_PASSWORD_MAX_CHARS} 位，` +
        "再长的口令在网页里提交不上去（接口能用，人就登不进来）"
    );
  }
  if (CHINESE.test(password)) problems.push("口令不能包含中文");
  if (!ASCII_PRINTABLE.test(password)) problems.push("口令只能用 ASCII 可见字符（字母、数字、符号）");
  const used = CLASSES.filter(([, re]) => re.test(password)).map(([name]) => name);
  if (used.length < 2) {
    problems.push("口令至少包含两类字符（数字 / 小写字母 / 大写字母 / 符号 里的任意两类）");
  }
  return problems;
}

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+?";

function pick(alphabet: string): string {
  return alphabet[randomInt(0, alphabet.length)]!;
}

/**
 * 生成一个既能过表单、又有足够熵的口令。
 *
 * 默认 16 位、四类字符各至少一个：字母表 24+24+8+12=68 种，16 位约 97 bit 熵，
 * 远高于口语化密码，也不至于长到记不住。
 */
export function generateAdminPassword(length = ADMIN_PASSWORD_RECOMMENDED_CHARS): string {
  if (length < 4) throw new Error("口令长度至少要 4 位才能覆盖四类字符");
  if (length > ADMIN_PASSWORD_MAX_CHARS) {
    throw new Error(`后台登录表单只接受 ${ADMIN_PASSWORD_MIN_CHARS}–${ADMIN_PASSWORD_MAX_CHARS} 位`);
  }
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  while (chars.length < length) chars.push(pick(all));
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = randomInt(0, index + 1);
    [chars[index], chars[swap]] = [chars[swap]!, chars[index]!];
  }
  return chars.join("");
}
