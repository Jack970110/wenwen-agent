import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求级 RAG 作用域：把"当前请求者的检索边界"（如游客只能搜公开库）
 * 从 HTTP 层透传到工具执行层，不用把身份参数层层传递。
 * ALS 会在 async/await 链路中自动保持上下文。
 */
export const ragScope = new AsyncLocalStorage<{ onlyPublic?: boolean }>();
