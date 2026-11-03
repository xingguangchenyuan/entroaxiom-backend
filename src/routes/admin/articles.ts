import type { FastifyInstance } from "fastify";
import { getContext } from "../../context.js";
import { errors } from "../../http/errors.js";
import { ok, okBinary } from "../../http/reply.js";
import { Input, parseIfMatch, parsePaging, pathId, queryBool, queryString } from "../../http/validation.js";
import type { ContentRes } from "../../db/types.js";
import { assertValidId, slugify } from "../../lib/ids.js";
import {
  createArticle,
  deleteArticle,
  detailView,
  getArticleRow,
  getPublishedView,
  getVersion,
  listArticles,
  listVersions,
  restoreVersion,
  saveArticle
} from "../../services/articles.js";
import {
  changeArticleVisibility,
  checkArticle,
  publishArticle,
  unpublishArticle
} from "../../services/article-publish.js";
import { exportArticle } from "../../services/export.js";
import { actorOf, contentRes, readDraft } from "./shared.js";

function articleId(raw: string | null, title: string, res: ContentRes): string {
  if (!raw) return slugify(title, res);
  try {
    return assertValidId(raw);
  } catch {
    throw errors.validation([
      { loc: ["body", "id"], msg: "ID 只能包含字母、数字、.、_、-，且以字母或数字开头，最长 80 个字符" }
    ]);
  }
}

/**
 * 文章（笔记 / 随笔）后台接口。
 * 可见范围、发布、撤回都是独立动作，普通保存永远不会顺手改权限或状态。
 */
export async function registerAdminArticleRoutes(app: FastifyInstance): Promise<void> {
  const db = () => getContext().db;
  const base = "/api/admin/articles/:res";

  app.get<{ Params: { res: string }; Querystring: Record<string, unknown> }>(base, async (request, reply) => {
    const res = contentRes(request.params.res);
    const paging = parsePaging(request.query);
    const result = await listArticles(
      db(),
      res,
      {
        keyword: queryString(request.query, "keyword"),
        status: queryString(request.query, "status"),
        visibility: queryString(request.query, "visibility"),
        category: queryString(request.query, "category"),
        tag: queryString(request.query, "tag"),
        hasUnpublishedChanges: queryBool(request.query, "hasUnpublishedChanges")
      },
      paging
    );
    return ok(reply, result);
  });

  app.get<{ Params: { res: string; id: string } }>(`${base}/:id`, async (request, reply) => {
    const res = contentRes(request.params.res);
    const id = pathId(request.params.id, "文章 ID");
    const row = await getArticleRow(db(), res, id);
    return ok(reply, await detailView(db(), row));
  });

  app.post<{ Params: { res: string } }>(base, async (request, reply) => {
    const res = contentRes(request.params.res);
    const config = getContext().config;
    const input = new Input(request.body);
    const rawId = input.str("id", { max: 80, label: "ID" });
    const draft = readDraft(input, res, config.maxBodyBytes);
    const created = await createArticle(
      db(),
      actorOf(request),
      res,
      draft,
      articleId(rawId, draft.title, res)
    );
    return ok(reply, created, 201);
  });

  app.put<{ Params: { res: string; id: string } }>(`${base}/:id`, async (request, reply) => {
    const res = contentRes(request.params.res);
    const config = getContext().config;
    const id = pathId(request.params.id, "文章 ID");
    const input = new Input(request.body);
    const draft = readDraft(input, res, config.maxBodyBytes);
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    const saveMode = input.oneOf("saveMode", ["auto", "manual"], { default: "auto", label: "saveMode" });
    input.finish();
    const saved = await saveArticle(db(), actorOf(request), res, id, {
      ...draft,
      baseRevision: baseRevision ?? 0,
      saveMode: saveMode === "manual" ? "manual" : "auto"
    });
    return ok(reply, saved);
  });

  app.patch<{ Params: { res: string; id: string } }>(`${base}/:id/visibility`, async (request, reply) => {
    const res = contentRes(request.params.res);
    const id = pathId(request.params.id, "文章 ID");
    const input = new Input(request.body);
    const visibility = input.oneOf("visibility", ["public", "private"], { required: true, label: "可见范围" });
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    const checkId = input.str("checkId", { required: true, label: "checkId" });
    input.finish();
    const updated = await changeArticleVisibility(db(), actorOf(request), res, id, {
      visibility: visibility === "public" ? "public" : "private",
      baseRevision: baseRevision ?? 0,
      checkId: checkId ?? ""
    });
    return ok(reply, updated);
  });

  app.post<{ Params: { res: string; id: string } }>(`${base}/:id/publication-check`, async (request, reply) => {
    const res = contentRes(request.params.res);
    const id = pathId(request.params.id, "文章 ID");
    const input = new Input(request.body);
    const action = input.oneOf("action", ["publish", "visibility"], { required: true, label: "动作" });
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    const target = input.oneOf("targetVisibility", ["public", "private"], { label: "目标可见范围" });
    input.finish();
    const result = await checkArticle(db(), actorOf(request), res, id, {
      action: action === "visibility" ? "visibility" : "publish",
      baseRevision: baseRevision ?? 0,
      targetVisibility: target === "public" ? "public" : target === "private" ? "private" : null
    });
    return ok(reply, result);
  });

  app.post<{ Params: { res: string; id: string } }>(`${base}/:id/publish`, async (request, reply) => {
    const res = contentRes(request.params.res);
    const id = pathId(request.params.id, "文章 ID");
    const input = new Input(request.body);
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    const checkId = input.str("checkId", { required: true, label: "checkId" });
    const target = input.oneOf("targetVisibility", ["public", "private"], { label: "目标可见范围" });
    const confirmed = input.bool("confirmed", { default: false, label: "确认" });
    const decisions = readDecisions(input);
    input.finish();
    if (confirmed !== true) throw errors.confirmRequired();
    const published = await publishArticle(db(), actorOf(request), res, id, {
      baseRevision: baseRevision ?? 0,
      checkId: checkId ?? "",
      assetDecisions: decisions,
      targetVisibility: target === "public" ? "public" : target === "private" ? "private" : null
    });
    return ok(reply, published);
  });

  app.post<{ Params: { res: string; id: string } }>(`${base}/:id/unpublish`, async (request, reply) => {
    const res = contentRes(request.params.res);
    const id = pathId(request.params.id, "文章 ID");
    const input = new Input(request.body);
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    input.finish();
    return ok(reply, await unpublishArticle(db(), actorOf(request), res, id, baseRevision ?? 0));
  });

  app.get<{ Params: { res: string; id: string } }>(`${base}/:id/published`, async (request, reply) => {
    const res = contentRes(request.params.res);
    const id = pathId(request.params.id, "文章 ID");
    return ok(reply, await getPublishedView(db(), res, id));
  });

  app.delete<{ Params: { res: string; id: string } }>(`${base}/:id`, async (request, reply) => {
    const res = contentRes(request.params.res);
    const id = pathId(request.params.id, "文章 ID");
    const baseRevision = parseIfMatch(request.headers["if-match"]);
    return ok(reply, await deleteArticle(db(), actorOf(request), res, id, baseRevision));
  });

  app.get<{ Params: { res: string; id: string }; Querystring: Record<string, unknown> }>(
    `${base}/:id/versions`,
    async (request, reply) => {
      const res = contentRes(request.params.res);
      const id = pathId(request.params.id, "文章 ID");
      return ok(reply, await listVersions(db(), res, id, parsePaging(request.query, 20, 100)));
    }
  );

  app.get<{ Params: { res: string; id: string; versionId: string } }>(
    `${base}/:id/versions/:versionId`,
    async (request, reply) => {
      const res = contentRes(request.params.res);
      const id = pathId(request.params.id, "文章 ID");
      return ok(reply, await getVersion(db(), res, id, request.params.versionId));
    }
  );

  app.post<{ Params: { res: string; id: string; versionId: string } }>(
    `${base}/:id/versions/:versionId/restore`,
    async (request, reply) => {
      const res = contentRes(request.params.res);
      const id = pathId(request.params.id, "文章 ID");
      const input = new Input(request.body);
      const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
      input.finish();
      const restored = await restoreVersion(db(), actorOf(request), res, id, request.params.versionId, baseRevision ?? 0);
      return ok(reply, restored);
    }
  );

  app.get<{ Params: { res: string; id: string }; Querystring: Record<string, unknown> }>(
    `${base}/:id/export`,
    async (request, reply) => {
      const res = contentRes(request.params.res);
      const id = pathId(request.params.id, "文章 ID");
      const source = queryString(request.query, "source") === "published" ? "published" : "working";
      const format = queryString(request.query, "format") === "zip" ? "zip" : "md";
      const file = await exportArticle(db(), res, id, { source, format });
      return okBinary(reply, file);
    }
  );
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
