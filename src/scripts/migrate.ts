import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createPool, installTypeParsers } from "../db/index.js";
import { runMigrations } from "../db/migrator.js";

/** 支持三种运行形态：tsx 直跑源码、tsc 后的 dist、以及从仓库根目录执行。 */
function resolveMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../db/migrations"),
    path.resolve(here, "../../src/db/migrations"),
    path.resolve(process.cwd(), "src/db/migrations"),
    path.resolve(process.cwd(), "dist/db/migrations")
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!;
}

async function main(): Promise<void> {
  const config = loadConfig();
  installTypeParsers();
  const pool = createPool(config);
  try {
    const directory = resolveMigrationsDir();
    const result = await runMigrations(pool, directory);
    for (const version of result.applied) process.stdout.write(`已应用 ${version}\n`);
    for (const version of result.skipped) process.stdout.write(`已存在 ${version}（跳过）\n`);
    process.stdout.write(
      `迁移完成：应用 ${result.applied.length} 个，跳过 ${result.skipped.length} 个（目录 ${directory}）\n`
    );
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`迁移失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
