// @ts-check
/**
 * 调度日志仓库单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';

import { writeLog, getRecent } from '../../src/data/scheduler-logs.repo.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(clearKv);

describe('scheduler-logs.repo', () => {
  it('writeLog → getRecent 返回 1 条', async () => {
    await writeLog(env, {
      startedAt: '2026-05-24T17:00:00.000Z',
      finishedAt: '2026-05-24T17:00:01.000Z',
      timezone: 'Asia/Shanghai',
      currentHour: '01',
      configuredHours: ['01', '08'],
      inWindow: true,
      checkedCount: 5,
      matchedCount: 2,
      dedupedCount: 0,
      sentCount: 2,
      autoRenewedCount: 0,
      status: 'ok'
    });
    const r = await getRecent(env, 10);
    expect(r).toHaveLength(1);
    expect(r[0].sentCount).toBe(2);
    expect(r[0].timezone).toBe('Asia/Shanghai');
  });

  it('getRecent 按时间倒序', async () => {
    await writeLog(env, { startedAt: '2026-05-22T00:00:00.000Z', timezone: 'UTC', currentHour: '00', status: 'ok' });
    await writeLog(env, { startedAt: '2026-05-24T00:00:00.000Z', timezone: 'UTC', currentHour: '00', status: 'ok' });
    await writeLog(env, { startedAt: '2026-05-23T00:00:00.000Z', timezone: 'UTC', currentHour: '00', status: 'ok' });
    const r = await getRecent(env, 10);
    expect(r[0].startedAt).toBe('2026-05-24T00:00:00.000Z');
    expect(r[2].startedAt).toBe('2026-05-22T00:00:00.000Z');
  });

  it('getRecent 受 limit 限制', async () => {
    for (let i = 0; i < 5; i++) {
      await writeLog(env, {
        startedAt: `2026-05-2${i}T00:00:00.000Z`,
        timezone: 'UTC',
        currentHour: '00',
        status: 'ok'
      });
    }
    const r = await getRecent(env, 2);
    expect(r).toHaveLength(2);
  });

  it('status=skipped + reason 字段保留', async () => {
    await writeLog(env, {
      startedAt: '2026-05-24T00:00:00.000Z',
      timezone: 'Asia/Shanghai',
      currentHour: '03',
      configuredHours: ['08'],
      inWindow: false,
      status: 'skipped',
      reason: 'not_in_window'
    });
    const r = await getRecent(env, 10);
    expect(r[0].status).toBe('skipped');
    expect(r[0].reason).toBe('not_in_window');
  });
});
