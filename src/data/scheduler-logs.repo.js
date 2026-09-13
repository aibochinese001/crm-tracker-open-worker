// @ts-check
/**
 * 调度器执行日志仓库（D1 版，v2）
 * D1: scheduler_logs(id PK, run_at, checked, fired, detail JSON, created_at)
 * 降级：D1 不可用时回退 KV sched_log:{isoUtc}
 */

const PREFIX = 'sched_log:';
const KV_PREFIX = 'sched_log:';

/**
 * 写一条调度日志。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace }} env
 * @param {Object} entry
 * @param {Object} [opts]
 */
export async function writeLog(env, entry, opts = {}) {
  const { getDB } = await import('./db.js');
  const db = await getDB(env);
  // key 唯一性：优先调用方 key；否则 sched_log:{entry.timestamp}（同 key 覆盖，与 KV 版语义一致）
  const finalKey = entry.key
    || PREFIX + (entry.startedAt || entry.timestamp || new Date().toISOString());
  const stored = { ...entry, key: finalKey };
  if (!db) {
    await env.SUBSCRIPTIONS_KV.put(finalKey, JSON.stringify(stored), { expirationTtl: 30 * 24 * 3600 });
    return stored;
  }
  await db
    .prepare(
      "INSERT INTO scheduler_logs (id, run_at, checked, fired, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
      "ON CONFLICT(id) DO UPDATE SET detail = ?5, run_at = ?2"
    )
    .bind(
      finalKey,
      entry.startedAt || entry.timestamp
        ? new Date(entry.startedAt || entry.timestamp).getTime()
        : Date.now(),
      entry.checked ?? null,
      entry.fired ?? null,
      JSON.stringify(stored).slice(0, 4000),
      Date.now()
    )
    .run();
  return stored;
}

/**
 * 读取最近 N 条调度日志（新→旧）。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace }} env
 * @param {number} [limit]
 */
export async function getRecent(env, limit = 20) {
  const { getDB } = await import('./db.js');
  const db = await getDB(env);
  if (!db) {
    const keys = [];
    let cursor = undefined;
    do {
      const page = await env.SUBSCRIPTIONS_KV.list({ prefix: KV_PREFIX, cursor, limit: 100 });
      keys.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    keys.sort().reverse();
    const items = await Promise.all(keys.slice(0, limit).map((k) => env.SUBSCRIPTIONS_KV.get(k)));
    return items.filter(Boolean).map((raw) => {
      try { return JSON.parse(raw); } catch { return null; }
    }).filter(Boolean);
  }

  const result = await db
    .prepare('SELECT detail FROM scheduler_logs ORDER BY run_at DESC LIMIT ?1')
    .bind(Math.min(limit, 100))
    .all();
  return (result.results || []).map((r) => {
    try { return JSON.parse(/** @type {string} */ (r.detail)); } catch { return null; }
  }).filter(Boolean);
}
