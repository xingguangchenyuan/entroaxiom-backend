import { sql } from "kysely";
import { pagedTotal, type Db } from "../db/index.js";
import { likePattern } from "../lib/sql-like.js";
import { getContext } from "../context.js";
import { errors } from "../http/errors.js";
import { dateOnly, iso, numberOrNull, publicUrlFor, tagsOrNull } from "../http/serialize.js";
import { assertValidId, isValidId, normalizeId } from "../lib/ids.js";
import { toDateOnly } from "../lib/time.js";
import { writeAudit, type Actor } from "./audit.js";
import { consumeCheck, createCheck } from "./checks.js";
import { getFileRow } from "./files.js";
import { syncReferences } from "./references.js";
import { type PendingCleanup, runCleanups } from "./storage-cleanup.js";
import {
  applyAssetDecisions,
  buildAssetDecisionViews,
  checkItem,
  loadAssets,
  resolvePublicUrl,
  type CheckItem
} from "./article-publish.js";

export type ShelfKind = "book" | "film" | "music";
export type ConsumeStatus = "done" | "doing" | "want";
export type Visibility = "public" | "private";

export interface ShelfDraftInput {
  id: string;
  kind: ShelfKind;
  title: string;
  creator: string | null;
  year: number | null;
  rating: number | null;
  status: ConsumeStatus;
  date: string | null;
  tags: string[] | null;
  quote: string | null;
  review: string | null;
  cover: string | null;
  link: string | null;
}

export interface ShelfFilters {
  keyword?: string;
  kind?: string;
  status?: string;
  publicationStatus?: string;
  visibility?: string;
}

export interface Paging {
  page: number;
  pageSize: number;
  offset: number;
}

const KINDS: ShelfKind[] = ["book", "film", "music"];
const STATUSES: ConsumeStatus[] = ["done", "doing", "want"];

type ShelfRow = Awaited<ReturnType<typeof selectShelf>>;

async function selectShelf(exec: Db, id: string, forUpdate = false) {
  let query = exec.selectFrom("shelf_items").selectAll().where("id", "=", id);
  if (forUpdate) query = query.forUpdate();
  return query.executeTakeFirst();
}

export async function getShelfRow(
  exec: Db,
  id: string,
  forUpdate = false
): Promise<NonNullable<ShelfRow>> {
  const row = await selectShelf(exec, id, forUpdate);
  if (!row) throw errors.notFound("书架条目不存在");
  return row;
}

export function clampRating(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const clamped = Math.min(5, Math.max(0, value));
  return Math.round(clamped * 2) / 2;
}

export function coverAssetId(cover: string | null): string | null {
  if (!cover) return null;
  const match = /^asset:([A-Za-z0-9_-]{4,64})$/.exec(cover.trim());
  return match ? match[1] : null;
}

export function validateShelfInput(input: ShelfDraftInput): ShelfDraftInput {
  if (!KINDS.includes(input.kind)) {
    throw errors.validation([{ loc: ["body", "kind"], msg: "kind 只能是 book / film / music" }]);
  }
  if (!STATUSES.includes(input.status)) {
    throw errors.validation([{ loc: ["body", "status"], msg: "status 只能是 done / doing / want" }]);
  }
  if (input.link && !/^https?:\/\//i.test(input.link)) {
    throw errors.validation([{ loc: ["body", "link"], msg: "链接必须是 http(s) 地址" }]);
  }
  if (input.cover && !coverAssetId(input.cover) && !/^https?:\/\//i.test(input.cover)) {
    throw errors.validation([{ loc: ["body", "cover"], msg: "封面必须是 asset:<fileId> 或 http(s) 地址" }]);
  }
  if (input.year !== null && (!Number.isInteger(input.year) || input.year < 0 || input.year > 3000)) {
    throw errors.validation([{ loc: ["body", "year"], msg: "年份不合法" }]);
  }
  return { ...input, rating: clampRating(input.rating) };
}

/**
 * 已发布条目换封面后重算公开地址：封面还是私密状态或已被删除时返回 null，
 * 前台就不显示封面，而不是继续指向一个 404 的旧图。
 */
async function republishedCoverUrl(exec: Db, cover: string | null): Promise<string | null> {
  const assetId = coverAssetId(cover);
  if (!assetId) return /^https?:\/\//i.test(cover ?? "") ? cover : null;
  const file = await exec
    .selectFrom("files")
    .select(["id", "ext", "visibility", "status", "deleted_at"])
    .where("id", "=", assetId)
    .executeTakeFirst();
  if (!file || file.deleted_at !== null || file.visibility !== "public" || file.status !== "ready") return null;
  return publicUrlFor({ id: file.id, ext: file.ext });
}

async function coverInfo(exec: Db, cover: string | null) {
  const assetId = coverAssetId(cover);
  if (!assetId) {
    return { visibility: null as Visibility | null, shared: false, url: /^https?:\/\//i.test(cover ?? "") ? cover : null };
  }
  const row = await exec
    .selectFrom("files")
    .select(["id", "ext", "visibility", "deleted_at", "status"])
    .where("id", "=", assetId)
    .executeTakeFirst();
  if (!row || row.deleted_at || row.status !== "ready") {
    return { visibility: null as Visibility | null, shared: false, url: null, missing: assetId };
  }
  const refs = await exec
    .selectFrom("file_references")
    .select(["owner", "target_id"])
    .where("file_id", "=", assetId)
    .where("usage", "!=", "cover")
    .execute();
  return {
    visibility: row.visibility,
    shared: refs.length > 0,
    url: row.visibility === "public" ? `/uploads/public/${row.id}.${row.ext}` : null
  };
}

export async function shelfView(exec: Db, row: NonNullable<ShelfRow>) {
  const cover = await coverInfo(exec, row.cover);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    creator: row.creator,
    year: row.year,
    rating: numberOrNull(row.rating),
    status: row.status,
    date: dateOnly(row.date),
    tags: tagsOrNull(row.tags),
    quote: row.quote,
    review: row.review,
    cover: row.cover,
    link: row.link,
    publicationStatus: row.publication_status,
    visibility: row.visibility,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    publishedAt: iso(row.published_at),
    publishedRevision: row.published_revision,
    coverVisibility: cover.visibility,
    coverShared: cover.shared,
    coverUrl: row.publication_status === "published" ? row.published_cover ?? cover.url : cover.url
  };
}

export async function listShelf(
  db: Db,
  filters: ShelfFilters,
  paging: Paging
): Promise<{ items: unknown[]; total: number }> {
  let query = db
    .selectFrom("shelf_items")
    .selectAll()
    .select(sql<string>`count(*) over ()`.as("total_count"));

  const keyword = filters.keyword?.trim();
  if (keyword) {
    const like = likePattern(keyword);
    query = query.where(eb =>
      eb.or([
        eb("title", "ilike", like),
        eb("creator", "ilike", like),
        eb("quote", "ilike", like),
        eb("review", "ilike", like)
      ])
    );
  }
  if (filters.kind && KINDS.includes(filters.kind as ShelfKind)) {
    query = query.where("kind", "=", filters.kind as ShelfKind);
  }
  if (filters.status && STATUSES.includes(filters.status as ConsumeStatus)) {
    query = query.where("status", "=", filters.status as ConsumeStatus);
  }
  if (filters.publicationStatus === "draft" || filters.publicationStatus === "published") {
    query = query.where("publication_status", "=", filters.publicationStatus);
  }
  if (filters.visibility === "public" || filters.visibility === "private") {
    query = query.where("visibility", "=", filters.visibility);
  }

  const rows = await query
    .orderBy("updated_at", "desc")
    .limit(paging.pageSize)
    .offset(paging.offset)
    .execute();
  const total = await pagedTotal(rows as Array<{ total_count: string }>, () => query.orderBy("updated_at", "desc").limit(1).execute());
  const items: unknown[] = [];
  for (const row of rows) items.push(await shelfView(db, row as NonNullable<ShelfRow>));
  return { items, total };
}

export async function getShelfView(db: Db, id: string): Promise<unknown> {
  return shelfView(db, await getShelfRow(db, id));
}

export async function createShelfItem(
  db: Db,
  actor: Actor,
  input: ShelfDraftInput
): Promise<unknown> {
  const data = validateShelfInput(input);
  const id = normalizeId(data.id);
  if (!isValidId(id)) throw errors.validation([{ loc: ["body", "id"], msg: "ID 不合法" }]);
  return db.transaction().execute(async trx => {
    const existing = await trx.selectFrom("shelf_items").select("id").where("id", "=", id).executeTakeFirst();
    if (existing) throw errors.duplicateId();
    const now = new Date();
    const row = await trx
      .insertInto("shelf_items")
      .values({
        id,
        kind: data.kind,
        title: data.title,
        creator: data.creator,
        year: data.year,
        rating: data.rating === null ? null : data.rating.toFixed(1),
        status: data.status,
        date: data.date ?? toDateOnly(now),
        tags: data.tags,
        quote: data.quote,
        review: data.review,
        cover: data.cover,
        link: data.link,
        publication_status: "draft",
        visibility: "private",
        cover_visibility: null,
        revision: 1,
        created_at: now,
        updated_at: now,
        published_at: null,
        published_revision: null,
        created_by: actor.userId
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const assetId = coverAssetId(data.cover);
    await syncReferences(
      trx,
      { owner: "shelf", targetId: id, usage: "cover" },
      assetId ? [assetId] : []
    );
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "shelf.create",
      resourceType: "shelf",
      resourceId: id,
      after: { title: row.title },
      ipHash: actor.ipHash
    });
    return shelfView(trx, row);
  });
}

export async function saveShelfItem(
  db: Db,
  actor: Actor,
  id: string,
  input: ShelfDraftInput & { baseRevision: number }
): Promise<unknown> {
  const data = validateShelfInput(input);
  return db.transaction().execute(async trx => {
    const current = await getShelfRow(trx, id, true);
    if (current.revision !== input.baseRevision) throw errors.revisionConflict(current.revision);

    const row = await trx
      .updateTable("shelf_items")
      .set({
        kind: data.kind,
        title: data.title,
        creator: data.creator,
        year: data.year,
        rating: data.rating === null ? null : data.rating.toFixed(1),
        status: data.status,
        date: data.date,
        tags: data.tags,
        quote: data.quote,
        review: data.review,
        cover: data.cover,
        link: data.link,
        revision: current.revision + 1,
        updated_at: new Date()
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    const assetId = coverAssetId(data.cover);
    await syncReferences(
      trx,
      { owner: "shelf", targetId: id, usage: "cover" },
      assetId ? [assetId] : []
    );
    // 已发布条目换封面：公开视图读的是 published_cover，不重算就会一直显示旧图。
    // 私有/已删的封面在这里被降级成 null，公开区宁可不显示封面也不裂图。
    const saved =
      row.publication_status === "published"
        ? await trx
            .updateTable("shelf_items")
            .set({ published_cover: await republishedCoverUrl(trx, data.cover) })
            .where("id", "=", id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : row;
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "shelf.save",
      resourceType: "shelf",
      resourceId: id,
      before: { title: current.title, revision: current.revision },
      after: { title: saved.title, revision: saved.revision },
      ipHash: actor.ipHash
    });
    return shelfView(trx, saved);
  });
}

export async function deleteShelfItem(
  db: Db,
  actor: Actor,
  id: string,
  baseRevision: number
): Promise<{ deleted: true }> {
  return db.transaction().execute(async trx => {
    const current = await getShelfRow(trx, id, true);
    if (current.revision !== baseRevision) throw errors.revisionConflict(current.revision);
    await trx.deleteFrom("file_references").where("owner", "=", "shelf").where("target_id", "=", id).execute();
    await trx.deleteFrom("shelf_items").where("id", "=", id).execute();
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "shelf.delete",
      resourceType: "shelf",
      resourceId: id,
      before: { title: current.title },
      ipHash: actor.ipHash
    });
    return { deleted: true as const };
  });
}

export async function checkShelfItem(
  db: Db,
  actor: Actor,
  id: string,
  input: { action: "publish" | "visibility"; baseRevision: number; targetVisibility: Visibility | null }
): Promise<unknown> {
  const row = await getShelfRow(db, id);
  if (row.revision !== input.baseRevision) throw errors.revisionConflict(row.revision);

  const checks: CheckItem[] = [];
  if (!row.title.trim()) checks.push(checkItem("MISSING_TITLE", "error", "标题不能为空"));
  if (!row.creator || !row.creator.trim()) {
    checks.push(checkItem("MISSING_CREATOR", "warning", "还没有填写作者 / 导演 / 音乐人"));
  }

  const assetId = coverAssetId(row.cover);
  const assets = [];
  if (assetId) {
    const { assets: loaded } = await loadAssets(db, `asset:${assetId}`);
    if (loaded.length === 0) {
      checks.push(checkItem("DANGLING_COVER", "error", "封面引用的文件已不存在", [assetId]));
    } else {
      assets.push(...loaded);
    }
  }
  const privateAssets = assets.filter(asset => asset.visibility === "private");
  if (privateAssets.length > 0) {
    checks.push(
      checkItem("PRIVATE_ASSET", "warning", "封面是私密文件，发布前需要决定处理方式", privateAssets.map(a => a.fileId))
    );
  }

  // 与文章发布共用同一套判断：排除本条目自身的 cover 引用，
  // 看这个文件是否还被其他未公开内容引用，据此给出「建议复制公开副本」的提示。
  const assetDecisions =
    input.action === "publish"
      ? await buildAssetDecisionViews(db, assets, { owner: "shelf", targetId: id })
      : [];

  const created = await createCheck(
    db,
    {
      userId: actor.userId,
      subjectType: "shelf",
      subjectId: id,
      action: input.action,
      targetVisibility: input.targetVisibility,
      baseRevision: input.baseRevision,
      privateAssetIds: privateAssets.map(asset => asset.fileId)
    },
    checks
  );

  return {
    checkId: created.checkId,
    expiresAt: iso(created.expiresAt),
    action: input.action,
    targetVisibility: input.targetVisibility,
    checks,
    assetDecisions,
    canProceed: checks.every(check => check.severity !== "error")
  };
}

export async function publishShelfItem(
  db: Db,
  actor: Actor,
  id: string,
  input: {
    baseRevision: number;
    checkId: string;
    assetDecisions?: Array<{ fileId: string; decision: string }>;
    targetVisibility?: Visibility | null;
  }
): Promise<unknown> {
  const { config, logger } = getContext();
  const createdFiles: PendingCleanup[] = [];
  let result: { view: unknown; cleanups: PendingCleanup[] };
  try {
    result = await db.transaction().execute(async trx => {
    const row = await getShelfRow(trx, id, true);
    if (row.revision !== input.baseRevision) throw errors.revisionConflict(row.revision);

    const assets = [];
    const assetId = coverAssetId(row.cover);
    if (assetId) {
      const { assets: loaded } = await loadAssets(trx, `asset:${assetId}`);
      assets.push(...loaded);
    }
    const privateIds = assets.filter(asset => asset.visibility === "private").map(a => a.fileId);

    await consumeCheck(trx, {
      userId: actor.userId,
      subjectType: "shelf",
      subjectId: id,
      action: "publish",
      targetVisibility: input.targetVisibility ?? null,
      baseRevision: input.baseRevision,
      privateAssetIds: privateIds,
      checkId: input.checkId
    });

    // 与文章发布共用同一套决策执行逻辑：非法决策/非封面文件/重复 fileId 都会 4xx，
    // 未给决策的私密封面一律按 keep-private 处理，绝不默认公开。
    const outcome = await applyAssetDecisions(trx, actor, assets, input.assetDecisions, {
      unknownFileMessage: fileId => `该文件不是本条目的封面：${fileId}`,
      onCreatedFile: (visibility, storageKey) =>
        createdFiles.push({ fileId: id, visibility, storageKey, operation: "shelf.publish" })
    });
    const resolved = outcome.resolved;

    const coverUrl = assetId ? resolvePublicUrl(resolved.get(assetId)) : /^https?:\/\//i.test(row.cover ?? "") ? row.cover : null;
    const nextRevision = row.revision + 1;
    const publishedAt = new Date();
    const visibility = input.targetVisibility ?? row.visibility;

    const updated = await trx
      .updateTable("shelf_items")
      .set({
        publication_status: "published",
        visibility,
        published_cover: coverUrl,
        cover_visibility: assetId ? (coverUrl ? "public" : "private") : null,
        published_at: publishedAt,
        published_revision: nextRevision,
        revision: nextRevision,
        updated_at: publishedAt
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    const publishedCoverId = assetId ? resolved.get(assetId)?.finalId : null;
    await syncReferences(
      trx,
      { owner: "shelf", targetId: id, usage: "published", version: nextRevision },
      publishedCoverId ? [publishedCoverId] : []
    );
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "shelf.publish",
      resourceType: "shelf",
      resourceId: id,
      before: { publicationStatus: row.publication_status, revision: row.revision },
      after: { publicationStatus: updated.publication_status, revision: updated.revision },
      ipHash: actor.ipHash
    });
    const view = await shelfView(trx, updated);
    return { view, cleanups: outcome.cleanups };
    });
  } catch (error) {
    // 事务回滚：决策过程复制出来的公开副本没有记录指向它，先清理再抛出。
    if (createdFiles.length > 0) await runCleanups(createdFiles, logger, config);
    throw error;
  }

  // make-public 的旧私密封面要在提交之后再删，否则回滚后记录会指向不存在的文件。
  if (result.cleanups.length > 0) await runCleanups(result.cleanups, logger, config);
  return result.view;
}

export async function changeShelfVisibility(
  db: Db,
  actor: Actor,
  id: string,
  input: { visibility: Visibility; baseRevision: number; checkId: string }
): Promise<unknown> {
  return db.transaction().execute(async trx => {
    const row = await getShelfRow(trx, id, true);
    if (row.revision !== input.baseRevision) throw errors.revisionConflict(row.revision);

    const assetId = coverAssetId(row.cover);
    const privateIds: string[] = [];
    if (assetId) {
      const { assets } = await loadAssets(trx, `asset:${assetId}`);
      privateIds.push(...assets.filter(asset => asset.visibility === "private").map(a => a.fileId));
    }

    await consumeCheck(trx, {
      userId: actor.userId,
      subjectType: "shelf",
      subjectId: id,
      action: "visibility",
      targetVisibility: input.visibility,
      baseRevision: input.baseRevision,
      privateAssetIds: privateIds,
      checkId: input.checkId
    });

    const updated = await trx
      .updateTable("shelf_items")
      .set({ visibility: input.visibility, revision: row.revision + 1, updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "shelf.visibility",
      resourceType: "shelf",
      resourceId: id,
      before: { visibility: row.visibility },
      after: { visibility: updated.visibility },
      ipHash: actor.ipHash
    });
    return shelfView(trx, updated);
  });
}

export async function unpublishShelfItem(
  db: Db,
  actor: Actor,
  id: string,
  baseRevision: number
): Promise<unknown> {
  return db.transaction().execute(async trx => {
    const row = await getShelfRow(trx, id, true);
    if (row.revision !== baseRevision) throw errors.revisionConflict(row.revision);
    const updated = await trx
      .updateTable("shelf_items")
      .set({ publication_status: "draft", published_cover: null, revision: row.revision + 1, updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .deleteFrom("file_references")
      .where("owner", "=", "shelf")
      .where("target_id", "=", id)
      .where("usage", "=", "published")
      .execute();
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "shelf.unpublish",
      resourceType: "shelf",
      resourceId: id,
      ipHash: actor.ipHash
    });
    return shelfView(trx, updated);
  });
}
