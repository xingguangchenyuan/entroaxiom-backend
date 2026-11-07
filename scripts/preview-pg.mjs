// 本地预览用的 PostgreSQL 兼容服务：PGlite(WASM) + pglite-socket。
// 单连接，所以后端要用 PG_POOL_MAX=1；数据落在 .tmp/local/pgdata，重启不丢。
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const dataDir = path.resolve(process.cwd(), "..", ".tmp", "local", "pgdata");
const port = Number(process.env.PREVIEW_PG_PORT ?? 55432);

const db = await PGlite.create({ dataDir });
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
await server.start();
process.stdout.write(`[preview] pglite listening 127.0.0.1:${port} data=${dataDir}\n`);

const stop = async () => {
  try {
    server.stop();
  } catch {}
  try {
    await db.close();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
