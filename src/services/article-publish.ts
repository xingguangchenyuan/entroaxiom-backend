import type { Db } from "../db/index.js";
import type { ContentRes } from "../db/types.js";
import { getContext } from "../context.js";
import { errors } from "../http/errors.js";
import { iso, publicUrlFor } from "../http/serialize.js";
import { charCount, extractAssetIds, replaceAssetRefs } from "../lib/markdown.js";
import { writeAudit, type Actor } from "./audit.js";
import { detailView, getArticleRow, insertVersion } from "./articles.js";
import { consumeCheck, createCheck } from "./checks.js";
import { copyFileForPublish, makeFilePublic } from "./files.js";
import { type PendingCleanup, runCleanups } from "./storage-cleanup.js";
import { syncReferences } from "./references.js";

export type Visibility = "public" | "private";
export type Decision = "keep-private" | "copy-public" | "make-public";

export interface AssetInfo {
  fileId: string;
  name: string;
  kind: string;
  size: number;
  ext: string;
  visibility: Visibility;
}

export interface ResolvedAsset {
  finalId: string;
  ext: string;
  isPublic: boolean;
}

export interface CheckItem {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  fileIds?: string[];
}

export interface AssetDecisionView {
  fileId: string;
  name: string;
  kind: string;
  visibility: Visibility;
  options: Decision[];
  sharedWithPrivate: boolean;
  reason: string | null;
}

/** 读取正文里引用到的文件（含已被删掉的 id：返回 null 表示悬空引用）。 */
export async function loadAssets(
  exec: Db,
  body: string
): Promise<{ assets: AssetInfo[]; dangling: string[] }> {
  const ids = extractAssetIds(body);
  if (ids.length === 0) return { assets: [], dangling: [] };
  const rows = await exec
    .selectFrom("files")
    .select(["id", "name", "kind", "size", "ext", "visibility", "status"])
    .where("id", "in", ids)
    .where("deleted_at", "is", null)
    .execute();
  const found = new Set(rows.map(row => row.id));
  return {
    assets: rows
      .filter(row => row.status === "ready")
      .map(row => ({
        fileId: row.id,
        name: row.name,
        kind: row.kind,
        size: Number(row.size),
        ext: row.ext,
        visibility: row.visibility
      })),
    dangling: ids.filter(id => !found.has(id))
  };
}

async function sharedWithPrivate(exec: Db, fileId: string, exclude: { owner: string; targetId: string }): Promise<boolean> {
  const rows = await exec
    .selectFrom("file_references")
    .select(["owner", "target_id", "usage", "is_public"])
    .where("file_id", "=", fileId)
    .execute();
  return rows.some(
    row =>
      row.is_public === false &&
      !(row.owner === exclude.owner && row.target_id === exclude.targetId) &&
      row.usage !== "published"
  );
}

export function checkItem(
  code: string,
  severity: "info" | "warning" | "error",
  message: string,
  fileIds?: string[]
): CheckItem {
  return fileIds ? { code, severity, message, fileIds } : { code, severity, message };
}

export async function buildAssetDecisionViews(
  exec: Db,
  assets: AssetInfo[],
  exclude: { owner: string; targetId: string }
): Promise<AssetDecisionView[]> {
  const views: AssetDecisionView[] = [];
  for (const asset of assets) {
    if (asset.visibility === "public") continue;
    const shared = await sharedWithPrivate(exec, asset.fileId, exclude);
    const sharedReason = shared
      ? "这个文件同时被其它未公开内容引用，建议使用 copy-public 生成副本，避免一处公开影响别处。"
      : "这个文件当前是私密状态，发布前需要决定公开方式。";
    views.push({
      fileId: asset.fileId,
      name: asset.name,
      kind: asset.kind,
      visibility: "private",
      options: ["keep-private", "copy-public", "make-public"],
      sharedWithPrivate: shared,
      reason: sharedReason
    });
  }
  return views;
}

/**
 * 执行站长的资源决策，返回"正文引用 id → 最终公开地址信息"的映射。
 * 未给决策的私密资源一律按 keep-private 处理：宁可出现占位符，也不悄悄公开。
 */
export interface AssetDecisionOutcome {
  resolved: Map<string, ResolvedAsset>;
  /** 事务提交之后才该执行的物理文件清理（旧私密文件等）。 */
  cleanups: PendingCleanup[];
}

export async function applyAssetDecisions(
  exec: Db,
  actor: Actor,
  assets: AssetInfo[],
  decisions: Array<{ fileId: string; decision: string }> | undefined,
  options: {
    unknownFileMessage?: (fileId: string) => string;
    /** 本次决策新建出来的文件；外层事务回滚时由调用方负责删除。 */
    onCreatedFile?: (visibility: "public" | "private", storageKey: string) => void;
  } = {}
): Promise<AssetDecisionOutcome> {
  const unknownFileMessage =
    options.unknownFileMessage ?? ((fileId: string) => `正文未引用该文件：${fileId}`);
  const byId = new Map<string, string>();
  for (const decision of decisions ?? []) {
    if (!["keep-private", "copy-public", "make-public"].includes(decision.decision)) {
      throw errors.validation([
        { loc: ["body", "assetDecisions"], msg: `未知的资源处理方式：${decision.decision}` }
      ]);
    }
    // 同一个 fileId 出现两次时拒绝而不是"后者覆盖"：两种决策同时生效会让
    // 磁盘上出现多份副本或半公开状态，宁可报错让前端修正。
    if (byId.has(decision.fileId)) {
      throw errors.validation([
        { loc: ["body", "assetDecisions"], msg: `同一个文件出现了多条处理决策：${decision.fileId}` }
      ]);
    }
    byId.set(decision.fileId, decision.decision);
  }

  const known = new Set(assets.map(asset => asset.fileId));
  for (const fileId of byId.keys()) {
    if (!known.has(fileId)) {
      throw errors.validation([{ loc: ["body", "assetDecisions"], msg: unknownFileMessage(fileId) }]);
    }
  }

  const resolved = new Map<string, ResolvedAsset>();
  const cleanups: PendingCleanup[] = [];
  for (const asset of assets) {
    if (asset.visibility === "public") {
      resolved.set(asset.fileId, { finalId: asset.fileId, ext: asset.ext, isPublic: true });
      continue;
    }
    const decision = byId.get(asset.fileId) ?? "keep-private";
    if (decision === "make-public") {
      const cleanup = await makeFilePublic(exec, actor, asset.fileId, options.onCreatedFile);
      if (cleanup) cleanups.push(cleanup);
      resolved.set(asset.fileId, { finalId: asset.fileId, ext: asset.ext, isPublic: true });
    } else if (decision === "copy-public") {
      const copyId = await copyFileForPublish(exec, actor, asset.fileId, options.onCreatedFile);
      resolved.set(asset.fileId, { finalId: copyId, ext: asset.ext, isPublic: true });
    } else {
      resolved.set(asset.fileId, { finalId: asset.fileId, ext: asset.ext, isPublic: false });
    }
  }
  return { resolved, cleanups };
}

export function resolvePublicUrl(resolved: ResolvedAsset | undefined): string | null {
  if (!resolved || !resolved.isPublic) return null;
  return publicUrlFor({ id: resolved.finalId, ext: resolved.ext });
}

export interface ArticleCheckInput {
  action: "publish" | "visibility";
  baseRevision: number;
  targetVisibility: Visibility | null;
}

export async function checkArticle(
  db: Db,
  actor: Actor,
  res: ContentRes,
  id: string,
  input: ArticleCheckInput
): Promise<unknown> {
  const config = getContext().config;
  const row = await getArticleRow(db, res, id);
  if (row.revision !== input.baseRevision) throw errors.revisionConflict(row.revision);

  const { assets, dangling } = await loadAssets(db, row.body);
  const checks: CheckItem[] = [];

  if (!row.title.trim()) checks.push(checkItem("MISSING_TITLE", "error", "标题不能为空"));
  if (!row.body.trim()) checks.push(checkItem("EMPTY_BODY", "error", "正文不能为空"));
  if (!row.summary || !row.summary.trim()) {
    checks.push(checkItem("MISSING_SUMMARY", "warning", "还没有写摘要，列表页会显示不完整"));
  }
  const chars = charCount(row.body);
  if (chars > 0 && chars < config.shortBodyChars) {
    checks.push(
      checkItem("SHORT_BODY", "warning", `正文只有 ${chars} 个字符，可能还没写完`)
    );
  }
  if (dangling.length > 0) {
    checks.push(
      checkItem("DANGLING_REF", "error", "正文引用了已不存在的文件", dangling)
    );
  }
  const privateAssets = assets.filter(asset => asset.visibility === "private");
  if (privateAssets.length > 0) {
    checks.push(
      checkItem(
        "PRIVATE_ASSET",
        "warning",
        "正文引用了私密文件，发布时需要决定处理方式",
        privateAssets.map(asset => asset.fileId)
      )
    );
  }

  // 只有"发布"才需要资源处置决策：改可见范围不会复制文件、也不会改文件可见性，
  // 返回决策只会让前端以为要选，误导站长。
  const assetDecisions =
    input.action === "publish"
      ? await buildAssetDecisionViews(db, assets, { owner: res, targetId: id })
      : [];
  const created = await createCheck(
    db,
    {
      userId: actor.userId,
      subjectType: "article",
      subjectId: id,
      action: input.action,
      targetVisibility: input.targetVisibility,
      baseRevision: input.baseRevision,
      privateAssetIds: privateAssets.map(asset => asset.fileId)
    },
    checks
  );

  return {
    checkId: created.checkId,
    expiresAt: iso(created.expiresAt),
    action: input.action,
    targetVisibility: input.targetVisibility,
    checks,
    assetDecisions,
    canProceed: checks.every(check => check.severity !== "error")
  };
}

export interface PublishInput {
  baseRevision: number;
  checkId: string;
  assetDecisions?: Array<{ fileId: string; decision: string }>;
  targetVisibility?: Visibility | null;
}

export async function publishArticle(
  db: Db,
  actor: Actor,
  res: ContentRes,
  id: string,
  input: PublishInput
): Promise<unknown> {
  const { config, logger } = getContext();
  const createdFiles: PendingCleanup[] = [];
  let result: { view: unknown; cleanups: PendingCleanup[] };
  try {
    result = await db.transaction().execute(async trx => {
    const row = await getArticleRow(trx, res, id, true);
    if (row.revision !== input.baseRevision) throw errors.revisionConflict(row.revision);

    const { assets } = await loadAssets(trx, row.body);
    const privateIds = assets
      .filter(asset => asset.visibility === "private")
      .map(asset => asset.fileId);

    await consumeCheck(trx, {
      userId: actor.userId,
      subjectType: "article",
      subjectId: id,
      action: "publish",
      targetVisibility: input.targetVisibility ?? null,
      baseRevision: input.baseRevision,
      privateAssetIds: privateIds,
      checkId: input.checkId
    });

    const outcome = await applyAssetDecisions(trx, actor, assets, input.assetDecisions, {
      onCreatedFile: (visibility, storageKey) =>
        createdFiles.push({ fileId: id, visibility, storageKey, operation: "article.publish" })
    });
    const resolved = outcome.resolved;
    const publicBody = replaceAssetRefs(row.body, fileId => resolvePublicUrl(resolved.get(fileId)));

    const nextRevision = row.revision + 1;
    const publishedAt = new Date();
    const visibility = input.targetVisibility ?? row.visibility;

    await trx
      .insertInto("published_article_snapshots")
      .values({
        article_id: id,
        published_revision: nextRevision,
        public_title: row.title,
        public_summary: row.summary,
        public_body: publicBody,
        public_meta: JSON.stringify({
          category: row.category,
          tags: row.tags,
          date: row.date,
          updated: row.updated,
          mood: row.mood,
          place: row.place
        }),
        published_at: publishedAt
      })
      .onConflict(oc =>
        oc.column("article_id").doUpdateSet({
          published_revision: nextRevision,
          public_title: row.title,
          public_summary: row.summary,
          public_body: publicBody,
          public_meta: JSON.stringify({
            category: row.category,
            tags: row.tags,
            date: row.date,
            updated: row.updated,
            mood: row.mood,
            place: row.place
          }),
          published_at: publishedAt
        })
      )
      .execute();

    const updated = await trx
      .updateTable("articles")
      .set({
        status: "published",
        visibility,
        published_at: publishedAt,
        published_revision: nextRevision,
        revision: nextRevision,
        updated_at: publishedAt
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    // 发布本身也是一份可回溯的存档：撤回发布或改错了之后，历史里要能找回这次的正文。
    await insertVersion(trx, updated, "publish", actor.userId, { skipIfSame: true });

    const publishedFileIds = [...resolved.values()]
      .filter(asset => asset.isPublic)
      .map(asset => asset.finalId);
    await syncReferences(
      trx,
      { owner: res, targetId: id, usage: "published", version: nextRevision },
      publishedFileIds
    );

    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "article.publish",
      resourceType: res,
      resourceId: id,
      before: { status: row.status, revision: row.revision },
      after: { status: updated.status, revision: updated.revision, visibility },
      ipHash: actor.ipHash
    });

    const view = await detailView(trx, updated);
    return { view, cleanups: outcome.cleanups };
    });
  } catch (error) {
    // 事务回滚：决策过程中复制出来的公开副本没有任何记录指向它，先清掉再抛出。
    if (createdFiles.length > 0) await runCleanups(createdFiles, logger, config);
    throw error;
  }

  // 事务已经提交，这里删旧私密文件才是安全的；失败只会留下孤儿文件并写日志。
  if (result.cleanups.length > 0) await runCleanups(result.cleanups, logger, config);
  return result.view;
}

export async function changeArticleVisibility(
  db: Db,
  actor: Actor,
  res: ContentRes,
  id: string,
  input: { visibility: Visibility; baseRevision: number; checkId: string }
): Promise<unknown> {
  return db.transaction().execute(async trx => {
    const row = await getArticleRow(trx, res, id, true);
    if (row.revision !== input.baseRevision) throw errors.revisionConflict(row.revision);

    const { assets } = await loadAssets(trx, row.body);
    const privateIds = assets
      .filter(asset => asset.visibility === "private")
      .map(asset => asset.fileId);

    await consumeCheck(trx, {
      userId: actor.userId,
      subjectType: "article",
      subjectId: id,
      action: "visibility",
      targetVisibility: input.visibility,
      baseRevision: input.baseRevision,
      privateAssetIds: privateIds,
      checkId: input.checkId
    });

    const updated = await trx
      .updateTable("articles")
      .set({
        visibility: input.visibility,
        revision: row.revision + 1,
        updated_at: new Date()
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "article.visibility",
      resourceType: res,
      resourceId: id,
      before: { visibility: row.visibility, revision: row.revision },
      after: { visibility: updated.visibility, revision: updated.revision },
      ipHash: actor.ipHash
    });
    return detailView(trx, updated);
  });
}

export async function unpublishArticle(
  db: Db,
  actor: Actor,
  res: ContentRes,
  id: string,
  baseRevision: number
): Promise<unknown> {
  return db.transaction().execute(async trx => {
    const row = await getArticleRow(trx, res, id, true);
    if (row.revision !== baseRevision) throw errors.revisionConflict(row.revision);
    if (row.status !== "published") throw errors.notPublished();

    const updated = await trx
      .updateTable("articles")
      .set({ status: "draft", revision: row.revision + 1, updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .deleteFrom("file_references")
      .where("owner", "=", res)
      .where("target_id", "=", id)
      .where("usage", "=", "published")
      .execute();

    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "article.unpublish",
      resourceType: res,
      resourceId: id,
      before: { status: row.status, revision: row.revision },
      after: { status: updated.status, revision: updated.revision },
      ipHash: actor.ipHash
    });
    return detailView(trx, updated);
  });
}
