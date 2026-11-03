import { mkdir } from "node:fs/promises";
import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type { FastifyBaseLogger } from "fastify";
import { loadConfig, type AppConfig } from "./config.js";
import { setContext, clearContext, type AppContext } from "./context.js";
import { closeDatabase, createDatabase, createPool, installTypeParsers, pingDatabase } from "./db/index.js";
import { createLogger } from "./logger.js";
import { registerAuth } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/errors.js";
import { registerMultipart } from "./plugins/multipart.js";
import { registerSecurity } from "./plugins/security.js";
import { registerStatic } from "./plugins/static.js";
import { registerRoutes } from "./routes/index.js";
import { ensureUploadDirs } from "./services/storage.js";

export interface BuildOptions {
  config?: AppConfig;
  logger?: FastifyBaseLogger;
}

/**
 * 组装应用：配置 → 日志 → 数据库 → 插件 → 路由。
 * 这里不跑迁移，也不做任何破坏性初始化：迁移永远是独立的运维动作。
 */
export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  installTypeParsers();
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config.logLevel);

  await ensureUploadDirs(config);
  await mkdir(config.importRoot, { recursive: true });
  await mkdir(config.backupRoot, { recursive: true });

  const pool = createPool(config);
  const db = createDatabase(pool);
  const ctx: AppContext = { config, db, pool, logger };
  setContext(ctx);

  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: config.maxBodyBytes,
    trustProxy: config.trustProxy,
    disableRequestLogging: false
  });

  app.decorate("ctx", ctx);
  app.decorateRequest("session", null);

  await app.register(fastifyCookie);
  registerErrorHandler(app);
  registerSecurity(app);
  await registerMultipart(app, config);
  registerAuth(app);
  await registerStatic(app, config);

  app.get("/healthz", async () => ({ status: "ok", uptime: Math.round(process.uptime()) }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await pingDatabase(pool);
      return reply.send({ status: "ready" });
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  await registerRoutes(app);

  app.addHook("onClose", async () => {
    await closeDatabase(db, pool);
    clearContext();
  });

  return app;
}
