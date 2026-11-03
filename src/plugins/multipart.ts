import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";

export async function registerMultipart(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: Math.max(config.maxFileBytes, config.maxArchiveBytes),
      files: 2,
      fields: 12,
      parts: 16,
      headerPairs: 200
    }
  });
}
