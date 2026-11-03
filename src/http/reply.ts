import type { FastifyReply } from "fastify";
import { contentDispositionAttachment } from "../lib/mime.js";

export function ok<T>(reply: FastifyReply, data: T, status = 200): FastifyReply {
  return reply
    .code(status)
    .header("Content-Type", "application/json; charset=utf-8")
    .send({ success: true, data: data ?? null, error: null });
}

export function okBinary(
  reply: FastifyReply,
  file: { filename: string; contentType: string; body: Buffer }
): FastifyReply {
  return reply
    .code(200)
    .header("Content-Type", file.contentType)
    .header("Content-Disposition", contentDispositionAttachment(file.filename))
    .header("Content-Length", String(file.body.byteLength))
    .send(file.body);
}
