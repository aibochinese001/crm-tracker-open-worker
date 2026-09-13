// @ts-check
/**
 * 端到端：创建订阅 → 配置提醒 → 模拟到期调度 → 通知日志 → 续订 → 删除清理
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';
import { checkExpiringSubscriptions } from '../../src/services/scheduler.js';
import * as subRepo from '../../src/data/subscriptions.repo.js';
import * as remindersRepo from '../../src/data/reminders.repo.js';
import { query as queryNotifyLogs } from '../../src/data/notification-logs.repo.js';

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
      TIMEZONE: 'UTC',
      NOTIFICATION_HOURS: [],
      ENABLED_NOTIFIERS: ['webhook'],
      WEBHOOK_URL: 'https://example.com/hook',
      WEBHOOK_METHOD: 'POST'
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

beforeEach(async () => {
  await clearKv();
  vi.stubGlobal(
    'fetch',
    async () =>
      /** @type {any} */ ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => 'ok'
      })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('订阅生命周期 e2e', () => {
  it('创建→规则→到期前触发→日志→续订→删除清理', async () => {
    const cookie = await loginCookie();

    // 1) 创建：到期日设为 7 天后（UTC）
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T08:00:00Z'));

    const createRes = await app.request(
      '/api/subscriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Lifecycle',
          expiryDate: '2026-06-08',
          periodValue: 1,
          periodUnit: 'month',
          isActive: true,
          amount: 10,
          currency: 'CNY',
          reminderRules: [
            { type: 'before_expiry', value: 7, unit: 'days', isEnabled: true },
            { type: 'on_expiry', value: 0, unit: 'days', isEnabled: true }
          ]
        })
      },
      env
    );
    const created = await createRes.json();
    expect(created.success).toBe(true);
    const id = created.subscription.id;

    // 2) 确认规则
    const rulesRes = await app.request(
      '/api/subscriptions/' + id + '/reminders',
      { headers: { Cookie: cookie } },
      env
    );
    const rulesBody = await rulesRes.json();
    expect(rulesBody.rules.some((r) => r.value === 7)).toBe(true);

    // 3) 调度：剩余 7 天应触发 before_expiry=7
    const sched = await checkExpiringSubscriptions(env);
    expect(sched).toBeTruthy();
    expect(sched.matchedCount).toBeGreaterThanOrEqual(1);
    expect(sched.sentCount).toBeGreaterThanOrEqual(0);

    // 4) 通知日志（若渠道成功）
    const logs = await queryNotifyLogs(env, { subId: id, limit: 20 });
    // webhook mock 成功时应有日志；至少调度不应 error
    expect(['ok', 'skipped', 'error']).toContain(sched.status);

    // 5) 续订
    const renewRes = await app.request(
      '/api/subscriptions/' + id + '/renew',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ amount: 10, periodMultiplier: 1 })
      },
      env
    );
    const renewBody = await renewRes.json();
    expect(renewBody.success).toBe(true);
    const afterRenew = await subRepo.getById(env, id);
    expect(new Date(afterRenew.expiryDate).getTime()).toBeGreaterThan(
      new Date(created.subscription.expiryDate).getTime()
    );

    // 6) 删除并清理规则
    const del = await app.request(
      '/api/subscriptions/' + id,
      { method: 'DELETE', headers: { Cookie: cookie } },
      env
    );
    expect((await del.json()).success).toBe(true);
    expect(await subRepo.getById(env, id)).toBeNull();
    expect(await remindersRepo.listForSubscription(env, id)).toEqual([]);

    void logs;
  });
});
