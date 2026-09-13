// @ts-check
/**
 * 通知日志仓库单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';

import { writeLog, query, recentForSubscription, ymdhUtc } from '../../src/data/notification-logs.repo.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(clearKv);

describe('notification-logs.repo', () => {
  it('ymdhUtc 输出 10 位 UTC 时间字符串', () => {
    expect(ymdhUtc(new Date('2026-05-24T03:30:00Z'))).toBe('2026052403');
    expect(ymdhUtc(new Date('2026-12-01T23:59:59Z'))).toBe('2026120123');
  });

  it('writeLog 后 query 能读到', async () => {
    await writeLog(env, {
      subId: 's1',
      ruleId: 'r1',
      channel: 'telegram',
      status: 'success',
      title: '到期提醒',
      content: '到期前 7 天'
    });
    const logs = await query(env, {});
    expect(logs).toHaveLength(1);
    expect(logs[0].subId).toBe('s1');
    expect(logs[0].channel).toBe('telegram');
    expect(logs[0].status).toBe('success');
  });

  it('query 按 subId 过滤', async () => {
    await writeLog(env, { subId: 's1', channel: 'tg', status: 'success' });
    await writeLog(env, { subId: 's2', channel: 'tg', status: 'success' });
    expect((await query(env, { subId: 's1' }))).toHaveLength(1);
    expect((await query(env, { subId: 's2' }))).toHaveLength(1);
  });

  it('query 按 status 过滤', async () => {
    await writeLog(env, { subId: 's1', channel: 'tg', status: 'success' });
    await writeLog(env, { subId: 's1', channel: 'bark', status: 'failed', error: 'http 400' });
    expect((await query(env, { status: 'failed' }))).toHaveLength(1);
    expect((await query(env, { status: 'success' }))).toHaveLength(1);
  });

  it('query 按 channel 过滤', async () => {
    await writeLog(env, { subId: 's1', channel: 'telegram', status: 'success' });
    await writeLog(env, { subId: 's1', channel: 'bark', status: 'success' });
    expect((await query(env, { channel: 'bark' }))).toHaveLength(1);
  });

  it('query 按 since/until 时间区间过滤', async () => {
    await writeLog(env, { subId: 's1', channel: 'tg', status: 'success', timestamp: '2026-05-20T00:00:00Z' });
    await writeLog(env, { subId: 's1', channel: 'tg', status: 'success', timestamp: '2026-05-22T00:00:00Z' });
    await writeLog(env, { subId: 's1', channel: 'tg', status: 'success', timestamp: '2026-05-24T00:00:00Z' });
    const r = await query(env, { since: '2026-05-21T00:00:00Z', until: '2026-05-23T00:00:00Z' });
    expect(r).toHaveLength(1);
  });

  it('query 按时间倒序返回', async () => {
    await writeLog(env, { subId: 's1', channel: 'tg', status: 'success', timestamp: '2026-05-20T00:00:00Z' });
    await writeLog(env, { subId: 's1', channel: 'tg', status: 'success', timestamp: '2026-05-22T00:00:00Z' });
    await writeLog(env, { subId: 's1', channel: 'tg', status: 'success', timestamp: '2026-05-24T00:00:00Z' });
    const r = await query(env, {});
    expect(r[0].timestamp).toContain('2026-05-24');
    expect(r[2].timestamp).toContain('2026-05-20');
  });

  it('query.limit 限制返回数', async () => {
    for (let i = 0; i < 5; i++) {
      await writeLog(env, { subId: 's1', channel: 'tg', status: 'success', timestamp: `2026-05-${20 + i}T00:00:00Z` });
    }
    const r = await query(env, { limit: 3 });
    expect(r).toHaveLength(3);
  });

  it('recentForSubscription 等价于 query+limit', async () => {
    for (let i = 0; i < 3; i++) {
      await writeLog(env, { subId: 's1', channel: 'tg', status: 'success' });
    }
    await writeLog(env, { subId: 's2', channel: 'tg', status: 'success' });
    expect((await recentForSubscription(env, 's1', 10))).toHaveLength(3);
  });
});
