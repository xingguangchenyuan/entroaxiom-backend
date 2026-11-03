import { sql } from "kysely";
import { pagedTotal, type Db, type Executor } from "../db/index.js";
import { likePattern } from "../lib/sql-like.js";
import type { ContentRes } from "../db/types.js";
import { getContext } from "../context.js";
import { errors } from "../http/errors.js";
import { dateOnly, iso, tagsOrNull } from "../http/serialize.js";
import { charCount, extractAssetIds } from "../lib/markdown.js";
import { toDateOnly } from "../lib/time.js";
import { writeAudit, type Actor } from "./audit.js";
import { articleAssets, deleteReferences, syncReferences } from "./references.js";

export interface DraftFields {
  title: string;
  body: string;
  summary: string | null;
  category: string | null;
  tags: string[] | null;
  date: string | null;
  updated: string | null;
  mood: string | null;
  place: string | null;
}

export interface ArticleFilters {
  keyword?: string;
  status?: string;
  visibility?: string;
  category?: string;
  tag?: string;
  hasUnpublishedChanges?: boolean;
}

export interface Paging {
  page: number;
  pageSize: number;
  offset: number;
}

const MAX_TITLE = 200;
const MAX_SUMMARY = 500;

type ArticleRow = Awaited<ReturnType<typeof selectArticle>>;

async function selectArticle(exec: Db, res: ContentRes, id: string, forUpdate: boolean) {
  let query = exec
    .selectFrom("articles")
    .selectAll()
    .where("id", "=", id)
    .where("resource_type", "=", res);
  if (forUpdate) query = query.forUpdate();
  return query.executeTakeFirst();
}

export async function getArticleRow(
  exec: Db,
  res: ContentRes,
  id: string,
  forUpdate = false
): Promise<NonNullable<ArticleRow>> {
  const row = await selectArticle(exec, res, id, forUpdate);
  if (!row) throw errors.notFound("内容不存在");
  return row;
}

export function hasUnpublishedChanges(row: {
  status: string;
  revision: number;
  published_revision: number | null;
}): boolean {
  return row.status !== "published" || row.published_revision !== row.revision;
}

function metaView(row: NonNullable<ArticleRow>) {
  const base = {
    title: row.title,
    summary: row.summary,
    category: row.category,
    tags: tagsOrNull(row.tags),
    date: dateOnly(row.date),
    updated: dateOnly(row.updated)
  };
  if (row.resource_type === "essays") {
    return { ...base, mood: row.mood, place: row.place };
  }
  return base;
}

export function draftView(row: NonNullable<ArticleRow>) {
  return { id: row.id, body: row.body, ...metaView(row) };
}

export function listItemView(row: NonNullable<ArticleRow>) {
  return {
    id: row.id,
    ...metaView(row),
    visibility: row.visibility,
    status: row.status,
    hasUnpublishedChanges: hasUnpublishedChanges(row),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    publishedAt: iso(row.published_at),
    publishedRevision: row.published_revision,
    charCount: charCount(row.body)
  };
}

export async function detailView(exec: Db, row: NonNullable<ArticleRow>) {
  const assets = await articleAssets(exec, row.resource_type, row.id);
  return {
    ...draftView(row),
    visibility: row.visibility,
    status: row.status,
    hasUnpublishedChanges: hasUnpublishedChanges(row),
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    publishedAt: iso(row.published_at),
    publishedRevision: row.published_revision,
    assets
  };
}

function validateDraft(input: DraftFields): void {
  if (charCount(input.title) > MAX_TITLE) {
    throw errors.validation([{ loc: ["body", "title"], msg: `标题最多 ${MAX_TITLE} 个字符` }]);
  }
  if (input.summary && charCount(input.summary) > MAX_SUMMARY) {
    throw errors.validation([{ loc: ["body", "summary"], msg: `摘要最多 ${MAX_SUMMARY} 个字符` }]);
  }
}

export async function listArticles(
  db: Db,
  res: ContentRes,
  filters: ArticleFilters,
  paging: Paging
): Promise<{ items: unknown[]; total: number }> {
  let query = db
    .selectFrom("articles")
    .selectAll()
    .select(sql<string>`count(*) over ()`.as("total_count"))
    .where("resource_type", "=", res);

  const keyword = filters.keyword?.trim();
  if (keyword) {
    const like = likePattern(keyword);
    query = query.where(eb =>
      eb.or([eb("title", "ilike", like), eb("summary", "ilike", like), eb("id", "ilike", like)])
    );
  }
  if (filters.status === "draft" || filters.status === "published") {
    query = query.where("status", "=", filters.status);
  }
  if (filters.visibility === "public" || filters.visibility === "private") {
    query = query.where("visibility", "=", filters.visibility);
  }
  if (filters.category) query = query.where("category", "=", filters.category);
  if (filters.tag) query = query.where(sql<boolean>`${filters.tag} = any(tags)`);
  if (filters.hasUnpublishedChanges === true) {
    query = query.where(eb =>
      eb.or([eb("published_revision", "is", null), eb("published_revision", "!=", eb.ref("revision"))])
    );
  } else if (filters.hasUnpublishedChanges === false) {
    query = query.whereRef("published_revision", "=", "revision");
  }

  const rows = await query
    .orderBy("updated_at", "desc")
    .limit(paging.pageSize)
    .offset(paging.offset)
    .execute();

  const total = await pagedTotal(rows as Array<{ total_count: string }>, () =>
    query.orderBy("updated_at", "desc").limit(1).execute()
  );
  return { items: rows.map(row => listItemView(row as NonNullable<ArticleRow>)), total };
}

export async function createArticle(
  db: Db,
  actor: Actor,
  res: ContentRes,
  input: DraftFields,
  id: string
): Promise<unknown> {
  validateDraft(input);
  return db.transaction().execute(async trx => {
    const existing = await trx
      .selectFrom("articles")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (existing) throw errors.duplicateId();

    const now = new Date();
    const row = await trx
      .insertInto("articles")
      .values({
        id,
        resource_type: res,
        title: input.title,
        body: input.body,
        summary: input.summary,
        category: input.category,
        tags: input.tags,
        date: input.date ?? toDateOnly(now),
        updated: input.updated ?? toDateOnly(now),
        mood: res === "essays" ? input.mood : null,
        place: res === "essays" ? input.place : null,
        visibility: "private",
        status: "draft",
        revision: 1,
        created_at: now,
        updated_at: now,
        published_at: null,
        published_revision: null,
        created_by: actor.userId
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await syncReferences(
      trx,
      { owner: res, targetId: id, usage: "working" },
      extractAssetIds(row.body)
    );
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "article.create",
      resourceType: res,
      resourceId: id,
      after: { title: row.title, revision: row.revision },
      ipHash: actor.ipHash
    });
    return detailView(trx, row);
  });
}

export async function saveArticle(
  db: Db,
  actor: Actor,
  res: ContentRes,
  id: string,
  input: DraftFields & { baseRevision: number; saveMode: "auto" | "manual" }
): Promise<unknown> {
  validateDraft(input);
  return db.transaction().execute(async trx => {
    const current = await getArticleRow(trx, res, id, true);
    if (current.revision !== input.baseRevision) {
      throw errors.revisionConflict(current.revision);
    }
    const row = await trx
      .updateTable("articles")
      .set({
        title: input.title,
        body: input.body,
        summary: input.summary,
        category: input.category,
        tags: input.tags,
        date: input.date,
        updated: input.updated,
        mood: res === "essays" ? input.mood : null,
        place: res === "essays" ? input.place : null,
        revision: current.revision + 1,
        updated_at: new Date()
      })
      .where("id", "=", id)
      .where("revision", "=", current.revision)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw errors.revisionConflict(current.revision);

    if (input.saveMode === "manual") {
      await insertVersion(trx, row, "manual", actor.userId);
    }
    await syncReferences(
      trx,
      { owner: res, targetId: id, usage: "working" },
      extractAssetIds(row.body)
    );
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: input.saveMode === "manual" ? "article.save" : "article.autosave",
      resourceType: res,
      resourceId: id,
      before: { title: current.title, revision: current.revision },
      after: { title: row.title, revision: row.revision },
      ipHash: actor.ipHash
    });
    return detailView(trx, row);
  });
}

export async function deleteArticle(
  db: Db,
  actor: Actor,
  res: ContentRes,
  id: string,
  baseRevision: number
): Promise<{ deleted: true }> {
  return db.transaction().execute(async trx => {
    const current = await getArticleRow(trx, res, id, true);
    if (current.revision !== baseRevision) throw errors.revisionConflict(current.revision);

    await deleteReferences(trx, res, id);
    await trx.deleteFrom("article_versions").where("article_id", "=", id).execute();
    await trx.deleteFrom("published_article_snapshots").where("article_id", "=", id).execute();
    await trx.deleteFrom("articles").where("id", "=", id).execute();
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "article.delete",
      resourceType: res,
      resourceId: id,
      before: { title: current.title, revision: current.revision },
      ipHash: actor.ipHash
    });
    return { deleted: true as const };
  });
}

export async function insertVersion(
  exec: Db,
  row: NonNullable<ArticleRow>,
  source: "manual" | "publish" | "import" | "restore",
  createdBy: string | null,
  options: { skipIfSame?: boolean } = {}
): Promise<number> {
  const current = await exec
    .selectFrom("article_versions")
    .selectAll()
    .where("article_id", "=", row.id)
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
  const nextVersion = Number(current?.version ?? 0) + 1;

  // 同一个动作连点两次（比如「更新发布」点重了）不该在历史里留下两条一模一样的版本；
  // 但「手动保存」之后紧接着发布仍要各留一份，所以来源也要相同才算重复。
  if (
    options.skipIfSame &&
    current &&
    current.source === source &&
    current.title === row.title &&
    current.body === row.body &&
    (current.summary ?? null) === (row.summary ?? null)
  ) {
    return current.version;
  }

  await exec
    .insertInto("article_versions")
    .values({
      article_id: row.id,
      version: nextVersion,
      source,
      title: row.title,
      body: row.body,
      summary: row.summary,
      category: row.category,
      tags: row.tags,
      date: row.date,
      updated: row.updated,
      mood: row.mood,
      place: row.place,
      size: charCount(row.body),
      created_by: createdBy,
      created_at: new Date()
    })
    .execute();

  await syncReferences(
    exec,
    { owner: row.resource_type, targetId: row.id, usage: "version", version: nextVersion },
    extractAssetIds(row.body)
  );

  const retention = getContext().config.versionRetention;
  const stale = await exec
    .selectFrom("article_versions")
    .select("version")
    .where("article_id", "=", row.id)
    .orderBy("version", "desc")
    .offset(retention)
    .execute();
  for (const item of stale) {
    await exec
      .deleteFrom("file_references")
      .where("owner", "=", row.resource_type)
      .where("target_id", "=", row.id)
      .where("usage", "=", "version")
      .where("target_version", "=", item.version)
      .execute();
    await exec
      .deleteFrom("article_versions")
      .where("article_id", "=", row.id)
      .where("version", "=", item.version)
      .execute();
  }
  return nextVersion;
}

export async function listVersions(
  db: Db,
  res: ContentRes,
  id: string,
  paging: Paging
): Promise<unknown[]> {
  await getArticleRow(db, res, id);
  const rows = await db
    .selectFrom("article_versions")
    .select(["version", "source", "title", "summary", "size", "created_at"])
    .where("article_id", "=", id)
    .orderBy("version", "desc")
    .limit(paging.pageSize)
    .offset(paging.offset)
    .execute();
  return rows.map(row => ({
    versionId: String(row.version),
    version: row.version,
    source: row.source,
    createdAt: iso(row.created_at),
    title: row.title,
    summary: row.summary,
    size: row.size === null ? null : Number(row.size)
  }));
}

function parseVersionId(versionId: string): number {
  const parsed = Number.parseInt(versionId, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== versionId.trim()) {
    throw errors.validation([{ loc: ["path", "versionId"], msg: "版本号不合法" }]);
  }
  return parsed;
}

export async function getVersion(
  db: Db,
  res: ContentRes,
  id: string,
  versionId: string
): Promise<unknown> {
  const row = await getArticleRow(db, res, id);
  const version = parseVersionId(versionId);
  const found = await db
    .selectFrom("article_versions")
    .selectAll()
    .where("article_id", "=", id)
    .where("version", "=", version)
    .executeTakeFirst();
  if (!found) throw errors.notFound("版本不存在");
  const base = {
    versionId: String(found.version),
    version: found.version,
    source: found.source,
    createdAt: iso(found.created_at),
    title: found.title,
    summary: found.summary,
    category: found.category,
    tags: tagsOrNull(found.tags),
    date: dateOnly(found.date),
    updated: dateOnly(found.updated),
    body: found.body
  };
  if (row.resource_type === "essays") {
    return { ...base, mood: found.mood, place: found.place };
  }
  return base;
}

export async function restoreVersion(
  db: Db,
  actor: Actor,
  res: ContentRes,
  id: string,
  versionId: string,
  baseRevision: number
): Promise<unknown> {
  return db.transaction().execute(async trx => {
    const current = await getArticleRow(trx, res, id, true);
    if (current.revision !== baseRevision) throw errors.revisionConflict(current.revision);

    const version = parseVersionId(versionId);
    const found = await trx
      .selectFrom("article_versions")
      .selectAll()
      .where("article_id", "=", id)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!found) throw errors.notFound("版本不存在");

    const preserved = await insertVersion(trx, current, "restore", actor.userId);
    const row = await trx
      .updateTable("articles")
      .set({
        title: found.title,
        body: found.body,
        summary: found.summary,
        category: found.category,
        tags: found.tags,
        date: found.date,
        updated: found.updated,
        mood: found.mood,
        place: found.place,
        revision: current.revision + 1,
        updated_at: new Date()
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await syncReferences(
      trx,
      { owner: res, targetId: id, usage: "working" },
      extractAssetIds(row.body)
    );
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "article.restore",
      resourceType: res,
      resourceId: id,
      before: { revision: current.revision },
      after: { revision: row.revision, restoredFrom: version },
      ipHash: actor.ipHash
    });
    return { article: await detailView(trx, row), preservedVersion: String(preserved) };
  });
}

export async function getPublishedView(
  db: Db,
  res: ContentRes,
  id: string
): Promise<unknown> {
  const row = await getArticleRow(db, res, id);
  if (row.status !== "published") throw errors.notPublished();
  const snapshot = await db
    .selectFrom("published_article_snapshots")
    .selectAll()
    .where("article_id", "=", id)
    .executeTakeFirst();
  if (!snapshot) throw errors.notPublished();

  const meta = (snapshot.public_meta ?? {}) as Record<string, unknown>;
  const assets = await articleAssets(db, res, id);
  const base = {
    id: row.id,
    title: snapshot.public_title,
    summary: snapshot.public_summary,
    category: (meta.category as string | null) ?? null,
    tags: (meta.tags as string[] | null) ?? null,
    date: (meta.date as string | null) ?? null,
    updated: (meta.updated as string | null) ?? null,
    body: snapshot.public_body,
    visibility: row.visibility,
    publishedAt: iso(snapshot.published_at),
    publishedRevision: snapshot.published_revision,
    assets
  };
  if (res === "essays") {
    return { ...base, mood: (meta.mood as string | null) ?? null, place: (meta.place as string | null) ?? null };
  }
  return base;
}

export type { ArticleRow };

