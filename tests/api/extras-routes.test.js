// @ts-check
/**
 * 提醒规则 / 通知日志 / 调度日志 路由测试
 *
 * - /api/subscriptions/:id/reminders 完整 CRUD
 * - /api/notification-logs 查询 + 过滤
 * - /api/scheduler-logs 查询
 * - 创建订阅时 reminderRules 字段联动
 * - 鉴权失败路径
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';

import app from '../../src/app.js';
import * as subRepo from '../../src/data/subscriptions.repo.js';
import * as remindersRepo from '../../src/data/reminders.repo.js';
import { writeLog as writeNotifyLog } from '../../src/data/notification-logs.repo.js';
import { writeLog as writeSchedLog } from '../../src/data/scheduler-logs.repo.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

/** 写入默认管理员 + 拿到登录 cookie */
async function loginCookie() {
  await env.SUBSCRIPTIONS_KV.put(
    'config',
    JSON.stringify({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'password', JWT_SECRET: 'k' })
  );
  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'password' })
  }, env);
  return res.headers.get('Set-Cookie')?.split(';')[0] || '';
}

/** 当前 D1 admin 用户 id（与登录用户一致，seed 数据用） */
async function adminUid() {
  const r = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").first();
  return r ? r.id : 'kv-admin';
}

beforeEach(async () => {
  await clearKv();
  // D1 清库 + 重置初始化缓存，保证用例间隔离
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

describe('GET /api/subscriptions/:id/reminders', () => {
  it('未授权 → 401', async () => {
    const res = await app.request('/api/subscriptions/x/reminders', {}, env);
    expect(res.status).toBe(401);
  });

  it('返回当前规则数组', async () => {
    const cookie = await loginCookie();
    await remindersRepo.replaceForSubscription(env, 'sub-1', [
      remindersRepo.normalizeRule({ type: 'before_expiry', value: 7, unit: 'days' })
    ]);
    const res = await app.request('/api/subscriptions/sub-1/reminders', {
      headers: { Cookie: cookie }
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0].value).toBe(7);
  });
});

describe('POST /api/subscriptions/:id/reminders', () => {
  it('添加单条规则', async () => {
    const cookie = await loginCookie();
    const res = await app.request('/api/subscriptions/sub-2/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'before_expiry', value: 3, unit: 'days' })
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.rule.value).toBe(3);

    const list = await remindersRepo.listForSubscription(env, 'sub-2');
    expect(list).toHaveLength(1);
  });

  it('preset=true 一键应用 4 条预设', async () => {
    const cookie = await loginCookie();
    const res = await app.request('/api/subscriptions/sub-preset/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ preset: true })
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rules).toHaveLength(4);
  });
});

describe('PUT/DELETE /api/subscriptions/:id/reminders/:ruleId', () => {
  it('PUT 更新规则', async () => {
    const cookie = await loginCookie();
    const created = await remindersRepo.addRule(env, 'sub-3', {
      type: 'before_expiry',
      value: 7,
      unit: 'days'
    });

    const res = await app.request(`/api/subscriptions/sub-3/reminders/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ value: 1, isEnabled: false })
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rule.value).toBe(1);
    expect(body.rule.isEnabled).toBe(false);
  });

  it('PUT 不存在的 rule → 404', async () => {
    const cookie = await loginCookie();
    const res = await app.request('/api/subscriptions/sub-3/reminders/ghost', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ value: 1 })
    }, env);
    expect(res.status).toBe(404);
  });

  it('DELETE 移除规则', async () => {
    const cookie = await loginCookie();
    const created = await remindersRepo.addRule(env, 'sub-4', {
      type: 'before_expiry',
      value: 7,
      unit: 'days'
    });
    const res = await app.request(`/api/subscriptions/sub-4/reminders/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie }
    }, env);
    expect(res.status).toBe(200);
    expect(await remindersRepo.listForSubscription(env, 'sub-4')).toEqual([]);
  });
});

describe('GET /api/notification-logs', () => {
  it('未授权 → 401', async () => {
    const res = await app.request('/api/notification-logs', {}, env);
    expect(res.status).toBe(401);
  });

  it('过滤 subId / status', async () => {
    const cookie = await loginCookie();
    const scoped = { ...env, __ownerScope: await adminUid() };
    await writeNotifyLog(scoped, { subId: 's1', channel: 'tg', status: 'success' });
    await writeNotifyLog(scoped, { subId: 's2', channel: 'tg', status: 'failed', error: 'X' });
    await writeNotifyLog(scoped, { subId: 's1', channel: 'bark', status: 'success' });

    const res = await app.request('/api/notification-logs?subId=s1', {
      headers: { Cookie: cookie }
    }, env);
    const body = await res.json();
    expect(body.logs.length).toBe(2);

    const failedRes = await app.request('/api/notification-logs?status=failed', {
      headers: { Cookie: cookie }
    }, env);
    const failed = await failedRes.json();
    expect(failed.logs.length).toBe(1);
    expect(failed.logs[0].error).toBe('X');
  });
});

describe('GET /api/scheduler-logs', () => {
  it('返回最近 N 条调度日志', async () => {
    const cookie = await loginCookie();
    await writeSchedLog(env, {
      startedAt: '2026-05-24T10:00:00Z',
      finishedAt: '2026-05-24T10:00:01Z',
      timezone: 'Asia/Shanghai',
      currentHour: '18',
      configuredHours: ['08', '18'],
      inWindow: true,
      checkedCount: 3,
      matchedCount: 1,
      dedupedCount: 0,
      sentCount: 1,
      autoRenewedCount: 0,
      status: 'ok'
    });

    const res = await app.request('/api/scheduler-logs?limit=10', {
      headers: { Cookie: cookie }
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0].sentCount).toBe(1);
  });
});

describe('POST /api/subscriptions 自动应用提醒规则', () => {
  it('未传 reminderRules → 应用 4 条智能预设', async () => {
    const cookie = await loginCookie();
    const res = await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Netflix',
        expiryDate: '2026-12-31T00:00:00Z',
        amount: 98,
        currency: 'CNY',
        periodValue: 1,
        periodUnit: 'month'
      })
    }, env);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    const subId = body.subscription.id;

    const rules = await remindersRepo.listForSubscription(env, subId);
    expect(rules).toHaveLength(4);
  });

  it('传入自定义 reminderRules → 用它替代预设', async () => {
    const cookie = await loginCookie();
    const res = await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Custom',
        expiryDate: '2026-12-31T00:00:00Z',
        amount: 1,
        currency: 'CNY',
        periodValue: 1,
        periodUnit: 'month',
        reminderRules: [
          { type: 'before_expiry', value: 14, unit: 'days' }
        ]
      })
    }, env);
    expect(res.status).toBe(201);
    const subId = (await res.json()).subscription.id;

    const rules = await remindersRepo.listForSubscription(env, subId);
    expect(rules).toHaveLength(1);
    expect(rules[0].value).toBe(14);
  });
});

describe('GET /api/version', () => {
  it('返回版本号', async () => {
    const cookie = await loginCookie();
    const res = await app.request('/api/version', { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe('3.1.0');
  });
});

describe('GET/POST /api/categories', () => {
  it('初始为空数组', async () => {
    const cookie = await loginCookie();
    const res = await app.request('/api/categories', { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.categories).toEqual([]);
  });

  it('POST 新增分类后 GET 返回', async () => {
    const cookie = await loginCookie();
    await app.request('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: '娱乐' })
    }, env);
    const res = await app.request('/api/categories', { headers: { Cookie: cookie } }, env);
    const body = await res.json();
    expect(body.categories).toContain('娱乐');
  });

  it('创建订阅时自动保存分类', async () => {
    const cookie = await loginCookie();
    await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Netflix', expiryDate: '2026-12-31T00:00:00Z', category: '流媒体' })
    }, env);
    const res = await app.request('/api/categories', { headers: { Cookie: cookie } }, env);
    const body = await res.json();
    expect(body.categories).toContain('流媒体');
  });
});

describe('GET /api/subscriptions/:id/next-reminder', () => {
  it('返回最近的下次触发时间', async () => {
    const cookie = await loginCookie();
    // Create a subscription with future expiry
    const createRes = await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Test', expiryDate: '2027-01-01T00:00:00Z', periodValue: 1, periodUnit: 'month' })
    }, env);
    const subId = (await createRes.json()).subscription.id;

    const res = await app.request(`/api/subscriptions/${subId}/next-reminder`, {
      headers: { Cookie: cookie }
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.nextReminder).not.toBeNull();
    expect(body.nextReminder.nextFireTime).toBeTruthy();
    expect(body.allUpcoming.length).toBeGreaterThan(0);
  });
});
