import { sql } from "kysely";
import { pagedTotal, type Db } from "../db/index.js";
import { likePattern } from "../lib/sql-like.js";
import { getContext } from "../context.js";
import { errors } from "../http/errors.js";
import { iso } from "../http/serialize.js";
import { hmacSha256Hex, randomId } from "../lib/crypto.js";
import { toPlainExcerpt } from "../lib/markdown.js";
import { writeAudit, type Actor } from "./audit.js";
import { evaluateRules, type RuleMatch } from "./moderation.js";

export interface GuestSubmitInput {
  name: string;
  email: string | null;
  site: string | null;
  body: string;
  sigil: string | null;
}

export interface GuestbookFilters {
  keyword?: string;
  status?: string;
  replied?: boolean;
}

export interface Paging {
  page: number;
  pageSize: number;
  offset: number;
}

type GuestRow = Awaited<ReturnType<typeof selectGuest>>;

async function selectGuest(exec: Db, id: string, forUpdate = false) {
  let query = exec.selectFrom("guestbook").selectAll().where("id", "=", id);
  if (forUpdate) query = query.forUpdate();
  return query.executeTakeFirst();
}

export async function getGuestRow(
  exec: Db,
  id: string,
  forUpdate = false
): Promise<NonNullable<GuestRow>> {
  const row = await selectGuest(exec, id, forUpdate);
  if (!row) throw errors.notFound("留言不存在");
  return row;
}

async function replyOf(exec: Db, guestbookId: string) {
  const row = await exec
    .selectFrom("guestbook_replies")
    .select(["body", "created_at", "updated_at"])
    .where("guestbook_id", "=", guestbookId)
    .executeTakeFirst();
  if (!row) return null;
  return { body: row.body, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

async function evidenceOf(exec: Db, guestbookId: string) {
  const row = await exec
    .selectFrom("moderation_evidence")
    .select(["rule_id", "rule_text", "field", "reason", "policy_version", "matched_at"])
    .where("guestbook_id", "=", guestbookId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    ruleId: row.rule_id,
    ruleText: row.rule_text,
    field: row.field,
    reason: row.reason,
    policyVersion: row.policy_version,
    matchedAt: iso(row.matched_at)
  };
}

export async function guestbookMessageView(exec: Db, row: NonNullable<GuestRow>) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    site: row.site,
    body: row.body,
    sigil: row.sigil,
    status: row.status,
    reply: await replyOf(exec, row.id),
    evidence: await evidenceOf(exec, row.id),
    ipHash: row.ip_hash,
    createdAt: iso(row.created_at),
    revision: row.revision
  };
}

/**
 * 公开留言板的分页。只返回 approved：
 * blocked（被规则拦下）与 hidden（站长隐藏）都不可见，且绝不下发 email / IP / 证据。
 */
export async function publicGuestbookPage(
  db: Db,
  offset: number,
  limit: number
): Promise<{ items: unknown[]; total: number }> {
  const pageQuery = db
    .selectFrom("guestbook")
    .selectAll()
    .select(sql<string>`count(*) over ()`.as("total_count"))
    .where("status", "=", "approved");
  const rows = await pageQuery.orderBy("created_at", "desc").limit(limit).offset(offset).execute();

  const total = await pagedTotal(rows as Array<{ total_count: string }>, () => pageQuery.limit(1).execute());
  const items = [];
  for (const row of rows) {
    const reply = await replyOf(db, row.id);
    items.push({
      id: row.id,
      name: row.name,
      site: row.site,
      body: row.body,
      sigil: row.sigil,
      createdAt: iso(row.created_at),
      reply: reply ? { body: reply.body, createdAt: reply.createdAt } : null
    });
  }
  return { items, total };
}

/**
 * 留言落库：校验 → 规范化 → 规则匹配 → 写证据。
 * 命中规则的行存成 blocked，但对提交者一律回 pending，不给试探者任何反馈。
 */
export async function submitGuestMessage(
  db: Db,
  input: GuestSubmitInput,
  ip: string
): Promise<{ id: string; status: "pending" | "approved"; createdAt: string | null }> {
  const config = getContext().config;
  return db.transaction().execute(async trx => {
    const matches: RuleMatch[] = await evaluateRules(trx, input.name, input.body);
    const hit = matches[0] ?? null;
    const status = hit ? "blocked" : "approved";
    const id = randomId(8);
    const createdAt = new Date();

    const row = await trx
      .insertInto("guestbook")
      .values({
        id,
        name: input.name,
        email: input.email,
        site: input.site,
        body: input.body,
        sigil: input.sigil,
        status,
        ip_hash: hmacSha256Hex(config.ipHashSecret, ip),
        revision: 1,
        created_at: createdAt,
        updated_at: createdAt
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (hit) {
      await trx
        .insertInto("moderation_evidence")
        .values({
          guestbook_id: id,
          rule_id: hit.ruleId,
          rule_text: hit.text,
          field: hit.field,
          reason: `命中${hit.matchMode === "exact" ? "精确" : "包含"}规则：${hit.text}`,
          policy_version: config.moderationPolicyVersion,
          matched_at: createdAt
        })
        .execute();
    }

    await writeAudit(trx, {
      actorUserId: null,
      action: "guestbook.submit",
      resourceType: "guestbook",
      resourceId: id,
      after: { status, name: row.name },
      ipHash: hmacSha256Hex(config.ipHashSecret, ip)
    });

    return {
      id,
      status: status === "approved" ? ("approved" as const) : ("pending" as const),
      createdAt: iso(createdAt)
    };
  });
}

export async function listGuestbook(
  db: Db,
  filters: GuestbookFilters,
  paging: Paging
): Promise<{ items: unknown[]; total: number }> {
  let query = db
    .selectFrom("guestbook")
    .selectAll()
    .select(sql<string>`count(*) over ()`.as("total_count"));

  const keyword = filters.keyword?.trim();
  if (keyword) {
    const like = likePattern(keyword);
    query = query.where(eb => eb.or([eb("name", "ilike", like), eb("body", "ilike", like)]));
  }
  if (filters.status && ["approved", "blocked", "hidden", "pending"].includes(filters.status)) {
    query = query.where("status", "=", filters.status as "approved" | "blocked" | "hidden" | "pending");
  }
  if (filters.replied === true) {
    query = query.where(eb =>
      eb.exists(
        eb.selectFrom("guestbook_replies").select("guestbook_replies.guestbook_id").whereRef("guestbook_replies.guestbook_id", "=", "guestbook.id")
      )
    );
  } else if (filters.replied === false) {
    query = query.where(eb =>
      eb.not(
        eb.exists(
          eb.selectFrom("guestbook_replies").select("guestbook_replies.guestbook_id").whereRef("guestbook_replies.guestbook_id", "=", "guestbook.id")
        )
      )
    );
  }

  const rows = await query
    .orderBy("created_at", "desc")
    .limit(paging.pageSize)
    .offset(paging.offset)
    .execute();
  const total = await pagedTotal(rows as Array<{ total_count: string }>, () => query.orderBy("created_at", "desc").limit(1).execute());

  const items = [];
  for (const row of rows) {
    const reply = await replyOf(db, row.id);
    items.push({
      id: row.id,
      name: row.name,
      excerpt: toPlainExcerpt(row.body, 60),
      status: row.status,
      createdAt: iso(row.created_at),
      replied: reply !== null,
      sigil: row.sigil,
      site: row.site
    });
  }
  return { items, total };
}

export async function getGuestMessage(db: Db, id: string): Promise<unknown> {
  return guestbookMessageView(db, await getGuestRow(db, id));
}

export async function setGuestStatus(
  db: Db,
  actor: Actor,
  id: string,
  input: { status: "approved" | "hidden"; baseRevision: number }
): Promise<unknown> {
  return db.transaction().execute(async trx => {
    const current = await getGuestRow(trx, id, true);
    if (current.revision !== input.baseRevision) throw errors.revisionConflict(current.revision);
    const row = await trx
      .updateTable("guestbook")
      .set({ status: input.status, revision: current.revision + 1, updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "guestbook.status",
      resourceType: "guestbook",
      resourceId: id,
      before: { status: current.status },
      after: { status: row.status },
      ipHash: actor.ipHash
    });
    return guestbookMessageView(trx, row);
  });
}

export async function saveReply(
  db: Db,
  actor: Actor,
  id: string,
  input: { body: string; baseRevision: number }
): Promise<unknown> {
  return db.transaction().execute(async trx => {
    const current = await getGuestRow(trx, id, true);
    if (current.revision !== input.baseRevision) throw errors.revisionConflict(current.revision);

    const existing = await trx
      .selectFrom("guestbook_replies")
      .select("guestbook_id")
      .where("guestbook_id", "=", id)
      .executeTakeFirst();
    if (existing) {
      await trx
        .updateTable("guestbook_replies")
        .set({ body: input.body, updated_at: new Date() })
        .where("guestbook_id", "=", id)
        .execute();
    } else {
      await trx
        .insertInto("guestbook_replies")
        .values({
          guestbook_id: id,
          body: input.body,
          created_at: new Date(),
          updated_at: null,
          author_user_id: actor.userId
        })
        .execute();
    }

    const row = await trx
      .updateTable("guestbook")
      .set({ revision: current.revision + 1, updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "guestbook.reply",
      resourceType: "guestbook",
      resourceId: id,
      ipHash: actor.ipHash
    });
    return guestbookMessageView(trx, row);
  });
}

export async function deleteReply(
  db: Db,
  actor: Actor,
  id: string,
  baseRevision: number
): Promise<unknown> {
  return db.transaction().execute(async trx => {
    const current = await getGuestRow(trx, id, true);
    if (current.revision !== baseRevision) throw errors.revisionConflict(current.revision);
    await trx.deleteFrom("guestbook_replies").where("guestbook_id", "=", id).execute();
    const row = await trx
      .updateTable("guestbook")
      .set({ revision: current.revision + 1, updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "guestbook.reply.delete",
      resourceType: "guestbook",
      resourceId: id,
      ipHash: actor.ipHash
    });
    return guestbookMessageView(trx, row);
  });
}

export async function deleteGuestMessage(
  db: Db,
  actor: Actor,
  id: string,
  baseRevision: number
): Promise<{ deleted: true }> {
  return db.transaction().execute(async trx => {
    const current = await getGuestRow(trx, id, true);
    if (current.revision !== baseRevision) throw errors.revisionConflict(current.revision);
    await trx.deleteFrom("guestbook_replies").where("guestbook_id", "=", id).execute();
    await trx.deleteFrom("moderation_evidence").where("guestbook_id", "=", id).execute();
    await trx.deleteFrom("guestbook").where("id", "=", id).execute();
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "guestbook.delete",
      resourceType: "guestbook",
      resourceId: id,
      before: { name: current.name, status: current.status },
      ipHash: actor.ipHash
    });
    return { deleted: true as const };
  });
}
