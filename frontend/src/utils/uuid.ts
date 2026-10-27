/**
 * UUID 生成：crypto.randomUUID 仅在安全上下文（HTTPS/localhost）可用，
 * 通过 http://IP 访问的部署形态没有该 API——用 getRandomValues 兜底
 * （它在非安全上下文同样可用，随机性来自 CSPRNG，不是 Math.random）。
 */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
