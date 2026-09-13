// @ts-check
/**
 * 提醒规则仓库（D1 版，v2）
 *
 * D1: reminder_rules(sub_id PK, rules JSON, updated_at)
 * 降级：D1 不可用时回退 KV reminder_rules:{subId}
 */

const KEY_PREFIX = 'reminder_rules:';
const KV_PREFIX = 'reminder_rules:';

/**
 * @typedef {Object} ReminderRule
 * @property {string} id
 * @property {'before_expiry'|'on_expiry'|'after_expiry'} type
 * @property {number} value
 * @property {'days'|'hours'} unit
 * @property {number|null} [repeatInterval]
 * @property {'renewed'|'acknowledged'|'never'} [repeatUntil]
 * @property {boolean} isEnabled
 * @property {string} createdAt
 */

/**
 * 生成新 rule 的默认 id（UUID）。
 *
 * @returns {string}
 */
export function makeRuleId() {
  return crypto.randomUUID();
}

/**
 * 智能预设：4 条 — 到期前 7/3/1 天 + 当天。
 *
 * @returns {ReminderRule[]}
 */
export function defaultPresetRules() {
  const now = new Date().toISOString();
  return [
    { id: makeRuleId(), type: 'before_expiry', value: 7, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true, createdAt: now },
    { id: makeRuleId(), type: 'before_expiry', value: 3, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true, createdAt: now },
    { id: makeRuleId(), type: 'before_expiry', value: 1, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true, createdAt: now },
    { id: makeRuleId(), type: 'on_expiry', value: 0, unit: 'days', repeatInterval: null, repeatUntil: 'renewed', isEnabled: true, createdAt: now }
  ];
}

/**
 * 把旧的 reminderUnit/reminderValue 单点提醒转换为 1 条等价规则。
 *
 * @param {{ reminderUnit?: string, reminderValue?: number, reminderDays?: number, reminderHours?: number }} sub
 * @returns {ReminderRule}
 */
export function legacyFieldToRule(sub) {
  const unitRaw = String(sub.reminderUnit || 'day').toLowerCase();
  const unit = unitRaw === 'hour' || unitRaw === 'hours' ? 'hours' : 'days';
  const fallback = unit === 'hours' ? sub.reminderHours : sub.reminderDays;
  const value = Number(
    sub.reminderValue !== undefined && sub.reminderValue !== null ? sub.reminderValue : fallback
  );
  // value 为非数字时回退 7；value=0 视为"到期当天"，保留
  const safeValue = Number.isFinite(value) && value >= 0 ? value : 7;
  return {
    id: makeRuleId(),
    type: safeValue === 0 ? 'on_expiry' : 'before_expiry',
    value: safeValue,
    unit,
    repeatInterval: null,
    repeatUntil: 'renewed',
    isEnabled: true,
    createdAt: new Date().toISOString()
  };
}

/**
 * 规范化单条规则（防御性字段清洗）。
 *
 * @param {Partial<ReminderRule>} raw
 * @returns {ReminderRule}
 */
export function normalizeRule(raw) {
  const type = ['before_expiry', 'on_expiry', 'after_expiry'].includes(raw.type) ? raw.type : 'before_expiry';
  const unit = raw.unit === 'hours' ? 'hours' : 'days';
  const value = Number.isFinite(Number(raw.value)) && Number(raw.value) >= 0 ? Number(raw.value) : 7;
  // repeatInterval 仅 after_expiry 语义有效，其他类型一律置 null
  const repeatInterval = type === 'after_expiry' &&
    Number.isFinite(Number(raw.repeatInterval)) && Number(raw.repeatInterval) > 0
    ? Number(raw.repeatInterval)
    : null;
  const repeatUntil = ['renewed', 'acknowledged', 'never'].includes(raw.repeatUntil) ? raw.repeatUntil : 'renewed';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeRuleId(),
    type,
    value,
    unit,
    repeatInterval,
    repeatUntil,
    isEnabled: raw.isEnabled !== false,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString()
  };
}

/* ---------------- 存取 ---------------- */

async function kvList(env, subId) {
  const raw = await env.SUBSCRIPTIONS_KV.get(KEY_PREFIX + subId);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRule);
  } catch {
    return [];
  }
}

/**
 * 读取某客户的提醒规则。
 */
export async function listForSubscription(env, subId) {
  const { getDB } = await import('./db.js');
  const db = await getDB(env);
  if (!db) return kvList(env, subId);
  const row = await db.prepare('SELECT rules FROM reminder_rules WHERE sub_id = ?1').bind(subId).first();
  if (!row) return [];
  try {
    const parsed = JSON.parse(/** @type {string} */ (row.rules));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRule);
  } catch {
    return [];
  }
}

/**
 * 整体替换某客户的提醒规则。
 */
export async function replaceForSubscription(env, subId, rules) {
  const safe = Array.isArray(rules) ? rules.map(normalizeRule) : [];
  const { getDB } = await import('./db.js');
  const db = await getDB(env);
  if (!db) {
    await env.SUBSCRIPTIONS_KV.put(KV_PREFIX + subId, JSON.stringify(safe));
    return;
  }
  await db
    .prepare(
      "INSERT INTO reminder_rules (sub_id, rules, updated_at) VALUES (?1, ?2, ?3) " +
      "ON CONFLICT(sub_id) DO UPDATE SET rules = ?2, updated_at = ?3"
    )
    .bind(subId, JSON.stringify(safe), Date.now())
    .run();
}

/**
 * 添加单条规则。
 */
export async function addRule(env, subId, rule) {
  const list = await listForSubscription(env, subId);
  const normalized = normalizeRule({ ...rule, id: rule.id || makeRuleId() });
  list.push(normalized);
  await replaceForSubscription(env, subId, list);
  return normalized;
}

/**
 * 更新单条规则。
 */
export async function updateRule(env, subId, ruleId, patch) {
  const list = await listForSubscription(env, subId);
  const idx = list.findIndex((r) => r.id === ruleId);
  if (idx === -1) return null;
  list[idx] = normalizeRule({ ...list[idx], ...patch, id: ruleId });
  await replaceForSubscription(env, subId, list);
  return list[idx];
}

/**
 * 删除单条规则。
 */
export async function deleteRule(env, subId, ruleId) {
  const list = await listForSubscription(env, subId);
  const next = list.filter((r) => r.id !== ruleId);
  if (next.length === list.length) return false;
  await replaceForSubscription(env, subId, next);
  return true;
}

/**
 * 删除某客户的所有规则。
 */
export async function clearForSubscription(env, subId) {
  const { getDB } = await import('./db.js');
  const db = await getDB(env);
  if (!db) {
    await env.SUBSCRIPTIONS_KV.delete(KV_PREFIX + subId);
    return;
  }
  await db.prepare('DELETE FROM reminder_rules WHERE sub_id = ?1').bind(subId).run();
}

/**
 * 从多规则推导列表展示用的 legacy 单点字段（兼容旧 UI / 通知正文）。
 */
export function deriveLegacyFromRules(rules) {
  const list = Array.isArray(rules) ? rules.filter((r) => r && r.isEnabled !== false) : [];
  if (list.length === 0) return { unit: 'day', value: 7 };

  const befores = list.filter((r) => r.type === 'before_expiry');
  if (befores.length > 0) {
    const sorted = [...befores].sort((a, b) => Number(b.value) - Number(a.value));
    const top = sorted[0];
    const unit = top.unit === 'hours' ? 'hour' : 'day';
    return { unit, value: Number.isFinite(top.value) ? top.value : 7 };
  }

  const on = list.find((r) => r.type === 'on_expiry');
  if (on) return { unit: 'day', value: 0 };

  const first = list[0];
  const unit = first.unit === 'hours' ? 'hour' : 'day';
  return { unit, value: Number.isFinite(first.value) ? first.value : 7 };
}

/**
 * 生成列表「提醒」列摘要文案（多规则）。
 */
export function formatRulesSummary(rules) {
  const list = Array.isArray(rules) ? rules.filter((r) => r && r.isEnabled !== false) : [];
  if (list.length === 0) return '未设置提醒';

  /** @type {string[]} */
  const parts = [];
  const beforeDays = list
    .filter((r) => r.type === 'before_expiry' && r.unit !== 'hours')
    .map((r) => r.value)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => b - a);
  const beforeHours = list
    .filter((r) => r.type === 'before_expiry' && r.unit === 'hours')
    .map((r) => r.value)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

  for (const d of beforeDays) parts.push(`提前 ${d} 天`);
  for (const h of beforeHours) parts.push(`提前 ${h} 小时`);

  const onExpiry = list.find((r) => r.type === 'on_expiry');
  if (onExpiry) parts.push('到期当天');

  const afters = list.filter((r) => r.type === 'after_expiry');
  for (const a of afters) {
    if (a.unit === 'hours') {
      parts.push(`过期后每 ${a.repeatInterval || 24} 小时`);
    } else {
      parts.push(`过期后每 ${a.repeatInterval || 24} 小时，持续 ${a.value} 天`);
    }
  }

  const disabledCount = rules.length - list.length;
  if (disabledCount > 0) parts.push(`${disabledCount} 条已停用`);

  return parts.join('；') || '未设置提醒';
}
