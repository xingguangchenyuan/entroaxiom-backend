import type { Db, Executor } from "../db/index.js";
import { publicUrlFor } from "../http/serialize.js";

export type RefOwner = "notes" | "essays" | "shelf";
export type RefUsage = "working" | "published" | "version" | "cover";

export interface RefScope {
  owner: RefOwner;
  targetId: string;
  usage: RefUsage;
  version?: number;
}

export interface FileReferenceView {
  usage: RefUsage;
  owner: RefOwner;
  targetId: string;
  title: string;
  version: number | null;
  isPublic: boolean;
}

/**
 * 重建某一份内容的引用集合（先删后插，天然幂等）：
 * 文件被引用过就不允许硬删除，这是"删文件 409 FILE_IN_USE"的唯一依据。
 */
export async function syncReferences(
  exec: Executor,
  scope: RefScope,
  fileIds: string[]
): Promise<void> {
  const version = scope.version ?? 0;
  // published 行按"整体替换"处理：发布时 target_version 是每次递增的 revision，
  // 若只删当前版本，历史发布留下的引用永远不会消失，文件就永久 409 FILE_IN_USE。
  // version / working / cover 是按版本隔离的，仍只删自己那一份。
  const removal = exec
    .deleteFrom("file_references")
    .where("owner", "=", scope.owner)
    .where("target_id", "=", scope.targetId)
    .where("usage", "=", scope.usage);
  await (scope.usage === "published" ? removal : removal.where("target_version", "=", version)).execute();

  const unique = [...new Set(fileIds)];
  if (unique.length === 0) return;

  const files = await exec
    .selectFrom("files")
    .select(["id", "visibility"])
    .where("id", "in", unique)
    .where("deleted_at", "is", null)
    .execute();
  const visibility = new Map(files.map(file => [file.id, file.visibility]));

  const rows = unique
    .filter(id => visibility.has(id))
    .map(id => ({
      file_id: id,
      usage: scope.usage,
      owner: scope.owner,
      target_id: scope.targetId,
      target_version: version,
      is_public: visibility.get(id) === "public",
      created_at: new Date(),
      updated_at: new Date()
    }));
  if (rows.length === 0) return;
  await exec.insertInto("file_references").values(rows).execute();
}

/** 文件转公开后，把引用行里的 is_public 一并更新，避免列表和快照说法不一致。 */
export async function markFileRefsPublic(exec: Executor, fileId: string): Promise<void> {
  await exec
    .updateTable("file_references")
    .set({ is_public: true, updated_at: new Date() })
    .where("file_id", "=", fileId)
    .execute();
}

export async function deleteReferences(exec: Executor, owner: RefOwner, targetId: string): Promise<void> {
  await exec
    .deleteFrom("file_references")
    .where("owner", "=", owner)
    .where("target_id", "=", targetId)
    .execute();
}

export async function referencedFileIds(exec: Executor, scope: RefScope): Promise<string[]> {
  const rows = await exec
    .selectFrom("file_references")
    .select("file_id")
    .where("owner", "=", scope.owner)
    .where("target_id", "=", scope.targetId)
    .where("usage", "=", scope.usage)
    .where("target_version", "=", scope.version ?? 0)
    .execute();
  return rows.map(row => row.file_id);
}

export async function countReferences(db: Db, fileId: string): Promise<number> {
  const row = await db
    .selectFrom("file_references")
    .select(eb => eb.fn.countAll<string>().as("count"))
    .where("file_id", "=", fileId)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/**
 * 列出文件被谁引用：标题在查询时从当前内容表里取，
 * 已删除的内容不会出现在这里（引用行会随内容一起删除）。
 */
export async function listReferencesForFile(db: Db, fileId: string): Promise<FileReferenceView[]> {
  const rows = await db
    .selectFrom("file_references")
    .select(["usage", "owner", "target_id", "target_version", "is_public"])
    .where("file_id", "=", fileId)
    .orderBy("owner")
    .orderBy("target_id")
    .orderBy("target_version")
    .execute();
  if (rows.length === 0) return [];

  const articleIds = rows.filter(row => row.owner !== "shelf").map(row => row.target_id);
  const shelfIds = rows.filter(row => row.owner === "shelf").map(row => row.target_id);
  const titles = new Map<string, string>();
  if (articleIds.length > 0) {
    const articles = await db
      .selectFrom("articles")
      .select(["id", "title"])
      .where("id", "in", [...new Set(articleIds)])
      .execute();
    for (const article of articles) titles.set(article.id, article.title);
  }
  if (shelfIds.length > 0) {
    const items = await db
      .selectFrom("shelf_items")
      .select(["id", "title"])
      .where("id", "in", [...new Set(shelfIds)])
      .execute();
    for (const item of items) titles.set(item.id, item.title);
  }

  return rows.map(row => ({
    usage: row.usage,
    owner: row.owner,
    targetId: row.target_id,
    title: titles.get(row.target_id) ?? row.target_id,
    version: row.usage === "working" ? null : row.target_version,
    isPublic: row.is_public
  }));
}

export interface ArticleAssetView {
  fileId: string;
  name: string;
  kind: string;
  size: number;
  visibility: string | null;
  usages: RefUsage[];
  publicSrc: string | null;
}

/** 文章详情里的资源清单：按文件聚合，标出被哪些用途引用。 */
export async function articleAssets(
  db: Db,
  owner: RefOwner,
  targetId: string
): Promise<ArticleAssetView[]> {
  const rows = await db
    .selectFrom("file_references")
    .innerJoin("files", "files.id", "file_references.file_id")
    .select([
      "files.id as file_id",
      "files.name as name",
      "files.kind as kind",
      "files.size as size",
      "files.ext as ext",
      "files.visibility as visibility",
      "file_references.usage as usage"
    ])
    .where("file_references.owner", "=", owner)
    .where("file_references.target_id", "=", targetId)
    .where("files.deleted_at", "is", null)
    .execute();

  const grouped = new Map<string, ArticleAssetView>();
  for (const row of rows) {
    const current = grouped.get(row.file_id);
    if (current) {
      if (!current.usages.includes(row.usage)) current.usages.push(row.usage);
      continue;
    }
    grouped.set(row.file_id, {
      fileId: row.file_id,
      name: row.name,
      kind: row.kind,
      size: Number(row.size),
      visibility: row.visibility,
      usages: [row.usage],
      publicSrc: row.visibility === "public" ? publicUrlFor({ id: row.file_id, ext: row.ext }) : null
    });
  }
  return [...grouped.values()];
}
