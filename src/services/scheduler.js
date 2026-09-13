// 注：本文件暂不启用 // @ts-check，因 lunar 库返回类型分支较多，类型清理推迟到后续 Task。
/**
 * 定时任务调度器
 *
 * ── 修复的核心问题（#91 / #52 / #166 根因）─────────────────
 * 旧调度器把"当前 UTC 时刻的小时"当作"用户本地小时"来对比 NOTIFICATION_HOURS，
 * 配合"通知时段语义不一致"的文档表述，造成大量"不响 / 错时响"。
 *
 * 修复：
 * 1. 统一时区基准：通过 getNowInTimezone(config.TIMEZONE) 取用户 TZ 下的 hourString
 *    与 NOTIFICATION_HOURS（按用户 TZ 解释）比对，语义清晰。
 * 2. 多提醒规则：从 reminders.repo 加载每个客户的规则数组，逐条调
 *    reminder-engine.shouldFire 判断（不再单点 reminderUnit/reminderValue）。
 * 3. 去重粒度细化：dedup key 改为 (subId × ruleId × ymdh-local)，避免一条客户
 *    多规则相互打架。
 * 4. 结构化日志：每次执行写一条 sched_log；每条通知发送（成功/失败）写 notify_log。
 *
 * 数据流：
 *   Cron tick →
 *     ensureMigrations →
 *     load config + subs + rules →
 *     check window →
 *     for each (sub, rule):
 *       - daysDiff/hoursDiff 用 getDaysBetween（按用户 TZ）算
 *       - 自动续费（针对 sub 整体，仅算一次）
 *       - shouldFire? → dedupe → dispatch.send → notify_log
 *     → sched_log
 *
 */

import { getConfig } from '../data/config.js';
import { getAllSubscriptions } from '../data/subscriptions.js';
import * as subRepo from '../data/subscriptions.repo.js';
import * as remindersRepo from '../data/reminders.repo.js';
import * as schedulerLogsRepo from '../data/scheduler-logs.repo.js';
import {
  MS_PER_HOUR,
  getNowInTimezone,
  getDaysBetween,
  getTimezoneDateParts,
  getTimezoneMidnightTimestamp,
  addCalendarPeriodInTimezone,
  getTimestampForTimezoneParts
} from '../core/time.js';
import { formatNotificationContent } from './notify/reminder.js';
import { dispatch } from './notify/dispatch.js';
import { shouldFire } from './notify/reminder-engine.js';
import { lunarCalendar, lunarBiz } from '../core/lunar.js';

const DEDUPE_TTL_SEC = 60 * 60 * 48; // 48h
const LAST_FIRE_TTL_SEC = 60 * 60 * 24 * 60; // 60 天

/**
 * 日级规则（before_expiry/days、on_expiry）按本地日期去重；小时级与 after_expiry 按本地小时。
 * @param {import('../data/reminders.repo.js').ReminderRule} rule
 * @param {{ year: number, month: number, day: number, hourString: string }} nowParts
 */
function buildDedupeBucket(rule, nowParts) {
  const ymd = `${nowParts.year}${String(nowParts.month).padStart(2, '0')}${String(nowParts.day).padStart(2, '0')}`;
  const isDayRule =
    rule.type === 'on_expiry' ||
    (rule.type === 'before_expiry' && rule.unit !== 'hours');
  return isDayRule ? ymd : `${ymd}${nowParts.hourString}`;
}

/**
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} subId
 * @param {string} ruleId
 */
async function readLastFireAt(env, subId, ruleId) {
  return env.SUBSCRIPTIONS_KV.get(`notify_lastfire:${subId}:${ruleId}`);
}

/**
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} subId
 * @param {string} ruleId
 * @param {string} iso
 */
async function writeLastFireAt(env, subId, ruleId, iso) {
  await env.SUBSCRIPTIONS_KV.put(`notify_lastfire:${subId}:${ruleId}`, iso, {
    expirationTtl: LAST_FIRE_TTL_SEC
  });
}

/**
 * 入口：被 Cron 触发的 scheduled() 调用。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<import('../data/scheduler-logs.repo.js').SchedulerLogEntry|null>}
 */
export async function checkExpiringSubscriptions(env) {
  const startedAtIso = new Date().toISOString();
  try {
    const config = await getConfig(env);
    const timezone = config.TIMEZONE || 'UTC';
    const now = getNowInTimezone(timezone);

    const normalizedHours = Array.isArray(config.NOTIFICATION_HOURS)
      ? config.NOTIFICATION_HOURS
          .map((h) => String(h).trim())
          .filter((h) => h.length > 0)
          .map((h) => {
            const up = h.toUpperCase();
            if (up === '*' || up === 'ALL') return '*';
            // 仅对纯数字做两位补齐；'*' 之类通配符保持原样
            return /^\d+$/.test(h) ? h.padStart(2, '0') : up;
          })
      : [];
    const inWindow =
      normalizedHours.length === 0 ||
      normalizedHours.includes('*') ||
      normalizedHours.includes('ALL') ||
      normalizedHours.includes(now.hourString);

    const subscriptions = await getAllSubscriptions(env);
    let activeCount = 0;
    let matchedCount = 0;
    let dedupedCount = 0;
    let sentCount = 0;
    let autoRenewedCount = 0;

    // 不在通知时段：不发送但仍跑自动续费（业务上希望续费总能发生）
    /** @type {Array<{ sub: any, rule: any, daysDiff: number, hoursDiff: number }>} */
    const candidates = [];

    /** @type {Array<any>} */
    const updatedSubsToSave = [];

    for (const subscription of subscriptions) {
      if (!subscription.isActive) continue;
      activeCount++;

      // 计算到期天数（按用户 TZ）
      let expiryDate = new Date(subscription.expiryDate);
      let daysDiff = getDaysBetween(now.utc, expiryDate, timezone);
      let hoursDiff = (expiryDate.getTime() - now.utc.getTime()) / MS_PER_HOUR;

      // 自动续费：已过期 + autoRenew=true → 推进到期日并写收款记录
      if (subscription.autoRenew && daysDiff < 0) {
        const renewed = autoRenew(subscription, now.utc, timezone, config);
        if (renewed) {
          updatedSubsToSave.push(renewed.next);
          autoRenewedCount++;
          // 续费后重算 diff
          expiryDate = new Date(renewed.next.expiryDate);
          daysDiff = getDaysBetween(now.utc, expiryDate, timezone);
          hoursDiff = (expiryDate.getTime() - now.utc.getTime()) / MS_PER_HOUR;
          // 用续费后的对象作后续判断
          subscription.expiryDate = renewed.next.expiryDate;
          subscription.startDate = renewed.next.startDate;
          subscription.lastPaymentDate = renewed.next.lastPaymentDate;
          subscription.paymentHistory = renewed.next.paymentHistory;
        }
      }

      // 加载规则；老客户没有规则时，用稳定 id 的 legacy 规则（避免每 tick 新 UUID 打穿 dedupe）
      let rules = await remindersRepo.listForSubscription(env, subscription.id);
      if (rules.length === 0) {
        const legacy = remindersRepo.legacyFieldToRule(subscription);
        legacy.id = `legacy:${subscription.id}`;
        rules = [legacy];
      }

      for (const rule of rules) {
        const lastFireAtIso =
          rule.type === 'after_expiry'
            ? (await readLastFireAt(env, subscription.id, rule.id)) || undefined
            : undefined;
        const decision = shouldFire(rule, {
          daysDiff,
          hoursDiff,
          nowIso: now.utc.toISOString(),
          lastFireAtIso
        });
        if (!decision.fire) continue;
        matchedCount++;
        candidates.push({ sub: subscription, rule, daysDiff, hoursDiff });
      }
    }

    // 持久化自动续费结果
    if (updatedSubsToSave.length > 0) {
      await subRepo.saveMany(env, updatedSubsToSave);
      console.log(`[定时任务] 已自动续费 ${updatedSubsToSave.length} 个客户`);
    }

    // 不在通知时段 → 写日志后返回
    if (!inWindow) {
      const entry = await schedulerLogsRepo.writeLog(env, {
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        timezone,
        currentHour: now.hourString,
        configuredHours: normalizedHours,
        inWindow: false,
        checkedCount: activeCount,
        matchedCount,
        dedupedCount: 0,
        sentCount: 0,
        autoRenewedCount,
        status: 'skipped',
        reason: `当前${timezone} ${now.hourString}点不在允许发送的小时 [${normalizedHours.join(',') || '未限制=每小时'}] 内（正常跳过，不会发通知）`
      });
      return entry;
    }

    // 在时段：先查重（不预占），发送成功后再写 dedupe / lastFire
    /** @type {Array<{ sub: any, rule: any, daysDiff: number, hoursDiff: number, dedupeKey: string }>} */
    const ready = [];
    const nowParts = {
      year: now.parts.year,
      month: now.parts.month,
      day: now.parts.day,
      hourString: now.hourString
    };
    for (const c of candidates) {
      const bucket = buildDedupeBucket(c.rule, nowParts);
      const dedupeKey = `notify_dedupe:${c.sub.id}:${c.rule.id}:${bucket}`;
      const exists = await env.SUBSCRIPTIONS_KV.get(dedupeKey);
      // 客户专属邮件已成功发送的（独立 dedupe），同样跳过
      const custSent = exists || (await env.SUBSCRIPTIONS_KV.get(dedupeKey + ':cust'));
      if (custSent) {
        dedupedCount++;
        continue;
      }
      ready.push({ ...c, dedupeKey });
    }

    if (ready.length === 0) {
      const entry = await schedulerLogsRepo.writeLog(env, {
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        timezone,
        currentHour: now.hourString,
        configuredHours: normalizedHours,
        inWindow: true,
        checkedCount: activeCount,
        matchedCount,
        dedupedCount,
        sentCount: 0,
        autoRenewedCount,
        status: matchedCount > 0 ? 'skipped' : 'ok',
        reason:
          matchedCount > 0
            ? `命中 ${matchedCount} 条规则但全部在去重窗口内（跳过 ${dedupedCount}）`
            : '本次未命中任何提醒规则'
      });
      return entry;
    }

    // 排序：按剩余天数升序，更紧迫的在前
    ready.sort((a, b) => a.daysDiff - b.daysDiff);

    // 按 owner 分组：每个用户用自己的通知配置（用户隔离）
    const { ownerMap } = await import('../data/subscriptions.repo.js');
    const { getNotifyConfig } = await import('../data/users.repo.js');
    const idToOwner = await ownerMap(env);
    /** @type {Record<string, typeof ready>} */
    const byOwner = {};
    for (const c of ready) {
      const owner = idToOwner[c.sub.id] || '';
      (byOwner[owner] = byOwner[owner] || []).push(c);
    }

    let anySuccess = false;
    const ownerResults = [];
    for (const [owner, items] of Object.entries(byOwner)) {
      // 解析该用户的通知配置；未配置的用户跳过（不发，也不写 dedupe → 配置后可重发）
      let userCfg = null;
      if (owner) {
        userCfg = await getNotifyConfig(env, owner);
      }

      const effCfg = userCfg
        ? {
            ...config,
            ENABLED_NOTIFIERS: userCfg.ENABLED_NOTIFIERS || [],
            TG_BOT_TOKEN: userCfg.TG_BOT_TOKEN || '',
            TG_CHAT_ID: userCfg.TG_CHAT_ID || '',
            BARK_DEVICE_KEY: userCfg.BARK_DEVICE_KEY || '',
            WEBHOOK_URL: userCfg.WEBHOOK_URL || '',
            WECHATBOT_WEBHOOK: userCfg.WECHATBOT_WEBHOOK || '',
            WECHATBOT_MSG_TYPE: userCfg.WECHATBOT_MSG_TYPE || 'text',
            RESEND_API_KEY: userCfg.RESEND_API_KEY || '',
            EMAIL_FROM: userCfg.EMAIL_FROM || '',
            EMAIL_TO: userCfg.EMAIL_TO || '',
            TIMEZONE: userCfg.TIMEZONE || timezone
          }
        : (owner ? null : config); // 有 owner 但没配置 → 不发；无主（遗留数据）→ 全局 config

      if (!effCfg) {
        ownerResults.push({ owner, items, sent: 0, reason: '用户未配置通知渠道，跳过' });
        continue;
      }

      // ── 客户专属邮件（客户填了邮箱 + owner 配了 SMTP + 有模板）──
      let ownerRow = null, defaultTpl = null, ownerTemplates = [];
      try {
        const { getRowById } = await import('../data/users.repo.js');
        const { getDefaultTemplate, listTemplates } = await import('../data/email-templates.repo.js');
        ownerRow = await getRowById(env, owner);
        if (ownerRow) {
          defaultTpl = await getDefaultTemplate(env, owner);
          ownerTemplates = await listTemplates(env, owner);
        }
      } catch (e) { /* 模板/配置读取失败不影响主流程 */ }

      const tplOf = (c) => {
        // 客户级模板优先，回退默认模板
        if (c.sub.notifyTemplateId) {
          const t = ownerTemplates.find((x) => x.id === c.sub.notifyTemplateId);
          if (t) return t;
        }
        return defaultTpl;
      };
      const withEmail = ownerRow && (ownerRow.notify_config || '').includes('SMTP_EMAIL')
        ? items.filter((c) => c.sub.customerEmail && tplOf(c))
        : [];
      const withoutEmail = items.filter((c) => !withEmail.includes(c));

      for (const c of withEmail) {
        const tpl = tplOf(c);
        try {
          const { sendCustomerEmail } = await import('../api/handlers/email-templates.js');
          const result = await sendCustomerEmail(env, ownerRow, tpl, c.sub, {
            '客户名': c.sub.name,
            '到期日期': new Date(c.sub.expiryDate).toISOString().slice(0, 10),
            '剩余天数': Math.ceil(c.daysDiff),
            '金额': c.sub.amount != null ? `${c.sub.amount} ${c.sub.currency || ''}`.trim() : '',
            '分类': c.sub.category || c.sub.customType || ''
          });
          if (result.ok) {
            sentCount++;
            c.customerEmailed = true;
            // 专属邮件成功即写独立 dedupe：即使聚合通知失败，下小时也不会重复给客户发信
            const custDedupeKey = c.dedupeKey + ':cust';
            await env.SUBSCRIPTIONS_KV.put(custDedupeKey, '1', { expirationTtl: 20 * 24 * 3600 });
          } else {
            console.warn(`[定时任务] 客户专属邮件失败 (${c.sub.name}):`, result.error);
          }
        } catch (e) {
          console.warn('[定时任务] 客户专属邮件异常:', e.message);
        }
      }

      // ── 聚合通知（发给 owner 自己的渠道）──
      // 只聚合未发专属邮件的客户？不——全部聚合，保证 owner 自己的渠道也有完整清单。
      const enrichedSubs = items.map((c) => ({
        ...c.sub,
        customerEmailed: !!c.customerEmailed,
        daysRemaining: c.daysDiff,
        hoursRemaining: Math.round(c.hoursDiff)
      }));
      const content = formatNotificationContent(enrichedSubs, effCfg);
      const title = '客户到期/续费提醒';

      const primary = items[0];
      const dispatchResult = await dispatch(
        { title, content },
        effCfg,
        {
          env,
          subId: primary.sub.id,
          ruleId: primary.rule.id,
          logPrefix: '[定时任务]',
          metadata: {
            tags: enrichedSubs.map((s) => s.name),
            daysRemaining: primary.daysDiff,
            ruleType: primary.rule.type,
            ruleValue: primary.rule.value,
            ownerUserId: owner || null
          }
        }
      );
      sentCount += dispatchResult.successCount;
      if (dispatchResult.successCount > 0) anySuccess = true;
      ownerResults.push({ owner, items, sent: dispatchResult.successCount });

      // 该用户组发送成功 → 写 dedupe / lastFire（仅成功的组）
      if (dispatchResult.successCount > 0) {
        const firedAt = now.utc.toISOString();
        await Promise.all(
          items.map(async (c) => {
            await env.SUBSCRIPTIONS_KV.put(c.dedupeKey, '1', { expirationTtl: DEDUPE_TTL_SEC });
            if (c.rule.type === 'after_expiry') {
              await writeLastFireAt(env, c.sub.id, c.rule.id, firedAt);
            }
          })
        );
      }
    }

    const entry = await schedulerLogsRepo.writeLog(env, {
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      timezone,
      currentHour: now.hourString,
      configuredHours: normalizedHours,
      inWindow: true,
      checkedCount: activeCount,
      matchedCount,
      dedupedCount,
      sentCount,
      autoRenewedCount,
      status: sentCount === 0 && matchedCount > 0 && dedupedCount === 0 ? 'skipped' : 'ok',
      reason:
        sentCount > 0
          ? `按用户分组发送完成，成功 ${sentCount} 个渠道调用`
          : (ownerResults.find((r) => r.reason) || {}).reason || '本次无匹配或全部去重',
      extra: {
        ownerResults: ownerResults.map((r) => ({ owner: r.owner, count: r.items.length, sent: r.sent, reason: r.reason || null })),
        candidates: ready.map((c) => ({
          subId: c.sub.id,
          subName: c.sub.name,
          ruleId: c.rule.id,
          ruleType: c.rule.type,
          ruleValue: c.rule.value,
          daysDiff: c.daysDiff
        }))
      }
    });
    return entry;
  } catch (error) {
    console.error('[定时任务] 执行失败:', error);
    return schedulerLogsRepo.writeLog(env, {
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      timezone: 'UTC',
      currentHour: '00',
      configuredHours: [],
      inWindow: false,
      checkedCount: 0,
      matchedCount: 0,
      dedupedCount: 0,
      sentCount: 0,
      autoRenewedCount: 0,
      status: 'error',
      reason: '执行异常: ' + (error && error.message ? error.message : String(error)),
      extra: { stack: error && error.stack }
    });
  }
}

/**
 * 自动续费：把已过期的客户按周期推进，生成 auto 类型收款记录。
 *
 * 按"cycle / reset 模式 + 公历 / 农历分支。
 *
 * @param {any} sub
 * @param {Date} now UTC 时刻
 * @param {string} timezone
 * @param {any} config
 * @returns {{ next: any } | null}
 */
function autoRenew(sub, now, timezone, config) {
  const mode = sub.subscriptionMode || 'cycle';
  const tz = timezone || 'UTC';
  let expiryDate = new Date(sub.expiryDate);
  let periodsAdded = 0;
  const nowMidnight = getTimezoneMidnightTimestamp(now, tz);

  /**
   * @param {number} y
   * @param {number} m
   * @param {number} d
   */
  function atTimezoneMidnight(y, m, d) {
    const ts = getTimestampForTimezoneParts(
      { year: y, month: m, day: d, hour: 0, minute: 0, second: 0 },
      tz
    );
    return new Date(ts);
  }

  if (sub.useLunar) {
    let parts = getTimezoneDateParts(expiryDate, tz);
    let lunar = lunarCalendar.solar2lunar(parts.year, parts.month, parts.day);
    while (getTimezoneMidnightTimestamp(expiryDate, tz) <= nowMidnight) {
      if (!lunar) break;
      lunar = lunarBiz.addLunarPeriod(lunar, sub.periodValue, sub.periodUnit);
      const solar = lunarBiz.lunar2solar(lunar);
      if (!solar) break;
      expiryDate = atTimezoneMidnight(solar.year, solar.month, solar.day);
      periodsAdded++;
      if (periodsAdded > 60) break;
    }
  } else {
    while (getTimezoneMidnightTimestamp(expiryDate, tz) <= nowMidnight) {
      if (mode === 'reset') {
        // 重置：从「现在」所在本地日重新起算一个周期
        const p = getTimezoneDateParts(now, tz);
        expiryDate = atTimezoneMidnight(p.year, p.month, p.day);
      }
      expiryDate = addCalendarPeriodInTimezone(
        expiryDate,
        sub.periodValue || 1,
        sub.periodUnit || 'month',
        tz,
        { endOfMonth: !!sub.endOfMonth }
      );
      periodsAdded++;
      if (periodsAdded > 120) break;
    }
  }

  if (periodsAdded === 0) return null;

  const newStartDate = mode === 'reset' ? new Date(now) : new Date(sub.expiryDate);
  const newExpiryDate = expiryDate;

  const paymentRecord = {
    id: Date.now().toString(),
    date: now.toISOString(),
    amount: sub.amount || 0,
    type: 'auto',
    note: `自动续费 (${mode === 'reset' ? '重置模式' : '接续模式'}${
      periodsAdded > 1 ? ', 补齐' + periodsAdded + '周期' : ''
    })`,
    periodStart: newStartDate.toISOString(),
    periodEnd: newExpiryDate.toISOString()
  };

  const paymentHistoryLimit = Number(config.PAYMENT_HISTORY_LIMIT) || 100;
  const ph = [...(sub.paymentHistory || []), paymentRecord];
  const trimmed = ph.length > paymentHistoryLimit ? ph.slice(-paymentHistoryLimit) : ph;

  return {
    next: {
      ...sub,
      startDate: newStartDate.toISOString(),
      expiryDate: newExpiryDate.toISOString(),
      lastPaymentDate: now.toISOString(),
      paymentHistory: trimmed
    }
  };
}
