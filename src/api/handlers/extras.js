// @ts-check
/**
 * 提醒规则 / 通知日志 / 调度日志 路由
 *
 * 接口表（路径前缀 /api）：
 *   GET    /subscriptions/:id/reminders           列出某客户的提醒规则
 *   POST   /subscriptions/:id/reminders           新增一条规则
 *   PUT    /subscriptions/:id/reminders/:ruleId   更新一条规则
 *   DELETE /subscriptions/:id/reminders/:ruleId   删除一条规则
 *
 *   GET    /notification-logs?subId=&channel=&status=&since=&limit=
 *                                                 查询通知日志
 *   GET    /scheduler-logs?limit=N                查询调度执行日志
 *
 * 鉴权：与既有客户端约定一致——需要登录（cookie token），由 router.js 在 routes 之前
 * 统一校验。本文件被 router.js 调用，不再单独校验。
 *
 */

import * as remindersRepo from '../../data/reminders.repo.js';
import * as notifyLogsRepo from '../../data/notification-logs.repo.js';
import * as schedLogsRepo from '../../data/scheduler-logs.repo.js';
import { getCategories, addCategory } from '../../data/categories.js';
import { getNextFireTime } from '../../services/notify/reminder-engine.js';

export const VERSION = '3.1.0';

/** 标准 JSON 响应 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * 规则变更后同步客户上的 legacy 提醒字段，保证列表展示一致。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} subId
 * @param {import('../../data/reminders.repo.js').ReminderRule[]} [rules]
 */
async function syncLegacyAfterRulesChange(env, subId, rules) {
  try {
    const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
    const list = rules || (await remindersRepo.listForSubscription(env, subId));
    await syncLegacyReminderFields(env, subId, list);
  } catch (err) {
    console.error('[reminders] 同步 legacy 字段失败:', err);
  }
}

/**
 * 处理提醒规则 / 通知日志 / 调度日志相关的 新 API。
 * 返回 null 表示路径不匹配，由调用方继续转给下一组路由。
 *
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} path 已剥离 /api 前缀的路径
 */
export async function handleExtraRoutes(request, env, path) {
  const method = request.method;

  // /subscriptions/:id/reminders[/:ruleId]
  const remMatch = path.match(/^\/subscriptions\/([^/]+)\/reminders(?:\/([^/]+))?\/?$/);
  if (remMatch) {
    const [, subId, ruleId] = remMatch;
    return handleReminderRoute(request, env, method, subId, ruleId);
  }

  // /subscriptions/:id/next-reminder
  const nrMatch = path.match(/^\/subscriptions\/([^/]+)\/next-reminder\/?$/);
  if (nrMatch && method === 'GET') {
    const [, subId] = nrMatch;
    const { getSubscription } = await import('../../data/subscriptions.js');
    const sub = await getSubscription(subId, env);
    if (!sub) return json({ success: false, message: '客户不存在' }, 404);
    const rules = await remindersRepo.listForSubscription(env, subId);
    const nowIso = new Date().toISOString();
    const times = rules
      .map((r) => ({ ruleId: r.id, type: r.type, value: r.value, unit: r.unit, nextFireTime: getNextFireTime(r, sub.expiryDate, nowIso) }))
      .filter((t) => t.nextFireTime !== null)
      .sort((a, b) => new Date(a.nextFireTime).getTime() - new Date(b.nextFireTime).getTime());
    return json({ success: true, nextReminder: times[0] || null, allUpcoming: times });
  }

  // /notification-logs
  if (path === '/notification-logs' && method === 'GET') {
    return handleNotifyLogsList(request, env);
  }

  // /scheduler-logs
  if (path === '/scheduler-logs' && method === 'GET') {
    return handleSchedLogsList(request, env);
  }

  // /version
  if (path === '/version' && method === 'GET') {
    return json({ success: true, version: VERSION });
  }

  // /categories
  if (path === '/categories') {
    if (method === 'GET') {
      return json({ success: true, categories: await getCategories(env) });
    }
    if (method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ success: false, message: '请求体不是合法 JSON' }, 400); }
      const name = body && body.name;
      if (!name || !name.trim()) return json({ success: false, message: '分类名不能为空' }, 400);
      await addCategory(env, name);
      return json({ success: true });
    }
  }

  return null;
}

/**
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} method
 * @param {string} subId
 * @param {string} [ruleId]
 */
async function handleReminderRoute(request, env, method, subId, ruleId) {
  // GET /subscriptions/:id/reminders
  if (method === 'GET' && !ruleId) {
    const list = await remindersRepo.listForSubscription(env, subId);
    return json({ success: true, rules: list });
  }

  // POST /subscriptions/:id/reminders
  if (method === 'POST' && !ruleId) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: '请求体不是合法 JSON' }, 400);
    }
    if (body && body.preset === true) {
      // 一次性应用智能预设（覆盖现有规则）
      const presets = remindersRepo.defaultPresetRules();
      await remindersRepo.replaceForSubscription(env, subId, presets);
      await syncLegacyAfterRulesChange(env, subId);
      return json({ success: true, rules: presets });
    }
    const rule = await remindersRepo.addRule(env, subId, body || {});
    await syncLegacyAfterRulesChange(env, subId);
    return json({ success: true, rule });
  }

  // PUT /subscriptions/:id/reminders（不带 ruleId）→ 整体替换规则列表
  if (method === 'PUT' && !ruleId) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: '请求体不是合法 JSON' }, 400);
    }
    const rules = Array.isArray(body && body.rules) ? body.rules : [];
    await remindersRepo.replaceForSubscription(env, subId, rules);
    const saved = await remindersRepo.listForSubscription(env, subId);
    await syncLegacyAfterRulesChange(env, subId, saved);
    return json({ success: true, rules: saved });
  }

  // PUT /subscriptions/:id/reminders/:ruleId
  if (method === 'PUT' && ruleId) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: '请求体不是合法 JSON' }, 400);
    }
    const updated = await remindersRepo.updateRule(env, subId, ruleId, body || {});
    if (!updated) return json({ success: false, message: '规则不存在' }, 404);
    await syncLegacyAfterRulesChange(env, subId);
    return json({ success: true, rule: updated });
  }

  // DELETE /subscriptions/:id/reminders/:ruleId
  if (method === 'DELETE' && ruleId) {
    const ok = await remindersRepo.deleteRule(env, subId, ruleId);
    if (!ok) return json({ success: false, message: '规则不存在' }, 404);
    await syncLegacyAfterRulesChange(env, subId);
    return json({ success: true });
  }

  return json({ success: false, message: 'Method Not Allowed' }, 405);
}

/**
 * GET /api/notification-logs?subId=&channel=&status=&since=&limit=
 *
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
async function handleNotifyLogsList(request, env) {
  const url = new URL(request.url);
  const filter = {
    subId: url.searchParams.get('subId') || undefined,
    channel: url.searchParams.get('channel') || undefined,
    status:
      /** @type {'success'|'failed'|undefined} */
      (url.searchParams.get('status') || undefined),
    since: url.searchParams.get('since') || undefined,
    until: url.searchParams.get('until') || undefined,
    limit: Number(url.searchParams.get('limit') || 100)
  };
  const logs = await notifyLogsRepo.query(env, filter);
  return json({ success: true, logs });
}

/**
 * GET /api/scheduler-logs?limit=N
 *
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
async function handleSchedLogsList(request, env) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') || 20);
  const logs = await schedLogsRepo.getRecent(env, limit);
  return json({ success: true, logs });
}
