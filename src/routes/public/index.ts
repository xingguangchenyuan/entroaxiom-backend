import type { FastifyInstance } from "fastify";
import { getContext } from "../../context.js";
import { errors } from "../../http/errors.js";
import { ok } from "../../http/reply.js";
import { Input, pathId } from "../../http/validation.js";
import { contentFingerprint } from "../../lib/crypto.js";
import { guestbookLimiter } from "../../lib/rate-limit.js";
import type { ContentRes } from "../../db/types.js";
import { getPublicArticle, listPublicArticles, listPublicFiles, getPublicFile, listPublicShelf, getPublicShelf } from "../../services/public.js";
import { publicGuestbookPage, submitGuestMessage } from "../../services/guestbook.js";

const SIGILS = ["sun", "moon", "mercury", "venus", "mars", "jupiter", "saturn"] as const;

function integerQuery(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * 公开接口：只读 + 留言提交。
 * 这里永不返回草稿、私密内容、邮箱、IP 或审核证据。
 */
export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  const db = () => getContext().db;

  for (const res of ["notes", "essays"] as ContentRes[]) {
    app.get(`/api/public/${res}`, async (_request, reply) => {
      return ok(reply, await listPublicArticles(db(), res));
    });

    app.get<{ Params: { id: string } }>(`/api/public/${res}/:id`, async (request, reply) => {
      const id = pathId(request.params.id, "内容 ID");
      return ok(reply, await getPublicArticle(db(), res, id));
    });
  }

  app.get("/api/public/files", async (_request, reply) => {
    return ok(reply, await listPublicFiles(db()));
  });

  app.get<{ Params: { id: string } }>("/api/public/files/:id", async (request, reply) => {
    const id = pathId(request.params.id, "文件 ID");
    return ok(reply, await getPublicFile(db(), id));
  });

  app.get("/api/public/shelf", async (_request, reply) => {
    return ok(reply, await listPublicShelf(db()));
  });

  app.get<{ Params: { id: string } }>("/api/public/shelf/:id", async (request, reply) => {
    const id = pathId(request.params.id, "条目 ID");
    return ok(reply, await getPublicShelf(db(), id));
  });

  app.get<{ Querystring: { offset?: string; limit?: string } }>(
    "/api/public/guestbook",
    async (request, reply) => {
      const offset = integerQuery(request.query.offset, 0, 0, 100000);
      const limit = integerQuery(request.query.limit, 12, 1, 50);
      return ok(reply, await publicGuestbookPage(db(), offset, limit));
    }
  );

  app.post("/api/public/guestbook", async (request, reply) => {
    const config = getContext().config;
    const marker = request.headers["x-requested-with"];
    if (typeof marker !== "string" || marker !== "entroaxiom") {
      throw errors.forbidden("缺少 X-Requested-With: entroaxiom 请求头");
    }

    const input = new Input(request.body);
    const name = input.str("name", { required: true, max: 24, label: "称呼" });
    const body = input.str("body", { required: true, min: 2, max: 500, label: "留言" });
    const email = input.str("email", { max: 120, label: "邮箱" });
    const site = input.httpUrl("site", { max: 200, label: "网址" });
    const sigil = input.oneOf("sigil", SIGILS, { label: "印记" });
    input.finish();

    const ip = request.ip;
    const shortLimit = guestbookLimiter.check(`short:${ip}`, 5, 10 * 60_000);
    if (!shortLimit.allowed) {
      throw errors.rateLimited("留言太频繁了，请稍后再试", shortLimit.retryAfterSeconds);
    }
    const dayLimit = guestbookLimiter.check(`day:${ip}`, 30, 24 * 60 * 60_000);
    if (!dayLimit.allowed) {
      throw errors.rateLimited("今天留言次数已达上限", dayLimit.retryAfterSeconds);
    }
    const duplicate = guestbookLimiter.check(
      `dup:${ip}:${contentFingerprint([name ?? "", body ?? ""])}`,
      1,
      10 * 60_000
    );
    if (!duplicate.allowed) {
      throw errors.rateLimited("相同的留言刚刚提交过", duplicate.retryAfterSeconds);
    }

    guestbookLimiter.record(`short:${ip}`);
    guestbookLimiter.record(`day:${ip}`);
    guestbookLimiter.record(`dup:${ip}:${contentFingerprint([name ?? "", body ?? ""])}`);

    const receipt = await submitGuestMessage(
      db(),
      { name: name ?? "", email, site, body: body ?? "", sigil },
      ip
    );
    void config;
    return ok(reply, receipt, 201);
  });
}
