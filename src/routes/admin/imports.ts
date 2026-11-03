import type { FastifyInstance } from "fastify";
import { getContext } from "../../context.js";
import { errors } from "../../http/errors.js";
import { ok } from "../../http/reply.js";
import { fieldValue, readMultipart } from "../../http/multipart.js";
import { Input, pathId } from "../../http/validation.js";
import type { ContentRes } from "../../db/types.js";
import {
  cleanupExpiredImports,
  commitImport,
  createPreview,
  discardImport,
  selectCandidate,
  type CommitInput
} from "../../services/imports.js";
import { actorOf, contentRes } from "./shared.js";

function importType(value: string | null): ContentRes {
  if (value === "notes" || value === "essays") return value;
  throw errors.validation([{ loc: ["body", "type"], msg: "导入类型必须是 notes 或 essays" }]);
}

export async function registerAdminImportRoutes(app: FastifyInstance): Promise<void> {
  const db = () => getContext().db;

  app.post("/api/admin/imports/preview", async (request, reply) => {
    const payload = await readMultipart(request);
    const file = payload.file;
    if (!file) {
      throw errors.validation([{ loc: ["body", "file"], msg: "请选择要导入的 .md 或 .zip 文件" }]);
    }
    // type 在这里严格校验：缺失或非法都报验证错误，绝不猜默认值。
    const res = importType(fieldValue(payload, "type"));

    const preview = await createPreview(db(), actorOf(request), {
      data: file.data,
      filename: file.filename,
      res
    });
    return ok(reply, preview, 201);
  });

  app.post<{ Params: { importId: string } }>("/api/admin/imports/:importId/select", async (request, reply) => {
    const importId = pathId(request.params.importId, "导入 ID");
    const input = new Input(request.body);
    const target = input.str("path", { required: true, max: 500, label: "文件路径" });
    input.finish();
    return ok(reply, await selectCandidate(db(), actorOf(request), importId, target ?? ""));
  });

  app.post<{ Params: { importId: string } }>("/api/admin/imports/:importId/commit", async (request, reply) => {
    const config = getContext().config;
    const importId = pathId(request.params.importId, "导入 ID");
    const input = new Input(request.body);
    const mode = input.oneOf("mode", ["create", "update"], { default: "create", label: "模式" });
    const targetId = input.str("targetId", { max: 80, label: "目标 ID" });
    const baseRevision = input.int("baseRevision", { min: 1, label: "baseRevision" });

    const draftInput = input.nested("draft", true);
    let draft: CommitInput["draft"] | null = null;
    if (draftInput) {
      const id = draftInput.str("id", { max: 80, label: "ID" });
      const title = draftInput.str("title", { required: true, max: 200, label: "标题" });
      const body = draftInput.str("body", { required: true, max: config.maxBodyBytes, label: "正文" });
      const summary = draftInput.str("summary", { max: 500, label: "摘要" });
      const category = draftInput.str("category", { max: 40, label: "分类" });
      const tags = draftInput.strArray("tags", { maxItems: 20, maxLength: 30, label: "标签" });
      const date = draftInput.dateOnly("date", { label: "写作日期" });
      const updated = draftInput.dateOnly("updated", { label: "更新日期" });
      const mood = draftInput.str("mood", { max: 40, label: "心情" });
      const place = draftInput.str("place", { max: 60, label: "地点" });
      draftInput.finish();
      input.child(draftInput);
      draft = {
        id: id ?? undefined,
        title: title ?? "",
        body: body ?? "",
        summary,
        category,
        tags: tags && tags.length > 0 ? tags : null,
        date,
        updated,
        mood,
        place
      };
    }

    const includeUnreferencedPaths = input.strArray("includeUnreferencedPaths", {
      maxItems: 200,
      maxLength: 500,
      label: "附带资源"
    });
    input.finish();

    if (!draft) throw errors.validation([{ loc: ["body", "draft"], msg: "缺少草稿内容" }]);

    const result = await commitImport(db(), actorOf(request), importId, {
      mode: mode === "update" ? "update" : "create",
      targetId: targetId ?? undefined,
      baseRevision: baseRevision ?? undefined,
      draft,
      includeUnreferencedPaths: includeUnreferencedPaths ?? []
    });
    return ok(reply, result);
  });

  app.delete<{ Params: { importId: string } }>("/api/admin/imports/:importId", async (request, reply) => {
    const importId = pathId(request.params.importId, "导入 ID");
    await discardImport(db(), actorOf(request), importId);
    return ok(reply, { deleted: true as const });
  });

  app.post("/api/admin/imports/cleanup", async (request, reply) => {
    const removed = await cleanupExpiredImports(db());
    return ok(reply, { removed });
  });
}

