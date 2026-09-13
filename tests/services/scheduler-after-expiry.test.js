// @ts-check
/**
 * 调度器 after_expiry 行为：当前未传 lastFireAtIso，依赖小时 dedupe 节流
 * 记录设计现状，防止静默回归
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import { checkExpiringSubscriptions } from '../../src/services/scheduler.js';
import * as subRepo from '../../src/data/subscriptions.repo.js';
import * as remindersRepo from '../../src/data/reminders.repo.js';
import { shouldFire } from '../../src/services/notify/reminder-engine.js';

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
        json: async () => ({ ok: true, code: 200 }),
        text: async () => ''
      })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('after_expiry 引擎 vs 调度器', () => {
  it('引擎：无 lastFireAtIso 时首次应 fire', () => {
    const r = shouldFire(
      {
        id: '1',
        type: 'after_expiry',
        value: 0,
        unit: 'days',
        repeatInterval: 24,
        isEnabled: true,
        createdAt: ''
      },
      { daysDiff: -1, hoursDiff: -10, nowIso: '2026-06-10T08:00:00Z' }
    );
    expect(r.fire).toBe(true);
  });

  it('引擎：间隔内有 lastFireAtIso 不 fire', () => {
    const r = shouldFire(
      {
        id: '1',
        type: 'after_expiry',
        value: 0,
        unit: 'days',
        repeatInterval: 24,
        isEnabled: true,
        createdAt: ''
      },
      {
        daysDiff: -2,
        hoursDiff: -30,
        lastFireAtIso: '2026-06-10T00:00:00Z',
        nowIso: '2026-06-10T08:00:00Z'
      }
    );
    expect(r.fire).toBe(false);
  });

  it('调度器：已过期 + after_expiry 在窗口内会匹配（无 lastFireAtIso）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T08:00:00Z'));
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({
        TIMEZONE: 'UTC',
        NOTIFICATION_HOURS: [],
        ENABLED_NOTIFIERS: ['webhook'],
        WEBHOOK_URL: 'https://example.com/h',
        WEBHOOK_METHOD: 'POST'
      })
    );
    await subRepo.save(env, {
      id: 'expired-1',
      name: 'Expired',
      expiryDate: '2026-06-01T00:00:00.000Z',
      isActive: true,
      autoRenew: false,
      periodValue: 1,
      periodUnit: 'month'
    });
    await remindersRepo.replaceForSubscription(env, 'expired-1', [
      remindersRepo.normalizeRule({
        type: 'after_expiry',
        value: 0,
        unit: 'days',
        repeatInterval: 24,
        isEnabled: true
      })
    ]);

    const entry = await checkExpiringSubscriptions(env);
    expect(entry.matchedCount).toBeGreaterThanOrEqual(1);
  });
});
