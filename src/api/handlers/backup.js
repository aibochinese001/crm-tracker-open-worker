// @ts-check
/**
 * 配置与数据备份 / 恢复
 *
 * GET  /api/backup?includeSecrets=0|1
 * POST /api/restore  body: { backup, mode: 'merge'|'replace', includeSecrets?: boolean }
 *
 * 设计约束：
 * - 默认导出不含密钥/密码，避免备份文件泄露
 * - JWT_SECRET 永不导出、导入时也不覆盖（避免会话被意外作废；换环境请重新登录）
 * - 客户 + reminder_rules 一并导出，保证多规则提醒可无损迁移
 */
import { getConfig, setConfig } from '../../data/config.js';
import * as subRepo from '../../data/subscriptions.repo.js';
import * as remindersRepo from '../../data/reminders.repo.js';
import { getCategories } from '../../data/categories.js';
import { putKVJson } from '../../data/kv.js';
import { SECRET_FIELDS } from './config.js';
import { VERSION } from './extras.js';

const BACKUP_FORMAT = 'substracker-backup';
const BACKUP_VERSION = 1;

/** 永不导出/覆盖的字段 */
const NEVER_EXPORT_FIELDS = ['JWT_SECRET', 'ADMIN_PASSWORD'];

/**
 * @param {any} data
 * @param {number} [status]
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * @param {any} config
 * @param {boolean} includeSecrets
 */
function buildExportConfig(config, includeSecrets) {
  /** @type {Record<string, any>} */
  const out = { ...config };
  delete out.JWT_SECRET;

  if (!includeSecrets) {
    delete out.ADMIN_PASSWORD;
    for (const key of SECRET_FIELDS) {
      if (key in out) out[key] = '';
    }
  } else {
    // 即使含密钥，也不导出 JWT_SECRET
    delete out.JWT_SECRET;
  }

  return out;
}

/**
 * GET /api/backup
 *
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function handleExportBackup(request, env) {
  try {
    const url = new URL(request.url);
    const includeSecrets =
      url.searchParams.get('includeSecrets') === '1' ||
      url.searchParams.get('includeSecrets') === 'true';

    const config = await getConfig(env);
    const categories = await getCategories(env);
    const subscriptions = await subRepo.listAll(env);

    /** @type {Record<string, any[]>} */
    const reminderRules = {};
    for (const sub of subscriptions) {
      if (!sub || !sub.id) continue;
      let rules = await remindersRepo.listForSubscription(env, sub.id);
      if (rules.length === 0) {
        rules = [remindersRepo.legacyFieldToRule(sub)];
      }
      reminderRules[sub.id] = rules;
    }

    // 导出体不附带运行时附加字段
    const cleanSubs = subscriptions.map((sub) => {
      const { reminderRules: _rr, reminderRulesSummary: _rs, ...rest } = sub || {};
      return rest;
    });

    const backup = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      appVersion: VERSION,
      exportedAt: new Date().toISOString(),
      includeSecrets,
      config: buildExportConfig(config, includeSecrets),
      categories,
      subscriptions: cleanSubs,
      reminderRules
    };

    return new Response(JSON.stringify(backup, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="substracker-backup-${new Date()
          .toISOString()
          .slice(0, 10)}.json"`
      }
    });
  } catch (error) {
    console.error('[backup] 导出失败:', error);
    return json(
      { success: false, message: '导出失败: ' + (error && error.message ? error.message : String(error)) },
      500
    );
  }
}

/**
 * 校验备份结构
 * @param {any} raw
 * @returns {{ ok: true, backup: any } | { ok: false, message: string }}
 */
/**
 * @param {any} sub
 * @param {number} index
 * @returns {string|null} 错误信息
 */
function validateSubscriptionEntry(sub, index) {
  if (!sub || typeof sub !== 'object') {
    return `subscriptions[${index}] 不是对象`;
  }
  if (typeof sub.id !== 'string' || !sub.id.trim()) {
    return `subscriptions[${index}] 缺少有效 id`;
  }
  if (typeof sub.name !== 'string' || !sub.name.trim()) {
    return `subscriptions[${index}] 缺少 name`;
  }
  if (!sub.expiryDate || Number.isNaN(new Date(sub.expiryDate).getTime())) {
    return `subscriptions[${index}] 缺少有效 expiryDate`;
  }
  return null;
}

function validateBackup(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, message: '备份内容不是有效 JSON 对象' };
  }
  if (raw.format && raw.format !== BACKUP_FORMAT) {
    return { ok: false, message: `不支持的备份格式: ${raw.format}` };
  }
  if (raw.version != null && Number(raw.version) > BACKUP_VERSION) {
    return { ok: false, message: `备份版本过高 (${raw.version})，请升级应用后再导入` };
  }
  if (!Array.isArray(raw.subscriptions)) {
    return { ok: false, message: '备份缺少 subscriptions 数组' };
  }
  for (let i = 0; i < raw.subscriptions.length; i++) {
    const err = validateSubscriptionEntry(raw.subscriptions[i], i);
    if (err) return { ok: false, message: err };
  }
  if (raw.reminderRules != null && typeof raw.reminderRules !== 'object') {
    return { ok: false, message: 'reminderRules 必须是对象' };
  }
  return { ok: true, backup: raw };
}

/**
 * 合并配置：默认不覆盖密钥空值；includeSecrets 时才写入非空密钥
 *
 * @param {any} current
 * @param {any} incoming
 * @param {boolean} includeSecrets
 */
function mergeConfig(current, incoming, includeSecrets) {
  if (!incoming || typeof incoming !== 'object') return current;

  /** @type {Record<string, any>} */
  const next = { ...current };

  for (const [key, value] of Object.entries(incoming)) {
    if (NEVER_EXPORT_FIELDS.includes(key) || key === 'JWT_SECRET') continue;

    if (SECRET_FIELDS.includes(key) || key === 'ADMIN_PASSWORD') {
      if (!includeSecrets) continue;
      if (typeof value === 'string' && value.trim() !== '') {
        next[key] = value;
      }
      continue;
    }

    if (value !== undefined) {
      next[key] = value;
    }
  }

  // 始终保留现有 JWT
  next.JWT_SECRET = current.JWT_SECRET;
  return next;
}

/**
 * POST /api/restore
 *
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function handleImportBackup(request, env) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: '请求体不是合法 JSON' }, 400);
    }

    // 兼容：body 直接是备份，或 { backup, mode, includeSecrets }
    const rawBackup = body && body.backup ? body.backup : body;
    const mode = body && body.mode === 'replace' ? 'replace' : 'merge';
    const includeSecrets = !!(body && body.includeSecrets);

    const validated = validateBackup(rawBackup);
    if (!validated.ok) {
      return json({ success: false, message: /** @type {any} */ (validated).message }, 400);
    }
    const backup = /** @type {any} */ (validated).backup;

    // 先写客户/规则，再写配置：避免配置已改但数据半残
    const incomingSubs = backup.subscriptions.filter((s) => s && typeof s.id === 'string' && s.id);
    if (mode === 'replace' && incomingSubs.length === 0) {
      return json(
        { success: false, message: '覆盖模式拒绝空客户列表（请确认备份完整或改用合并模式）' },
        400
      );
    }

    const rulesMap =
      backup.reminderRules && typeof backup.reminderRules === 'object' ? backup.reminderRules : {};

    let importedSubs = 0;
    let importedRules = 0;

    if (mode === 'replace') {
      const existing = await subRepo.listAll(env);
      for (const sub of existing) {
        if (sub && sub.id) {
          await remindersRepo.clearForSubscription(env, sub.id);
        }
      }
      await subRepo.replaceAll(env, incomingSubs);
      importedSubs = incomingSubs.length;
    } else {
      for (const sub of incomingSubs) {
        await subRepo.save(env, sub);
        importedSubs++;
      }
    }

    for (const sub of incomingSubs) {
      let rules = Array.isArray(rulesMap[sub.id]) ? rulesMap[sub.id] : null;
      if (!rules && Array.isArray(sub.reminderRules)) rules = sub.reminderRules;
      if (rules && rules.length > 0) {
        const normalized = rules.map((r) => remindersRepo.normalizeRule(r));
        await remindersRepo.replaceForSubscription(env, sub.id, normalized);
        importedRules += normalized.length;
        try {
          const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
          await syncLegacyReminderFields(env, sub.id, normalized);
        } catch {
          /* ignore */
        }
      }
    }

    // 分类
    if (Array.isArray(backup.categories)) {
      const cats = backup.categories
        .filter((c) => typeof c === 'string' && c.trim())
        .map((c) => c.trim());
      if (mode === 'replace') {
        await putKVJson(env, 'categories', [...new Set(cats)].sort());
      } else {
        const existing = await getCategories(env);
        const set = new Set([...existing, ...cats]);
        await putKVJson(env, 'categories', [...set].sort());
      }
    }

    // 配置放最后
    const currentConfig = await getConfig(env);
    if (backup.config && typeof backup.config === 'object') {
      const merged = mergeConfig(currentConfig, backup.config, includeSecrets);
      await setConfig(env, merged);
    }

    return json({
      success: true,
      message: `恢复完成（模式: ${mode === 'replace' ? '覆盖' : '合并'}）`,
      stats: {
        subscriptions: importedSubs,
        reminderRules: importedRules,
        categories: Array.isArray(backup.categories) ? backup.categories.length : 0,
        configRestored: !!backup.config,
        secretsApplied: includeSecrets
      }
    });
  } catch (error) {
    console.error('[backup] 导入失败:', error);
    return json(
      { success: false, message: '导入失败: ' + (error && error.message ? error.message : String(error)) },
      500
    );
  }
}
