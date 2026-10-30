import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求级 RAG 作用域：把"当前请求者的检索边界与处理策略"从 HTTP 层
 * 透传到工具执行层，不用把身份/级别参数层层传递。
 * ALS 会在 async/await 链路中自动保持上下文。
 */
export interface RagScope {
  /** 游客只搜公开演示库 */
  onlyPublic?: boolean;
  /** 聚焦书的体量级别（T1 = 全文注入模式，检索工具对其无意义） */
  tier?: string;
  /** T1 聚焦书的全文（供深度模式阶段 2 直接使用） */
  fullText?: string | null;
}
export const ragScope = new AsyncLocalStorage<RagScope>();
