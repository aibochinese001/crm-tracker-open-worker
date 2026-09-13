// @ts-check
/**
 * 配置读写与敏感字段脱敏
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';
import { getConfig } from '../../src/data/config.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

async function loginCookie() {
  await env.SUBSCRIPTIONS_KV.put(
    'config',
    JSON.stringify({
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'password',
      JWT_SECRET: 'secret-jwt',
      TG_BOT_TOKEN: 'bot-secret',
      TG_CHAT_ID: '111',
      TIMEZONE: 'Asia/Shanghai'
    })
  );
  const res = await app.request(
    '/api/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password' })
    },
    env
  );
  return res.headers.get('Set-Cookie')?.split(';')[0] || '';
}

beforeEach(clearKv);

describe('GET /api/config', () => {
  it('未登录 401', async () => {
    const res = await app.request('/api/config', {}, env);
    expect(res.status).toBe(401);
  });

  it('敏感字段脱敏 + CONFIGURED 标记', async () => {
    const cookie = await loginCookie();
    const res = await app.request('/api/config', { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const cfg = await res.json();
    expect(cfg.TG_BOT_TOKEN).toBe('');
    expect(cfg.TG_BOT_TOKEN_CONFIGURED).toBe(true);
    expect(cfg.JWT_SECRET).toBeUndefined();
    expect(cfg.ADMIN_PASSWORD).toBeUndefined();
    expect(cfg.TG_CHAT_ID).toBe('111');
  });
});

describe('POST /api/config', () => {
  it('空字符串不误清空已有 Token', async () => {
    const cookie = await loginCookie();
    const res = await app.request(
      '/api/config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          TG_BOT_TOKEN: '',
          TG_CHAT_ID: '222',
          TIMEZONE: 'UTC',
          ENABLED_NOTIFIERS: ['telegram']
        })
      },
      env
    );
    expect(res.status).toBe(200);
    const stored = await getConfig(env);
    expect(stored.TG_BOT_TOKEN).toBe('bot-secret');
    expect(stored.TG_CHAT_ID).toBe('222');
    expect(stored.TIMEZONE).toBe('UTC');
  });

  it('CLEAR_SECRET_FIELDS 可显式清空', async () => {
    const cookie = await loginCookie();
    await app.request(
      '/api/config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          CLEAR_SECRET_FIELDS: ['TG_BOT_TOKEN'],
          TG_CHAT_ID: '111'
        })
      },
      env
    );
    const stored = await getConfig(env);
    expect(stored.TG_BOT_TOKEN).toBe('');
  });
});
