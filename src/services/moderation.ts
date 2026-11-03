import { sql } from "kysely";
import { pagedTotal, type Db, type Executor } from "../db/index.js";
import { likePattern } from "../lib/sql-like.js";
import { getContext } from "../context.js";
import { errors } from "../http/errors.js";
import { iso } from "../http/serialize.js";
import { randomId } from "../lib/crypto.js";
import { writeAudit, type Actor } from "./audit.js";
import type { Paging } from "./guestbook.js";

export type MatchMode = "contains" | "exact";
export type MatchField = "name" | "body";

export interface RuleMatch {
  ruleId: string;
  text: string;
  matchMode: MatchMode;
  field: MatchField;
}

export interface RuleInput {
  text: string;
  matchMode: MatchMode;
  fields: MatchField[];
  category: string | null;
  enabled: boolean;
}

export const MATCH_MODES: MatchMode[] = ["contains", "exact"];
export const MATCH_FIELDS: MatchField[] = ["name", "body"];

/**
 * 只做规范化，不解释正则：NFKC 统一全角/兼容字符，转小写近似 case fold，
 * 空白折叠成一个空格。规则匹配永远基于规范化文本，落库保留原文。
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

type RuleRow = Awaited<ReturnType<typeof selectRule>>;

async function selectRule(exec: Db, id: string, forUpdate = false) {
  let query = exec.selectFrom("moderation_rules").selectAll().where("id", "=", id);
  if (forUpdate) query = query.forUpdate();
  return query.executeTakeFirst();
}

function ruleView(row: NonNullable<RuleRow>) {
  return {
    id: row.id,
    text: row.text,
    matchMode: row.match_mode,
    fields: row.fields,
    category: row.category,
    enabled: row.enabled,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

/** 按规则表顺序匹配，返回全部命中项（同一规则同一字段只算一次）。 */
export async function evaluateRules(
  exec: Executor,
  name: string,
  body: string
): Promise<RuleMatch[]> {
  const rules = await exec
    .selectFrom("moderation_rules")
    .selectAll()
    .where("enabled", "=", true)
    .orderBy("created_at", "asc")
    .execute();

  const normalized: Record<MatchField, string> = {
    name: normalizeText(name),
    body: normalizeText(body)
  };

  const matches: RuleMatch[] = [];
  for (const rule of rules) {
    const target = rule.normalized_text;
    if (!target) continue;
    for (const field of rule.fields as MatchField[]) {
      const value = normalized[field] ?? "";
      const hit =
        rule.match_mode === "exact" ? value === target : value.includes(target);
      if (hit) {
        matches.push({
          ruleId: rule.id,
          text: rule.text,
          matchMode: rule.match_mode,
          field
        });
      }
    }
  }
  return matches;
}

function validateRule(input: RuleInput): RuleInput {
  const text = input.text.trim();
  if (!text) throw errors.validation([{ loc: ["body", "text"], msg: "规则内容不能为空" }]);
  if ([...text].length > 200) {
    throw errors.validation([{ loc: ["body", "text"], msg: "规则内容最多 200 个字符" }]);
  }
  if (!MATCH_MODES.includes(input.matchMode)) {
    throw errors.validation([{ loc: ["body", "matchMode"], msg: "只能是 contains 或 exact" }]);
  }
  const fields = [...new Set(input.fields)].filter((field): field is MatchField =>
    MATCH_FIELDS.includes(field as MatchField)
  );
  if (fields.length === 0) {
    throw errors.validation([{ loc: ["body", "fields"], msg: "至少要选择一个匹配字段" }]);
  }
  return { text, matchMode: input.matchMode, fields, category: input.category, enabled: input.enabled };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export async function listRules(
  db: Db,
  filters: { keyword?: string; enabled?: boolean },
  paging: Paging
): Promise<{ items: unknown[]; total: number }> {
  let query = db
    .selectFrom("moderation_rules")
    .selectAll()
    .select(sql<string>`count(*) over ()`.as("total_count"));
  const keyword = filters.keyword?.trim();
  if (keyword) {
    const like = likePattern(keyword);
    query = query.where(eb => eb.or([eb("text", "ilike", like), eb("category", "ilike", like)]));
  }
  if (filters.enabled === true) query = query.where("enabled", "=", true);
  if (filters.enabled === false) query = query.where("enabled", "=", false);

  const rows = await query.orderBy("created_at", "asc").limit(paging.pageSize).offset(paging.offset).execute();
  const total = await pagedTotal(rows as Array<{ total_count: string }>, () => query.orderBy("created_at", "asc").limit(1).execute());
  return { items: rows.map(row => ruleView(row as NonNullable<RuleRow>)), total };
}

export async function createRule(db: Db, actor: Actor, input: RuleInput): Promise<unknown> {
  const data = validateRule(input);
  return db.transaction().execute(async trx => {
    try {
      const row = await trx
        .insertInto("moderation_rules")
        .values({
          id: randomId(8),
          text: data.text,
          normalized_text: normalizeText(data.text),
          match_mode: data.matchMode,
          fields: data.fields,
          category: data.category ?? "custom",
          enabled: data.enabled,
          revision: 1,
          created_at: new Date(),
          updated_at: new Date()
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        actorUserId: actor.userId,
        action: "moderation.rule.create",
        resourceType: "moderation_rule",
        resourceId: row.id,
        after: { text: row.text, matchMode: row.match_mode, fields: row.fields },
        ipHash: actor.ipHash
      });
      return ruleView(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.duplicateRule();
      throw error;
    }
  });
}

export async function updateRule(
  db: Db,
  actor: Actor,
  id: string,
  input: Partial<RuleInput> & { baseRevision: number }
): Promise<unknown> {
  return db.transaction().execute(async trx => {
    const current = await selectRule(trx, id, true);
    if (!current) throw errors.notFound("规则不存在");
    if (current.revision !== input.baseRevision) throw errors.revisionConflict(current.revision);

    const merged = validateRule({
      text: input.text ?? current.text,
      matchMode: (input.matchMode ?? current.match_mode) as MatchMode,
      fields: (input.fields ?? (current.fields as MatchField[])) as MatchField[],
      category: input.category === undefined ? current.category : input.category,
      enabled: input.enabled ?? current.enabled
    });

    try {
      const row = await trx
        .updateTable("moderation_rules")
        .set({
          text: merged.text,
          normalized_text: normalizeText(merged.text),
          match_mode: merged.matchMode,
          fields: merged.fields,
          category: merged.category ?? "custom",
          enabled: merged.enabled,
          revision: current.revision + 1,
          updated_at: new Date()
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        actorUserId: actor.userId,
        action: "moderation.rule.update",
        resourceType: "moderation_rule",
        resourceId: id,
        before: { text: current.text, enabled: current.enabled, revision: current.revision },
        after: { text: row.text, enabled: row.enabled, revision: row.revision },
        ipHash: actor.ipHash
      });
      return ruleView(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.duplicateRule();
      throw error;
    }
  });
}

export async function deleteRule(
  db: Db,
  actor: Actor,
  id: string,
  baseRevision: number
): Promise<{ deleted: true }> {
  return db.transaction().execute(async trx => {
    const current = await selectRule(trx, id, true);
    if (!current) throw errors.notFound("规则不存在");
    if (current.revision !== baseRevision) throw errors.revisionConflict(current.revision);
    await trx.deleteFrom("moderation_rules").where("id", "=", id).execute();
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "moderation.rule.delete",
      resourceType: "moderation_rule",
      resourceId: id,
      before: { text: current.text },
      ipHash: actor.ipHash
    });
    return { deleted: true as const };
  });
}

/** 规则试跑：只读，不落库，给站长确认"这条话会不会被拦"。 */
export async function testRules(
  db: Db,
  input: { name: string; body: string }
): Promise<unknown> {
  const config = getContext().config;
  const matches = await evaluateRules(db, input.name, input.body);
  return {
    allowed: matches.length === 0,
    matches,
    normalized: { name: normalizeText(input.name), body: normalizeText(input.body) },
    policyVersion: config.moderationPolicyVersion,
    note: matches.length === 0 ? "没有命中任何启用的规则" : "命中了规则，真实提交会被记为 blocked"
  };
}
