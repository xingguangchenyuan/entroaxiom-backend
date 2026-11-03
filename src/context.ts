import type { Kysely } from "kysely";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type { AppConfig } from "./config.js";
import type { Database } from "./db/types.js";

export interface AppContext {
  config: AppConfig;
  db: Kysely<Database>;
  pool: Pool;
  logger: FastifyBaseLogger;
}

let current: AppContext | null = null;

export function setContext(context: AppContext): void {
  current = context;
}

export function getContext(): AppContext {
  if (!current) throw new Error("应用上下文尚未初始化");
  return current;
}

export function clearContext(): void {
  current = null;
}
