import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";

export interface MigrationFile {
  version: string;
  filePath: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const FILE_PATTERN = /^(\d{4}_[A-Za-z0-9_-]+)\.sql$/;

export async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => FILE_PATTERN.test(name))
    .sort();

  const migrations: MigrationFile[] = [];
  for (const name of files) {
    const version = FILE_PATTERN.exec(name)![1];
    const filePath = path.join(directory, name);
    const sql = await readFile(filePath, "utf8");
    migrations.push({
      version,
      filePath,
      sql,
      checksum: createHash("sha256").update(sql, "utf8").digest("hex")
    });
  }
  return migrations;
}

/**
 * 顺序执行未应用的迁移，每个文件一个事务。
 * 不做任何破坏性自动迁移（不 drop、不 truncate），失败即回滚并中止。
 */
export async function runMigrations(pool: pg.Pool, directory: string): Promise<MigrationResult> {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query(
      `create table if not exists schema_migrations (
         version    text primary key,
         checksum   text not null,
         applied_at timestamptz not null default now()
       )`
    );
    const existing = await client.query<{ version: string; checksum: string }>(
      "select version, checksum from schema_migrations"
    );
    const known = new Map(existing.rows.map(row => [row.version, row.checksum]));

    for (const migration of migrations) {
      const previous = known.get(migration.version);
      if (previous) {
        if (previous !== migration.checksum) {
          process.stderr.write(
            `[migrate] 警告：${migration.version} 已应用但内容发生变化，跳过（不要修改已发布的迁移）\n`
          );
        }
        skipped.push(migration.version);
        continue;
      }
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query("insert into schema_migrations (version, checksum) values ($1, $2)", [
          migration.version,
          migration.checksum
        ]);
        await client.query("commit");
        applied.push(migration.version);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw new Error(
          `迁移 ${migration.version} 执行失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } finally {
    client.release();
  }
  return { applied, skipped };
}
