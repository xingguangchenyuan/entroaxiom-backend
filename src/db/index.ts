import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { AppConfig } from "../config.js";
import type { Database } from "./types.js";

export type { Database } from "./types.js";
export type Db = Kysely<Database>;
/** 服务层既可以在连接池上执行，也可以在事务里执行，统一用这个类型。 */
export type Executor = Db | Transaction<Database>;

let parsersInstalled = false;

/**
 * node-pg 默认把 int8（bigint/count）解析成字符串。本站规模下所有计数都在
 * Number 安全范围内，统一转成 number，避免每个调用点都手写 Number()。
 */
export function installTypeParsers(): void {
  if (parsersInstalled) return;
  pg.types.setTypeParser(20, value => Number(value));
  // date（OID 1082）必须原样返回字符串：node-pg 默认会把它解析成本地零点的 JS Date，
  // 再经 toISOString() 转成 UTC 就在东八区退回前一天，而且每保存一次再退一天。
  pg.types.setTypeParser(1082, value => value);
  parsersInstalled = true;
}

export function createPool(config: AppConfig): pg.Pool {
  installTypeParsers();
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    application_name: "entroaxiom-api"
  });
  pool.on("error", error => {
    // 空闲连接被服务端掐断时不要让进程崩掉，下一次查询会自动重连
    process.stderr.write(`[db] idle client error: ${error.message}\n`);
  });
  return pool;
}

export function createDatabase(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool })
  });
}

export async function withTransaction<T>(
  db: Db,
  handler: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(handler);
}

/**
 * 分页列表的 total：`count(*) over ()` 只在有行时才有值，翻到越界页时会被算成 0，
 * 前端于是显示"暂无数据"而不是"第 N 页是空的"。空页时用同一查询重取第一行拿真实总数。
 */
export async function pagedTotal<T extends { total_count: string }>(
  rows: T[],
  reloadFirstPage: () => Promise<T[]>
): Promise<number> {
  if (rows.length > 0) return Number(rows[0].total_count);
  const first = await reloadFirstPage();
  return first.length > 0 ? Number(first[0].total_count) : 0;
}

export async function pingDatabase(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select 1");
  } finally {
    client.release();
  }
}

export async function closeDatabase(db: Db, pool: pg.Pool): Promise<void> {
  await db.destroy();
  await pool.end().catch(() => undefined);
}
