// @ts-check
/**
 * 备份 / 恢复 API 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';

import app from '../../src/app.js';
import * as subRepo from '../../src/data/subscriptions.repo.js';
import * as remindersRepo from '../../src/data/reminders.repo.js';
import { getConfig } from '../../src/data/config.js';
import { putKVJson } from '../../src/data/kv.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}


async function adminUid() {
  const r = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").first();
  return r ? r.id : 'kv-admin';
}
async function seedSub(sub) {
  await subRepo.save({ ...env, __ownerScope: await adminUid() }, sub);
}

async function loginCookie() {
  await env.SUBSCRIPTIONS_KV.put(
    'config',
    JSON.stringify({
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'password',
      JWT_SECRET: 'test-jwt-secret',
      TG_BOT_TOKEN: 'secret-token-value',
      TG_CHAT_ID: '12345',
      TIMEZONE: 'Asia/Shanghai'
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
  // D1：首次触发建表（getDB 初始化），然后清空业务表 + 重置初始化缓存
  // （vitest-pool-workers 的 isolatedStorage 对 D1 的隔离不稳定，显式清理）
  const { getDB, _resetDbInitCache } = await import('../../src/data/db.js');
  const db = await getDB(env);
  if (db) {
    const TABLES = ['users', 'plans', 'orders', 'subscriptions', 'reminder_rules',
      'notification_logs', 'scheduler_logs', 'settings', 'migrate_meta',
      'login_attempts', 'register_attempts'];
    for (const t of TABLES) {
      await db.prepare('DELETE FROM ' + t).run();
    }
  }
  _resetDbInitCache();
});

describe('GET /api/backup', () => {
  it('未授权 → 401', async () => {
    const res = await app.request('/api/backup', {}, env);
    expect(res.status).toBe(401);
  });

  it('默认导出不含密钥，含订阅与规则', async () => {
    const cookie = await loginCookie();
    await seedSub( {
      id: 's1',
      name: 'Netflix',
      expiryDate: '2026-08-01T00:00:00.000Z',
      isActive: true,
      reminderValue: 7,
      reminderUnit: 'day'
    });
    await remindersRepo.replaceForSubscription(env, 's1', [
      remindersRepo.normalizeRule({ type: 'before_expiry', value: 30, unit: 'days' })
    ]);
    await putKVJson(env, 'categories', ['视频']);

    const res = await app.request('/api/backup', { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const backup = await res.json();
    expect(backup.format).toBe('substracker-backup');
    expect(backup.includeSecrets).toBe(false);
    expect(backup.config.TG_BOT_TOKEN).toBe('');
    expect(backup.config.JWT_SECRET).toBeUndefined();
    expect(backup.config.ADMIN_PASSWORD).toBeUndefined();
    expect(backup.config.TG_CHAT_ID).toBe('12345');
    expect(backup.subscriptions).toHaveLength(1);
    expect(backup.subscriptions[0].name).toBe('Netflix');
    expect(backup.reminderRules.s1[0].value).toBe(30);
    expect(backup.categories).toContain('视频');
  });

  it('includeSecrets=1 时导出 Token', async () => {
    const cookie = await loginCookie();
    const res = await app.request('/api/backup?includeSecrets=1', { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const backup = await res.json();
    expect(backup.includeSecrets).toBe(true);
    expect(backup.config.TG_BOT_TOKEN).toBe('secret-token-value');
    expect(backup.config.JWT_SECRET).toBeUndefined();
  });
});

describe('POST /api/restore', () => {
  it('合并导入订阅与规则', async () => {
    const cookie = await loginCookie();
    await seedSub( {
      id: 'keep-me',
      name: 'Keep',
      expiryDate: '2026-09-01T00:00:00.000Z',
      isActive: true
    });

    const backup = {
      format: 'substracker-backup',
      version: 1,
      config: { TIMEZONE: 'Asia/Tokyo', TG_CHAT_ID: '999' },
      categories: ['工具'],
      subscriptions: [
        {
          id: 'new-1',
          name: 'Imported',
          expiryDate: '2026-10-01T00:00:00.000Z',
          isActive: true
        }
      ],
      reminderRules: {
        'new-1': [{ type: 'before_expiry', value: 5, unit: 'days', isEnabled: true }]
      }
    };

    const res = await app.request(
      '/api/restore',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ backup, mode: 'merge', includeSecrets: false })
      },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const all = await subRepo.listAll(env);
    expect(all.map((s) => s.id).sort()).toEqual(['keep-me', 'new-1']);
    const rules = await remindersRepo.listForSubscription(env, 'new-1');
    expect(rules[0].value).toBe(5);

    const cfg = await getConfig(env);
    expect(cfg.TIMEZONE).toBe('Asia/Tokyo');
    expect(cfg.TG_CHAT_ID).toBe('999');
    // 未请求 includeSecrets 时不应清空已有 token
    expect(cfg.TG_BOT_TOKEN).toBe('secret-token-value');
    expect(cfg.JWT_SECRET).toBe('test-jwt-secret');
  });

  it('覆盖模式删除旧订阅', async () => {
    const cookie = await loginCookie();
    // 防御：用例间 D1 可能残留数据（isolatedStorage 对 D1 的隔离不稳定），先清空
    await subRepo.replaceAll({ ...env, __ownerScope: await adminUid() }, []);
    await seedSub( {
      id: 'old',
      name: 'Old',
      expiryDate: '2026-01-01T00:00:00.000Z',
      isActive: true
    });
    await remindersRepo.replaceForSubscription(env, 'old', [
      remindersRepo.normalizeRule({ type: 'on_expiry', value: 0, unit: 'days' })
    ]);

    const backup = {
      format: 'substracker-backup',
      version: 1,
      subscriptions: [
        { id: 'only', name: 'Only', expiryDate: '2026-12-01T00:00:00.000Z', isActive: true }
      ],
      reminderRules: {}
    };

    const res = await app.request(
      '/api/restore',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ backup, mode: 'replace' })
      },
      env
    );
    expect(res.status).toBe(200);
    const all = await subRepo.listAll(env);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('only');
    const oldRules = await remindersRepo.listForSubscription(env, 'old');
    expect(oldRules).toHaveLength(0);
  });

  it('非法备份 → 400', async () => {
    const cookie = await loginCookie();
    const res = await app.request(
      '/api/restore',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ backup: { format: 'other', subscriptions: [] } })
      },
      env
    );
    expect(res.status).toBe(400);
  });
});
