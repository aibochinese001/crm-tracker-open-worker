// @ts-check
/**
 * 自动数据迁移
 *
 * ── 设计原则 ────────────────────────────────────────────────
 * 1. **幂等**：每个 step 多次执行结果一致，且 `migrate:{step.id}=done` 标记跳过。
 * 2. **可重入安全**：通过 `migration_lock` Key（60s TTL）防止 Cron 与请求并发触发。
 *    最坏情况是其中一方放弃迁移，另一方完成；不会双写。
 * 3. **可累加**：后续 Task 在 `MIGRATION_STEPS` 数组里追加 step，不影响已运行的步骤。
 * 4. **数据安全**：旧 `subscriptions` 单 Key 在迁移成功后改名为
 *    `subscriptions_v2_backup`（7 天 TTL）保留作回滚备份。
 *
 * ── KV 标记一览 ─────────────────────────────────────────────
 *   schema_version           = 'v3'        ← 数据 schema 版本标识，置上后每次请求秒过
 *   migrate:subscriptions_v3 = 'done'      ← 每个 step 自己的标记
 *   migration_lock           = ISO 时间戳   ← TTL 60s 的悲观锁
 *
 */

import * as subRepo from './subscriptions.repo.js';
import * as remindersRepo from './reminders.repo.js';
import * as schedulerLogsRepo from './scheduler-logs.repo.js';

/** 当前 schema 版本字符串 */
export const SCHEMA_VERSION = 'v3';

const KEY_SCHEMA_VERSION = 'schema_version';
const KEY_MIGRATION_LOCK = 'migration_lock';
const LOCK_TTL_SEC = 60;
const BACKUP_TTL_SEC = 7 * 24 * 3600;

/**
 * @typedef {Object} MigrationStep
 * @property {string} id 唯一标识，用于幂等标记
 * @property {string} description 中文描述
 * @property {(env: any) => Promise<void>} run 执行体
 */

/** 当前所有 迁移步骤（后续 Task 追加） */
export const MIGRATION_STEPS = [
  {
    id: 'subscriptions_v3',
    description: '把单 Key subscriptions 拆成 sub:{id} + sub_index',
    run: migrateSubscriptions
  },
  {
    id: 'reminder_rules_v3',
    description: '把客户自带的 reminderUnit/reminderValue 转成 reminder_rules:{subId}',
    run: migrateReminderRules
  },
  {
    id: 'scheduler_logs_v3',
    description: '把旧 scheduler_status_history 合并到 sched_log:{iso}',
    run: migrateSchedulerLogs
  }
];

/**
 * 已运行迁移的内存缓存（避免每次请求都查一次 KV）。
 * 同一 isolate 内只查一次。
 */
let cachedSchemaVersion = /** @type {string|null} */ (null);

/**
 * 入口：确保所有迁移步骤已运行完成。
 *
 * 调用方式：在 Worker fetch / scheduled 入口处第一行调用一次。
 * 已迁移过的请求几乎零开销（命中内存缓存或 1 次 KV.get）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<{ migrated: boolean, reason?: string, ranSteps?: string[] }>}
 */
export async function ensureMigrations(env) {
  if (cachedSchemaVersion === SCHEMA_VERSION) {
    return { migrated: false, reason: 'cached' };
  }

  const current = await env.SUBSCRIPTIONS_KV.get(KEY_SCHEMA_VERSION);
  if (current === SCHEMA_VERSION) {
    cachedSchemaVersion = SCHEMA_VERSION;
    return { migrated: false, reason: 'already_v3' };
  }

  // 尝试加锁
  const acquired = await tryAcquireLock(env);
  if (!acquired) {
    return { migrated: false, reason: 'locked_elsewhere' };
  }

  const ranSteps = [];
  try {
    for (const step of MIGRATION_STEPS) {
      const doneFlag = await env.SUBSCRIPTIONS_KV.get(`migrate:${step.id}`);
      if (doneFlag === 'done') continue;

      console.log(`[migrate] 开始执行: ${step.id} - ${step.description}`);
      await step.run(env);
      await env.SUBSCRIPTIONS_KV.put(`migrate:${step.id}`, 'done');
      console.log(`[migrate] 完成: ${step.id}`);
      ranSteps.push(step.id);
    }
    await env.SUBSCRIPTIONS_KV.put(KEY_SCHEMA_VERSION, SCHEMA_VERSION);
    cachedSchemaVersion = SCHEMA_VERSION;
    return { migrated: true, ranSteps };
  } catch (err) {
    console.error('[migrate] 执行失败，本次不会标记完成，下次请求会重试:', err);
    throw err;
  } finally {
    await releaseLock(env);
  }
}

/**
 * 测试用：清除内存缓存，强制下次重新检查 schema_version。
 */
export function _resetMigrationCache() {
  cachedSchemaVersion = null;
}

/**
 * 测试用：检查内存缓存状态。
 */
export function _getCachedSchemaVersion() {
  return cachedSchemaVersion;
}

// ─────────────────────────────────────────────────────────────
// 锁 helper
// ─────────────────────────────────────────────────────────────

/**
 * 试图获取迁移锁。
 * KV 没有 CAS，只能"先读后写"——存在小窗口竞态，足够大多数场景。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<boolean>}
 */
async function tryAcquireLock(env) {
  const existing = await env.SUBSCRIPTIONS_KV.get(KEY_MIGRATION_LOCK);
  if (existing) return false;
  await env.SUBSCRIPTIONS_KV.put(KEY_MIGRATION_LOCK, new Date().toISOString(), {
    expirationTtl: LOCK_TTL_SEC
  });
  return true;
}

async function releaseLock(env) {
  try {
    await env.SUBSCRIPTIONS_KV.delete(KEY_MIGRATION_LOCK);
  } catch (err) {
    console.warn('[migrate] 释放锁失败（TTL 60s 后会自动释放）:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// 各 step 实现
// ─────────────────────────────────────────────────────────────

/**
 * 迁移：旧 `subscriptions`（JSON 数组）→ `sub:{id}` 多 Key + `sub_index`。
 *
 * - 读 `subscriptions`，逐条写 `sub:{id}`，构建索引并写 `sub_index`
 * - 旧 `subscriptions` 改名为 `subscriptions_v2_backup`（7 天 TTL）后删除
 * - 旧数据为空或缺失：仅写一个空索引，schema_version 仍写入
 *
 * 幂等性：
 *   - 若 sub_index 已写过且 sub:{id} 已存在，重复执行会覆盖（值相同，影响仅 KV 写次数）
 *   - 若旧 subscriptions 已被改名，第二次读到 null 视为已迁移，跳过
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function migrateSubscriptions(env) {
  const oldRaw = await env.SUBSCRIPTIONS_KV.get('subscriptions');

  /** @type {any[]} */
  let oldSubs = [];
  if (oldRaw) {
    try {
      const parsed = JSON.parse(oldRaw);
      oldSubs = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error('[migrate:subscriptions_v3] 旧数据 JSON 解析失败，按空处理:', err);
      oldSubs = [];
    }
  }

  // 写入新结构（即使 oldSubs 为空也要写 sub_index 占位）
  if (oldSubs.length > 0) {
    await subRepo.replaceAll(env, oldSubs);
  } else {
    // 现有索引可能已有值（来自第二次执行），不要覆盖
    // （v2 SaaS 版 sub_index 由 KV 降级层内部维护，此处直接确保占位存在）
    const existingRaw = await env.SUBSCRIPTIONS_KV.get('sub_index');
    if (!existingRaw) {
      await env.SUBSCRIPTIONS_KV.put('sub_index', '[]');
    }
  }

  // 备份旧数据并删除原 Key
  if (oldRaw) {
    await env.SUBSCRIPTIONS_KV.put('subscriptions_v2_backup', oldRaw, {
      expirationTtl: BACKUP_TTL_SEC
    });
    await env.SUBSCRIPTIONS_KV.delete('subscriptions');
  }

  console.log(`[migrate:subscriptions_v3] 已迁移 ${oldSubs.length} 条客户`);
}

/**
 * 迁移：根据每个客户的 reminderUnit/reminderValue 生成 1 条等价 before_expiry 规则。
 *
 * 仅对没有 reminder_rules:{subId} 的客户写入；如果用户在新版本里已经手动配置过规则，
 * 不会被覆盖。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function migrateReminderRules(env) {
  const subs = await subRepo.listAll(env);
  let count = 0;
  for (const sub of subs) {
    const existing = await remindersRepo.listForSubscription(env, sub.id);
    if (existing.length > 0) continue;
    const rule = remindersRepo.legacyFieldToRule(sub);
    await remindersRepo.replaceForSubscription(env, sub.id, [rule]);
    count++;
  }
  console.log(`[migrate:reminder_rules_v3] 已为 ${count} 个客户生成默认提醒规则`);
}

/**
 * 迁移：把旧 scheduler_status_history（早期版本最多保留 20 条调度状态）转写到 sched_log:{iso}。
 *
 * 仅作历史记录的最佳努力迁移，结构差异较大，主要保留时间线索。
 * 旧 Key 迁移完保留作回滚备份（让 KV TTL 自然过期清理）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function migrateSchedulerLogs(env) {
  const histRaw = await env.SUBSCRIPTIONS_KV.get('scheduler_status_history');
  if (!histRaw) return;
  /** @type {any[]} */
  let history = [];
  try {
    const parsed = JSON.parse(histRaw);
    history = Array.isArray(parsed) ? parsed : [];
  } catch {
    history = [];
  }

  let count = 0;
  for (const item of history) {
    const startedAt = item.lastRunAt || new Date().toISOString();
    await schedulerLogsRepo.writeLog(
      env,
      {
        startedAt,
        finishedAt: startedAt,
        timezone: item.timezone || 'UTC',
        currentHour: item.currentHour || '00',
        configuredHours: Array.isArray(item.configuredHours) ? item.configuredHours : [],
        inWindow: !!item.shouldNotifyThisHour,
        checkedCount: item.checkedSubscriptions || 0,
        matchedCount: item.expiringMatched || 0,
        dedupedCount: item.dedupeSkipped || 0,
        sentCount: item.sent ? 1 : 0,
        autoRenewedCount: item.updatedSubscriptions || 0,
        status: item.errorStack ? 'error' : item.sent ? 'ok' : 'skipped',
        reason: item.reason || (item.errorStack ? 'legacy_error' : undefined),
        extra: { migratedFromV2: true }
      },
      { ttlSec: 7 * 24 * 3600 }
    );
    count++;
  }
  console.log(`[migrate:scheduler_logs_v3] 已迁移 ${count} 条历史调度记录`);
}
