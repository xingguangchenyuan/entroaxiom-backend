import type { Executor } from "../db/index.js";

export interface Actor {
  userId: string;
  ipHash: string | null;
}

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  before?: unknown;
  after?: unknown;
  ipHash?: string | null;
}

function encode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** 审计日志是"谁在什么时候改了什么"的唯一记录，写入失败会连带业务事务一起回滚。 */
export async function writeAudit(exec: Executor, entry: AuditEntry): Promise<void> {
  await exec
    .insertInto("audit_logs")
    .values({
      actor_user_id: entry.actorUserId,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId,
      before_json: encode(entry.before),
      after_json: encode(entry.after),
      ip_hash: entry.ipHash ?? null,
      created_at: new Date()
    })
    .execute();
}

