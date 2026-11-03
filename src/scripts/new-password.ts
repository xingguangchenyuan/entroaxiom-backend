import { generateAdminPassword, ADMIN_PASSWORD_RECOMMENDED_CHARS } from "../lib/password-policy.js";

/**
 * 打印一个能直接粘进后台登录框的口令。
 *
 * 单独做成一个命令，是因为部署时最容易踩的坑就是长度：
 * `openssl rand -base64 24` 出来 32 位，接口能登录、网页表单却只收 8–18 位。
 */
const length = Number(process.argv[2] ?? ADMIN_PASSWORD_RECOMMENDED_CHARS);
if (!Number.isInteger(length)) {
  process.stderr.write(`口令长度必须是整数，收到：${process.argv[2] ?? ""}\n`);
  process.exit(1);
}
try {
  process.stdout.write(generateAdminPassword(length) + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exit(1);
}
