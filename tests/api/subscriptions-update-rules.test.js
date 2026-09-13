// @ts-check
/**
 * PUT 订阅时 body.reminderRules 应写入并同步 legacy
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';
import * as remindersRepo from '../../src/data/reminders.repo.js';
import * as subRepo from '../../src/data/subscriptions.repo.js';

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
      JWT_SECRET: 'k',
      TIMEZONE: 'UTC'
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

describe('PUT /api/subscriptions/:id + reminderRules', () => {
  it('更新时替换规则列表', async () => {
    const cookie = await loginCookie();
    const create = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'X', expiryDate: '2026-12-01' })
      },
      env
    );
    const { subscription } = await create.json();
    const id = subscription.id;

    const put = await app.request(
      '/api/subscriptions/' + id,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'X2',
          expiryDate: '2026-12-01',
          periodValue: 1,
          periodUnit: 'month',
          reminderRules: [
            { type: 'before_expiry', value: 30, unit: 'days', isEnabled: true },
            { type: 'on_expiry', value: 0, unit: 'days', isEnabled: true }
          ]
        })
      },
      env
    );
    expect((await put.json()).success).toBe(true);

    const rules = await remindersRepo.listForSubscription(env, id);
    expect(rules).toHaveLength(2);
    expect(rules.some((r) => r.value === 30)).toBe(true);

    const sub = await subRepo.getById(env, id);
    expect(sub.reminderValue).toBe(30);
    expect(sub.name).toBe('X2');
  });

  it('非法 JSON → 400', async () => {
    const cookie = await loginCookie();
    const res = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: 'not-json'
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it('GET 不存在 → 404', async () => {
    const cookie = await loginCookie();
    const res = await app.request(
      '/api/subscriptions/no-such',
      { headers: { Cookie: cookie } },
      env
    );
    expect(res.status).toBe(404);
  });
});
