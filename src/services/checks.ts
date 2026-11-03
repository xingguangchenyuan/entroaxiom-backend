import type { Executor } from "../db/index.js";
import { errors } from "../http/errors.js";
import { randomId } from "../lib/crypto.js";
import { addMinutes } from "../lib/time.js";

export type CheckSubjectType = "article" | "shelf";
export type CheckAction = "publish" | "visibility";

export interface CheckScope {
  userId: string;
  subjectType: CheckSubjectType;
  subjectId: string;
  action: CheckAction;
  targetVisibility: "public" | "private" | null;
  baseRevision: number;
  privateAssetIds: string[];
}

export interface CheckHandle {
  checkId: string;
  expiresAt: Date;
}

export const CHECK_TTL_MINUTES = 5;

function sortedIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

function sameIds(left: string[], right: string[]): boolean {
  const a = sortedIds(left);
  const b = sortedIds(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * 预检凭据就是"站长看过这份检查结果"的签名：
 * 它绑定用户、对象、动作、目标可见性、revision 和当时的私密资源集合。
 * 任意一项变了，旧凭据立即失效，必须重新预检。
 */
export async function createCheck(
  exec: Executor,
  scope: CheckScope,
  checks: unknown
): Promise<CheckHandle> {
  const expiresAt = addMinutes(new Date(), CHECK_TTL_MINUTES);
  const inserted = await exec
    .insertInto("publication_checks")
    .values({
      id: randomId(16),
      user_id: scope.userId,
      subject_type: scope.subjectType,
      subject_id: scope.subjectId,
      action: scope.action,
      target_visibility: scope.targetVisibility,
      base_revision: scope.baseRevision,
      private_asset_ids: sortedIds(scope.privateAssetIds),
      checks: JSON.stringify(checks),
      expires_at: expiresAt,
      consumed_at: null,
      created_at: new Date()
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { checkId: inserted.id, expiresAt };
}

/**
 * 预检结果里只要还有 severity=error 的条目，就不允许消费凭据。
 *
 * 前端拿到的 canProceed 只是提示，服务端必须以落库的 checks 为准：
 * 否则调用方完全可以无视预检结果，直接调发布接口把有错误的稿子发出去。
 * 解析失败、或结构不是数组时同样按"不可信"处理——宁可直接拒绝。
 * 这里抛错发生在写 consumed_at 之前，所以凭据不会被消耗，
 * 修正内容后可以重新预检再用。
 */
function assertNoBlockingChecks(raw: unknown): void {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw errors.checkMismatch("预检结果无法解析，请重新预检");
    }
  }
  if (!Array.isArray(parsed)) {
    throw errors.checkMismatch("预检结果格式不正确，请重新预检");
  }
  const blocking = parsed.filter(item => {
    if (!item || typeof item !== "object") return false;
    return (item as { severity?: unknown }).severity === "error";
  });
  if (blocking.length === 0) return;
  const first = blocking[0] as { message?: unknown };
  const reason =
    typeof first.message === "string" && first.message.trim() ? first.message.trim() : "存在未解决的错误";
  throw errors.checkMismatch(`预检未通过：${reason}。请修正后重新预检`);
}

/**
 * 消费预检凭据。必须在业务事务里调用：校验与置位一次完成，
 * 这样并发发布只有一个能成功，另一个必然拿到 CHECK_MISMATCH。
 */
export async function consumeCheck(
  exec: Executor,
  input: CheckScope & { checkId: string }
): Promise<void> {
  const row = await exec
    .selectFrom("publication_checks")
    .selectAll()
    .where("id", "=", input.checkId)
    .forUpdate()
    .executeTakeFirst();

  if (!row) throw errors.checkMismatch("预检凭据不存在，请重新预检");
  if (row.consumed_at) throw errors.checkMismatch("预检凭据已被使用，请重新预检");
  if (row.user_id !== input.userId) throw errors.checkMismatch("预检凭据不属于当前账号");
  if (row.subject_type !== input.subjectType || row.subject_id !== input.subjectId) {
    throw errors.checkMismatch("预检凭据对应的内容已变化，请重新预检");
  }
  if (row.action !== input.action) throw errors.checkMismatch("预检动作不一致，请重新预检");
  if (row.base_revision !== input.baseRevision) {
    throw errors.revisionConflict(row.base_revision);
  }
  if (row.target_visibility !== null && row.target_visibility !== input.targetVisibility) {
    throw errors.checkMismatch("目标可见性与预检时不一致，请重新预检");
  }
  if (!sameIds(row.private_asset_ids ?? [], input.privateAssetIds)) {
    throw errors.checkMismatch("私密资源已变化，请重新预检");
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw errors.checkExpired();
  }

  // 预检当时就有 error 的，说明内容还没准备好；这里再挡一次，
  // 不依赖前端是否尊重 canProceed。
  assertNoBlockingChecks(row.checks);

  await exec
    .updateTable("publication_checks")
    .set({ consumed_at: new Date() })
    .where("id", "=", input.checkId)
    .execute();
}

