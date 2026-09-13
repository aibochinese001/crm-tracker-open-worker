// @ts-check
/**
 * 调度器：日规则按本地日去重；发送失败不占 dedupe；after_expiry 写 lastFire
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import { checkExpiringSubscriptions } from '../../src/services/scheduler.js';
import * as subRepo from '../../src/data/subscriptions.repo.js';
import * as remindersRepo from '../../src/data/reminders.repo.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(clearKv);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('日级去重与成功后占位', () => {
  it('日规则：同一天不同小时第二次应被 dedupe', async () => {
    vi.useFakeTimers();
    // 到期 2026-06-08，当前 6/1 → daysDiff=7
    vi.setSystemTime(new Date('2026-06-01T08:00:00Z'));
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
      id: 'day-1',
      name: 'DayRule',
      expiryDate: '2026-06-08T00:00:00.000Z',
      isActive: true,
      autoRenew: false
    });
    await remindersRepo.replaceForSubscription(env, 'day-1', [
      remindersRepo.normalizeRule({
        id: 'r7',
        type: 'before_expiry',
        value: 7,
        unit: 'days',
        isEnabled: true
      })
    ]);

    vi.stubGlobal(
      'fetch',
      async () =>
        /** @type {any} */ ({
          ok: true,
          json: async () => ({ ok: true }),
          text: async () => 'ok'
        })
    );

    const first = await checkExpiringSubscriptions(env);
    expect(first.matchedCount).toBeGreaterThanOrEqual(1);
    expect(first.sentCount).toBeGreaterThanOrEqual(1);

    // 同一天晚些时候
    vi.setSystemTime(new Date('2026-06-01T20:00:00Z'));
    const second = await checkExpiringSubscriptions(env);
    expect(second.dedupedCount).toBeGreaterThanOrEqual(1);
    expect(second.sentCount).toBe(0);
  });

  it('发送全失败时不写 dedupe，同小时可重试', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T08:00:00Z'));
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
      id: 'fail-1',
      name: 'FailSend',
      expiryDate: '2026-06-08T00:00:00.000Z',
      isActive: true,
      autoRenew: false
    });
    await remindersRepo.replaceForSubscription(env, 'fail-1', [
      remindersRepo.normalizeRule({
        id: 'r7',
        type: 'before_expiry',
        value: 7,
        unit: 'days',
        isEnabled: true
      })
    ]);

    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls === 1) {
        return /** @type {any} */ ({
          ok: false,
          status: 500,
          json: async () => ({ error: 'down' }),
          text: async () => 'down'
        });
      }
      return /** @type {any} */ ({
        ok: true,
        json: async () => ({ ok: true }),
        text: async () => 'ok'
      });
    });

    const first = await checkExpiringSubscriptions(env);
    expect(first.sentCount).toBe(0);

    const second = await checkExpiringSubscriptions(env);
    expect(second.dedupedCount).toBe(0);
    expect(second.sentCount).toBeGreaterThanOrEqual(1);
  });

  it('after_expiry：成功后写 lastFire，间隔内不再匹配发送', async () => {
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
      id: 'ae-1',
      name: 'After',
      expiryDate: '2026-06-01T00:00:00.000Z',
      isActive: true,
      autoRenew: false
    });
    await remindersRepo.replaceForSubscription(env, 'ae-1', [
      remindersRepo.normalizeRule({
        id: 'ra',
        type: 'after_expiry',
        value: 0,
        unit: 'days',
        repeatInterval: 24,
        isEnabled: true
      })
    ]);
    vi.stubGlobal(
      'fetch',
      async () =>
        /** @type {any} */ ({
          ok: true,
          json: async () => ({}),
          text: async () => 'ok'
        })
    );

    const first = await checkExpiringSubscriptions(env);
    expect(first.matchedCount).toBeGreaterThanOrEqual(1);
    expect(first.sentCount).toBeGreaterThanOrEqual(1);

    // +2 小时仍在 24h 间隔内，且不同小时桶
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    const second = await checkExpiringSubscriptions(env);
    // shouldFire 因 lastFire 拒绝 → matched 可为 0
    expect(second.sentCount).toBe(0);
  });
});
