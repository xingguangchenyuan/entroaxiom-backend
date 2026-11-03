import type { FastifyRequest } from "fastify";
import { getContext } from "../../context.js";
import { errors } from "../../http/errors.js";
import type { Input } from "../../http/validation.js";
import type { ContentRes } from "../../db/types.js";
import { hmacSha256Hex } from "../../lib/crypto.js";
import type { Actor } from "../../services/audit.js";
import type { DraftFields } from "../../services/articles.js";
import type { SessionContext } from "../../services/sessions.js";

export function requireSession(request: FastifyRequest): SessionContext {
  const session = request.session;
  if (!session) throw errors.unauthorized();
  return session;
}

/** 审计需要的执行者：谁 + 来源 IP 的 HMAC（永不存明文 IP）。 */
export function actorOf(request: FastifyRequest): Actor {
  const session = requireSession(request);
  const config = getContext().config;
  return {
    userId: session.user.id,
    ipHash: request.ip ? hmacSha256Hex(config.ipHashSecret, request.ip) : null
  };
}

export function contentRes(value: string | undefined): ContentRes {
  if (value === "notes" || value === "essays") return value;
  throw errors.notFound("没有这类内容");
}

export function readDraft(
  input: Input,
  res: ContentRes,
  maxBody: number
): DraftFields {
  const title = input.str("title", { required: true, max: 200, label: "标题" });
  const body = input.str("body", { required: true, max: maxBody, label: "正文" });
  const summary = input.str("summary", { max: 500, label: "摘要" });
  const category = input.str("category", { max: 40, label: "分类" });
  const tags = input.strArray("tags", { maxItems: 20, maxLength: 30, label: "标签" });
  const date = input.dateOnly("date", { label: "写作日期" });
  const updated = input.dateOnly("updated", { label: "更新日期" });
  const mood = res === "essays" ? input.str("mood", { max: 40, label: "心情" }) : null;
  const place = res === "essays" ? input.str("place", { max: 60, label: "地点" }) : null;
  input.finish();

  return {
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
