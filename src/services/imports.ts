import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db/index.js";
import { getContext } from "../context.js";
import { errors } from "../http/errors.js";
import { iso } from "../http/serialize.js";
import { randomId } from "../lib/crypto.js";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { assertValidId, isValidId, slugify } from "../lib/ids.js";
import { describeExtension, extensionOf, sanitizeFileName } from "../lib/mime.js";
import { addMinutes } from "../lib/time.js";
import { extractArchive, listArchive } from "../lib/zip.js";
import { createFileRecord } from "./files.js";
import { removeStoredFile, storageKeyFor } from "./storage.js";
import { insertVersion, getArticleRow } from "./articles.js";
import { syncReferences } from "./references.js";
import { writeAudit, type Actor } from "./audit.js";
import type { ContentRes } from "../db/types.js";

export interface ImportCandidate {
  path: string;
  title: string | null;
  size: number;
}

export type AssetState = "matched" | "unreferenced" | "missing" | "ambiguous" | "unsupported";

export interface ImportAssetView {
  path: string;
  name: string;
  kind: string;
  size: number;
  referenced: boolean;
  state: AssetState;
  candidates?: string[];
  note?: string;
}

export interface ImportWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
}

export interface ImportConflict {
  id: string;
  title: string;
  updatedAt: string | null;
  revision: number;
}

export interface ImportPreview {
  importId: string;
  expiresAt: string | null;
  type: ContentRes;
  candidates: ImportCandidate[];
  selectedPath: string | null;
  draft: Record<string, unknown> | null;
  unknownFrontmatter: string[];
  assets: ImportAssetView[];
  warnings: ImportWarning[];
  conflicts: ImportConflict[];
  committable: boolean;
  missingCount: number;
}

export interface CommitInput {
  mode: "create" | "update";
  targetId?: string;
  baseRevision?: number;
  draft: {
    id?: string;
    title: string;
    summary?: string | null;
    category?: string | null;
    tags?: string[] | null;
    date?: string | null;
    updated?: string | null;
    body: string;
    mood?: string | null;
    place?: string | null;
  };
  includeUnreferencedPaths?: string[];
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const KNOWN_FRONTMATTER = new Set([
  "id", "title", "summary", "category", "tags", "date", "updated",
  "mood", "place", "visibility", "status"
]);

type ImportRow = NonNullable<Awaited<ReturnType<typeof selectImport>>>;

async function selectImport(db: Db, id: string) {
  return db.selectFrom("imports").selectAll().where("id", "=", id).executeTakeFirst();
}

async function walk(directory: string, base = ""): Promise<Array<{ relPath: string; size: number }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<{ relPath: string; size: number }> = [];
  for (const entry of entries) {
    const relPath = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full, relPath)));
    } else if (entry.isFile()) {
      const info = await stat(full);
      files.push({ relPath, size: info.size });
    }
  }
  return files;
}

/**
 * 把正文里的相对引用解析成"相对压缩包根"的路径。
 *
 * 预览阶段是按选中 md 所在目录解析的（notes/article.md 里的 assets/a.png
 * 指向 notes/assets/a.png），提交阶段必须用同一个函数算映射键，
 * 否则两边对不上，资源识别成功但正文里还是相对路径。
 */
function resolveLocalRef(markdownDir: string, ref: string): string {
  if (!markdownDir || markdownDir === ".") return ref;
  const resolved = path.posix.normalize(path.posix.join(markdownDir, ref));
  // 越出压缩包根（多余的 ../）一律不认，避免把包外路径当成包内资源。
  if (resolved.startsWith("..")) return ref;
  return resolved;
}

function normalizeRef(raw: string): string {
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* 保留原样 */
  }
  value = value.replace(/^\.\//, "").replace(/^\/+/, "");
  return path.posix.normalize(value);
}

function extractRefs(body: string): string[] {
  const refs: string[] = [];
  const pattern = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const target = match[1] ?? "";
    if (!target || /^(https?:)?\/\//i.test(target) || target.startsWith("#") || target.startsWith("mailto:")) continue;
    if (target.startsWith("asset:")) continue;
    refs.push(normalizeRef(target));
  }
  return [...new Set(refs)];
}

function draftFromMarkdown(raw: string): {
  draft: Record<string, unknown> | null;
  unknownFrontmatter: string[];
  body: string;
  title: string | null;
} {
  const parsed = parseFrontmatter(raw);
  const data = parsed.data;
  const unknownFrontmatter = Object.keys(data).filter(key => !KNOWN_FRONTMATTER.has(key));
  const body = parsed.body.trimStart();
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : null;

  if (!parsed.present) {
    return { draft: null, unknownFrontmatter, body, title: null };
  }

  const asString = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const tags = Array.isArray(data.tags)
    ? (data.tags as unknown[]).filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : null;

  const draft: Record<string, unknown> = {
    id: asString(data.id) ?? (title ? slugify(title, "import") : ""),
    title: title ?? "",
    body,
    summary: asString(data.summary),
    category: asString(data.category),
    tags: tags && tags.length > 0 ? tags : null,
    date: asString(data.date),
    updated: asString(data.updated),
    mood: asString(data.mood),
    place: asString(data.place)
  };
  return { draft, unknownFrontmatter, body, title };
}

async function computePreview(db: Db, row: ImportRow, res: ContentRes): Promise<ImportPreview> {
  const config = getContext().config;
  const files = await walk(row.temp_dir);
  const mdFiles = files.filter(file => MARKDOWN_EXTENSIONS.has(extensionOf(file.relPath)));

  const candidates: ImportCandidate[] = [];
  for (const file of mdFiles) {
    const raw = await readFile(path.join(row.temp_dir, file.relPath), "utf8").catch(() => "");
    const parsed = draftFromMarkdown(raw);
    candidates.push({ path: file.relPath, title: parsed.title, size: file.size });
  }
  candidates.sort((a, b) => a.path.localeCompare(b.path));

  const warnings: ImportWarning[] = [];
  let selectedPath = row.selected_path;
  if (!selectedPath && candidates.length === 1 && candidates[0]) {
    selectedPath = candidates[0].path;
  }

  let draft: Record<string, unknown> | null = null;
  let unknownFrontmatter: string[] = [];
  let body = "";
  const assets: ImportAssetView[] = [];
  let missingCount = 0;

  if (selectedPath) {
    const target = files.find(file => file.relPath === selectedPath);
    if (!target) {
      selectedPath = null;
      warnings.push({ code: "ENTRY_MISSING", severity: "warning", message: "选中的 Markdown 在临时目录里已不存在" });
    } else {
      const raw = await readFile(path.join(row.temp_dir, target.relPath), "utf8").catch(() => null);
      if (raw === null) {
        warnings.push({
          code: "ENTRY_UNREADABLE",
          severity: "error",
          message: "Markdown 不是有效的 UTF-8 文本",
          path: target.relPath
        });
      } else {
        const parsed = draftFromMarkdown(raw);
        draft = parsed.draft;
        unknownFrontmatter = parsed.unknownFrontmatter;
        body = parsed.body;
        if (parsed.unknownFrontmatter.length > 0) {
          warnings.push({
            code: "UNKNOWN_FRONTMATTER",
            severity: "info",
            message: `以下 frontmatter 字段不会被导入：${parsed.unknownFrontmatter.join("、")}`,
            path: target.relPath
          });
        }
        if (!draft) {
          warnings.push({
            code: "NO_FRONTMATTER",
            severity: "warning",
            message: "这段 Markdown 没有 frontmatter，标题与摘要需要手工填写",
            path: target.relPath
          });
        }
      }
    }
  }

  if (selectedPath) {
    const dir = path.posix.dirname(selectedPath);
    const refs = extractRefs(body);
    const assetFiles = files.filter(file => !MARKDOWN_EXTENSIONS.has(extensionOf(file.relPath)));
    const byBase = new Map<string, string[]>();
    for (const file of assetFiles) {
      const base = path.posix.basename(file.relPath);
      byBase.set(base, [...(byBase.get(base) ?? []), file.relPath]);
    }

    const referencedPaths = new Set<string>();
    for (const ref of refs) {
      const resolved = resolveLocalRef(dir, ref);
      const exact = assetFiles.find(file => file.relPath === resolved);
      if (exact) {
        referencedPaths.add(exact.relPath);
        continue;
      }
      const byName = byBase.get(path.posix.basename(ref)) ?? [];
      if (byName.length === 1 && byName[0]) {
        referencedPaths.add(byName[0]);
        warnings.push({
          code: "ASSET_PATH_FIXED",
          severity: "info",
          message: `正文引用的 ${ref} 按文件名匹配到了 ${byName[0]}`,
          path: byName[0]
        });
        continue;
      }
      missingCount += 1;
      if (byName.length > 1) {
        assets.push({
          path: ref,
          name: path.posix.basename(ref),
          kind: describeExtension(extensionOf(ref)).kind,
          size: 0,
          referenced: true,
          state: "ambiguous",
          candidates: byName,
          note: "有多份同名文件，无法判断引用的是哪一份"
        });
        warnings.push({
          code: "ASSET_AMBIGUOUS",
          severity: "error",
          message: `正文引用的 ${ref} 在压缩包里有 ${byName.length} 个同名候选`,
          path: ref
        });
      } else {
        assets.push({
          path: ref,
          name: path.posix.basename(ref),
          kind: describeExtension(extensionOf(ref)).kind,
          size: 0,
          referenced: true,
          state: "missing",
          note: "正文引用了这个文件，但压缩包里没有"
        });
        warnings.push({
          code: "ASSET_MISSING",
          severity: "error",
          message: `正文引用的 ${ref} 在压缩包里找不到`,
          path: ref
        });
      }
    }

    for (const file of assetFiles) {
      const kind = describeExtension(extensionOf(file.relPath)).kind;
      const referenced = referencedPaths.has(file.relPath);
      if (kind === "archive" || extensionOf(file.relPath) === "") {
        assets.push({
          path: file.relPath,
          name: path.posix.basename(file.relPath),
          kind,
          size: file.size,
          referenced,
          state: "unsupported",
          note: "不支持导入这种文件类型"
        });
        continue;
      }
      assets.push({
        path: file.relPath,
        name: path.posix.basename(file.relPath),
        kind,
        size: file.size,
        referenced,
        state: referenced ? "matched" : "unreferenced"
      });
    }
    assets.sort((a, b) => a.path.localeCompare(b.path));
  }

  const conflicts: ImportConflict[] = [];
  const draftId = typeof draft?.id === "string" ? draft.id : "";
  if (draftId) {
    const existing = await db
      .selectFrom("articles")
      .select(["id", "title", "updated_at", "revision"])
      .where("id", "=", draftId)
      .where("resource_type", "=", res)
      .executeTakeFirst();
    if (existing) {
      conflicts.push({
        id: existing.id,
        title: existing.title,
        updatedAt: iso(existing.updated_at),
        revision: existing.revision
      });
      warnings.push({
        code: "ID_CONFLICT",
        severity: "warning",
        message: `已存在同 ID 的内容（${existing.title}），要覆盖请显式使用更新模式`,
        path: selectedPath ?? undefined
      });
    }
  }

  const preview: ImportPreview = {
    importId: row.id,
    expiresAt: iso(row.expires_at),
    type: res,
    candidates,
    selectedPath,
    draft,
    unknownFrontmatter,
    assets,
    warnings,
    conflicts,
    committable: draft !== null && missingCount === 0,
    missingCount
  };
  return preview;
}

async function loadOwnedImport(db: Db, importId: string, actor: Actor): Promise<ImportRow> {
  const row = await selectImport(db, importId);
  if (!row || row.status === "deleted") throw errors.importExpired();
  if (row.user_id !== actor.userId) throw errors.forbidden("这个导入任务不属于当前账号");
  if (row.status !== "open") throw errors.importExpired();
  const expiresAt = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw errors.importExpired();
  return row;
}

async function persistAssetRows(db: Db, importId: string, assets: ImportAssetView[]): Promise<void> {
  await db.deleteFrom("import_assets").where("import_id", "=", importId).execute();
  if (assets.length === 0) return;
  await db
    .insertInto("import_assets")
    .values(
      assets.map(asset => ({
        import_id: importId,
        path: asset.path,
        name: asset.name,
        kind: asset.kind,
        size: asset.size,
        file_id: null,
        referenced: asset.referenced,
        state: asset.state,
        note: asset.note ?? null
      }))
    )
    .execute();
}

/** 预览：把上传的 md / zip 落到临时目录，解析 frontmatter 与资源引用。永不发布。 */
export async function createPreview(
  db: Db,
  actor: Actor,
  input: { data: Buffer; filename: string; res: ContentRes }
): Promise<ImportPreview> {
  const config = getContext().config;
  const originalName = sanitizeFileName(input.filename);
  const ext = extensionOf(originalName);
  const isZip = ext === "zip";
  if (!isZip && !MARKDOWN_EXTENSIONS.has(ext)) {
    throw errors.unsupportedType("只支持 .md / .markdown / .zip 文件");
  }
  if (input.data.byteLength > config.maxArchiveBytes) {
    throw errors.archiveTooLarge(`压缩包不能超过 ${Math.floor(config.maxArchiveBytes / 1024 / 1024)} MB`);
  }

  const importId = randomId(12);
  const tempDir = path.join(config.importRoot, importId);
  await mkdir(tempDir, { recursive: true });

  try {
    if (isZip) {
      const archivePath = path.join(tempDir, "source.zip");
      await writeFile(archivePath, input.data);
      const limits = {
        maxEntries: config.maxArchiveEntries,
        maxArchiveBytes: config.maxArchiveBytes,
        maxExpandedBytes: config.maxExpandedBytes,
        maxEntryBytes: Math.min(config.maxFileBytes, config.maxExpandedBytes),
        timeoutMs: config.importTimeoutMs
      };
      const entries = await listArchive(archivePath, limits);
      if (!entries.some(entry => MARKDOWN_EXTENSIONS.has(extensionOf(entry.path)))) {
        throw errors.entryUnreadable("压缩包里没有 .md 文件");
      }
      const contentDir = path.join(tempDir, "content");
      await mkdir(contentDir, { recursive: true });
      await extractArchive(archivePath, contentDir, limits);
    } else {
      const contentDir = path.join(tempDir, "content");
      await mkdir(contentDir, { recursive: true });
      await writeFile(path.join(contentDir, originalName), input.data);
    }

    const now = new Date();
    const expiresAt = addMinutes(now, config.importTtlMinutes);
    const row = await db
      .insertInto("imports")
      .values({
        id: importId,
        user_id: actor.userId,
        resource_type: input.res,
        original_name: originalName,
        archive_kind: isZip ? "zip" : "markdown",
        temp_dir: path.join(tempDir, "content"),
        selected_path: null,
        status: "open",
        expires_at: expiresAt,
        created_at: now,
        updated_at: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(db, {
      actorUserId: actor.userId,
      action: "import.preview",
      resourceType: "import",
      resourceId: importId,
      after: { originalName, res: input.res },
      ipHash: actor.ipHash
    });

    const preview = await computePreview(db, row, input.res);
    await persistAssetRows(db, importId, preview.assets);
    if (preview.selectedPath && preview.selectedPath !== row.selected_path) {
      await db.updateTable("imports").set({ selected_path: preview.selectedPath, updated_at: new Date() }).where("id", "=", importId).execute();
    }
    return preview;
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** 在多个候选 md 之间切换；重新计算资源状态。 */
export async function selectCandidate(
  db: Db,
  actor: Actor,
  importId: string,
  targetPath: string
): Promise<ImportPreview> {
  const row = await loadOwnedImport(db, importId, actor);
  const files = await walk(row.temp_dir);
  const normalized = normalizeRef(targetPath);
  const target = files.find(file => file.relPath === normalized || file.relPath === targetPath);
  if (!target) throw errors.notFound("这个 Markdown 不在导入包里");
  if (!MARKDOWN_EXTENSIONS.has(extensionOf(target.relPath))) {
    throw errors.validation([{ loc: ["body", "path"], msg: "只能选择 .md / .markdown 文件" }]);
  }
  await db
    .updateTable("imports")
    .set({ selected_path: target.relPath, updated_at: new Date() })
    .where("id", "=", importId)
    .execute();
  const preview = await computePreview(db, { ...row, selected_path: target.relPath }, row.resource_type);
  await persistAssetRows(db, importId, preview.assets);
  return preview;
}

function replaceRefs(body: string, mapping: Map<string, string>, markdownDir: string): string {
  const pattern = /(!?\[[^\]]*\]\(\s*<?)([^)\s>]+)(>?(?:\s+"[^"]*")?\s*\))/g;
  return body.replace(pattern, (whole, prefix: string, target: string, suffix: string) => {
    if (/^(https?:)?\/\//i.test(target) || target.startsWith("#") || target.startsWith("mailto:")) return whole;
    if (target.startsWith("asset:")) return whole;
    // 与预览同一个解析口径：先按 md 所在目录拼，再查映射。
    const key = normalizeRef(resolveLocalRef(markdownDir, target));
    const assetId = mapping.get(key);
    if (!assetId) return whole;
    return `${prefix}asset:${assetId}${suffix}`;
  });
}

/** 提交导入：按选中的 md 建/更新工作稿，引用的资源落成私密文件。永不自动发布。 */
export async function commitImport(
  db: Db,
  actor: Actor,
  importId: string,
  input: CommitInput
): Promise<{
  articleId: string;
  title: string;
  createdAssets: number;
  linkedAssets: number;
  preservedVersion: string | null;
}> {
  const config = getContext().config;
  // 事务回滚后这些行不存在，但磁盘上的私密文件已经写好了，必须在 catch 里清掉。
  const createdFiles: { visibility: "public" | "private"; storageKey: string }[] = [];
  return db.transaction().execute(async trx => {
    const row = await loadOwnedImport(trx, importId, actor);
    // 行锁 + 状态 CAS：并发提交时只有一个事务能把 open 行改成 committed，
    // 另一个在这里看到的受影响行数是 0，直接 IMPORT_EXPIRED。
    const locked = await trx
      .updateTable("imports")
      .set({ updated_at: new Date() })
      .where("id", "=", importId)
      .where("status", "=", "open")
      .executeTakeFirst();
    if (Number(locked?.numUpdatedRows ?? 0) !== 1) throw errors.importExpired();
    const res = row.resource_type;
    const preview = await computePreview(trx, row, res);
    if (!preview.selectedPath) {
      throw errors.validation([{ loc: ["body", "path"], msg: "请先选择要导入的 Markdown" }]);
    }
    if (preview.missingCount > 0) {
      throw errors.validation([
        { loc: ["body", "path"], msg: `正文引用了 ${preview.missingCount} 个找不到的资源，请先补齐压缩包` }
      ]);
    }

    const title = input.draft.title?.trim() ?? "";
    if (!title) {
      throw errors.validation([{ loc: ["body", "draft", "title"], msg: "标题不能为空" }]);
    }
    const body = input.draft.body ?? "";
    if (!body.trim()) {
      throw errors.validation([{ loc: ["body", "draft", "body"], msg: "正文不能为空" }]);
    }

    const includeUnreferenced = new Set((input.includeUnreferencedPaths ?? []).map(normalizeRef));
    const byPath = new Map(preview.assets.map(asset => [asset.path, asset]));

    const mapping = new Map<string, string>();
    let createdAssets = 0;
    const referencedIds: string[] = [];
    for (const assetPath of includeUnreferenced) {
      const asset = byPath.get(assetPath);
      if (!asset) {
        throw errors.validation([{ loc: ["body", "includeUnreferencedPaths"], msg: `${assetPath} 不在导入包里` }]);
      }
      if (asset.state !== "unreferenced" && asset.state !== "matched") {
        throw errors.validation([{ loc: ["body", "includeUnreferencedPaths"], msg: `${assetPath} 当前不可导入（${asset.state}）` }]);
      }
    }

    const toImport = preview.assets.filter(
      asset => (asset.referenced && asset.state === "matched") || includeUnreferenced.has(asset.path)
    );
    for (const asset of toImport) {
      const data = await readFile(path.join(row.temp_dir, asset.path));
      const created = await createFileRecord(trx, actor, {
        originalName: asset.name,
        displayName: asset.name,
        description: null,
        visibility: "private",
        data
      });
      mapping.set(asset.path, created.id);
      createdFiles.push({ visibility: "private", storageKey: storageKeyFor(created.id, created.ext) });
      createdAssets += 1;
      if (asset.referenced) referencedIds.push(created.id);
    }

    const markdownDir = path.posix.dirname(preview.selectedPath);
    const rewrittenBody = replaceRefs(body, mapping, markdownDir);

    let articleId: string;
    let preservedVersion: string | null = null;

    if (input.mode === "update") {
      const targetId = input.targetId?.trim();
      if (!targetId) {
        throw errors.validation([{ loc: ["body", "targetId"], msg: "更新模式必须提供 targetId" }]);
      }
      if (typeof input.baseRevision !== "number") {
        throw errors.validation([{ loc: ["body", "baseRevision"], msg: "更新模式必须提供 baseRevision" }]);
      }
      const current = await getArticleRow(trx, res, targetId, true);
      if (current.revision !== input.baseRevision) throw errors.revisionConflict(current.revision);
      const version = await insertVersion(trx, current, "import", actor.userId);
      preservedVersion = String(version);
      await trx
        .updateTable("articles")
        .set({
          title,
          body: rewrittenBody,
          summary: input.draft.summary ?? null,
          category: input.draft.category ?? null,
          tags: input.draft.tags ?? null,
          date: input.draft.date ?? current.date,
          updated: input.draft.updated ?? current.updated,
          mood: res === "essays" ? input.draft.mood ?? null : null,
          place: res === "essays" ? input.draft.place ?? null : null,
          revision: current.revision + 1,
          updated_at: new Date()
        })
        .where("id", "=", targetId)
        .execute();
      articleId = targetId;
    } else {
      const desiredId = (input.draft.id ?? preview.draft?.id ?? "").toString().trim();
      articleId = desiredId || slugify(title, res);
      assertValidId(articleId);
      const existing = await trx
        .selectFrom("articles")
        .select("id")
        .where("id", "=", articleId)
        .where("resource_type", "=", res)
        .executeTakeFirst();
      if (existing) throw errors.duplicateId();
      const now = new Date();
      await trx
        .insertInto("articles")
        .values({
          id: articleId,
          resource_type: res,
          title,
          body: rewrittenBody,
          summary: input.draft.summary ?? null,
          category: input.draft.category ?? null,
          tags: input.draft.tags ?? null,
          date: input.draft.date ?? null,
          updated: input.draft.updated ?? null,
          mood: res === "essays" ? input.draft.mood ?? null : null,
          place: res === "essays" ? input.draft.place ?? null : null,
          visibility: "private",
          status: "draft",
          revision: 1,
          created_at: now,
          updated_at: now,
          published_at: null,
          published_revision: null
        })
        .execute();
    }

    // 只给"正文真正引用"的资源登记引用：includeUnreferencedPaths 只是顺带打包，
    // 给它写 working 引用会让这个文件永远 409 FILE_IN_USE。
    await syncReferences(trx, { owner: res, targetId: articleId, usage: "working" }, referencedIds);

    await trx
      .updateTable("imports")
      .set({ status: "committed", updated_at: new Date() })
      .where("id", "=", importId)
      .execute();

    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "import.commit",
      resourceType: "article",
      resourceId: articleId,
      after: { mode: input.mode, createdAssets, title },
      ipHash: actor.ipHash
    });

    return {
      articleId,
      title,
      createdAssets,
      linkedAssets: referencedIds.length,
      preservedVersion
    };
  })
    .then(async result => {
      const row = await selectImport(db, importId);
      if (row?.temp_dir) {
        const tempDir = path.dirname(row.temp_dir);
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
      return result;
    })
    .catch(async error => {
      // 回滚路径：数据库里没有这些文件行，磁盘上的副本必须一起删掉，否则成了孤儿私密文件。
      await Promise.all(
        createdFiles.map(file =>
          removeStoredFile(config, file.visibility, file.storageKey).catch(() => undefined)
        )
      );
      throw error;
    });
}

/** 放弃导入：删临时目录；重复调用也返回成功。 */
export async function discardImport(db: Db, actor: Actor, importId: string): Promise<void> {
  const row = await selectImport(db, importId);
  if (!row) return;
  if (row.user_id !== actor.userId) throw errors.forbidden("这个导入任务不属于当前账号");
  await db
    .updateTable("imports")
    .set({ status: "deleted", updated_at: new Date() })
    .where("id", "=", importId)
    .execute();
  await rm(path.dirname(row.temp_dir), { recursive: true, force: true }).catch(() => undefined);
}

/** 清理过期导入的临时目录（由定时任务或启动时调用）。 */
export async function cleanupExpiredImports(db: Db): Promise<number> {
  const rows = await db
    .selectFrom("imports")
    .select(["id", "temp_dir"])
    .where("status", "=", "open")
    .where("expires_at", "<", new Date())
    .execute();
  for (const row of rows) {
    await rm(path.dirname(row.temp_dir), { recursive: true, force: true }).catch(() => undefined);
    await db.updateTable("imports").set({ status: "deleted", updated_at: new Date() }).where("id", "=", row.id).execute();
  }
  return rows.length;
}
