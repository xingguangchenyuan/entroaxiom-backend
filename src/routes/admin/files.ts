import type { FastifyInstance } from "fastify";
import { getContext } from "../../context.js";
import { errors } from "../../http/errors.js";
import { ok } from "../../http/reply.js";
import { Input, parseIfMatch, parsePaging, pathId, queryBool, queryString } from "../../http/validation.js";
import { fieldValue, readMultipart, visibilityField } from "../../http/multipart.js";
import { contentDispositionAttachment, contentDispositionInline } from "../../lib/mime.js";
import {
  createFileRecord,
  deleteFileRecord,
  getFileRow,
  getFileView,
  listFiles,
  updateFileRecord
} from "../../services/files.js";
import { listReferencesForFile } from "../../services/references.js";
import { readStoredFile } from "../../services/storage.js";
import { actorOf } from "./shared.js";

/**
 * 文件库接口。
 * 上传只接受白名单扩展名、真实 MIME 由服务端判定，落盘名永远是服务端生成的 storage_key。
 */
export async function registerAdminFileRoutes(app: FastifyInstance): Promise<void> {
  const db = () => getContext().db;

  app.get<{ Querystring: Record<string, unknown> }>("/api/admin/files", async (request, reply) => {
    const result = await listFiles(
      db(),
      {
        keyword: queryString(request.query, "keyword"),
        kind: queryString(request.query, "kind"),
        visibility: queryString(request.query, "visibility"),
        unused: queryBool(request.query, "unused"),
        sort: queryString(request.query, "sort")
      },
      parsePaging(request.query)
    );
    return ok(reply, result);
  });

  app.get<{ Params: { id: string } }>("/api/admin/files/:id", async (request, reply) => {
    const id = pathId(request.params.id, "文件 ID");
    return ok(reply, await getFileView(db(), id));
  });

  app.post("/api/admin/files", async (request, reply) => {
    const payload = await readMultipart(request);
    const file = payload.file;
    if (!file) {
      throw errors.validation([{ loc: ["body", "file"], msg: "请选择要上传的文件" }]);
    }

    const name = fieldValue(payload, "name");
    if (name && name.length > 200) {
      throw errors.validation([{ loc: ["body", "name"], msg: "文件名不能超过 200 个字符" }]);
    }
    const description = fieldValue(payload, "description");
    if (description && description.length > 500) {
      throw errors.validation([{ loc: ["body", "description"], msg: "说明不能超过 500 个字符" }]);
    }
    // 非法 visibility 直接报错，绝不静默降级。
    const visibility = visibilityField(payload);

    const created = await createFileRecord(db(), actorOf(request), {
      originalName: file.filename,
      displayName: name,
      description,
      visibility,
      data: file.data
    });
    return ok(reply, created, 201);
  });

  app.put<{ Params: { id: string } }>("/api/admin/files/:id", async (request, reply) => {
    const id = pathId(request.params.id, "文件 ID");
    const input = new Input(request.body);
    const name = input.str("name", { max: 200, label: "文件名" });
    const description = input.str("description", { max: 500, label: "说明" });
    const visibility = input.oneOf("visibility", ["public", "private"], { label: "可见范围" });
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    input.finish();

    const updated = await updateFileRecord(db(), actorOf(request), id, {
      name: name ?? undefined,
      description,
      visibility: visibility === "public" ? "public" : visibility === "private" ? "private" : undefined,
      baseRevision: baseRevision ?? 0
    });
    return ok(reply, updated);
  });

  app.delete<{ Params: { id: string } }>("/api/admin/files/:id", async (request, reply) => {
    const id = pathId(request.params.id, "文件 ID");
    const baseRevision = parseIfMatch(request.headers["if-match"]);
    return ok(reply, await deleteFileRecord(db(), actorOf(request), id, baseRevision));
  });

  app.get<{ Params: { id: string } }>("/api/admin/files/:id/references", async (request, reply) => {
    const id = pathId(request.params.id, "文件 ID");
    await getFileRow(db(), id);
    return ok(reply, await listReferencesForFile(db(), id));
  });

  /** 私密文件的唯一读取入口：必须带会话，永远不走 Nginx 静态目录。 */
  app.get<{ Params: { id: string } }>("/api/admin/files/:id/content", async (request, reply) => {
    const config = getContext().config;
    const id = pathId(request.params.id, "文件 ID");
    const row = await getFileRow(db(), id);

    let data: Buffer;
    try {
      data = await readStoredFile(config, row.visibility, row.storage_key);
    } catch {
      throw errors.notFound("文件实体已丢失");
    }

    const disposition = row.kind === "image" ? contentDispositionInline(row.name) : contentDispositionAttachment(row.name);
    reply.header("Content-Type", row.mime);
    reply.header("Content-Disposition", disposition);
    reply.header("Content-Length", String(data.length));
    reply.header("Cache-Control", "private, no-store");
    return reply.send(data);
  });
}

