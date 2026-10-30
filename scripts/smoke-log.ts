import { logger, ingestLog, summaryLog } from '../src/logger.js';
logger.info({ novel: '测试', tier: 'T4', chunks: 5972, embedMs: 213400 }, '向量化完成');
summaryLog.warn({ chapter: '第二十三章', err: 'content filter 1301' }, '章节摘要跳过');
ingestLog.error({ novel: '测试', totalMs: 120000, error: 'x' }, '入库失败，已回滚');
