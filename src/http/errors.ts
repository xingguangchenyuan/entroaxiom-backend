export interface FieldError {
  loc: Array<string | number>;
  msg: string;
}

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_CREDENTIALS"
  | "INVALID_REFRESH_TOKEN"
  | "SESSION_EXPIRED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "FILE_IN_USE"
  | "CONTENT_REJECTED"
  | "CHECK_EXPIRED"
  | "CHECK_MISMATCH"
  | "CONFIRM_REQUIRED"
  | "DUPLICATE_ID"
  | "DUPLICATE_RULE"
  | "NOT_PUBLISHED"
  | "IMPORT_EXPIRED"
  | "ARCHIVE_TOO_LARGE"
  | "ENTRY_UNREADABLE"
  | "UNSUPPORTED_TYPE"
  | "FILE_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

/** 业务错误：由全局错误处理器翻译成统一信封，绝不以 HTTP 200 返回失败。 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly payload: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details: unknown = null, payload: unknown = null) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.payload = payload;
  }
}

export const errors = {
  validation(details: FieldError[], message = "请求参数不合法"): AppError {
    return new AppError(422, "VALIDATION_ERROR", message, details);
  },
  badRequest(code: ErrorCode, message: string, details: unknown = null): AppError {
    return new AppError(400, code, message, details);
  },
  invalidCredentials(): AppError {
    return new AppError(401, "INVALID_CREDENTIALS", "用户名或密码不正确");
  },
  invalidRefreshToken(): AppError {
    return new AppError(401, "INVALID_REFRESH_TOKEN", "登录状态已失效，请重新登录");
  },
  sessionExpired(): AppError {
    return new AppError(401, "SESSION_EXPIRED", "登录已过期，请重新登录");
  },
  unauthorized(message = "请先登录"): AppError {
    return new AppError(401, "UNAUTHORIZED", message);
  },
  forbidden(message = "没有权限执行该操作"): AppError {
    return new AppError(403, "FORBIDDEN", message);
  },
  notFound(message = "内容不存在"): AppError {
    return new AppError(404, "NOT_FOUND", message);
  },
  revisionConflict(currentRevision: number | null): AppError {
    return new AppError(409, "REVISION_CONFLICT", "这份内容已被更新的改动覆盖，请先对比后再保存", null, { currentRevision });
  },
  fileInUse(details: unknown): AppError {
    return new AppError(409, "FILE_IN_USE", "该文件仍被内容引用，无法删除", details);
  },
  contentRejected(message: string): AppError {
    return new AppError(400, "CONTENT_REJECTED", message);
  },
  checkExpired(): AppError {
    return new AppError(409, "CHECK_EXPIRED", "预检结果已过期，请重新检查后再发布");
  },
  checkMismatch(message = "预检结果与当前内容不一致，请重新检查"): AppError {
    return new AppError(409, "CHECK_MISMATCH", message);
  },
  confirmRequired(): AppError {
    return new AppError(409, "CONFIRM_REQUIRED", "发布前需要在预检结果中确认");
  },
  duplicateId(): AppError {
    return new AppError(409, "DUPLICATE_ID", "已存在相同 ID 的内容");
  },
  duplicateRule(): AppError {
    return new AppError(409, "DUPLICATE_RULE", "已存在相同的过滤规则");
  },
  notPublished(): AppError {
    return new AppError(404, "NOT_PUBLISHED", "这篇内容还没有发布");
  },
  importExpired(): AppError {
    return new AppError(410, "IMPORT_EXPIRED", "导入会话已过期，请重新上传");
  },
  archiveTooLarge(message: string): AppError {
    return new AppError(413, "ARCHIVE_TOO_LARGE", message);
  },
  entryUnreadable(message: string): AppError {
    return new AppError(422, "ENTRY_UNREADABLE", message);
  },
  unsupportedType(message: string): AppError {
    return new AppError(422, "UNSUPPORTED_TYPE", message);
  },
  fileTooLarge(limit: number): AppError {
    return new AppError(413, "FILE_TOO_LARGE", `文件超过 ${Math.floor(limit / 1024 / 1024)}MB 上限`);
  },
  rateLimited(message = "操作太频繁了，请稍后再试", retryAfterSeconds?: number): AppError {
    return new AppError(429, "RATE_LIMITED", message, retryAfterSeconds ? { retryAfter: retryAfterSeconds } : null);
  },
  internal(message = "服务器内部错误"): AppError {
    return new AppError(500, "INTERNAL_ERROR", message);
  }
};
