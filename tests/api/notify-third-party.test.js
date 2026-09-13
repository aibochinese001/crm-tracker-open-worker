// @ts-check
/**
 * 第三方 /api/notify/:token — 不依赖管理员 JWT
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(async () => {
  await clearKv();
  vi.stubGlobal(
    'fetch',
    async () =>
      /** @type {any} */ ({
        ok: true,
        json: async () => ({ ok: true }),
        text: async () => 'ok'
      })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/notify/:token', () => {
  it('未配置 token → 403（无需登录）', async () => {
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({ JWT_SECRET: 'k', THIRD_PARTY_API_TOKEN: '' })
    );
    const res = await app.request(
      '/api/notify/any',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hi' })
      },
      env
    );
    expect(res.status).toBe(403);
  });

  it('错误 token → 401', async () => {
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({
        JWT_SECRET: 'k',
        THIRD_PARTY_API_TOKEN: 'good-token',
        ENABLED_NOTIFIERS: ['webhook'],
        WEBHOOK_URL: 'https://example.com/h'
      })
    );
    const res = await app.request(
      '/api/notify/bad-token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hi' })
      },
      env
    );
    expect(res.status).toBe(401);
  });

  it('正确 token 无 JWT 可发送', async () => {
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({
        JWT_SECRET: 'k',
        THIRD_PARTY_API_TOKEN: 'good-token',
        ENABLED_NOTIFIERS: ['webhook'],
        WEBHOOK_URL: 'https://example.com/h',
        WEBHOOK_METHOD: 'POST'
      })
    );
    const res = await app.request(
      '/api/notify/good-token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 't', content: 'hello from third party' })
      },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(String(body.message || '')).toMatch(/成功/);
  });
});
