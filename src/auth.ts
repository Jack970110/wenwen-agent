import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 访问密码（最小可用鉴权）：
 * - 未配置 ACCESS_PASSWORD 时完全关闭（本地开发零打扰）
 * - 登录后签发 HMAC cookie（密码本身不出现在 cookie 里），30 天有效
 * - 定位是"挡住公网陌生人薅免费模型额度"，不是多用户体系——v3c 真要开账号再加
 */

export function getAuthPassword(): string | undefined {
  const pw = process.env.ACCESS_PASSWORD;
  return pw && pw.trim() ? pw.trim() : undefined;
}

export function makeToken(password: string): string {
  return createHmac('sha256', `wenwen-agent:${password}`).update('auth-v1').digest('hex');
}

export function verifyToken(token: string | undefined): boolean {
  const pw = getAuthPassword();
  if (!pw) return true; // 未启用鉴权
  if (!token) return false;
  const expected = makeToken(pw);
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false; // 长度不等等情况
  }
}

export function checkPassword(input: string): boolean {
  const pw = getAuthPassword();
  if (!pw) return true;
  return input === pw;
}
