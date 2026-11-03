import { mkdir } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";

/**
 * 只有 public 目录会被直接对外提供；私密文件永远只能走后台鉴权接口。
 * 生产环境由 Nginx 承担同样的映射，这里保证单进程开发时行为一致。
 */
export async function registerStatic(app: FastifyInstance, config: AppConfig): Promise<void> {
  const root = path.join(config.uploadRoot, "public");
  await mkdir(root, { recursive: true });
  await app.register(fastifyStatic, {
    root,
    prefix: "/uploads/public/",
    index: false,
    list: false,
    dotfiles: "deny",
    // 公开文件的 URL 不随可见性变化，一旦改成私密，浏览器/CDN 里的副本
    // 仍然会存活到缓存过期。所以这里只给 5 分钟，并且不加 immutable，
    // 撤回后最迟一个 TTL 就会消失（要立即生效需要版本化 URL + CDN purge）。
    cacheControl: true,
    maxAge: "5m",
    immutable: false
  });
}
