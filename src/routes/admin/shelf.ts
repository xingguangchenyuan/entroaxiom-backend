import type { FastifyInstance } from "fastify";
import { getContext } from "../../context.js";
import { errors } from "../../http/errors.js";
import { ok } from "../../http/reply.js";
import { Input, parseIfMatch, parsePaging, pathId, queryString } from "../../http/validation.js";
import { assertValidId, slugify } from "../../lib/ids.js";
import {
  changeShelfVisibility,
  checkShelfItem,
  createShelfItem,
  deleteShelfItem,
  getShelfView,
  listShelf,
  publishShelfItem,
  saveShelfItem,
  unpublishShelfItem,
  type ConsumeStatus,
  type ShelfDraftInput,
  type ShelfKind
} from "../../services/shelf.js";
import { actorOf } from "./shared.js";

function readShelfDraft(input: Input): ShelfDraftInput {
  const id = input.str("id", { max: 80, label: "ID" });
  const kind = input.oneOf("kind", ["book", "film", "music"], { required: true, label: "类型" });
  const title = input.str("title", { required: true, max: 200, label: "标题" });
  const creator = input.str("creator", { max: 120, label: "作者" });
  const year = input.int("year", { min: 0, max: 3000, label: "年份" });
  const rating = input.float("rating", { min: 0, max: 5, label: "评分" });
  const status = input.oneOf("status", ["done", "doing", "want"], { default: "done", label: "状态" });
  const date = input.dateOnly("date", { label: "日期" });
  const tags = input.strArray("tags", { maxItems: 20, maxLength: 30, label: "标签" });
  const quote = input.str("quote", { max: 300, label: "摘录" });
  const review = input.str("review", { max: 5000, label: "短评" });
  const cover = input.str("cover", { max: 300, label: "封面" });
  const link = input.httpUrl("link", { max: 500, label: "链接" });
  input.finish();

  return {
    id: id ?? slugify(title ?? "", "shelf"),
    kind: (kind ?? "book") as ShelfKind,
    title: title ?? "",
    creator,
    year,
    rating,
    status: (status ?? "done") as ConsumeStatus,
    date,
    tags: tags && tags.length > 0 ? tags : null,
    quote,
    review,
    cover,
    link
  };
}

function readDecisions(input: Input): Array<{ fileId: string; decision: string }> {
  const raw = input.raw("assetDecisions");
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw errors.validation([{ loc: ["body", "assetDecisions"], msg: "必须是数组" }]);
  }
  return raw.map((item, index) => {
    const entry = item as { fileId?: unknown; decision?: unknown };
    if (typeof entry?.fileId !== "string" || typeof entry?.decision !== "string") {
      throw errors.validation([{ loc: ["body", "assetDecisions", index], msg: "需要 fileId 与 decision" }]);
    }
    return { fileId: entry.fileId, decision: entry.decision };
  });
}

export async function registerAdminShelfRoutes(app: FastifyInstance): Promise<void> {
  const db = () => getContext().db;

  app.get<{ Querystring: Record<string, unknown> }>("/api/admin/shelf", async (request, reply) => {
    const result = await listShelf(
      db(),
      {
        keyword: queryString(request.query, "keyword"),
        kind: queryString(request.query, "kind"),
        status: queryString(request.query, "status"),
        publicationStatus: queryString(request.query, "publicationStatus"),
        visibility: queryString(request.query, "visibility")
      },
      parsePaging(request.query)
    );
    return ok(reply, result);
  });

  app.get<{ Params: { id: string } }>("/api/admin/shelf/:id", async (request, reply) => {
    const id = pathId(request.params.id, "条目 ID");
    return ok(reply, await getShelfView(db(), id));
  });

  app.post("/api/admin/shelf", async (request, reply) => {
    const input = new Input(request.body);
    const draft = readShelfDraft(input);
    try {
      assertValidId(draft.id);
    } catch {
      throw errors.validation([
        { loc: ["body", "id"], msg: "ID 只能包含字母、数字、.、_、-，且以字母或数字开头，最长 80 个字符" }
      ]);
    }
    return ok(reply, await createShelfItem(db(), actorOf(request), draft), 201);
  });

  app.put<{ Params: { id: string } }>("/api/admin/shelf/:id", async (request, reply) => {
    const id = pathId(request.params.id, "条目 ID");
    const input = new Input(request.body);
    const draft = readShelfDraft(input);
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    input.finish();
    const saved = await saveShelfItem(db(), actorOf(request), id, {
      ...draft,
      id,
      baseRevision: baseRevision ?? 0
    });
    return ok(reply, saved);
  });

  app.patch<{ Params: { id: string } }>("/api/admin/shelf/:id/visibility", async (request, reply) => {
    const id = pathId(request.params.id, "条目 ID");
    const input = new Input(request.body);
    const visibility = input.oneOf("visibility", ["public", "private"], { required: true, label: "可见范围" });
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    const checkId = input.str("checkId", { required: true, label: "checkId" });
    input.finish();
    const updated = await changeShelfVisibility(db(), actorOf(request), id, {
      visibility: visibility === "public" ? "public" : "private",
      baseRevision: baseRevision ?? 0,
      checkId: checkId ?? ""
    });
    return ok(reply, updated);
  });

  app.delete<{ Params: { id: string } }>("/api/admin/shelf/:id", async (request, reply) => {
    const id = pathId(request.params.id, "条目 ID");
    const baseRevision = parseIfMatch(request.headers["if-match"]);
    return ok(reply, await deleteShelfItem(db(), actorOf(request), id, baseRevision));
  });

  app.post<{ Params: { id: string } }>("/api/admin/shelf/:id/publication-check", async (request, reply) => {
    const id = pathId(request.params.id, "条目 ID");
    const input = new Input(request.body);
    const action = input.oneOf("action", ["publish", "visibility"], { required: true, label: "动作" });
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    const target = input.oneOf("targetVisibility", ["public", "private"], { label: "目标可见范围" });
    input.finish();
    const result = await checkShelfItem(db(), actorOf(request), id, {
      action: action === "visibility" ? "visibility" : "publish",
      baseRevision: baseRevision ?? 0,
      targetVisibility: target === "public" ? "public" : target === "private" ? "private" : null
    });
    return ok(reply, result);
  });

  app.post<{ Params: { id: string } }>("/api/admin/shelf/:id/publish", async (request, reply) => {
    const id = pathId(request.params.id, "条目 ID");
    const input = new Input(request.body);
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    const checkId = input.str("checkId", { required: true, label: "checkId" });
    const target = input.oneOf("targetVisibility", ["public", "private"], { label: "目标可见范围" });
    const confirmed = input.bool("confirmed", { default: false, label: "确认" });
    const decisions = readDecisions(input);
    input.finish();
    if (confirmed !== true) throw errors.confirmRequired();
    const published = await publishShelfItem(db(), actorOf(request), id, {
      baseRevision: baseRevision ?? 0,
      checkId: checkId ?? "",
      assetDecisions: decisions,
      targetVisibility: target === "public" ? "public" : target === "private" ? "private" : null
    });
    return ok(reply, published);
  });

  app.post<{ Params: { id: string } }>("/api/admin/shelf/:id/unpublish", async (request, reply) => {
    const id = pathId(request.params.id, "条目 ID");
    const input = new Input(request.body);
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    input.finish();
    return ok(reply, await unpublishShelfItem(db(), actorOf(request), id, baseRevision ?? 0));
  });
}
