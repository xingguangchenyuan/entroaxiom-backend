import type { FastifyInstance, FastifyRequest } from "fastify";
import { getContext } from "../context.js";
import { errors } from "../http/errors.js";
import { resolveSession } from "../services/sessions.js";

/** 允许在未登录状态下访问的后台接口。 */
const OPEN_PATHS = new Set([
  "/api/admin/login",
  "/api/admin/refresh-token",
  // 登出必须免鉴权：会话已经过期/已撤销时，重复登出仍要 200 并清掉 cookie，
  // 否则后台客户端会在“退出登录”这一步拿到 401，被迫再走一次会话过期流程。
  "/api/admin/logout"
]);

function isWriteMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function originOf(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * 后台写操作必须是同源请求。优先看 Origin，缺失时退回 Referer；
 * 两者都没有直接拒绝 —— 这是对 CSRF 的兜底，不是可选优化。
 */
export function assertSameOrigin(request: FastifyRequest): void {
  const config = getContext().config;
  const actual = originOf(request.headers.origin) ?? originOf(request.headers.referer);
  if (!actual) throw errors.forbidden("缺少来源信息，跨站请求已被拒绝");
  if (!config.allowedOrigins.includes(actual)) {
    throw errors.forbidden(`来源 ${actual} 不在允许列表中`);
  }
}

export function registerAuth(app: FastifyInstance): void {
  app.addHook("onRequest", async request => {
    const path = (request.raw.url ?? "").split("?")[0] ?? "";
    if (!path.startsWith("/api/admin")) return;

    if (isWriteMethod(request.method)) assertSameOrigin(request);

    const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
    if (OPEN_PATHS.has(normalized)) return;

    const config = getContext().config;
    const token = request.cookies[config.sessionCookieName];
    if (!token) throw errors.unauthorized();
    const session = await resolveSession(getContext().db, config, token);
    if (!session) throw errors.sessionExpired();
    request.session = session;
  });
}
