// @ts-check
/**
 * 订阅仓库 + 迁移单元测试
 *
 * 用 @cloudflare/vitest-pool-workers 提供的真实 KVNamespace 跑，
 * 不需要手写 mock，直接 import { env } from 'cloudflare:test'。
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore — vitest-pool-workers 注入的虚拟模块
import { env } from 'cloudflare:test';

import * as subRepo from '../../src/data/subscriptions.repo.js';
import {
  ensureMigrations,
  migrateSubscriptions,
  SCHEMA_VERSION,
  _resetMigrationCache,
  _getCachedSchemaVersion
} from '../../src/data/migrate.js';


/** 无 DB 的 env 视图：强制 repo 走 KV 降级层（本文件测的是 KV 索引/迁移行为） */
const kvEnv = { SUBSCRIPTIONS_KV: env.SUBSCRIPTIONS_KV };

/** 把 KV 清空（仅遍历常见 KV key 前缀） */
async function clearKv() {
  // KV.list 在 vitest-pool-workers 是真实实现
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(async () => {
  await clearKv();
  _resetMigrationCache();
});

describe('subscriptions.repo', () => {
  it('listIds 空仓库返回空数组', async () => {
    expect(await subRepo.listIds(kvEnv)).toEqual([]);
    expect(await subRepo.listAll(kvEnv)).toEqual([]);
  });

  it('save 新订阅 → 索引追加 + 单 Key 写入', async () => {
    const sub = { id: 'a1', name: 'Netflix' };
    await subRepo.save(kvEnv, sub);

    expect(await subRepo.listIds(kvEnv)).toEqual(['a1']);
    expect(await subRepo.getById(kvEnv, 'a1')).toEqual(sub);
    expect(await subRepo.listAll(kvEnv)).toEqual([sub]);
  });

  it('save 已存在订阅 → 仅更新 sub:{id}，索引不变', async () => {
    await subRepo.save(kvEnv, { id: 'a1', name: 'Old' });
    await subRepo.save(kvEnv, { id: 'a1', name: 'New' });

    expect(await subRepo.listIds(kvEnv)).toEqual(['a1']);
    expect((await subRepo.getById(kvEnv, 'a1')).name).toBe('New');
  });

  it('saveMany 批量写入并合并索引', async () => {
    await subRepo.saveMany(kvEnv, [
      { id: 'b1', name: 'A' },
      { id: 'b2', name: 'B' },
      { id: 'b3', name: 'C' }
    ]);

    expect((await subRepo.listIds(kvEnv)).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(await subRepo.listAll(kvEnv)).toHaveLength(3);
  });

  it('deleteById 移除单 Key 与索引', async () => {
    await subRepo.save(kvEnv, { id: 'c1', name: 'X' });
    await subRepo.save(kvEnv, { id: 'c2', name: 'Y' });

    expect(await subRepo.deleteById(kvEnv, 'c1')).toBe(true);
    expect(await subRepo.listIds(kvEnv)).toEqual(['c2']);
    expect(await subRepo.getById(kvEnv, 'c1')).toBeNull();
  });

  it('deleteById 不存在 → 返回 false 且清理悬空索引', async () => {
    await kvEnv.SUBSCRIPTIONS_KV.put('sub_index', JSON.stringify(['ghost']));
    expect(await subRepo.deleteById(kvEnv, 'ghost')).toBe(false);
    expect(await subRepo.listIds(kvEnv)).toEqual([]);
  });

  it('replaceAll 整体替换（迁移用）', async () => {
    await subRepo.save(kvEnv, { id: 'old1' });
    await subRepo.save(kvEnv, { id: 'old2' });

    await subRepo.replaceAll(kvEnv, [{ id: 'new1' }, { id: 'new2' }, { id: 'new3' }]);

    expect((await subRepo.listIds(kvEnv)).sort()).toEqual(['new1', 'new2', 'new3']);
    expect(await subRepo.getById(kvEnv, 'old1')).toBeNull();
    expect(await subRepo.getById(kvEnv, 'new2')).toEqual({ id: 'new2' });
  });

  it('save 缺少 id 抛异常', async () => {
    await expect(subRepo.save(kvEnv, /** @type {any} */ ({}))).rejects.toThrow();
    await expect(subRepo.save(kvEnv, /** @type {any} */ ({ id: '' }))).rejects.toThrow();
  });
});

describe('migrate.migrateSubscriptions', () => {
  it('旧 subscriptions 数组 → 新 sub:{id} + sub_index + 备份', async () => {
    const old = [
      { id: 's1', name: 'Netflix' },
      { id: 's2', name: 'Spotify' },
      { id: 's3', name: 'AWS' }
    ];
    await env.SUBSCRIPTIONS_KV.put('subscriptions', JSON.stringify(old));

    await migrateSubscriptions(kvEnv);

    expect((await subRepo.listIds(kvEnv)).sort()).toEqual(['s1', 's2', 's3']);
    expect((await subRepo.getById(kvEnv, 's2')).name).toBe('Spotify');

    // 备份存在，原 Key 已删
    expect(await kvEnv.SUBSCRIPTIONS_KV.get('subscriptions_v2_backup')).toBeTruthy();
    expect(await kvEnv.SUBSCRIPTIONS_KV.get('subscriptions')).toBeNull();
  });

  it('旧 subscriptions 不存在 → 仅写空索引，不报错', async () => {
    await migrateSubscriptions(kvEnv);
    expect(await subRepo.listIds(kvEnv)).toEqual([]);
    expect(await env.SUBSCRIPTIONS_KV.get('subscriptions_v2_backup')).toBeNull();
  });

  it('旧 subscriptions 是损坏 JSON → 按空处理不抛异常', async () => {
    await env.SUBSCRIPTIONS_KV.put('subscriptions', '{ this is not valid json');
    await migrateSubscriptions(kvEnv);
    expect(await subRepo.listIds(kvEnv)).toEqual([]);
  });
});

describe('migrate.migrateSchedulerLogs', () => {
  it('迁移旧 scheduler_status_history 到 sched_log:*', async () => {
    const v2History = [
      {
        lastRunAt: '2026-05-24T10:00:00.000Z',
        timezone: 'Asia/Shanghai',
        currentHour: '18',
        configuredHours: ['08', '18'],
        shouldNotifyThisHour: true,
        checkedSubscriptions: 5,
        expiringMatched: 2,
        dedupeSkipped: 1,
        sent: true,
        updatedSubscriptions: 1,
        reason: '已尝试发送'
      },
      {
        lastRunAt: '2026-05-24T09:00:00.000Z',
        timezone: 'Asia/Shanghai',
        currentHour: '17',
        configuredHours: ['08', '18'],
        shouldNotifyThisHour: false,
        sent: false,
        reason: '当前小时未在通知时段内'
      }
    ];
    await env.SUBSCRIPTIONS_KV.put('scheduler_status_history', JSON.stringify(v2History));

    const { migrateSchedulerLogs } = await import('../../src/data/migrate.js');
    await migrateSchedulerLogs(kvEnv);

    const list = await env.SUBSCRIPTIONS_KV.list({ prefix: 'sched_log:' });
    expect(list.keys.length).toBe(2);
  });
});

describe('migrate.ensureMigrations（编排器）', () => {
  it('初次执行 → 设置 schema_version 与 step 标记', async () => {
    await env.SUBSCRIPTIONS_KV.put(
      'subscriptions',
      JSON.stringify([{ id: 'x1', name: 'X', reminderUnit: 'day', reminderValue: 5 }])
    );

    const result = await ensureMigrations(kvEnv);

    expect(result.migrated).toBe(true);
    expect(result.ranSteps).toContain('subscriptions_v3');
    expect(result.ranSteps).toContain('reminder_rules_v3');
    expect(result.ranSteps).toContain('scheduler_logs_v3');
    expect(await kvEnv.SUBSCRIPTIONS_KV.get('schema_version')).toBe(SCHEMA_VERSION);
    expect(await kvEnv.SUBSCRIPTIONS_KV.get('migrate:subscriptions_v3')).toBe('done');
    expect(await kvEnv.SUBSCRIPTIONS_KV.get('migrate:reminder_rules_v3')).toBe('done');
    expect(await kvEnv.SUBSCRIPTIONS_KV.get('migrate:scheduler_logs_v3')).toBe('done');
    expect(_getCachedSchemaVersion()).toBe(SCHEMA_VERSION);

    // reminder rules 也已生成
    const rules = await kvEnv.SUBSCRIPTIONS_KV.get('reminder_rules:x1');
    expect(rules).toBeTruthy();
    const parsed = JSON.parse(/** @type {string} */ (rules));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].value).toBe(5);
  });

  it('schema_version 已就位 → 跳过，命中缓存', async () => {
    await env.SUBSCRIPTIONS_KV.put('schema_version', SCHEMA_VERSION);

    const r1 = await ensureMigrations(kvEnv);
    expect(r1.migrated).toBe(false);
    expect(r1.reason).toBe('already_v3');

    const r2 = await ensureMigrations(kvEnv);
    expect(r2.reason).toBe('cached'); // 二次走内存缓存
  });

  it('幂等：连续两次执行结果一致', async () => {
    await env.SUBSCRIPTIONS_KV.put(
      'subscriptions',
      JSON.stringify([{ id: 'idem', name: 'A' }])
    );
    await ensureMigrations(kvEnv);
    _resetMigrationCache();

    // 第二次：schema_version 已就位，应直接跳过
    const r2 = await ensureMigrations(kvEnv);
    expect(r2.migrated).toBe(false);
    expect(r2.reason).toBe('already_v3');

    expect((await subRepo.listIds(kvEnv)).length).toBe(1);
  });

  it('锁存在时 → 跳过，下次再试', async () => {
    await env.SUBSCRIPTIONS_KV.put('migration_lock', 'someone-else-running');

    const result = await ensureMigrations(kvEnv);
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('locked_elsewhere');

    // 没设置 schema_version
    expect(await kvEnv.SUBSCRIPTIONS_KV.get('schema_version')).toBeNull();
  });

  it('迁移成功后会自动释放锁', async () => {
    await ensureMigrations(kvEnv);
    expect(await kvEnv.SUBSCRIPTIONS_KV.get('migration_lock')).toBeNull();
  });
});
