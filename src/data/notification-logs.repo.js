// @ts-check
/**
 * 通知日志仓库（D1 版，v2）
 * D1: notification_logs(id PK, owner_user_id, channel, target, title, content, status, error, sub_id, sub_name, created_at)
 * 降级：D1 不可用时回退 KV notify_log:* 前缀
 */

const PREFIX = 'notify_log:';
const DEFAULT_TTL_SEC = 30 * 24 * 3600;

/**
 * 把 Date 转成 'YYYYMMDDHH' UTC 字符串。
 *
 * @param {Date | string | number} date
 * @returns {string}
 */
export function ymdhUtc(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return ymdhUtc(new Date());
  }
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}`;
}

/**
 * 写入一条通知日志。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace, __ownerScope?: string }} env
 * @param {{
 *   subId: string,
 *   ruleId?: string|null,
 *   channel: string,
 *   status: 'success'|'failed',
 *   title?: string,
 *   content?: string,
 *   error?: string,
 *   raw?: any,
 *   timestamp?: string|Date|number,
 *   ttlSec?: number,
 *   target?: string|null,
 *   subName?: string|null
 * }} entry
 * @returns {Promise<Object>}
 */
export async function writeLog(env, entry) {
  const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
  const rand = Math.floor(ts.getTime() % 100000).toString(36).padStart(4, '0');
  const ruleId = entry.ruleId || 'none';
  const key = `${PREFIX}${ymdhUtc(ts)}:${entry.subId}:${ruleId}:${entry.channel}:${rand}`;

  const stored = {
    timestamp: ts.toISOString(),
    subId: entry.subId,
    ruleId,
    channel: entry.channel,
    status: entry.status,
    title: entry.title,
    content: entry.content,
    error: entry.error,
    raw: entry.raw
  };

  const { getDB } = await import('./db.js');
  const db = await getDB(env);
  if (!db) {
    await env.SUBSCRIPTIONS_KV.put(key, JSON.stringify(stored), {
      expirationTtl: Math.max(60, entry.ttlSec || DEFAULT_TTL_SEC)
    });
    return { key, ...stored };
  }

  await db
    .prepare(
      "INSERT INTO notification_logs (id, owner_user_id, channel, target, title, content, status, error, sub_id, sub_name, created_at, rule_id) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
    )
    .bind(
      key,
      env.__ownerScope || null,
      String(entry.channel || 'unknown'),
      entry.target || null,
      entry.title || null,
      (entry.content || '').slice(0, 2000),
      String(entry.status || 'unknown'),
      entry.error ? String(entry.error).slice(0, 1000) : null,
      entry.subId || null,
      entry.subName || null,
      ts.getTime(),
      entry.ruleId || null
    )
    .run();
  return { key, ...stored };
}

/**
 * 查询通知日志。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace, __ownerScope?: string }} env
 * @param {{
 *   subId?: string,
 *   channel?: string,
 *   status?: 'success'|'failed',
 *   since?: string|Date|number,
 *   until?: string|Date|number,
 *   limit?: number
 * }} [filter]
 * @returns {Promise<Object[]>}
 */
export async function query(env, filter = {}) {
  const limit = Math.min(500, Math.max(1, filter.limit || 100));
  const { getDB } = await import('./db.js');
  const db = await getDB(env);

  if (!db) {
    // KV 降级路径（原实现）
    const all = [];
    let cursor;
    do {
      const res = await env.SUBSCRIPTIONS_KV.list({ prefix: PREFIX, cursor, limit: 1000 });
      for (const k of res.keys) all.push(k.name);
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor && all.length < 5000);

    all.sort((a, b) => b.localeCompare(a));
    const sinceTs = filter.since ? new Date(filter.since).getTime() : 0;
    const untilTs = filter.until ? new Date(filter.until).getTime() : Number.POSITIVE_INFINITY;
    const out = [];
    for (const key of all) {
      if (out.length >= limit) break;
      const raw = await env.SUBSCRIPTIONS_KV.get(key);
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        if (filter.subId && obj.subId !== filter.subId) continue;
        if (filter.channel && obj.channel !== filter.channel) continue;
        if (filter.status && obj.status !== filter.status) continue;
        const tsMs = new Date(obj.timestamp).getTime();
        if (tsMs < sinceTs || tsMs > untilTs) continue;
        out.push({ key, ...obj });
      } catch { /* skip */ }
    }
    return out;
  }

  // D1 路径
  const conds = [];
  const params = [];
  if (env.__ownerScope) {
    conds.push('owner_user_id = ?' + (params.length + 1));
    params.push(env.__ownerScope);
  }
  if (filter.subId) {
    conds.push('sub_id = ?' + (params.length + 1));
    params.push(filter.subId);
  }
  if (filter.channel) {
    conds.push('channel = ?' + (params.length + 1));
    params.push(filter.channel);
  }
  if (filter.status) {
    conds.push('status = ?' + (params.length + 1));
    params.push(filter.status);
  }
  if (filter.since) {
    conds.push('created_at >= ?' + (params.length + 1));
    params.push(new Date(filter.since).getTime());
  }
  if (filter.until) {
    conds.push('created_at <= ?' + (params.length + 1));
    params.push(new Date(filter.until).getTime());
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const result = await db
    .prepare('SELECT * FROM notification_logs ' + where + ' ORDER BY created_at DESC LIMIT ?' + (params.length + 1))
    .bind(...params, limit)
    .all();
  return (result.results || []).map((r) => ({
    key: r.id,
    timestamp: new Date(/** @type {number} */ (r.created_at)).toISOString(),
    subId: r.sub_id,
    subName: r.sub_name || null,
    ruleId: r.rule_id || null,
    channel: r.channel,
    status: r.status,
    title: r.title,
    content: r.content,
    error: r.error
  }));
}

/**
 * 取某客户最近 N 条日志。
 */
export async function recentForSubscription(env, subId, limit = 20) {
  return query(env, { subId, limit });
}
