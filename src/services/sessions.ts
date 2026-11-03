import type { Executor } from "../db/index.js";
import { hmacSha256Hex, randomToken, sha256Hex } from "../lib/crypto.js";
import { addHours, nowIso } from "../lib/time.js";
import type { AppConfig } from "../config.js";

export interface SessionUser {
  id: string;
  username: string;
  nickname: string;
  avatar: string | null;
  roles: string[];
  permissions: string[];
}

export interface SessionContext {
  sessionId: string;
  expiresAt: Date;
  user: SessionUser;
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(item => String(item));
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map(item => String(item));
    } catch {
      return [];
    }
  }
  return [];
}

export async function createSession(
  exec: Executor,
  config: AppConfig,
  input: { userId: string; ip: string; userAgent: string | null }
): Promise<CreatedSession> {
  const token = randomToken(32);
  const expiresAt = addHours(new Date(), config.sessionTtlHours);
  const inserted = await exec
    .insertInto("sessions")
    .values({
      token_hash: sha256Hex(token),
      user_id: input.userId,
      expires_at: expiresAt,
      last_seen_at: new Date(),
      revoked_at: null,
      created_ip_hash: hmacSha256Hex(config.ipHashSecret, input.ip),
      user_agent: input.userAgent ? input.userAgent.slice(0, 300) : null,
      created_at: new Date()
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { token, sessionId: inserted.id, expiresAt };
}

/**
 * 解析会话：校验 token 哈希、过期时间、空闲超时、吊销状态与账号禁用状态。
 * 空闲时间超过 60 秒才更新 last_seen_at，避免每个请求都写库。
 */
export async function resolveSession(
  db: Executor,
  config: AppConfig,
  token: string
): Promise<SessionContext | null> {
  if (!token) return null;
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select([
      "sessions.id as session_id",
      "sessions.expires_at as expires_at",
      "sessions.last_seen_at as last_seen_at",
      "sessions.revoked_at as revoked_at",
      "users.id as user_id",
      "users.username as username",
      "users.nickname as nickname",
      "users.avatar as avatar",
      "users.roles as roles",
      "users.permissions as permissions",
      "users.disabled_at as disabled_at"
    ])
    .where("sessions.token_hash", "=", sha256Hex(token))
    .executeTakeFirst();

  if (!row) return null;
  const now = Date.now();
  if (row.revoked_at) return null;
  if (row.disabled_at) return null;
  if (new Date(row.expires_at).getTime() <= now) return null;
  const idleDeadline = new Date(row.last_seen_at).getTime() + config.sessionIdleHours * 3600_000;
  if (idleDeadline <= now) return null;

  if (now - new Date(row.last_seen_at).getTime() > 60_000) {
    await db
      .updateTable("sessions")
      .set({ last_seen_at: new Date() })
      .where("id", "=", row.session_id)
      .execute();
  }

  return {
    sessionId: row.session_id,
    expiresAt: new Date(row.expires_at),
    user: {
      id: row.user_id,
      username: row.username,
      nickname: row.nickname,
      avatar: row.avatar,
      roles: parseJsonArray(row.roles),
      permissions: parseJsonArray(row.permissions)
    }
  };
}

/** 吊销会话；返回是否真的吊销（false 表示已被别的请求抢先吊销或不存在）。 */
export async function revokeSession(exec: Executor, sessionId: string): Promise<boolean> {
  const result = await exec
    .updateTable("sessions")
    .set({ revoked_at: new Date() })
    .where("id", "=", sessionId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * 刷新即轮换：旧会话以 `revoked_at is null` 为条件原子吊销，只有真正吊销成功的
 * 那个请求才能创建新会话。并发 refresh 时，失败者拿到 null，调用方应返回
 * INVALID_REFRESH_TOKEN 并且不下发 Cookie。必须在同一个事务里调用，保证
 * 「旧会话已吊销」与「新会话已创建」要么都成立、要么都不发生。
 */
export async function rotateSession(
  exec: Executor,
  config: AppConfig,
  input: { sessionId: string; userId: string; ip: string; userAgent: string | null }
): Promise<CreatedSession | null> {
  const revoked = await revokeSession(exec, input.sessionId);
  if (!revoked) return null;
  return createSession(exec, config, input);
}

export function sessionResponseToken(config: AppConfig, created: CreatedSession): string {
  return created.token;
}

export function nowStamp(): string {
  return nowIso();
}

