import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";

export type FileVisibility = "public" | "private";

export function uploadDir(config: AppConfig, visibility: FileVisibility): string {
  return path.join(config.uploadRoot, visibility);
}

export async function ensureUploadDirs(config: AppConfig): Promise<void> {
  await mkdir(uploadDir(config, "public"), { recursive: true });
  await mkdir(uploadDir(config, "private"), { recursive: true });
}

export function storageKeyFor(id: string, ext: string): string {
  return `${id}.${ext}`;
}

/** 物理路径只用服务端生成的 storage_key，绝不拼接客户端文件名。 */
export function storedPath(
  config: AppConfig,
  visibility: FileVisibility,
  storageKey: string
): string {
  const resolved = path.resolve(uploadDir(config, visibility), storageKey);
  const root = path.resolve(uploadDir(config, visibility));
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`非法的存储路径：${storageKey}`);
  }
  return resolved;
}

export async function writeStoredFile(
  config: AppConfig,
  visibility: FileVisibility,
  storageKey: string,
  data: Buffer
): Promise<number> {
  const target = storedPath(config, visibility, storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  const info = await stat(target);
  return info.size;
}

export async function copyStoredFile(
  config: AppConfig,
  from: { visibility: FileVisibility; storageKey: string },
  to: { visibility: FileVisibility; storageKey: string }
): Promise<void> {
  const target = storedPath(config, to.visibility, to.storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(storedPath(config, from.visibility, from.storageKey), target);
}

export async function removeStoredFile(
  config: AppConfig,
  visibility: FileVisibility,
  storageKey: string
): Promise<void> {
  await rm(storedPath(config, visibility, storageKey), { force: true });
}

export function readStoredFile(
  config: AppConfig,
  visibility: FileVisibility,
  storageKey: string
): Promise<Buffer> {
  return readFile(storedPath(config, visibility, storageKey));
}

export function streamStoredFile(
  config: AppConfig,
  visibility: FileVisibility,
  storageKey: string
) {
  return createReadStream(storedPath(config, visibility, storageKey));
}

/** 上传落盘占用统计（只统计 public/private 两个目录，忽略临时文件）。 */
export async function usedBytes(config: AppConfig): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  for (const visibility of ["public", "private"] as const) {
    let names: string[] = [];
    try {
      names = await readdir(uploadDir(config, visibility));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const info = await stat(path.join(uploadDir(config, visibility), name));
        if (info.isFile()) total += info.size;
      } catch {
        // 并发删除时忽略
      }
    }
  }
  return total;
}
