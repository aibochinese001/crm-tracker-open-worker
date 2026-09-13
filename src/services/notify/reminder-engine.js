// @ts-check
/**
 * 提醒规则触发引擎
 *
 * 给定一条规则 + 当前到期距离（天/小时）+ 上次触发时间，
 * 判断"现在这一小时是否应该发出提醒"。
 *
 * 设计成纯函数，与 KV / 网络解耦，便于单元测试覆盖所有边界。
 *
 * 三种规则类型语义：
 * - before_expiry: value 表示"提前 N 天/小时"。当 daysDiff/hoursDiff 落在 [0, value] 区间触发。
 *   特别地，value=0 等同于 on_expiry。
 * - on_expiry: 仅当到期日（daysDiff===0）触发。
 * - after_expiry: 已过期场景。每隔 repeatInterval 小时触发一次，直到达到终止条件
 *   （renewed/acknowledged/never）。本引擎不关心终止判断（由 scheduler 在加载规则前过滤），
 *   但会校验"距上次触发是否超过 repeatInterval"。
 *
 */

/**
 * @typedef {import('../../data/reminders.repo.js').ReminderRule} ReminderRule
 */

/**
 * @typedef {Object} FireContext
 * @property {number} daysDiff 距到期天数（基于用户 TZ 零点；可为负数 = 已过期天数）
 * @property {number} hoursDiff 距到期小时数（可为负数 = 已过期小时数）
 * @property {string} [lastFireAtIso] 同一规则上次触发的 ISO 时间（用于 after_expiry 重复间隔）
 * @property {string} [nowIso] 当前 ISO 时间，默认 new Date().toISOString()
 */

/**
 * @typedef {Object} FireDecision
 * @property {boolean} fire 是否应该触发
 * @property {string} [reason] 触发或拒绝的原因（便于日志诊断）
 */

/**
 * 判断规则是否应该在"本次调度"触发。
 *
 * @param {ReminderRule} rule
 * @param {FireContext} ctx
 * @returns {FireDecision}
 */
export function shouldFire(rule, ctx) {
  if (!rule || rule.isEnabled === false) {
    return { fire: false, reason: 'rule_disabled' };
  }

  const { daysDiff, hoursDiff } = ctx;
  if (!Number.isFinite(daysDiff) || !Number.isFinite(hoursDiff)) {
    return { fire: false, reason: 'invalid_diff' };
  }

  switch (rule.type) {
    case 'before_expiry':
      return decideBeforeExpiry(rule, ctx);
    case 'on_expiry':
      return decideOnExpiry(rule, ctx);
    case 'after_expiry':
      return decideAfterExpiry(rule, ctx);
    default:
      return { fire: false, reason: 'unknown_rule_type' };
  }
}

/**
 * @param {ReminderRule} rule
 * @param {FireContext} ctx
 * @returns {FireDecision}
 */
function decideBeforeExpiry(rule, ctx) {
  const { daysDiff, hoursDiff } = ctx;

  if (rule.unit === 'hours') {
    // hours 模式：value=0 意味着"到期当小时内"
    if (rule.value === 0) {
      return hoursDiff >= 0 && hoursDiff < 1
        ? { fire: true, reason: 'within_hour' }
        : { fire: false, reason: 'not_within_hour' };
    }
    // 其余：剩余小时刚好等于规则 value（精确触发）
    if (hoursDiff < 0) return { fire: false, reason: 'already_expired' };
    if (Math.round(hoursDiff) === rule.value) {
      return { fire: true, reason: `hours_diff_eq_${rule.value}` };
    }
    return { fire: false, reason: `hours_diff=${hoursDiff}_not_match_${rule.value}` };
  }

  // days 模式：value=0 等同 on_expiry
  if (rule.value === 0) {
    return daysDiff === 0
      ? { fire: true, reason: 'days_diff_zero' }
      : { fire: false, reason: `days_diff=${daysDiff}_not_zero` };
  }
  // 其余：精确匹配剩余天数
  if (daysDiff === rule.value) {
    return { fire: true, reason: `days_diff_eq_${rule.value}` };
  }
  return { fire: false, reason: `days_diff=${daysDiff}_not_match_${rule.value}` };
}

/**
 * @param {ReminderRule} rule
 * @param {FireContext} ctx
 * @returns {FireDecision}
 */
function decideOnExpiry(rule, ctx) {
  void rule;
  return ctx.daysDiff === 0
    ? { fire: true, reason: 'on_expiry_day' }
    : { fire: false, reason: `days_diff=${ctx.daysDiff}_not_today` };
}

/**
 * @param {ReminderRule} rule
 * @param {FireContext} ctx
 * @returns {FireDecision}
 */
function decideAfterExpiry(rule, ctx) {
  if (ctx.daysDiff >= 0) return { fire: false, reason: 'not_expired_yet' };

  // 没设 repeatInterval → 仅在过期当天 / 当天后某一时点触发一次（这里取每天 1 次）
  // 正常用法：repeatInterval > 0
  const interval = Number.isFinite(rule.repeatInterval) && rule.repeatInterval > 0
    ? rule.repeatInterval
    : 24;

  if (!ctx.lastFireAtIso) {
    return { fire: true, reason: 'after_expiry_first_fire' };
  }

  const last = new Date(ctx.lastFireAtIso).getTime();
  const now = ctx.nowIso ? new Date(ctx.nowIso).getTime() : Date.now();
  if (Number.isNaN(last) || Number.isNaN(now)) {
    return { fire: true, reason: 'invalid_last_fire_assume_due' };
  }

  const elapsedHours = (now - last) / (3600 * 1000);
  if (elapsedHours >= interval) {
    return { fire: true, reason: `after_expiry_interval_${interval}h_elapsed` };
  }
  return { fire: false, reason: `after_expiry_within_${interval}h_window` };
}

/**
 * 计算规则的下次触发时间（ISO 字符串）。
 *
 * @param {ReminderRule} rule
 * @param {string} expiryDateIso 服务到期日 ISO
 * @param {string} [nowIso] 当前时间 ISO（默认 now）
 * @returns {string|null} 下次触发的 ISO 时间，或 null（规则已禁用/不再触发）
 */
export function getNextFireTime(rule, expiryDateIso, nowIso) {
  if (!rule || rule.isEnabled === false) return null;

  const expiry = new Date(expiryDateIso).getTime();
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  if (Number.isNaN(expiry)) return null;

  const MS_HOUR = 3600_000;
  const MS_DAY = 86400_000;

  if (rule.type === 'before_expiry') {
    let fireAt;
    if (rule.unit === 'hours') {
      fireAt = expiry - rule.value * MS_HOUR;
    } else {
      fireAt = expiry - rule.value * MS_DAY;
    }
    return fireAt >= now ? new Date(fireAt).toISOString() : null;
  }

  if (rule.type === 'on_expiry') {
    return expiry >= now ? new Date(expiry).toISOString() : null;
  }

  if (rule.type === 'after_expiry') {
    if (now < expiry) return new Date(expiry).toISOString();
    const interval = (rule.repeatInterval && rule.repeatInterval > 0) ? rule.repeatInterval : 24;
    const elapsed = now - expiry;
    const periods = Math.ceil(elapsed / (interval * MS_HOUR));
    const nextFire = expiry + periods * interval * MS_HOUR;
    return new Date(nextFire).toISOString();
  }

  return null;
}
