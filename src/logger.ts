import { pino, type Logger } from "pino";

/** 脚本与独立进程使用的日志器；Fastify 内部使用它自己的 `app.log`（同样是 pino）。 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.cookie",
        "req.headers.authorization",
        "*.password",
        "*.passwordHash",
        "*.refreshToken",
        "*.accessToken"
      ],
      censor: "[redacted]"
    }
  });
}
