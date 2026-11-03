import type { FastifyInstance } from "fastify";
import { getContext } from "../../context.js";
import { ok } from "../../http/reply.js";
import { Input, parseIfMatch, parsePaging, pathId, queryBool, queryString } from "../../http/validation.js";
import {
  createRule,
  deleteRule,
  listRules,
  testRules,
  updateRule,
  type MatchField,
  type MatchMode
} from "../../services/moderation.js";
import { actorOf } from "./shared.js";

function readFields(input: Input): MatchField[] {
  const fields = input.strArray("fields", { required: true, maxItems: 2, label: "匹配字段" });
  return (fields ?? []).filter(
    (field): field is MatchField => field === "name" || field === "body"
  );
}

export async function registerAdminModerationRoutes(app: FastifyInstance): Promise<void> {
  const db = () => getContext().db;

  app.get<{ Querystring: Record<string, unknown> }>("/api/admin/moderation/rules", async (request, reply) => {
    const result = await listRules(
      db(),
      { keyword: queryString(request.query, "keyword"), enabled: queryBool(request.query, "enabled") },
      parsePaging(request.query)
    );
    return ok(reply, result);
  });

  app.post("/api/admin/moderation/rules", async (request, reply) => {
    const input = new Input(request.body);
    const text = input.str("text", { required: true, max: 200, label: "规则内容" });
    const matchMode = input.oneOf("matchMode", ["contains", "exact"], { default: "contains", label: "匹配方式" });
    const fields = readFields(input);
    const category = input.str("category", { max: 40, label: "分类" });
    const enabled = input.bool("enabled", { default: true, label: "启用" });
    input.finish();
    const created = await createRule(db(), actorOf(request), {
      text: text ?? "",
      matchMode: (matchMode ?? "contains") as MatchMode,
      fields,
      category,
      enabled: enabled !== false
    });
    return ok(reply, created, 201);
  });

  app.put<{ Params: { id: string } }>("/api/admin/moderation/rules/:id", async (request, reply) => {
    const id = pathId(request.params.id, "规则 ID");
    const input = new Input(request.body);
    const text = input.str("text", { max: 200, label: "规则内容" });
    const matchMode = input.oneOf("matchMode", ["contains", "exact"], { label: "匹配方式" });
    const fields = input.has("fields") ? readFields(input) : undefined;
    const category = input.str("category", { max: 40, label: "分类" });
    const enabled = input.bool("enabled", { label: "启用" });
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    input.finish();
    const updated = await updateRule(db(), actorOf(request), id, {
      text: text ?? undefined,
      matchMode: (matchMode ?? undefined) as MatchMode | undefined,
      fields,
      category,
      enabled: enabled ?? undefined,
      baseRevision: baseRevision ?? 0
    });
    return ok(reply, updated);
  });

  app.delete<{ Params: { id: string } }>("/api/admin/moderation/rules/:id", async (request, reply) => {
    const id = pathId(request.params.id, "规则 ID");
    const baseRevision = parseIfMatch(request.headers["if-match"]);
    return ok(reply, await deleteRule(db(), actorOf(request), id, baseRevision));
  });

  app.post("/api/admin/moderation/test", async (request, reply) => {
    const input = new Input(request.body);
    const name = input.str("name", { max: 200, label: "称呼" });
    const body = input.str("body", { max: 2000, label: "留言" });
    input.finish();
    return ok(reply, await testRules(db(), { name: name ?? "", body: body ?? "" }));
  });
}
