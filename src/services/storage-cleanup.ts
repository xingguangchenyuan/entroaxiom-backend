import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config.js";
import { removeStoredFile } from "./storage.js";

export type StoredVisibility = "public" | "private";

/**
 * 一次"提交成功之后才该执行"的物理文件清理。
 *
 * 数据库事务没法回滚磁盘操作：如果先删文件再提交，一旦提交失败，
 * 记录回滚了而文件已经没了，就变成"数据库指向一个不存在的文件"。
 * 所以统一改成先记下待删路径，等事务确定提交再删；
 * 删除失败最坏也只是留下孤儿文件，不会破坏已经一致的数据，但必须留日志。
 */
export interface PendingCleanup {
  fileId: string;
  visibility: StoredVisibility;
  storageKey: string;
  operation: string;
}

export async function runCleanups(
  cleanups: PendingCleanup[],
  logger: FastifyBaseLogger,
  config: AppConfig
): Promise<void> {
  for (const cleanup of cleanups) {
    try {
      await removeStoredFile(config, cleanup.visibility, cleanup.storageKey);
    } catch (error) {
      // 只记录文件 id 与路径，不涉及请求体、口令、Cookie、token。
      logger.error(
        {
          err: error,
          fileId: cleanup.fileId,
          visibility: cleanup.visibility,
          storageKey: cleanup.storageKey,
          operation: cleanup.operation
        },
        "清理旧存储文件失败，已保留孤儿文件"
      );
    }
  }
}