import type { FastifyInstance, FastifyReply } from "fastify";
import { getContext } from "../../context.js";
import type { AppConfig } from "../../config.js";
import { errors } from "../../http/errors.js";
import { ok } from "../../http/reply.js";
import { Input } from "../../http/validation.js";
import { hmacSha256Hex, randomToken } from "../../lib/crypto.js";
import { loginLimiter } from "../../lib/rate-limit.js";
import { burnPasswordCheck, verifyPassword } from "../../lib/passwords.js";
import { writeAudit } from "../../services/audit.js";
import { createSession, resolveSession, revokeSession, rotateSession } from "../../services/sessions.js";
import { findUserByUsername } from "../../services/users.js";

const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_FAILURES = 10;

function stringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function cookieOptions(config: AppConfig, expiresAt: Date) {
  return {
    httpOnly: true,
    secure: config.publicOrigin.startsWith("https://"),
    sameSite: "strict" as const,
    path: "/",
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
  };
}

/**
 * 后台客户端会把 accessToken/refreshToken 存进可被 JS 读取的 cookie，
 * 所以这里给的是与真实会话无关的一次性随机串：真正的凭证只有 HttpOnly 的 sid。
 * 服务端完全不接受 Authorization 头，避免两套认证并存。
 */
function clientTokens() {
  return { accessToken: randomToken(24), refreshToken: randomToken(24) };
}

export async function registerAdminAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/admin/login", async (request, reply) => {
    const config = getContext().config;
    const db = getContext().db;
    const ip = request.ip;

    const gate = loginLimiter.check(`login:${ip}`, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS);
    if (!gate.allowed) {
      throw errors.rateLimited(
        `登录失败次数过多，请 ${Math.ceil(gate.retryAfterSeconds / 60)} 分钟后再试`,
        gate.retryAfterSeconds
      );
    }

    const input = new Input(request.body);
    const username = input.str("username", { required: true, max: 64, label: "用户名" });
    const password = input.str("password", { required: true, max: 200, trim: false, label: "密码" });
    input.finish();

    const user = await findUserByUsername(db, username ?? "");
    if (!user) {
      await burnPasswordCheck(password ?? "", config.passwordHashMemoryKib);
      loginLimiter.record(`login:${ip}`);
      throw errors.invalidCredentials();
    }
    const matched = await verifyPassword(user.password_hash, password ?? "", config.passwordHashMemoryKib);
    if (!matched) {
      loginLimiter.record(`login:${ip}`);
      throw errors.invalidCredentials();
    }
    if (user.disabled_at) {
      loginLimiter.record(`login:${ip}`);
      throw errors.forbidden("账号已被停用");
    }

    loginLimiter.reset(`login:${ip}`);

    const created = await createSession(db, config, {
      userId: user.id,
      ip,
      userAgent: (request.headers["user-agent"] ?? "").slice(0, 300) || null
    });

    reply.setCookie(config.sessionCookieName, created.token, cookieOptions(config, created.expiresAt));

    await writeAudit(db, {
      actorUserId: user.id,
      action: "auth.login",
      resourceType: "session",
      resourceId: created.sessionId,
      ipHash: hmacSha256Hex(config.ipHashSecret, ip)
    });

    return ok(reply, {
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar ?? "",
      roles: stringArray(user.roles, ["admin"]),
      permissions: stringArray(user.permissions, ["*:*:*"]),
      ...clientTokens(),
      expires: created.expiresAt.getTime()
    });
  });

  app.post("/api/admin/refresh-token", async (request, reply) => {
    const config = getContext().config;
    const db = getContext().db;
    const token = request.cookies[config.sessionCookieName];
    if (!token) throw errors.invalidRefreshToken();

    // 解析 + 吊销 + 新建必须在同一个事务里：并发 refresh 只允许一个成功，
    // 失败者既拿不到新 Cookie，也不会把旧会话吊销两次。
    const rotated = await db.transaction().execute(async trx => {
      const session = await resolveSession(trx, config, token);
      if (!session) return null;
      return rotateSession(trx, config, {
        sessionId: session.sessionId,
        userId: session.user.id,
        ip: request.ip,
        userAgent: ((request.headers["user-agent"] as string | undefined) ?? "").slice(0, 300) || null
      });
    });

    if (!rotated) throw errors.invalidRefreshToken();

    reply.setCookie(config.sessionCookieName, rotated.token, cookieOptions(config, rotated.expiresAt));

    return ok(reply, {
      ...clientTokens(),
      expires: rotated.expiresAt.getTime()
    });
  });

  app.post("/api/admin/logout", async (request, reply) => {
    const config = getContext().config;
    const db = getContext().db;
    const token = request.cookies[config.sessionCookieName];
    if (token) {
      const session = await resolveSession(db, config, token);
      if (session) {
        await revokeSession(db, session.sessionId);
        await writeAudit(db, {
          actorUserId: session.user.id,
          action: "auth.logout",
          resourceType: "session",
          resourceId: session.sessionId,
          ipHash: hmacSha256Hex(config.ipHashSecret, request.ip)
        });
      }
    }
    clearSessionCookie(reply, config);
    return ok(reply, null);
  });

  app.get("/api/admin/capabilities", async (_request, reply) => {
    const config = getContext().config;
    return ok(reply, {
      upload: {
        maxFileBytes: config.maxFileBytes,
        allowedKinds: ["image", "pdf", "archive", "doc", "other"],
        allowedExtensions: config.allowedExtensions,
        maxConcurrent: config.maxConcurrentUploads
      },
      import: {
        maxArchiveBytes: config.maxArchiveBytes,
        maxExpandedBytes: config.maxExpandedBytes,
        maxEntries: config.maxArchiveEntries
      },
      content: {
        maxBodyBytes: config.maxBodyBytes,
        versionRetention: config.versionRetention,
        maxTitleChars: 200,
        maxSummaryChars: 500,
        charCounting: "codepoint"
      },
      features: {
        importZip: true,
        exportZip: true,
        versionRestore: true,
        moderationTest: true,
        serverLogout: true,
        authenticatedMedia: true
      },
      policyVersion: config.moderationPolicyVersion
    });
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(config.sessionCookieName, { path: "/", httpOnly: true, sameSite: "strict" });
}

