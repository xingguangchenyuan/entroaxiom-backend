import type { FastifyInstance } from "fastify";

/**
 * 同源后台不开放 CORS：任何响应都不加 Access-Control-Allow-Origin。
 * 这里只补必要的安全响应头与 API 不缓存策略。
 */
export function registerSecurity(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    const path = (request.raw.url ?? "").split("?")[0] ?? "";
    if (path.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    return payload;
  });
}
