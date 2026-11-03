import type { Db } from "../db/index.js";
import { errors } from "../http/errors.js";
import { dateOnly, iso, publicUrlFor, tagsOrNull } from "../http/serialize.js";
import type { ContentRes } from "../db/types.js";

interface MetaShape {
  category?: string | null;
  tags?: string[] | null;
  date?: string | null;
  updated?: string | null;
  mood?: string | null;
  place?: string | null;
}

function publicMeta(raw: unknown): MetaShape {
  if (!raw || typeof raw !== "object") return {};
  return raw as MetaShape;
}

function articleBody(res: ContentRes, snapshot: { public_title: string; public_summary: string | null; public_body: string; public_meta: unknown; published_at: Date }, row: { id: string }) {
  const meta = publicMeta(snapshot.public_meta);
  const base = {
    id: row.id,
    title: snapshot.public_title,
    summary: snapshot.public_summary,
    category: meta.category ?? null,
    tags: tagsOrNull(meta.tags ?? null),
    date: meta.date ?? null,
    updated: meta.updated ?? null
  };
  return res === "essays"
    ? { ...base, mood: meta.mood ?? null, place: meta.place ?? null }
    : base;
}

/**
 * 公开列表只读已发布快照：快照里的正文已经把私密资源换成占位符，
 * 因此列表即使不带 body 也不会泄露任何私密文件名。
 */
export async function listPublicArticles(db: Db, res: ContentRes): Promise<unknown[]> {
  const rows = await db
    .selectFrom("articles")
    .leftJoin("published_article_snapshots", "published_article_snapshots.article_id", "articles.id")
    .select([
      "articles.id",
      "articles.title",
      "articles.summary",
      "articles.category",
      "articles.tags",
      "articles.date",
      "articles.updated",
      "articles.mood",
      "articles.place",
      "articles.updated_at",
      "published_article_snapshots.public_title",
      "published_article_snapshots.public_summary",
      "published_article_snapshots.public_body",
      "published_article_snapshots.public_meta",
      "published_article_snapshots.published_at"
    ])
    .where("articles.resource_type", "=", res)
    .where("articles.visibility", "=", "public")
    .where("articles.status", "=", "published")
    .orderBy("articles.updated_at", "desc")
    .execute();

  return rows.map(row => {
    if (row.public_body !== null && row.published_at !== null) {
      return articleBody(res, {
        public_title: row.public_title ?? row.title,
        public_summary: row.public_summary,
        public_body: row.public_body,
        public_meta: row.public_meta,
        published_at: row.published_at
      }, row);
    }
    const base = {
      id: row.id,
      title: row.title,
      summary: row.summary,
      category: row.category,
      tags: tagsOrNull(row.tags),
      date: dateOnly(row.date),
      updated: dateOnly(row.updated)
    };
    return res === "essays" ? { ...base, mood: row.mood, place: row.place } : base;
  });
}

/** 公开详情：正文取自已发布快照的 public_body，绝不返回工作稿。 */
export async function getPublicArticle(db: Db, res: ContentRes, id: string): Promise<unknown> {
  const row = await db
    .selectFrom("articles")
    .leftJoin("published_article_snapshots", "published_article_snapshots.article_id", "articles.id")
    .select([
      "articles.id",
      "articles.title",
      "articles.summary",
      "articles.category",
      "articles.tags",
      "articles.date",
      "articles.updated",
      "articles.mood",
      "articles.place",
      "published_article_snapshots.public_title",
      "published_article_snapshots.public_summary",
      "published_article_snapshots.public_body",
      "published_article_snapshots.public_meta",
      "published_article_snapshots.published_at"
    ])
    .where("articles.id", "=", id)
    .where("articles.resource_type", "=", res)
    .where("articles.visibility", "=", "public")
    .where("articles.status", "=", "published")
    .executeTakeFirst();

  if (!row || row.public_body === null || row.published_at === null) {
    throw errors.notFound("内容不存在");
  }
  const view = articleBody(res, {
    public_title: row.public_title ?? row.title,
    public_summary: row.public_summary,
    public_body: row.public_body,
    public_meta: row.public_meta,
    published_at: row.published_at
  }, row);
  return { ...view, body: row.public_body };
}

function publicFileView(row: {
  id: string;
  name: string;
  ext: string;
  kind: string;
  size: unknown;
  mime: string;
  description: string | null;
  updated_at: Date;
  status: string;
}) {
  const src = publicUrlFor({ id: row.id, ext: row.ext });
  return {
    id: row.id,
    name: row.name,
    ext: row.ext,
    kind: row.kind,
    size: Number(row.size),
    updatedAt: iso(row.updated_at),
    src,
    description: row.description,
    publicUrl: src,
    publicSrc: src,
    mime: row.mime,
    visible: true,
    status: row.status
  };
}

export async function listPublicFiles(db: Db): Promise<unknown[]> {
  const rows = await db
    .selectFrom("files")
    .select(["id", "name", "ext", "kind", "size", "mime", "description", "updated_at", "status"])
    .where("visibility", "=", "public")
    .where("status", "=", "ready")
    .where("deleted_at", "is", null)
    .orderBy("updated_at", "desc")
    .execute();
  return rows.map(publicFileView);
}

export async function getPublicFile(db: Db, id: string): Promise<unknown> {
  const row = await db
    .selectFrom("files")
    .select(["id", "name", "ext", "kind", "size", "mime", "description", "updated_at", "status"])
    .where("id", "=", id)
    .where("visibility", "=", "public")
    .where("status", "=", "ready")
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw errors.notFound("文件不存在或未公开");
  return publicFileView(row);
}

async function coverUrlFor(
  db: Db,
  row: {
    id: string;
    cover: string | null;
    cover_visibility: string | null;
    published_cover: string | null;
    publication_status: string;
  }
): Promise<string | null> {
  // 发布状态是 publication_status；row.status 是 done/doing/want 这种阅读状态。
  // 以前拿 status 判断，导致 published_cover 永远取不到，撤回后的旧封面还会漏出去。
  const cover =
    (row.publication_status === "published" ? row.published_cover : null) ?? row.cover;
  if (!cover) return null;
  if (!cover.startsWith("asset:")) {
    // 发布时写入的是站内相对地址（/uploads/public/...），不是 http(s) 绝对地址。
    if (cover.startsWith("/")) return cover;
    return /^https?:\/\//i.test(cover) ? cover : null;
  }
  const fileId = cover.slice("asset:".length);
  const file = await db
    .selectFrom("files")
    .select(["id", "ext"])
    .where("id", "=", fileId)
    .where("visibility", "=", "public")
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return file ? publicUrlFor(file) : null;
}

function shelfPublicView(row: {
  id: string;
  kind: string;
  title: string;
  creator: string | null;
  year: number | null;
  rating: string | number | null;
  status: string;
  date: string | null;
  tags: string[] | null;
  quote: string | null;
  review: string | null;
  link: string | null;
}, cover: string | null) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    creator: row.creator,
    year: row.year === null ? null : Number(row.year),
    rating: row.rating === null ? null : Number(row.rating),
    status: row.status,
    date: row.date,
    tags: tagsOrNull(row.tags),
    quote: row.quote,
    review: row.review,
    cover,
    link: row.link
  };
}

export async function listPublicShelf(db: Db): Promise<unknown[]> {
  const rows = await db
    .selectFrom("shelf_items")
    .selectAll()
    .where("publication_status", "=", "published")
    .where("visibility", "=", "public")
    .orderBy("updated_at", "desc")
    .execute();
  const items = [];
  for (const row of rows) {
    items.push(shelfPublicView(row, await coverUrlFor(db, row)));
  }
  return items;
}

export async function getPublicShelf(db: Db, id: string): Promise<unknown> {
  const row = await db
    .selectFrom("shelf_items")
    .selectAll()
    .where("id", "=", id)
    .where("publication_status", "=", "published")
    .where("visibility", "=", "public")
    .executeTakeFirst();
  if (!row) throw errors.notFound("收藏不存在");
  return shelfPublicView(row, await coverUrlFor(db, row));
}
