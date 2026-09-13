// @ts-check
/**
 * 套餐 / 订单 / 设置 / 登录限流 仓库（D1）
 */

import { getDB } from './db.js';

/* ---------------- 套餐 ---------------- */

/**
 * @param {{ DB?: D1Database }} env
 * @returns {Promise<Array<{ id: string, name: string, durationDays: number, priceCents: number, maxSubscriptions: number, isActive: boolean, sort: number, createdAt: unknown }>>}
 */
export async function listPlans(env, { includeInactive = false } = {}) {
  const db = await getDB(env);
  if (!db) return [];
  const sql = includeInactive
    ? 'SELECT * FROM plans ORDER BY sort ASC, created_at ASC'
    : 'SELECT * FROM plans WHERE is_active = 1 ORDER BY sort ASC, created_at ASC';
  const result = await db.prepare(sql).all();
  return (result.results || []).map((r) => ({
    id: /** @type {string} */ (r.id),
    name: /** @type {string} */ (r.name),
    durationDays: /** @type {number} */ (r.duration_days),
    priceCents: /** @type {number} */ (r.price_cents),
    maxSubscriptions: /** @type {number} */ (r.max_subscriptions),
    isActive: !!r.is_active,
    sort: /** @type {number} */ (r.sort),
    createdAt: r.created_at
  }));
}

/**
 * @param {{ DB?: D1Database }} env
 * @returns {Promise<{ id: string, name: string, durationDays: number, priceCents: number, maxSubscriptions: number, isActive: boolean, sort: number, createdAt: unknown } | null>}
 */
export async function getPlan(env, planId) {
  const db = await getDB(env);
  if (!db) return null;
  const r = await db.prepare('SELECT * FROM plans WHERE id = ?1').bind(planId).first();
  if (!r) return null;
  return {
    id: /** @type {string} */ (r.id),
    name: /** @type {string} */ (r.name),
    durationDays: /** @type {number} */ (r.duration_days),
    priceCents: /** @type {number} */ (r.price_cents),
    maxSubscriptions: /** @type {number} */ (r.max_subscriptions),
    isActive: !!r.is_active,
    sort: /** @type {number} */ (r.sort),
    createdAt: r.created_at
  };
}

export async function savePlan(env, plan) {
  const db = await getDB(env);
  if (!db) throw new Error('数据库不可用');
  await db
    .prepare(
      "INSERT INTO plans (id, name, duration_days, price_cents, max_subscriptions, is_active, sort, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) " +
      "ON CONFLICT(id) DO UPDATE SET name=?2, duration_days=?3, price_cents=?4, max_subscriptions=?5, is_active=?6, sort=?7"
    )
    .bind(
      plan.id,
      plan.name,
      plan.durationDays,
      plan.priceCents,
      plan.maxSubscriptions,
      plan.isActive ? 1 : 0,
      plan.sort || 0,
      plan.createdAt || Date.now()
    )
    .run();
}

export async function deletePlan(env, planId) {
  const db = await getDB(env);
  if (!db) return false;
  const result = await db.prepare('DELETE FROM plans WHERE id = ?1').bind(planId).run();
  return (result.meta && result.meta.changes > 0) || false;
}

/** 内置默认套餐（首次初始化写入） */
export async function ensureDefaultPlans(env) {
  const db = await getDB(env);
  if (!db) return;
  const row = await db.prepare("SELECT value FROM migrate_meta WHERE key = 'default_plans_seeded'").first();
  if (row && row.value === '1') return;
  const now = Date.now();
  const defaults = [
    { id: 'plan_monthly', name: '月度会员', durationDays: 30, priceCents: 299, maxSubscriptions: -1, sort: 1 },
    { id: 'plan_quarterly', name: '季度会员', durationDays: 90, priceCents: 799, maxSubscriptions: -1, sort: 2 },
    { id: 'plan_yearly', name: '年度会员', durationDays: 365, priceCents: 2499, maxSubscriptions: -1, sort: 3 }
  ];
  for (const p of defaults) {
    await savePlan(env, { ...p, isActive: true, createdAt: now });
  }
  await db
    .prepare("INSERT INTO migrate_meta (key, value) VALUES ('default_plans_seeded', '1') ON CONFLICT(key) DO UPDATE SET value='1'")
    .run();
}

/* ---------------- 订单 ---------------- */

export async function createOrder(env, order) {  const db = await getDB(env);
  if (!db) throw new Error('数据库不可用');
  await db
    .prepare(
      "INSERT INTO orders (id, user_id, plan_id, plan_name, amount_cents, status, out_trade_no, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)"
    )
    .bind(order.id, order.userId, order.planId, order.planName, order.amountCents, order.outTradeNo, order.createdAt)
    .run();
  return order;
}

/**
 * @param {{ DB?: D1Database }} env
 * @returns {Promise<any>}
 */
export async function getOrderByOutTradeNo(env, outTradeNo) {
  const db = await getDB(env);
  if (!db) return null;
  const r = await db.prepare('SELECT * FROM orders WHERE out_trade_no = ?1').bind(outTradeNo).first();
  return r ? rowToOrder(/** @type {any} */ (r)) : null;
}

export async function markOrderPaid(env, outTradeNo, epayTradeNo, notifyRaw) {
  const db = await getDB(env);
  if (!db) return null;
  // 幂等：仅 pending → paid
  const result = await db
    .prepare(
      "UPDATE orders SET status='paid', epay_trade_no=?1, paid_at=?2, notify_raw=?3 " +
      "WHERE out_trade_no=?4 AND status='pending'"
    )
    .bind(epayTradeNo || null, Date.now(), (notifyRaw || '').slice(0, 4000), outTradeNo)
    .run();
  if (!result.meta || result.meta.changes === 0) {
    // 已处理过（幂等命中）或不存在
    return getOrderByOutTradeNo(env, outTradeNo);
  }
  return getOrderByOutTradeNo(env, outTradeNo);
}

/**
 * @param {{ DB?: D1Database }} env
 * @returns {Promise<{ total: number, items: any[] }>}
 */
export async function listOrders(env, { userId = null, page = 1, pageSize = 20, status = null } = {}) {
  const db = await getDB(env);
  if (!db) return { total: 0, items: [] };
  const offset = (page - 1) * pageSize;
  const conds = [];
  const params = [];
  if (userId) { conds.push('o.user_id = ?' + (params.length + 1)); params.push(userId); }
  if (status) { conds.push('o.status = ?' + (params.length + 1)); params.push(status); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const totalRow = await db
    .prepare('SELECT COUNT(*) AS n FROM orders o ' + where)
    .bind(...params)
    .first();
  const result = await db
    .prepare(
      'SELECT o.*, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id ' +
      where + ' ORDER BY o.created_at DESC LIMIT ?' + (params.length + 1) + ' OFFSET ?' + (params.length + 2)
    )
    .bind(...params, pageSize, offset)
    .all();
  return { total: totalRow ? /** @type {number} */ (totalRow.n) : 0, items: (result.results || []).map(rowToOrder) };
}

function rowToOrder(r) {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username || null,
    planId: r.plan_id,
    planName: r.plan_name,
    amountCents: r.amount_cents,
    status: r.status,
    outTradeNo: r.out_trade_no,
    epayTradeNo: r.epay_trade_no || null,
    createdAt: r.created_at,
    paidAt: r.paid_at || null
  };
}

/* ---------------- 设置（原 KV config 兜底读取） ---------------- */

export async function getSetting(env, key) {
  const db = await getDB(env);
  if (!db) return undefined;
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first();
  if (!r) return undefined;
  try {
    return JSON.parse(/** @type {string} */ (r.value));
  } catch {
    return r.value;
  }
}

export async function setSetting(env, key, value) {
  const db = await getDB(env);
  if (!db) return;
  await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value=?2, updated_at=?3"
    )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

/* ---------------- 登录/注册限流 ---------------- */

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const REGISTER_MAX_PER_WINDOW = 5;
const REGISTER_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function isLoginLocked(env, ip) {
  const db = await getDB(env);
  if (!db) return false;
  const r = await db.prepare('SELECT locked_until FROM login_attempts WHERE ip = ?1').bind(ip).first();
  return !!(r && r.locked_until && /** @type {number} */ (r.locked_until) > Date.now());
}

export async function recordLoginFailure(env, ip) {
  const db = await getDB(env);
  if (!db) return;
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO login_attempts (ip, count, locked_until, updated_at) VALUES (?1, 1, NULL, ?2) " +
      "ON CONFLICT(ip) DO UPDATE SET " +
      "count = CASE WHEN ?2 - updated_at > " + LOGIN_LOCK_MS + " THEN 1 ELSE count + 1 END, " +
      "locked_until = CASE WHEN (CASE WHEN ?2 - updated_at > " + LOGIN_LOCK_MS + " THEN 1 ELSE count + 1 END) >= " + LOGIN_MAX_ATTEMPTS + " THEN ?2 + " + LOGIN_LOCK_MS + " ELSE locked_until END, " +
      "updated_at = ?2"
    )
    .bind(ip, now)
    .run();
}

export async function clearLoginAttempts(env, ip) {
  const db = await getDB(env);
  if (!db) return;
  await db.prepare('DELETE FROM login_attempts WHERE ip = ?1').bind(ip).run();
}

export async function isRegisterAllowed(env, ip) {
  const db = await getDB(env);
  if (!db) return true;
  const now = Date.now();
  const r = await db.prepare('SELECT * FROM register_attempts WHERE ip = ?1').bind(ip).first();
  if (!r) return true;
  if (now - /** @type {number} */ (r.window_start) > REGISTER_WINDOW_MS) return true; // 窗口过期
  return /** @type {number} */ (r.count) < REGISTER_MAX_PER_WINDOW;
}

export async function recordRegister(env, ip) {
  const db = await getDB(env);
  if (!db) return;
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO register_attempts (ip, count, window_start, updated_at) VALUES (?1, 1, ?2, ?2) " +
      "ON CONFLICT(ip) DO UPDATE SET " +
      "count = CASE WHEN ?2 - window_start > " + REGISTER_WINDOW_MS + " THEN 1 ELSE count + 1 END, " +
      "window_start = CASE WHEN ?2 - window_start > " + REGISTER_WINDOW_MS + " THEN ?2 ELSE window_start END, " +
      "updated_at = ?2"
    )
    .bind(ip, now)
    .run();
}
