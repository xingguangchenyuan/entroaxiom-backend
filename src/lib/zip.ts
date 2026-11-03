import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { errors } from "../http/errors.js";
import { ARCHIVE_EXTENSIONS, extensionOf } from "./mime.js";

export interface ArchiveLimits {
  maxEntries: number;
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxEntryBytes: number;
  timeoutMs: number;
}

export interface ArchiveEntryInfo {
  /** 压缩包内的相对路径（已规范化，分隔符统一为 `/`） */
  path: string;
  size: number;
  compressedSize: number;
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true, strictFileNames: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(errors.unsupportedType(`无法读取压缩包：${error?.message ?? "未知错误"}`));
        return;
      }
      resolve(zipfile);
    });
  });
}

/**
 * 规范化并校验压缩包内路径：
 * - 拒绝绝对路径、Windows 盘符、`..` 段、NUL 字符；
 * - 统一分隔符，丢弃空段与 `.` 段；
 * 返回相对路径，调用方必须再用 `resolveInside()` 复核一次。
 */
export function sanitizeEntryPath(rawName: string): string {
  const unified = rawName.replace(/\\/g, "/");
  if (unified.includes("\u0000")) throw errors.unsupportedType("压缩包内含非法文件名（NUL 字符）");
  if (unified.startsWith("/")) throw errors.unsupportedType(`压缩包内含绝对路径：${rawName}`);
  if (/^[A-Za-z]:/.test(unified)) throw errors.unsupportedType(`压缩包内含 Windows 盘符路径：${rawName}`);
  const segments = unified.split("/").filter(segment => segment.length > 0 && segment !== ".");
  if (segments.length === 0) throw errors.unsupportedType(`压缩包内含空路径：${rawName}`);
  for (const segment of segments) {
    if (segment === "..") throw errors.unsupportedType(`压缩包内含上级目录引用：${rawName}`);
    if (segment.includes("\u0000")) throw errors.unsupportedType("压缩包内含非法文件名");
  }
  return segments.join("/");
}

/** 复核解析后的绝对路径确实落在根目录内，防止符号链接/编码绕过。 */
export function resolveInside(root: string, relative: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(withSep)) {
    throw errors.unsupportedType(`压缩包内路径越界：${relative}`);
  }
  return target;
}

function assertRegularFile(entry: yauzl.Entry): void {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  const isSymlink = mode === 0o120000;
  if (isSymlink) throw errors.unsupportedType(`压缩包内含符号链接：${entry.fileName}`);
}

function assertNotEncrypted(entry: yauzl.Entry): void {
  if ((entry.generalPurposeBitFlag & 0x1) === 0x1) {
    throw errors.unsupportedType(`压缩包已加密，无法导入：${entry.fileName}`);
  }
}

function assertNotNestedArchive(entryPath: string): void {
  const ext = extensionOf(entryPath);
  if (ARCHIVE_EXTENSIONS.has(ext)) {
    throw errors.unsupportedType(`压缩包内含嵌套压缩文件，无法导入：${entryPath}`);
  }
}

type EntryHandler = (entry: yauzl.Entry) => Promise<void>;

function walkZip(zipfile: yauzl.ZipFile, handler: EntryHandler): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {
        /* ignore */
      }
      reject(error);
    };
    zipfile.on("entry", (entry: yauzl.Entry) => {
      if (settled) return;
      handler(entry).then(
        () => {
          if (!settled) zipfile.readEntry();
        },
        error => fail(error)
      );
    });
    zipfile.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipfile.on("error", error => fail(errors.unsupportedType(`压缩包读取失败：${error.message}`)));
    zipfile.readEntry();
  });
}

export async function assertArchiveSize(filePath: string, limits: ArchiveLimits): Promise<number> {
  const info = await stat(filePath);
  if (info.size > limits.maxArchiveBytes) {
    throw errors.archiveTooLarge(
      `压缩包 ${(info.size / 1024 / 1024).toFixed(1)}MB 超过 ${Math.floor(limits.maxArchiveBytes / 1024 / 1024)}MB 上限`
    );
  }
  return info.size;
}

/** 只读取中央目录：用于预检，不解压任何内容。 */
export async function listArchive(filePath: string, limits: ArchiveLimits): Promise<ArchiveEntryInfo[]> {
  await assertArchiveSize(filePath, limits);
  const zipfile = await openZip(filePath);
  const entries: ArchiveEntryInfo[] = [];
  const startedAt = Date.now();
  let totalBytes = 0;

  await walkZip(zipfile, async entry => {
    if (Date.now() - startedAt > limits.timeoutMs) {
      throw errors.unsupportedType("压缩包处理超时，可能存在异常结构");
    }
    const isDirectory = entry.fileName.endsWith("/") || entry.fileName.endsWith("\\");
    const relative = sanitizeEntryPath(entry.fileName);
    if (isDirectory) return;
    assertRegularFile(entry);
    assertNotEncrypted(entry);
    assertNotNestedArchive(relative);
    if (entries.length + 1 > limits.maxEntries) {
      throw errors.archiveTooLarge(`压缩包条目超过 ${limits.maxEntries} 个上限`);
    }
    totalBytes += entry.uncompressedSize;
    if (totalBytes > limits.maxExpandedBytes) {
      throw errors.archiveTooLarge(
        `解压后体积超过 ${Math.floor(limits.maxExpandedBytes / 1024 / 1024)}MB 上限`
      );
    }
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      throw errors.archiveTooLarge(`文件过大：${relative}`);
    }
    entries.push({ path: relative, size: entry.uncompressedSize, compressedSize: entry.compressedSize });
  });

  return entries;
}

/** 解压到指定目录；每个条目都复核路径，边写边计数，防止 zip bomb 与路径穿越。 */
export async function extractArchive(
  filePath: string,
  destinationRoot: string,
  limits: ArchiveLimits
): Promise<ArchiveEntryInfo[]> {
  await assertArchiveSize(filePath, limits);
  const zipfile = await openZip(filePath);
  const extracted: ArchiveEntryInfo[] = [];
  const startedAt = Date.now();
  let totalBytes = 0;

  await walkZip(zipfile, async entry => {
    if (Date.now() - startedAt > limits.timeoutMs) {
      throw errors.unsupportedType("压缩包处理超时，可能存在异常结构");
    }
    const isDirectory = entry.fileName.endsWith("/") || entry.fileName.endsWith("\\");
    const relative = sanitizeEntryPath(entry.fileName);
    const target = resolveInside(destinationRoot, relative);

    if (isDirectory) {
      await mkdir(target, { recursive: true });
      return;
    }
    assertRegularFile(entry);
    assertNotEncrypted(entry);
    assertNotNestedArchive(relative);
    if (extracted.length + 1 > limits.maxEntries) {
      throw errors.archiveTooLarge(`压缩包条目超过 ${limits.maxEntries} 个上限`);
    }
    totalBytes += entry.uncompressedSize;
    if (totalBytes > limits.maxExpandedBytes) {
      throw errors.archiveTooLarge(
        `解压后体积超过 ${Math.floor(limits.maxExpandedBytes / 1024 / 1024)}MB 上限`
      );
    }
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      throw errors.archiveTooLarge(`文件过大：${relative}`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      zipfile.openReadStream(entry, (error, readStream) => {
        if (error || !readStream) {
          reject(errors.unsupportedType(`解压失败：${relative}`));
          return;
        }
        resolve(readStream);
      });
    });

    let written = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (written > entry.uncompressedSize + 1024) {
          callback(errors.archiveTooLarge(`条目实际内容超过声明大小：${relative}`));
          return;
        }
        if (totalBytes - entry.uncompressedSize + written > limits.maxExpandedBytes) {
          callback(errors.archiveTooLarge("解压后体积超过上限"));
          return;
        }
        callback(null, chunk);
      }
    });

    await pipeline(stream as NodeJS.ReadableStream, guard, createWriteStream(target));
    extracted.push({ path: relative, size: written, compressedSize: entry.compressedSize });
  });

  return extracted;
}
