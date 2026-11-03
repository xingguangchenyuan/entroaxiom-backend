import { sql } from "kysely";
import type { Db } from "../db/index.js";
import { getContext } from "../context.js";
import { iso } from "../http/serialize.js";
import { hasUnpublishedChanges } from "./articles.js";
import { usedBytes } from "./storage.js";
import type { ContentRes } from "../db/types.js";

async function countRows(db: Db, table: "articles" | "shelf_items" | "files" | "guestbook", where?: (query: any) => any): Promise<number> {
  let query = db.selectFrom(table as never).select(db.fn.countAll<string>().as("count"));
  if (where) query = where(query);
  const row = await (query as any).executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function getDashboard(db: Db): Promise<unknown> {
  const config = getContext().config;

  const counts = await db
    .selectFrom("articles")
    .select([
      sql<string>`count(*) filter (where resource_type = 'essays')`.as("essays"),
      sql<string>`count(*) filter (where resource_type = 'notes')`.as("notes")
    ])
    .executeTakeFirst();

  const [shelf, files, blockedGuestbook, pendingGuestbook] = await Promise.all([
    countRows(db, "shelf_items"),
    countRows(db, "files", query => query.where("deleted_at", "is", null)),
    countRows(db, "guestbook", query => query.where("status", "=", "blocked")),
    countRows(db, "guestbook", query => query.where("status", "=", "pending"))
  ]);

  const recent = await db
    .selectFrom("articles")
    .select([
      "id",
      "resource_type",
      "title",
      "status",
      "revision",
      "published_revision",
      "updated_at"
    ])
    .orderBy("updated_at", "desc")
    .limit(6)
    .execute();

  const totalBytes = config.storageTotalBytes;
  const storage =
    totalBytes === null
      ? null
      : { usedBytes: await usedBytes(config), totalBytes };

  return {
    stats: {
      essays: Number(counts?.essays ?? 0),
      notes: Number(counts?.notes ?? 0),
      shelf,
      files,
      blockedGuestbook,
      pendingGuestbook
    },
    recentDrafts: recent.map(row => ({
      res: row.resource_type as ContentRes,
      id: row.id,
      title: row.title,
      updatedAt: iso(row.updated_at),
      status: row.status,
      hasUnpublishedChanges: hasUnpublishedChanges({
        status: row.status,
        revision: row.revision,
        published_revision: row.published_revision
      } as never)
    })),
    storage
  };
}

/** 分类与标签候选来自现有内容，不写死字典。 */
export async function getContentOptions(
  db: Db,
  res?: ContentRes
): Promise<{ categories: string[]; tags: string[] }> {
  let categoryQuery = db
    .selectFrom("articles")
    .select("category")
    .distinct()
    .where("category", "is not", null)
    .where("category", "!=", "");
  let tagQuery = db
    .selectFrom("articles")
    .select(sql<string>`unnest(tags)`.as("tag"))
    .where("tags", "is not", null);
  if (res) {
    categoryQuery = categoryQuery.where("resource_type", "=", res);
    tagQuery = tagQuery.where("resource_type", "=", res);
  }

  const [categoryRows, tagRows] = await Promise.all([
    categoryQuery.execute(),
    tagQuery.execute()
  ]);

  const categories = [...new Set(categoryRows.map(row => row.category).filter((value): value is string => Boolean(value)))].sort((a, b) =>
    a.localeCompare(b, "zh-Hans-CN")
  );
  const tags = [...new Set(tagRows.map(row => row.tag).filter((value): value is string => Boolean(value)))].sort((a, b) =>
    a.localeCompare(b, "zh-Hans-CN")
  );
  return { categories: categories.slice(0, 300), tags: tags.slice(0, 300) };
}
