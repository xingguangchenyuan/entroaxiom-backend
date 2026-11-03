import type { Db, Executor } from "../db/index.js";
import { hashPassword } from "../lib/passwords.js";

export interface AdminUserRow {
  id: string;
  username: string;
  password_hash: string;
  nickname: string;
  avatar: string | null;
  roles: unknown;
  permissions: unknown;
  disabled_at: Date | null;
}

export async function findUserByUsername(db: Db, username: string): Promise<AdminUserRow | null> {
  const row = await db
    .selectFrom("users")
    .select([
      "id",
      "username",
      "password_hash",
      "nickname",
      "avatar",
      "roles",
      "permissions",
      "disabled_at"
    ])
    .where("username", "=", username)
    .executeTakeFirst();
  return (row as AdminUserRow | undefined) ?? null;
}

export async function createAdminUser(
  exec: Executor,
  input: {
    username: string;
    password: string;
    nickname: string;
    memoryKib: number;
    roles?: string[];
    permissions?: string[];
  }
): Promise<string> {
  const passwordHash = await hashPassword(input.password, input.memoryKib);
  const inserted = await exec
    .insertInto("users")
    .values({
      username: input.username,
      password_hash: passwordHash,
      nickname: input.nickname,
      avatar: null,
      roles: JSON.stringify(input.roles ?? ["admin"]),
      permissions: JSON.stringify(input.permissions ?? ["*:*:*"]),
      disabled_at: null,
      created_at: new Date(),
      updated_at: new Date()
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return inserted.id;
}

export async function updateAdminPassword(
  exec: Executor,
  input: { username: string; password: string; memoryKib: number }
): Promise<boolean> {
  const passwordHash = await hashPassword(input.password, input.memoryKib);
  const result = await exec
    .updateTable("users")
    .set({ password_hash: passwordHash, updated_at: new Date() })
    .where("username", "=", input.username)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}
