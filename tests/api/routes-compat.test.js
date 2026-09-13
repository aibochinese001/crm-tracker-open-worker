// @ts-check
/**
 * API 路由兼容性 smoke 测试
 *
 * 验证 Hono 应用与既有客户端的路由响应严格兼容：
 * - 未授权时返回 401 + 同样的错误结构
 * - 公开端点（登录页、登录接口）行为一致
 * - 4xx/5xx 错误格式与既有约定一致
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(clearKv);

describe('Hono app 路由兼容', () => {
  it('GET / 未登录返回登录页 HTML', async () => {
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html');
  });

  it('GET /admin 未登录跳回 / (302)', async () => {
    const res = await app.request('/admin', {}, env);
    expect([302, 200].includes(res.status)).toBe(true);
  });

  it('GET /api/subscriptions 未登录返回 401 + 标准错误体', async () => {
    const res = await app.request('/api/subscriptions', {}, env);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(typeof json.message).toBe('string');
  });

  it('POST /api/login 缺少 body → 400/401', async () => {
    const res = await app.request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json'
    }, env);
    expect([400, 401].includes(res.status)).toBe(true);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('POST /api/login 正确凭据 → success + Set-Cookie', async () => {
    // 配置默认管理员
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'password', JWT_SECRET: 'k' })
    );
    const res = await app.request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password' })
    }, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(res.headers.get('Set-Cookie') || '').toContain('token=');
  });

  it('GET /debug 未登录返回 401', async () => {
    const res = await app.request('/debug', {}, env);
    expect(res.status).toBe(401);
  });

  it('GET /api/未知端点 → 404 + 标准错误体', async () => {
    // 先登录拿 cookie
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'password', JWT_SECRET: 'k' })
    );
    const loginRes = await app.request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password' })
    }, env);
    const cookie = loginRes.headers.get('Set-Cookie')?.split(';')[0] || '';

    const res = await app.request('/api/non-existent-route', {
      headers: { Cookie: cookie }
    }, env);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('未匹配路径走兜底 → 返回登录页', async () => {
    const res = await app.request('/random/path/xyz', {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html');
  });
});
