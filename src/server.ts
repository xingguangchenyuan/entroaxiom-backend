import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write("配置校验失败，进程退出：\n");
      for (const problem of error.problems) process.stderr.write(` - ${problem}\n`);
      process.exit(1);
    }
    throw error;
  }

  const app = await buildApp({ config });
  let closing = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "收到退出信号，开始优雅关闭");
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "关闭过程中出错");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { host: config.host, port: config.port, env: config.nodeEnv },
    "entroaxiom api 已启动"
  );
}

main().catch(error => {
  process.stderr.write(`启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
