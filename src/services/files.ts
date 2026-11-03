import { sql } from "kysely";
import { pagedTotal, type Db } from "../db/index.js";
import { likePattern } from "../lib/sql-like.js";
import { getContext } from "../context.js";
import { errors } from "../http/errors.js";
import { iso, publicUrlFor } from "../http/serialize.js";
import { randomId } from "../lib/crypto.js";
import { BLOCKED_EXTENSIONS, describeExtension, extensionOf, sanitizeFileName, sniffContentMismatch } from "../lib/mime.js";
import { writeAudit, type Actor } from "./audit.js";
import { copyStoredFile, removeStoredFile, storageKeyFor, writeStoredFile } from "./storage.js";
import { type PendingCleanup, runCleanups } from "./storage-cleanup.js";

export type FileKind = "image" | "pdf" | "archive" | "doc" | "other";

export interface FileFilters {
  keyword?: string;
  kind?: string;
  visibility?: string;
  unused?: boolean;
  sort?: string;
}

export interface Paging {
  page: number;
  pageSize: number;
  offset: number;
}

type FileRow = Awaited<ReturnType<typeof selectFile>>;

async function selectFile(exec: Db, id: string, forUpdate = false) {
  let query = exec
    .selectFrom("files")
    .selectAll()
    .where("id", "=", id)
    .where("deleted_at", "is", null);
  if (forUpdate) query = query.forUpdate();
  return query.executeTakeFirst();
}

export async function getFileRow(
  exec: Db,
  id: string,
  forUpdate = false
): Promise<NonNullable<FileRow>> {
  const row = await selectFile(exec, id, forUpdate);
  if (!row) throw errors.notFound("文件不存在");
  return row;
}

export function fileView(row: NonNullable<FileRow>, referenceCount: number) {
  const isPublic = row.visibility === "public" && row.status === "ready";
  const url = isPublic ? publicUrlFor({ id: row.id, ext: row.ext }) : null;
  return {
    id: row.id,
    name: row.name,
    ext: row.ext,
    kind: row.kind,
    size: Number(row.size),
    updatedAt: iso(row.updated_at),
    createdAt: iso(row.created_at),
    description: row.description,
    visibility: row.visibility,
    revision: row.revision,
    referenceCount,
    publicSrc: url,
    publicUrl: url,
    mime: row.mime,
    visible: isPublic,
    status: row.status
  };
}

async function referenceCounts(exec: Db, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await exec
    .selectFrom("file_references")
    .select(["file_id", eb => eb.fn.countAll<string>().as("count")])
    .where("file_id", "in", ids)
    .groupBy("file_id")
    .execute();
  return new Map(rows.map(row => [row.file_id, Number(row.count)]));
}

export async function listFiles(
  db: Db,
  filters: FileFilters,
  paging: Paging
): Promise<{ items: unknown[]; total: number }> {
  let query = db
    .selectFrom("files")
    .selectAll()
    .select(sql<string>`count(*) over ()`.as("total_count"))
    .where("deleted_at", "is", null);

  const keyword = filters.keyword?.trim();
  if (keyword) {
    const like = likePattern(keyword);
    query = query.where(eb =>
      eb.or([eb("name", "ilike", like), eb("description", "ilike", like), eb("id", "ilike", like)])
    );
  }
  if (filters.kind && ["image", "pdf", "archive", "doc", "other"].includes(filters.kind)) {
    query = query.where("kind", "=", filters.kind as FileKind);
  }
  if (filters.visibility === "public" || filters.visibility === "private") {
    query = query.where("visibility", "=", filters.visibility);
  }
  if (filters.unused === true) {
    query = query.where(eb =>
      eb.not(
        eb.exists(
          eb.selectFrom("file_references").select("file_references.id").whereRef("file_references.file_id", "=", "files.id")
        )
      )
    );
  }

  query =
    filters.sort === "size"
      ? query.orderBy("size", "desc").orderBy("id", "desc")
      : query.orderBy("updated_at", "desc").orderBy("id", "desc");

  const rows = await query.limit(paging.pageSize).offset(paging.offset).execute();
  const total = await pagedTotal(rows as Array<{ total_count: string }>, () => query.limit(1).execute());
  const counts = await referenceCounts(db, rows.map(row => row.id));
  return {
    items: rows.map(row => fileView(row as NonNullable<FileRow>, counts.get(row.id) ?? 0)),
    total
  };
}

export async function getFileView(db: Db, id: string): Promise<unknown> {
  const row = await getFileRow(db, id);
  const counts = await referenceCounts(db, [id]);
  return fileView(row, counts.get(id) ?? 0);
}

/**
 * 新建文件记录：文件名只用于展示，落盘名由服务端生成。
 * 扩展名决定 kind 与 MIME；不在白名单里的类型直接拒绝。
 */
export async function createFileRecord(
  db: Db,
  actor: Actor,
  input: {
    originalName: string;
    displayName: string | null;
    description: string | null;
    visibility: "public" | "private";
    data: Buffer;
  }
): Promise<{ id: string } & ReturnType<typeof fileView>> {
  const config = getContext().config;
  const ext = extensionOf(input.originalName);
  if (!ext) throw errors.unsupportedType("无法识别文件扩展名");
  // SVG 不进入任何白名单：即使 ALLOWED_EXTENSIONS 被误配成包含 svg，这里也拒绝。
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw errors.unsupportedType("本版本不接受 SVG 上传：SVG 可能被当作同源文档执行脚本，请先转成 PNG/WebP");
  }
  const described = describeExtension(ext);
  if (!described) throw errors.unsupportedType("不支持的文件类型");
  if (!config.allowedExtensions.includes(ext)) throw errors.unsupportedType(`不支持 .${ext} 类型的文件`);
  if (input.data.length > config.maxFileBytes) throw errors.fileTooLarge(config.maxFileBytes);
  // 按内容复核扩展名：拦住"HTML/SVG 改名成 .png"这类伪装，认不出内容的仍按扩展名放行。
  const mismatch = sniffContentMismatch(ext, input.data);
  if (mismatch) throw errors.unsupportedType(mismatch);

  const id = randomId(8);
  const storageKey = storageKeyFor(id, ext);
  const size = await writeStoredFile(config, input.visibility, storageKey, input.data);
  const displayName = sanitizeFileName(input.displayName ?? input.originalName);

  try {
    const row = await db
      .insertInto("files")
      .values({
        id,
        name: displayName,
        ext,
        mime: described.mime,
        kind: described.kind,
        size,
        storage_key: storageKey,
        visibility: input.visibility,
        status: "ready",
        description: input.description,
        revision: 1,
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
        created_by: actor.userId
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(db, {
      actorUserId: actor.userId,
      action: "file.upload",
      resourceType: "file",
      resourceId: id,
      after: { name: row.name, size: Number(row.size), visibility: row.visibility },
      ipHash: actor.ipHash
    });
    return fileView(row, 0);
  } catch (error) {
    await removeStoredFile(config, input.visibility, storageKey).catch(() => undefined);
    throw error;
  }
}

export async function updateFileRecord(
  db: Db,
  actor: Actor,
  id: string,
  input: {
    name?: string;
    description?: string | null;
    visibility?: "public" | "private";
    baseRevision: number;
  }
): Promise<unknown> {
  const config = getContext().config;
  const logger = getContext().logger;
  // 旧物理文件必须等事务提交成功之后再删：先删后提交时一旦回滚，
  // 数据库里的记录就会指向一个已经不存在的文件。
  const staleCleanups: PendingCleanup[] = [];
  const createdCopies: PendingCleanup[] = [];
  let view: unknown;
  try {
    view = await db.transaction().execute(async trx => {
    const current = await getFileRow(trx, id, true);
    if (current.revision !== input.baseRevision) throw errors.revisionConflict(current.revision);

    let storageKey = current.storage_key;
    let visibility = current.visibility;

    if (input.visibility && input.visibility !== current.visibility) {
      // 可见性变更等价于换目录：先搬文件，再改记录，失败则回滚不留孤儿。
      visibility = input.visibility;
      const nextKey = storageKeyFor(id, current.ext);
      await copyStoredFile(
        config,
        { visibility: current.visibility, storageKey: current.storage_key },
        { visibility, storageKey: nextKey }
      );
      storageKey = nextKey;
      createdCopies.push({
        fileId: id,
        visibility,
        storageKey: nextKey,
        operation: "file.update"
      });
    }

    const row = await trx
      .updateTable("files")
      .set({
        name: input.name === undefined ? current.name : sanitizeFileName(input.name),
        description: input.description === undefined ? current.description : input.description,
        visibility,
        storage_key: storageKey,
        revision: current.revision + 1,
        updated_at: new Date()
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (visibility !== current.visibility) {
      staleCleanups.push({
        fileId: id,
        visibility: current.visibility,
        storageKey: current.storage_key,
        operation: "file.update"
      });
      await trx
        .updateTable("file_references")
        .set({ is_public: visibility === "public", updated_at: new Date() })
        .where("file_id", "=", id)
        .execute();
    }

    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "file.update",
      resourceType: "file",
      resourceId: id,
      before: { name: current.name, visibility: current.visibility, revision: current.revision },
      after: { name: row.name, visibility: row.visibility, revision: row.revision },
      ipHash: actor.ipHash
    });

    const counts = await referenceCounts(trx, [id]);
    return fileView(row, counts.get(id) ?? 0);
    });
  } catch (error) {
    // 事务回滚：新目录里的副本没人引用，直接清掉；旧文件本来就没动。
    if (createdCopies.length > 0) await runCleanups(createdCopies, logger, config);
    throw error;
  }

  if (staleCleanups.length > 0) await runCleanups(staleCleanups, logger, config);
  return view;
}

export async function deleteFileRecord(
  db: Db,
  actor: Actor,
  id: string,
  baseRevision: number
): Promise<{ deleted: true }> {
  const config = getContext().config;
  const logger = getContext().logger;
  const staleCleanups: PendingCleanup[] = [];
  await db.transaction().execute(async trx => {
    const current = await getFileRow(trx, id, true);
    if (current.revision !== baseRevision) throw errors.revisionConflict(current.revision);

    // 只有「当前稿 / 线上快照 / 封面」算真正占用；history 里的 version 引用只是给版本对比看的，
    // 拿它挡住删除会让文件一旦发布过就永远删不掉（版本清理前一直 409）。删文件时这些行会跟着级联消失。
    const refs = await trx
      .selectFrom("file_references")
      .select(["usage", "owner", "target_id", "target_version"])
      .where("file_id", "=", id)
      .where("usage", "in", ["working", "published", "cover"])
      .execute();
    if (refs.length > 0) {
      throw errors.fileInUse(
        refs.map(ref => ({
          loc: ["body", "fileId"],
          msg: `${ref.owner} ${ref.target_id}（${ref.usage}）仍在引用该文件`
        }))
      );
    }

    await trx.deleteFrom("files").where("id", "=", id).execute();
    await writeAudit(trx, {
      actorUserId: actor.userId,
      action: "file.delete",
      resourceType: "file",
      resourceId: id,
      before: { name: current.name, size: Number(current.size) },
      ipHash: actor.ipHash
    });
    staleCleanups.push({
      fileId: id,
      visibility: current.visibility,
      storageKey: current.storage_key,
      operation: "file.delete"
    });
    return { deleted: true as const };
  });

  if (staleCleanups.length > 0) await runCleanups(staleCleanups, logger, config);
  return { deleted: true as const };
}

/** 发布时把私密文件复制一份公开副本；原文件保持不动。 */
export async function copyFileForPublish(
  db: Db,
  actor: Actor,
  fileId: string,
  onCreated?: (visibility: "public" | "private", storageKey: string) => void
): Promise<string> {
  const config = getContext().config;
  const source = await getFileRow(db, fileId);
  // 同一个原件只保留一份公开副本：副本 ID 由原件派生（<id>-pub），重复发布直接复用。
  // 否则每发布一次就多一份副本，而旧副本被历史版本的引用钉住、永远 409 删不掉。
  const preferredId = `${fileId}-pub`;
  const existing = await db
    .selectFrom("files")
    .select(["id", "ext", "visibility", "deleted_at"])
    .where("id", "=", preferredId)
    .executeTakeFirst();
  if (existing && existing.deleted_at === null && existing.visibility === "public" && existing.ext === source.ext) {
    return existing.id;
  }
  // 上一份副本已被删除（或扩展名变了）时不能再占派生 ID，退回随机 ID。
  const id = existing ? randomId(8) : preferredId;
  const storageKey = storageKeyFor(id, source.ext);
  await copyStoredFile(
    config,
    { visibility: source.visibility, storageKey: source.storage_key },
    { visibility: "public", storageKey }
  );
  try {
    const row = await db
      .insertInto("files")
      .values({
        id,
        name: source.name,
        ext: source.ext,
        mime: source.mime,
        kind: source.kind,
        size: Number(source.size),
        storage_key: storageKey,
        visibility: "public",
        status: "ready",
        description: source.description,
        revision: 1,
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
        created_by: actor.userId
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await writeAudit(db, {
      actorUserId: actor.userId,
      action: "file.copy-public",
      resourceType: "file",
      resourceId: row.id,
      after: { copiedFrom: fileId },
      ipHash: actor.ipHash
    });
    // 记录/审计都写成功之后才登记：外层事务若回滚，这份副本就成了孤儿，
    // 调用方需要在回滚路径上把它删掉。
    onCreated?.("public", storageKey);
    return row.id;
  } catch (error) {
    // 数据库写入或审计失败时，刚复制出来的公开副本没人会引用，
    // 留着就是一个能通过 /uploads/public/ 访问的孤儿文件。
    await removeStoredFile(config, "public", storageKey).catch(() => undefined);
    throw error;
  }
}

/**
 * 发布时把原文件翻成公开（copy-public 之外的另一条路）。
 * 返回的清理任务必须在事务提交之后执行：旧私密文件在提交前删掉，
 * 一旦事务回滚就成了"记录还在、文件没了"。
 */
export async function makeFilePublic(
  db: Db,
  actor: Actor,
  fileId: string,
  onCreated?: (visibility: "public" | "private", storageKey: string) => void
): Promise<PendingCleanup | null> {
  const config = getContext().config;
  const current = await getFileRow(db, fileId);
  if (current.visibility === "public") return null;
  const nextKey = storageKeyFor(fileId, current.ext);
  // 先准备目标公开副本，再改记录；原私密文件在整个过程中保持不动。
  await copyStoredFile(
    config,
    { visibility: current.visibility, storageKey: current.storage_key },
    { visibility: "public", storageKey: nextKey }
  );
  try {
    await db
      .updateTable("files")
      .set({
        visibility: "public",
        storage_key: nextKey,
        revision: current.revision + 1,
        updated_at: new Date()
      })
      .where("id", "=", fileId)
      .execute();
    await db
      .updateTable("file_references")
      .set({ is_public: true, updated_at: new Date() })
      .where("file_id", "=", fileId)
      .execute();
    await writeAudit(db, {
      actorUserId: actor.userId,
      action: "file.make-public",
      resourceType: "file",
      resourceId: fileId,
      before: { visibility: current.visibility },
      after: { visibility: "public" },
      ipHash: actor.ipHash
    });
  } catch (error) {
    await removeStoredFile(config, "public", nextKey).catch(() => undefined);
    throw error;
  }
  onCreated?.("public", nextKey);
  return {
    fileId,
    visibility: current.visibility,
    storageKey: current.storage_key,
    operation: "file.make-public"
  };
}


