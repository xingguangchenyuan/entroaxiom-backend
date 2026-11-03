import path from "node:path";

export type NodeEnv = "development" | "test" | "production";

export interface AppConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  host: string;
  port: number;
  /** 站点自身的地址，用于 Origin/Referer 校验与公开链接拼接，结尾不带斜杠 */
  publicOrigin: string;
  allowedOrigins: string[];
  databaseUrl: string;
  databaseSsl: boolean;
  pgPoolMax: number;
  sessionCookieName: string;
  sessionSecret: string;
  sessionTtlHours: number;
  sessionIdleHours: number;
  passwordHashMemoryKib: number;
  uploadRoot: string;
  importRoot: string;
  backupRoot: string;
  maxBodyBytes: number;
  maxFileBytes: number;
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxArchiveEntries: number;
  importTimeoutMs: number;
  ipHashSecret: string;
  logLevel: string;
  trustProxy: boolean;
  storageTotalBytes: number | null;
  moderationPolicyVersion: string;
  importTtlMinutes: number;
  versionRetention: number;
  allowedExtensions: string[];
  maxConcurrentUploads: number;
  shortBodyChars: number;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`配置校验失败：\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEV_SESSION_SECRET = "dev-only-session-secret-do-not-use-in-production-32";
const DEV_IP_SECRET = "dev-only-ip-hash-secret";

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value.length > 0 ? value : undefined;
}

function readInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  problems: string[],
  min: number,
  max: number
): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    problems.push(`${key} 必须是整数，当前值：${raw}`);
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    problems.push(`${key} 必须在 ${min} 到 ${max} 之间，当前值：${raw}`);
    return fallback;
  }
  return value;
}

function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean, problems: string[]): boolean {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  problems.push(`${key} 必须是 true/false，当前值：${raw}`);
  return fallback;
}

function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function resolvePath(base: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

/**
 * 读取并校验配置。缺少生产环境必需的变量时抛出 `ConfigError`，进程直接退出，
 * 绝不静默使用开发默认值（尤其是会话密钥与管理员口令）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): AppConfig {
  const problems: string[] = [];
  const rawEnv = (readString(env, "NODE_ENV") ?? "development").toLowerCase();
  const nodeEnv: NodeEnv =
    rawEnv === "production" || rawEnv === "test" ? (rawEnv as NodeEnv) : "development";
  const isProduction = nodeEnv === "production";

  const publicOriginRaw = readString(env, "PUBLIC_ORIGIN") ?? (isProduction ? undefined : "http://127.0.0.1:8000");
  if (!publicOriginRaw) {
    problems.push("PUBLIC_ORIGIN 未设置（生产环境必填，例如 https://example.com）");
  } else if (!isHttpOrigin(publicOriginRaw)) {
    problems.push(`PUBLIC_ORIGIN 必须是 http(s) 源（不带路径与结尾斜杠），当前值：${publicOriginRaw}`);
  }
  const publicOrigin = normalizeOrigin(publicOriginRaw ?? "");

  const allowedOrigins = (readString(env, "ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map(item => normalizeOrigin(item.trim()))
    .filter(item => item.length > 0);
  if (publicOrigin && !allowedOrigins.includes(publicOrigin)) allowedOrigins.unshift(publicOrigin);

  const databaseUrl =
    readString(env, "DATABASE_URL") ?? (isProduction ? undefined : "postgres://postgres:postgres@127.0.0.1:5432/entroaxiom");
  if (!databaseUrl) {
    problems.push("DATABASE_URL 未设置（生产环境必填）");
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL 必须以 postgres:// 或 postgresql:// 开头");
  }

  const sessionSecret = readString(env, "SESSION_SECRET") ?? (isProduction ? undefined : DEV_SESSION_SECRET);
  if (sessionSecret === undefined) {
    problems.push("SESSION_SECRET 未设置（生产环境必填，至少 32 字节随机值）");
  } else if (sessionSecret.length < 32) {
    problems.push("SESSION_SECRET 长度不足 32 个字符，请改用 `openssl rand -base64 48` 生成");
  }

  const ipHashSecret = readString(env, "IP_HASH_SECRET") ?? (isProduction ? undefined : DEV_IP_SECRET);
  if (ipHashSecret === undefined) {
    problems.push("IP_HASH_SECRET 未设置（生产环境必填，用于对访客 IP 做 HMAC）");
  } else if (ipHashSecret.length < 16) {
    problems.push("IP_HASH_SECRET 长度不足 16 个字符");
  }

  const config: AppConfig = {
    nodeEnv,
    isProduction,
    host: readString(env, "HOST") ?? "127.0.0.1",
    port: readInt(env, "PORT", 8000, problems, 1, 65535),
    publicOrigin,
    allowedOrigins,
    databaseUrl: databaseUrl ?? "",
    databaseSsl: readBool(env, "DATABASE_SSL", false, problems),
    pgPoolMax: readInt(env, "PG_POOL_MAX", 10, problems, 1, 100),
    sessionCookieName: readString(env, "SESSION_COOKIE_NAME") ?? "sid",
    sessionSecret: sessionSecret ?? DEV_SESSION_SECRET,
    sessionTtlHours: readInt(env, "SESSION_TTL_HOURS", 168, problems, 1, 24 * 365),
    sessionIdleHours: readInt(env, "SESSION_IDLE_HOURS", 24, problems, 1, 24 * 365),
    passwordHashMemoryKib: readInt(env, "PASSWORD_HASH_MEMORY_KIB", 65536, problems, 8192, 1_048_576),
    uploadRoot: resolvePath(cwd, readString(env, "UPLOAD_ROOT") ?? "./var/uploads"),
    importRoot: resolvePath(cwd, readString(env, "IMPORT_ROOT") ?? "./var/imports"),
    backupRoot: resolvePath(cwd, readString(env, "BACKUP_ROOT") ?? "./var/backups"),
    maxBodyBytes: readInt(env, "MAX_BODY_BYTES", 2 * 1024 * 1024, problems, 1024, 64 * 1024 * 1024),
    maxFileBytes: readInt(env, "MAX_FILE_BYTES", 50 * 1024 * 1024, problems, 1024, 2 * 1024 * 1024 * 1024),
    maxArchiveBytes: readInt(env, "MAX_ARCHIVE_BYTES", 40 * 1024 * 1024, problems, 1024, 2 * 1024 * 1024 * 1024),
    maxExpandedBytes: readInt(env, "MAX_EXPANDED_BYTES", 200 * 1024 * 1024, problems, 1024, 8 * 1024 ** 3),
    maxArchiveEntries: readInt(env, "MAX_ARCHIVE_ENTRIES", 2000, problems, 1, 100_000),
    importTimeoutMs: readInt(env, "IMPORT_TIMEOUT_MS", 60_000, problems, 1000, 600_000),
    ipHashSecret: ipHashSecret ?? DEV_IP_SECRET,
    logLevel: readString(env, "LOG_LEVEL") ?? (isProduction ? "info" : "debug"),
    trustProxy: readBool(env, "TRUST_PROXY", false, problems),
    storageTotalBytes: readString(env, "STORAGE_TOTAL_BYTES")
      ? readInt(env, "STORAGE_TOTAL_BYTES", 0, problems, 1, Number.MAX_SAFE_INTEGER)
      : null,
    moderationPolicyVersion: readString(env, "MODERATION_POLICY_VERSION") ?? "2026-11-01",
    importTtlMinutes: readInt(env, "IMPORT_TTL_MINUTES", 30, problems, 1, 24 * 60),
    versionRetention: readInt(env, "VERSION_RETENTION", 20, problems, 1, 1000),
    allowedExtensions: (readString(env, "ALLOWED_EXTENSIONS") ?? "jpg,jpeg,png,webp,gif,avif,pdf,zip,md,txt,doc,docx")
      .split(",")
      .map(item => item.trim().toLowerCase().replace(/^\./, ""))
      .filter(item => item.length > 0),
    maxConcurrentUploads: readInt(env, "MAX_CONCURRENT_UPLOADS", 3, problems, 1, 32),
    shortBodyChars: readInt(env, "SHORT_BODY_CHARS", 50, problems, 1, 100_000)
  };

  if (config.nodeEnv === "production") {
    if (config.sessionSecret === DEV_SESSION_SECRET) problems.push("SESSION_SECRET 不能使用开发默认值");
    if (config.ipHashSecret === DEV_IP_SECRET) problems.push("IP_HASH_SECRET 不能使用开发默认值");
    if (!config.publicOrigin.startsWith("https://")) {
      // 仅提示，不阻塞：本地验收可能用 http，但生产必须 https
      problems.push("生产环境 PUBLIC_ORIGIN 必须是 https://（Secure Cookie 需要）");
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

