import pino from 'pino';

/**
 * 结构化日志（pino）：
 * - 生产（NODE_ENV=production）输出单行 JSON 到 stdout——12-factor：收集交给部署层（docker logs / logrotate）
 * - 开发走 pino-pretty 人读格式（可 LOG_PRETTY=false 关闭）
 * - LOG_LEVEL 控制噪音（默认 info，开发期可 debug）
 *
 * 纪律：
 * - mcp-server.ts（stdio 传输）禁用本模块——stdout 是协议通道，它保持 console.error(stderr)
 * - CLI（index.ts / ingest.ts）不接本模块——那是终端 UI，不是日志
 * - 进度类数据（摘要 x/y）走轮询 API 给前端，不走日志
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV === 'production' || process.env.LOG_PRETTY === 'false'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

/** 按模块划分子 logger：字段自动携带，检索时可按 module 过滤 */
export const ingestLog = logger.child({ module: 'ingest' });
export const summaryLog = logger.child({ module: 'summary' });
export const retrieveLog = logger.child({ module: 'retrieve' });
export const chatLog = logger.child({ module: 'chat' });
export const authLog = logger.child({ module: 'auth' });
