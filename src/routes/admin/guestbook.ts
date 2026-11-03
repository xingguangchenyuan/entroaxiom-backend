import type { FastifyInstance } from "fastify";
import { getContext } from "../../context.js";
import { ok } from "../../http/reply.js";
import { Input, parseIfMatch, parsePaging, pathId, queryBool, queryString } from "../../http/validation.js";
import {
  deleteGuestMessage,
  deleteReply,
  getGuestMessage,
  listGuestbook,
  saveReply,
  setGuestStatus
} from "../../services/guestbook.js";
import { actorOf } from "./shared.js";

export async function registerAdminGuestbookRoutes(app: FastifyInstance): Promise<void> {
  const db = () => getContext().db;

  app.get<{ Querystring: Record<string, unknown> }>("/api/admin/guestbook", async (request, reply) => {
    const result = await listGuestbook(
      db(),
      {
        keyword: queryString(request.query, "keyword"),
        status: queryString(request.query, "status"),
        replied: queryBool(request.query, "replied")
      },
      parsePaging(request.query)
    );
    return ok(reply, result);
  });

  app.get<{ Params: { id: string } }>("/api/admin/guestbook/:id", async (request, reply) => {
    const id = pathId(request.params.id, "留言 ID");
    return ok(reply, await getGuestMessage(db(), id));
  });

  app.patch<{ Params: { id: string } }>("/api/admin/guestbook/:id", async (request, reply) => {
    const id = pathId(request.params.id, "留言 ID");
    const input = new Input(request.body);
    const status = input.oneOf("status", ["approved", "hidden"], { required: true, label: "状态" });
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    input.finish();
    const updated = await setGuestStatus(db(), actorOf(request), id, {
      status: status === "hidden" ? "hidden" : "approved",
      baseRevision: baseRevision ?? 0
    });
    return ok(reply, updated);
  });

  app.put<{ Params: { id: string } }>("/api/admin/guestbook/:id/reply", async (request, reply) => {
    const id = pathId(request.params.id, "留言 ID");
    const input = new Input(request.body);
    const body = input.str("body", { required: true, max: 500, label: "回复" });
    const baseRevision = input.int("baseRevision", { required: true, min: 1, label: "baseRevision" });
    input.finish();
    const updated = await saveReply(db(), actorOf(request), id, {
      body: body ?? "",
      baseRevision: baseRevision ?? 0
    });
    return ok(reply, updated);
  });

  app.delete<{ Params: { id: string } }>("/api/admin/guestbook/:id/reply", async (request, reply) => {
    const id = pathId(request.params.id, "留言 ID");
    const baseRevision = parseIfMatch(request.headers["if-match"]);
    return ok(reply, await deleteReply(db(), actorOf(request), id, baseRevision));
  });

  app.delete<{ Params: { id: string } }>("/api/admin/guestbook/:id", async (request, reply) => {
    const id = pathId(request.params.id, "留言 ID");
    const baseRevision = parseIfMatch(request.headers["if-match"]);
    return ok(reply, await deleteGuestMessage(db(), actorOf(request), id, baseRevision));
  });
}
