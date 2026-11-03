import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

/** 会话令牌 / 刷新令牌：CSPRNG 生成，只把哈希写入数据库。 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** 短 ID（文件 id 等）：只含 URL 安全字符。 */
export function randomId(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

/** 访客 IP 只保留 HMAC，不可逆、不可跨环境关联。 */
export function hashIp(ip: string | undefined | null, secret: string): string | null {
  const value = (ip ?? "").trim();
  if (!value) return null;
  return hmacSha256Hex(secret, value);
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 访客留言的指纹：用于「10 分钟内完全相同的留言」去重。 */
export function contentFingerprint(parts: Array<string | null | undefined>): string {
  return sha256Hex(parts.map(part => (part ?? "").trim()).join("\u0000"));
}
