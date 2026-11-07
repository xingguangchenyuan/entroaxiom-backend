// 本地预览用的后端启动器：把环境变量设好，再按源码方式（tsx）拉起 src/server.ts。
// 与生产唯一的区别是：NODE_ENV=development、PUBLIC_ORIGIN 指向本地静态端口、
// 数据库连的是 .tmp/local 下的 PGlite、PG_POOL_MAX=1（pglite-socket 单连接）。
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataRoot = path.resolve(repoRoot, "..", ".tmp", "local");

const env = {
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: "8000",
  PUBLIC_ORIGIN: "http://localhost:8080",
  ALLOWED_ORIGINS: "http://localhost:8081",
  DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${process.env.PREVIEW_PG_PORT ?? 55432}/postgres`,
  SESSION_SECRET: "local-preview-session-secret-0123456789abcdef",
  IP_HASH_SECRET: "local-preview-ip-hash-secret",
  UPLOAD_ROOT: path.join(dataRoot, "uploads"),
  IMPORT_ROOT: path.join(dataRoot, "imports"),
  BACKUP_ROOT: path.join(dataRoot, "backups"),
  PG_POOL_MAX: "1",
  LOG_LEVEL: "info",
  PASSWORD_HASH_MEMORY_KIB: "8192"
};

for (const [key, value] of Object.entries(env)) process.env[key] = value;

await import("../src/server.ts");
