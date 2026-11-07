import type { FastifyInstance } from "fastify";
import { registerPublicRoutes } from "./public/index.js";
import { registerAdminAuthRoutes } from "./admin/auth.js";
import { registerAdminMetaRoutes } from "./admin/meta.js";
import { registerAdminArticleRoutes } from "./admin/articles.js";
import { registerAdminFileRoutes } from "./admin/files.js";
import { registerAdminShelfRoutes } from "./admin/shelf.js";
import { registerAdminGuestbookRoutes } from "./admin/guestbook.js";
import { registerAdminModerationRoutes } from "./admin/moderation.js";
import { registerAdminImportRoutes } from "./admin/imports.js";
import { registerAdminLogRoutes } from "./admin/logs.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerPublicRoutes(app);
  await registerAdminAuthRoutes(app);
  await registerAdminMetaRoutes(app);
  await registerAdminArticleRoutes(app);
  await registerAdminFileRoutes(app);
  await registerAdminShelfRoutes(app);
  await registerAdminGuestbookRoutes(app);
  await registerAdminModerationRoutes(app);
  await registerAdminImportRoutes(app);
  await registerAdminLogRoutes(app);
}
