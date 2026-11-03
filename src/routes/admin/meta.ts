import type { FastifyInstance } from "fastify";
import { getContext } from "../../context.js";
import { ok } from "../../http/reply.js";
import { queryString } from "../../http/validation.js";
import { getContentOptions, getDashboard } from "../../services/dashboard.js";
import { contentRes } from "./shared.js";

export async function registerAdminMetaRoutes(app: FastifyInstance): Promise<void> {
  const db = () => getContext().db;

  app.get("/api/admin/dashboard", async (_request, reply) => {
    return ok(reply, await getDashboard(db()));
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/admin/content-options", async (request, reply) => {
    const type = queryString(request.query, "type");
    const res = type === undefined ? undefined : contentRes(type);
    return ok(reply, await getContentOptions(db(), res));
  });
}
