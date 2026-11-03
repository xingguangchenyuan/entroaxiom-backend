import { loadConfig } from "../config.js";
import { installTypeParsers, createDatabase, closeDatabase, createPool } from "../db/index.js";
import { createAdminUser, findUserByUsername, updateAdminPassword } from "../services/users.js";
import { passwordPolicyProblems, ADMIN_PASSWORD_MIN_CHARS, ADMIN_PASSWORD_MAX_CHARS } from "../lib/password-policy.js";

interface Args {
  username: string | null;
  password: string | null;
  nickname: string | null;
  force: boolean;
}


const USAGE = `用法：
  npm run admin:init -- --username <用户名> [--nickname <昵称>] [--force]

口令来源（按优先级）：
  1. 交互输入（推荐）：在终端里运行上面的命令，会提示隐藏输入并二次确认，口令不回显、不进 shell history；
  2. 一次性环境变量 ADMIN_PASSWORD（仅用于受控的自动化，用完请立刻清掉，不要写进生产 env 文件）。

其它：
  --force  只用于重置已存在管理员的口令，不会删除或重建用户。
  用户名 3–32 位，允许字母、数字、点、下划线和短横线。
  口令 ${ADMIN_PASSWORD_MIN_CHARS}–${ADMIN_PASSWORD_MAX_CHARS} 位、至少两类字符（数字 / 小写 / 大写 / 符号）：
  这个区间来自后台登录表单的前端校验，超出范围网页就提交不上去。用 \`npm run admin:password\` 生成一个。`;

function parseArgs(argv: string[]): Args {
  const out: Args = { username: null, password: null, nickname: null, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--force") {
      out.force = true;
      continue;
    }
    const [flag, inline] = token.startsWith("--") && token.includes("=")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token, undefined];
    const value = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
    if (flag === "--username" || flag === "-u") out.username = value ?? null;
    else if (flag === "--password" || flag === "-p") out.password = value ?? null;
    else if (flag === "--nickname" || flag === "-n") out.nickname = value ?? null;
  }
  return out;
}

function check(username: string, password: string): string[] {
  const problems: string[] = [];
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    problems.push("用户名只能包含字母、数字、点、下划线和短横线，长度 3–32");
  }
  problems.push(...passwordPolicyProblems(password));
  return problems;
}

function promptVisible(question: string): Promise<string | null> {
  return new Promise(resolve => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u0003" || char === "\u0004") {
          cleanup();
          stdout.write("\n");
          resolve(null);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (char < " ") continue;
        value += char;
        stdout.write(char);
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

/**
 * 隐藏输入口令：关闭终端回显，逐个字符累积，只处理退格与 Ctrl-C。
 * 口令不落到 history、也不出现在 ps 的 argv 里。
 */
function promptHidden(question: string): Promise<string | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) return Promise.resolve(null);
  const wasRaw = stdin.isRaw === true;
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";
  return new Promise(resolve => {
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003" || char === "\u0004") {
          cleanup();
          stdout.write("\n");
          resolve(null);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char < " ") continue;
        value += char;
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

/** 交互模式下取口令：隐藏输入 + 二次确认；非 TTY 返回 null 由调用方报错退出。 */
async function readPasswordInteractively(username: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const first = await promptHidden(`为 ${username} 设置口令（${ADMIN_PASSWORD_MIN_CHARS}–${ADMIN_PASSWORD_MAX_CHARS} 位，输入不回显）：`);
  if (first === null) {
    process.stderr.write("\n已取消。\n");
    return null;
  }
  if (first.length === 0) {
    process.stderr.write("口令不能为空。\n");
    return null;
  }
  const second = await promptHidden("再输入一次确认：");
  if (second === null) {
    process.stderr.write("\n已取消。\n");
    return null;
  }
  if (first !== second) {
    process.stderr.write("两次输入不一致，已取消。\n");
    return null;
  }
  return first;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = (args.username ?? process.env.ADMIN_USERNAME ?? "").trim();
  const nickname = (args.nickname ?? process.env.ADMIN_NICKNAME ?? "").trim() || "站长";

  if (!username) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }

  let password = args.password ?? process.env.ADMIN_PASSWORD ?? "";
  if (password) {
    if (args.password) {
      process.stderr.write(
        "提示：用 --password 传明文口令会留在 shell history 与进程列表里；交互运行（不带 --password）更安全。\n"
      );
    }
  } else {
    password = (await readPasswordInteractively(username)) ?? "";
    if (!password) {
      process.stderr.write(
        "没有拿到口令，已退出（未创建任何账号）。\n" +
          "非交互环境请先在终端里交互执行，或临时用 ADMIN_PASSWORD 一次性变量。\n"
      );
      process.exit(1);
    }
  }

  const problems = check(username, password);
  if (problems.length > 0) {
    process.stderr.write("口令/用户名不符合要求：\n");
    for (const problem of problems) process.stderr.write(` - ${problem}\n`);
    process.stderr.write("提示：`npm run admin:password` 会打印一个能直接用的 16 位口令。\n");
    process.exit(1);
  }

  const config = loadConfig();
  installTypeParsers();
  const pool = createPool(config);
  const db = createDatabase(pool);
  try {
    const existing = await findUserByUsername(db, username);
    if (existing && !args.force) {
      process.stderr.write(`用户 ${username} 已存在。如需重置口令请追加 --force。\n`);
      process.exitCode = 1;
      return;
    }
    if (existing) {
      await updateAdminPassword(db, { username, password, memoryKib: config.passwordHashMemoryKib });
      process.stdout.write(`已重置 ${username} 的口令（用户与历史数据未改动）。\n`);
    } else {
      await createAdminUser(db, {
        username,
        password,
        nickname,
        memoryKib: config.passwordHashMemoryKib
      });
      process.stdout.write(`已创建管理员 ${username}（昵称 ${nickname}），权限 *:*:*。\n`);
    }
    process.stdout.write("请立刻用真实口令登录一次以确认可用，并妥善保管该口令。\n");
  } finally {
    await closeDatabase(db, pool);
  }
}

main().catch(error => {
  process.stderr.write(`创建管理员失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});