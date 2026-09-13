// @ts-check
/**
 * 客户仓库（D1 版，v2）
 *
 * 存储结构：
 *   subscriptions(id PK, owner_user_id, data JSON, created_at, updated_at)
 *
 * - 接口与 KV 版保持兼容：listAll / getById / save / saveMany / deleteById / replaceAll
 * - 新增 owner 维度：listAll(env, { ownerUserId }) 按归属过滤
 * - data 列存原订阅 JSON 对象全量，业务层无需感知列结构
 *
 * 降级：D1 不可用（getDB 返回 null）时回退读旧 KV 数据，保证线上可用性。
 */

import { getDB } from './db.js';

/**
 * 读取客户 ID 列表（KV 索引，导出兼容旧测试/迁移代码）。
 * D1 模式下无索引概念——测试在 KV 降级层断言索引行为。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<string[]>}
 */
export async function listIds(env) {
  return kvListIds(env);
}

const KEY_INDEX = 'sub_index';
const KEY_PREFIX = 'sub:';

/* ---------------- KV 降级实现（原逻辑保留） ---------------- */

async function kvListIds(env) {
  const raw = await env.SUBSCRIPTIONS_KV.get(KEY_INDEX);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function kvGetById(env, id) {
  if (!id) return null;
  const raw = await env.SUBSCRIPTIONS_KV.get(KEY_PREFIX + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[sub-repo-kv] 反序列化失败:', id, err);
    return null;
  }
}

/* ---------------- D1 实现 ---------------- */

/**
 * 读取所有客户（可按 owner 过滤）。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace, __ownerScope?: string }} env
 * @param {{ ownerUserId?: string }} [opts] 传入 ownerUserId 时只返回该用户的客户
 * @returns {Promise<Object[]>}
 */
export async function listAll(env, opts) {
  const db = await getDB(env);
  // owner 优先级：显式 opts > env.__ownerScope（请求级隔离）> 全量
  const ownerUserId = (opts && opts.ownerUserId) || env.__ownerScope || null;
  if (!db) {
    // 降级：KV 无 owner 概念，全量返回
    const ids = await kvListIds(env);
    if (ids.length === 0) return [];
    const items = await Promise.all(ids.map((id) => kvGetById(env, id)));
    // @ts-ignore
    return items.filter((it) => it != null);
  }

  let result;
  if (ownerUserId) {
    result = await db
      .prepare('SELECT data FROM subscriptions WHERE owner_user_id = ?1 ORDER BY created_at ASC')
      .bind(ownerUserId)
      .all();
  } else {
    result = await db.prepare('SELECT data FROM subscriptions ORDER BY created_at ASC').all();
  }
  return (result.results || []).map((r) => {
    try {
      return JSON.parse(/** @type {string} */ (r.data));
    } catch {
      console.error('[sub-repo] data 解析失败，跳过');
      return null;
    }
  }).filter(Boolean);
}

/**
 * 根据 ID 读取单条客户。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace, __ownerScope?: string }} env
 * @param {string} id
 * @param {{ ownerUserId?: string }} [opts] 传入时校验归属，不匹配返回 null
 * @returns {Promise<Object|null>}
 */
export async function getById(env, id, opts) {
  if (!id) return null;
  const db = await getDB(env);
  if (!db) return kvGetById(env, id);

  const ownerUserId = (opts && opts.ownerUserId) || env.__ownerScope || null;
  let row = null;
  if (ownerUserId) {
    row = await db
      .prepare('SELECT data FROM subscriptions WHERE id = ?1 AND owner_user_id = ?2')
      .bind(id, ownerUserId)
      .first();
  } else {
    row = await db.prepare('SELECT data FROM subscriptions WHERE id = ?1').bind(id).first();
  }
  if (!row) return null;
  try {
    return JSON.parse(/** @type {string} */ (row.data));
  } catch {
    return null;
  }
}

/**
 * 保存（创建或更新）一条客户。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace, __ownerScope?: string }} env
 * @param {Object} subscription 必须包含 string 类型的 id
 * @param {{ ownerUserId?: string }} [opts] 新建时的归属；更新时若传了 owner 则校验
 * @returns {Promise<Object>}
 */
export async function save(env, subscription, opts) {
  if (!subscription || typeof subscription.id !== 'string' || subscription.id === '') {
    throw new Error('客户缺少有效 id');
  }
  const db = await getDB(env);
  if (!db) {
    // KV 降级写（保持旧逻辑）
    await env.SUBSCRIPTIONS_KV.put(KEY_PREFIX + subscription.id, JSON.stringify(subscription));
    const ids = await kvListIds(env);
    if (!ids.includes(subscription.id)) {
      await env.SUBSCRIPTIONS_KV.put(KEY_INDEX, JSON.stringify([...ids, subscription.id]));
    }
    return subscription;
  }

  const now = Date.now();
  const data = JSON.stringify(subscription);
  const ownerUserId =
    (opts && opts.ownerUserId) ||
    env.__ownerScope ||
    subscription.ownerUserId ||
    // 无 scope（cron / 兜底登录）时新建：从现有行继承 owner，避免 owner 被置空
    null;

  if (ownerUserId) {
    await db
      .prepare(
        "INSERT INTO subscriptions (id, owner_user_id, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) " +
        "ON CONFLICT(id) DO UPDATE SET data = ?3, updated_at = ?4"
      )
      .bind(subscription.id, ownerUserId, data, now)
      .run();
  } else {
    // 无 scope（cron 更新 / 测试 seed / 恢复导入）：继承现有行的 owner；
    // 行不存在则 INSERT（owner='' 占位，等待迁移/归属认领）
    await db
      .prepare(
        "INSERT INTO subscriptions (id, owner_user_id, data, created_at, updated_at) VALUES (?1, '', ?2, ?3, ?3) " +
        "ON CONFLICT(id) DO UPDATE SET data = ?2, updated_at = ?3"
      )
      .bind(subscription.id, data, now)
      .run();
  }
  return subscription;
}

/**
 * 批量保存客户（自动续费等场景）。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace, __ownerScope?: string }} env
 * @param {Object[]} subs
 * @param {{ ownerUserId?: string }} [opts] 新建行时的归属
 */
export async function saveMany(env, subs, opts) {
  if (!Array.isArray(subs) || subs.length === 0) return;
  const db = await getDB(env);
  if (!db) {
    await Promise.all(
      subs.map((s) => env.SUBSCRIPTIONS_KV.put(KEY_PREFIX + s.id, JSON.stringify(s)))
    );
    const idsExisting = await kvListIds(env);
    const set = new Set(idsExisting);
    for (const s of subs) {
      if (typeof s.id === 'string') set.add(s.id);
    }
    if (set.size !== idsExisting.length) {
      await env.SUBSCRIPTIONS_KV.put(KEY_INDEX, JSON.stringify(Array.from(set)));
    }
    return;
  }

  const now = Date.now();
  const stmts = subs.map((s) =>
    db
      .prepare(
        "INSERT INTO subscriptions (id, owner_user_id, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) " +
        "ON CONFLICT(id) DO UPDATE SET data = ?3, updated_at = ?4"
      )
      .bind(
        s.id,
        (opts && opts.ownerUserId) || (s.ownerUserId ?? ''),
        JSON.stringify(s),
        now
      )
  );
  await db.batch(stmts);
}

/**
 * 删除一条客户。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace, __ownerScope?: string }} env
 * @param {string} id
 * @param {{ ownerUserId?: string }} [opts] 传入时校验归属
 * @returns {Promise<boolean>}
 */
export async function deleteById(env, id, opts) {
  if (!id) return false;
  const db = await getDB(env);
  if (!db) {
    const before = await env.SUBSCRIPTIONS_KV.get(KEY_PREFIX + id);
    // KV 模式：无论本体是否存在，都顺手清理索引中的悬空项
    const ids = await kvListIds(env);
    if (ids.includes(id)) {
      await env.SUBSCRIPTIONS_KV.put(KEY_INDEX, JSON.stringify(ids.filter((x) => x !== id)));
    }
    if (!before) return false;
    await env.SUBSCRIPTIONS_KV.delete(KEY_PREFIX + id);
    return true;
  }

  const ownerUserId = (opts && opts.ownerUserId) || env.__ownerScope || null;
  let result;
  if (ownerUserId) {
    result = await db
      .prepare('DELETE FROM subscriptions WHERE id = ?1 AND owner_user_id = ?2')
      .bind(id, ownerUserId)
      .run();
  } else {
    result = await db.prepare('DELETE FROM subscriptions WHERE id = ?1').bind(id).run();
  }
  return (result.meta && result.meta.changes > 0) || false;
}

/**
 * 全量 id → owner_user_id 映射（cron 按用户分组发送用）。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace, __ownerScope?: string }} env
 * @returns {Promise<Record<string, string>>}
 */
export async function ownerMap(env) {
  const db = await getDB(env);
  if (!db) return {};
  const result = await db.prepare('SELECT id, owner_user_id FROM subscriptions').all();
  /** @type {Record<string, string>} */
  const map = {};
  for (const r of result.results || []) {
    map[/** @type {string} */ (r.id)] = /** @type {string} */ (r.owner_user_id) || '';
  }
  return map;
}

/**
 * 计数（可按 owner）。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace, __ownerScope?: string }} env
 * @param {{ ownerUserId?: string }} [opts]
 * @returns {Promise<number>}
 */
export async function count(env, opts) {
  const db = await getDB(env);
  const ownerUserId = (opts && opts.ownerUserId) || env.__ownerScope || null;
  if (!db) {
    const all = await listAll(env);
    if (!ownerUserId) return all.length;
    return all.filter((s) => s.ownerUserId === ownerUserId).length;
  }
  let result;
  if (ownerUserId) {
    result = await db
      .prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE owner_user_id = ?1')
      .bind(ownerUserId)
      .first();
  } else {
    result = await db.prepare('SELECT COUNT(*) AS n FROM subscriptions').first();
  }
  return result ? /** @type {number} */ (result.n) : 0;
}

/**
 * 整仓覆盖（备份恢复场景，D1 版清空 owner 的数据后写入）。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace, __ownerScope?: string }} env
 * @param {Object[]} subs
 * @param {{ ownerUserId?: string }} [opts]
 */
export async function replaceAll(env, subs, opts) {
  const db = await getDB(env);
  if (!db) {
    const oldIds = await kvListIds(env);
    await Promise.all(oldIds.map((id) => env.SUBSCRIPTIONS_KV.delete(KEY_PREFIX + id)));
    if (Array.isArray(subs) && subs.length > 0) {
      await Promise.all(
        subs.map((s) => env.SUBSCRIPTIONS_KV.put(KEY_PREFIX + s.id, JSON.stringify(s)))
      );
      await env.SUBSCRIPTIONS_KV.put(KEY_INDEX, JSON.stringify(subs.map((s) => s.id)));
    } else {
      await env.SUBSCRIPTIONS_KV.put(KEY_INDEX, JSON.stringify([]));
    }
    return;
  }

  const now = Date.now();
  // 归属：恢复导入的数据归当前操作者（admin scope）；无 scope 时 owner=''（遗留待认领）
  const owner = (opts && opts.ownerUserId) || env.__ownerScope || '';
  if (owner) {
    await db.prepare('DELETE FROM subscriptions WHERE owner_user_id = ?1').bind(owner).run();
  } else {
    await db.prepare('DELETE FROM subscriptions').run();
  }
  if (Array.isArray(subs) && subs.length > 0) {
    const stmts = subs.map((s) =>
      db
        .prepare(
          "INSERT INTO subscriptions (id, owner_user_id, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)"
        )
        .bind(s.id, owner || (s.ownerUserId ?? ''), JSON.stringify(s), now)
    );
    await db.batch(stmts);
  }
}
