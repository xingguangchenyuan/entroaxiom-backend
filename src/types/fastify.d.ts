import "@fastify/cookie";
import type { AppContext } from "../context.js";
import type { SessionContext } from "../services/sessions.js";

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    /** 已通过 sid cookie 解析出的会话；公开路由上为 null。 */
    session: SessionContext | null;
  }
}
