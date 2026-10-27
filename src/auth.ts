import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 管理员账号（最小多用户方案）：
 * - 账号来自环境变量 ADMIN_USERS（格式："用户名:密码,用户名2:密码2"），加账号 = 改配置重启，无需用户表
 * - 登录签发 `${username}.${HMAC(password, username)}` 格式的 httpOnly cookie，密码本身不出现在 cookie
 * - 未配置 ADMIN_USERS 时鉴权关闭（本地开发零打扰，人人都是管理员）
 * - 定位是"个人作品集站点的少量管理员"，真正的多用户注册体系等到有需求再上
 */

export function getAdminUsers(): Map<string, string> {
  const raw = process.env.ADMIN_USERS || '';
  return new Map(
    raw.split(',').filter(Boolean).map((pair) => {
      const idx = pair.indexOf(':');
      return [pair.slice(0, idx).trim(), pair.slice(idx + 1)];
    }),
  );
}

export function authEnabled(): boolean {
  return getAdminUsers().size > 0;
}

export function checkPassword(username: string, password: string): boolean {
  return getAdminUsers().get(username) === password;
}

/** token = `${username}.${HMAC(password, username)}`——绑定用户名，伪造用户名无法通过校验 */
export function makeToken(username: string): string {
  const password = getAdminUsers().get(username) ?? '';
  return `${username}.${createHmac('sha256', password).update(username).digest('hex')}`;
}

/** 校验通过返回用户名，否则 undefined */
export function verifyToken(token: string | undefined): string | undefined {
  if (!authEnabled()) return 'admin'; // 鉴权未启用：视为管理员
  if (!token) return undefined;
  const dot = token.indexOf('.');
  if (dot <= 0) return undefined;
  const username = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const password = getAdminUsers().get(username);
  if (!password) return undefined;
  const expected = createHmac('sha256', password).update(username).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? username : undefined;
  } catch {
    return undefined;
  }
}
