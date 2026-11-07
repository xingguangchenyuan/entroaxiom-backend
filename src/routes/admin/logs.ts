import type { FastifyInstance } from "fastify";
import { getContext } from "../../context.js";
import { errors } from "../../http/errors.js";
import { ok } from "../../http/reply.js";
import { queryBool, queryString } from "../../http/validation.js";
import {
  fetchCloudflareEvents,
  listLogs,
  logSources,
  securitySummary,
  type LogLevel
} from "../../services/logs.js";

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function readHours(query: Record<string, unknown>, fallback = 24, max = 24 * 30): number {
  const raw = Number(queryString(query, "hours") ?? "");
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.floor(raw), 1), max);
}

function readTail(query: Record<string, unknown>): number {
  const raw = Number(queryString(query, "tail") ?? "");
  if (!Number.isFinite(raw)) return 200;
  return Math.min(Math.max(Math.floor(raw), 20), 2000);
}

/**
 * 日志中心接口。
 *
 * 全部是只读的 GET：日志是运维事实，后台不允许修改、删除、清空。
 * `source` 只接受配置里登记过的逻辑名，任何其他字符串直接 400，
 * 绝不放行到 `fs` 层。
 */
export async function registerAdminLogRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/logs/sources", async (_request, reply) => {
    const config = getContext().config;
    return ok(reply, logSources(config).map(({ id, label, kind }) => ({ id, label, kind })));
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/admin/logs", async (request, reply) => {
    const config = getContext().config;
    const source = queryString(request.query, "source");
    if (source && source !== "all" && !logSources(config).some(item => item.id === source)) {
      throw errors.badRequest("VALIDATION_ERROR", `未知的日志来源：${source}`);
    }

    const levelRaw = queryString(request.query, "level");
    const level =
      levelRaw && (LEVELS as readonly string[]).includes(levelRaw) ? (levelRaw as LogLevel) : undefined;
    const statusRaw = queryString(request.query, "status");
    const status = statusRaw && /^\d{3}$/.test(statusRaw) ? Number(statusRaw) : undefined;

    const result = await listLogs(config, {
      source,
      tail: readTail(request.query),
      keyword: queryString(request.query, "q"),
      level,
      status,
      suspectOnly: queryBool(request.query, "suspect") === true
    });
    return ok(reply, result);
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/admin/logs/security", async (request, reply) => {
    return ok(reply, await securitySummary(getContext().config, readHours(request.query)));
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/admin/logs/cloudflare", async (request, reply) => {
    return ok(reply, await fetchCloudflareEvents(getContext().config, readHours(request.query)));
  });
}
