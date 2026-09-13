// @ts-check
/**
 * 调度器集成测试
 *
 * 4 个核心场景（修复 #91 / #52 / #166）：
 * 1. UTC 0点 + TZ Asia/Shanghai + NOTIFICATION_HOURS=["08"] + 北京 8 点 → 应发送
 * 2. 同上但 NOTIFICATION_HOURS=["00"] → 不发送
 * 3. 多规则订阅（7/3/1/当天）：到期前 3 天 → 仅命中 value:3
 * 4. 同规则同小时第二次调用 → 去重跳过
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';

import { checkExpiringSubscriptions } from '../../src/services/scheduler.js';
import * as subRepo from '../../src/data/subscriptions.repo.js';
import * as remindersRepo from '../../src/data/reminders.repo.js';
import { getRecent } from '../../src/data/scheduler-logs.repo.js';
import { query as queryNotifyLogs } from '../../src/data/notification-logs.repo.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

/** 写入一条系统配置 */
async function setConfig(cfg) {
  await env.SUBSCRIPTIONS_KV.put('config', JSON.stringify(cfg));
}

/** mock fetch 返回 Telegram 成功 */
function mockTelegramOk() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

beforeEach(async () => {
  await clearKv();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('调度器 - 时区 + 通知时段', () => {
  it('场景1：UTC 0点 + TZ Asia/Shanghai + NOTIFICATION_HOURS=[08] + 北京 8 点 → 发送', async () => {
    // mock 当前时间为 UTC 2026-05-24 00:00 = 北京 5/24 08:00
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T00:00:00.000Z'));

    await setConfig({
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'password',
      JWT_SECRET: 'secret',
      TIMEZONE: 'Asia/Shanghai',
      NOTIFICATION_HOURS: ['08'],
      ENABLED_NOTIFIERS: ['telegram'],
      TG_BOT_TOKEN: 'B',
      TG_CHAT_ID: 'C'
    });

    // 一条订阅，5 月 31 日北京时间到期，距今 7 天
    await subRepo.save(env, {
      id: 's-netflix',
      name: 'Netflix',
      isActive: true,
      autoRenew: false,
      expiryDate: '2026-05-31T03:00:00.000Z', // 北京 5/31 11:00 → 距 5/24 7 天
      currency: 'CNY',
      periodValue: 1,
      periodUnit: 'month',
      reminderUnit: 'day',
      reminderValue: 7
    });
    await remindersRepo.replaceForSubscription(env, 's-netflix', [
      remindersRepo.normalizeRule({ type: 'before_expiry', value: 7, unit: 'days' })
    ]);

    const fetchSpy = mockTelegramOk();
    const log = await checkExpiringSubscriptions(env);
    expect(log.status).toBe('ok');
    expect(log.sentCount).toBe(1);
    expect(log.matchedCount).toBe(1);
    expect(log.dedupedCount).toBe(0);
    expect(log.timezone).toBe('Asia/Shanghai');
    expect(log.currentHour).toBe('08');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('场景2：同样设置但 NOTIFICATION_HOURS=[00] → 跳过不发送', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T00:00:00.000Z')); // 北京 08:00

    await setConfig({
      JWT_SECRET: 's',
      TIMEZONE: 'Asia/Shanghai',
      NOTIFICATION_HOURS: ['00'], // 用户配的是北京 0 点
      ENABLED_NOTIFIERS: ['telegram'],
      TG_BOT_TOKEN: 'B',
      TG_CHAT_ID: 'C'
    });
    await subRepo.save(env, {
      id: 's-x',
      name: 'X',
      isActive: true,
      autoRenew: false,
      expiryDate: '2026-05-31T00:00:00Z',
      currency: 'CNY',
      reminderUnit: 'day',
      reminderValue: 7
    });

    const fetchSpy = mockTelegramOk();
    const log = await checkExpiringSubscriptions(env);
    expect(log.status).toBe('skipped');
    expect(log.inWindow).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('场景3：多规则订阅（7/3/1/0），到期前 3 天 → 仅 value=3 命中', async () => {
    // 北京 5/24 08:00 → 到期 5/27 11:00 北京 → 距 3 天
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T00:00:00.000Z'));

    await setConfig({
      JWT_SECRET: 's',
      TIMEZONE: 'Asia/Shanghai',
      NOTIFICATION_HOURS: [],
      ENABLED_NOTIFIERS: ['telegram'],
      TG_BOT_TOKEN: 'B',
      TG_CHAT_ID: 'C'
    });
    await subRepo.save(env, {
      id: 's-multi',
      name: 'Multi',
      isActive: true,
      autoRenew: false,
      expiryDate: '2026-05-27T03:00:00.000Z'
    });
    await remindersRepo.replaceForSubscription(env, 's-multi', [
      remindersRepo.normalizeRule({ type: 'before_expiry', value: 7, unit: 'days' }),
      remindersRepo.normalizeRule({ type: 'before_expiry', value: 3, unit: 'days' }),
      remindersRepo.normalizeRule({ type: 'before_expiry', value: 1, unit: 'days' }),
      remindersRepo.normalizeRule({ type: 'on_expiry', value: 0, unit: 'days' })
    ]);

    mockTelegramOk();
    const log = await checkExpiringSubscriptions(env);
    expect(log.matchedCount).toBe(1); // 只命中 value=3
    expect(log.sentCount).toBe(1);
    expect(log.extra.candidates).toHaveLength(1);
    expect(log.extra.candidates[0].ruleValue).toBe(3);
  });

  it('场景4：同规则同小时第二次调用 → 去重跳过', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T00:00:00.000Z'));
    await setConfig({
      JWT_SECRET: 's',
      TIMEZONE: 'Asia/Shanghai',
      NOTIFICATION_HOURS: [],
      ENABLED_NOTIFIERS: ['telegram'],
      TG_BOT_TOKEN: 'B',
      TG_CHAT_ID: 'C'
    });
    await subRepo.save(env, {
      id: 's-dedupe',
      name: 'Dedupe',
      isActive: true,
      autoRenew: false,
      expiryDate: '2026-05-25T03:00:00.000Z'
    });
    await remindersRepo.replaceForSubscription(env, 's-dedupe', [
      remindersRepo.normalizeRule({ type: 'before_expiry', value: 1, unit: 'days' })
    ]);

    const fetchSpy = mockTelegramOk();

    const log1 = await checkExpiringSubscriptions(env);
    expect(log1.sentCount).toBe(1);
    expect(log1.dedupedCount).toBe(0);

    const log2 = await checkExpiringSubscriptions(env);
    expect(log2.sentCount).toBe(0);
    expect(log2.dedupedCount).toBe(1);
    expect(log2.matchedCount).toBe(1);

    expect(fetchSpy).toHaveBeenCalledTimes(1); // 只发了一次
  });

  it('场景5：NOTIFICATION_HOURS=["*"] 通配符不应被 padStart 误处理为 "0*"', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T00:00:00.000Z'));
    await setConfig({
      JWT_SECRET: 's',
      TIMEZONE: 'Asia/Shanghai',
      NOTIFICATION_HOURS: ['*'],
      ENABLED_NOTIFIERS: ['telegram'],
      TG_BOT_TOKEN: 'B',
      TG_CHAT_ID: 'C'
    });
    await subRepo.save(env, {
      id: 's-wc',
      name: 'WC',
      isActive: true,
      autoRenew: false,
      expiryDate: '2026-05-25T03:00:00.000Z'
    });
    await remindersRepo.replaceForSubscription(env, 's-wc', [
      remindersRepo.normalizeRule({ type: 'before_expiry', value: 1, unit: 'days' })
    ]);

    mockTelegramOk();
    const log = await checkExpiringSubscriptions(env);
    expect(log.inWindow).toBe(true);
    expect(log.configuredHours).toEqual(['*']);
    expect(log.sentCount).toBe(1);
  });
});

describe('调度器 - 自动续订', () => {
  it('已过期 + autoRenew=true → 推进到期日 + 写 auto 支付记录', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T00:00:00.000Z'));

    await setConfig({
      JWT_SECRET: 's',
      TIMEZONE: 'Asia/Shanghai',
      NOTIFICATION_HOURS: [],
      ENABLED_NOTIFIERS: []
    });
    await subRepo.save(env, {
      id: 's-renew',
      name: 'Renew',
      isActive: true,
      autoRenew: true,
      subscriptionMode: 'cycle',
      expiryDate: '2026-04-01T00:00:00.000Z', // 已过期 ~1.5 月
      periodValue: 1,
      periodUnit: 'month',
      amount: 10,
      currency: 'CNY',
      paymentHistory: []
    });

    const log = await checkExpiringSubscriptions(env);
    expect(log.autoRenewedCount).toBe(1);

    const next = await subRepo.getById(env, 's-renew');
    expect(new Date(next.expiryDate).getTime()).toBeGreaterThan(Date.now());
    expect(next.paymentHistory.length).toBeGreaterThan(0);
    expect(next.paymentHistory[next.paymentHistory.length - 1].type).toBe('auto');
  });
});

describe('调度器 - 写入日志', () => {
  it('每次执行都写一条 sched_log', async () => {
    await setConfig({
      JWT_SECRET: 's',
      TIMEZONE: 'UTC',
      NOTIFICATION_HOURS: [],
      ENABLED_NOTIFIERS: []
    });

    await checkExpiringSubscriptions(env);
    const logs = await getRecent(env, 5);
    expect(logs).toHaveLength(1);
  });

  it('成功发送时写 notify_log', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T00:00:00.000Z'));
    await setConfig({
      JWT_SECRET: 's',
      TIMEZONE: 'Asia/Shanghai',
      NOTIFICATION_HOURS: [],
      ENABLED_NOTIFIERS: ['telegram'],
      TG_BOT_TOKEN: 'B',
      TG_CHAT_ID: 'C'
    });
    await subRepo.save(env, {
      id: 's-log',
      name: 'L',
      isActive: true,
      autoRenew: false,
      expiryDate: '2026-05-25T03:00:00.000Z'
    });
    await remindersRepo.replaceForSubscription(env, 's-log', [
      remindersRepo.normalizeRule({ type: 'before_expiry', value: 1, unit: 'days' })
    ]);

    mockTelegramOk();
    await checkExpiringSubscriptions(env);

    const notifyLogs = await queryNotifyLogs(env, { subId: 's-log' });
    expect(notifyLogs).toHaveLength(1);
    expect(notifyLogs[0].channel).toBe('telegram');
    expect(notifyLogs[0].status).toBe('success');
  });
});
