// @ts-check
/**
 * 用户仓库（D1）
 */

import { getDB } from './db.js';

/**
 * 用户行 → 安全对象（去掉 password_hash/salt）
 */
function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    planId: row.plan_id || null,
    planExpiresAt: row.plan_expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * 按 ID 查用户（返回完整行，含哈希——仅内部登录校验用）
 * @returns {Promise<any>}
 */
export async function getRowById(env, id) {
  const db = await getDB(env);
  if (!db) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
}

/**
 * 按用户名查完整行
 * @returns {Promise<any>}
 */
export async function getRowByUsername(env, username) {
  const db = await getDB(env);
  if (!db) return null;
  return db.prepare('SELECT * FROM users WHERE username = ?1').bind(username).first();
}

/**
 * 创建用户。用户名冲突时抛出 USERNAME_TAKEN 错误。
 */
export async function createUser(env, { username, passwordHash, salt, role = 'user' }) {
  const db = await getDB(env);
  if (!db) throw new Error('数据库不可用');
  const now = Date.now();
  const id = 'u_' + crypto.randomUUID();
  try {
    await db
      .prepare(
        "INSERT INTO users (id, username, password_hash, salt, role, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)"
      )
      .bind(id, username, passwordHash, salt, role, now)
      .run();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      const e = new Error('用户名已被占用');
      /** @type {Error & {code?: string}} */ (e).code = 'USERNAME_TAKEN';
      throw e;
    }
    throw err;
  }
  return getRowById(env, id);
}

/**
 * 更新密码
 */
export async function updatePassword(env, userId, passwordHash, salt) {
  const db = await getDB(env);
  if (!db) return false;
  await db
    .prepare('UPDATE users SET password_hash = ?1, salt = ?2, updated_at = ?3 WHERE id = ?4')
    .bind(passwordHash, salt, Date.now(), userId)
    .run();
  return true;
}

/**
 * 更新用户名
 */
export async function updateUsername(env, userId, newUsername) {
  const db = await getDB(env);
  if (!db) return false;
  try {
    await db
      .prepare('UPDATE users SET username = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(newUsername, Date.now(), userId)
      .run();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      const e = new Error('用户名已被占用');
      /** @type {Error & {code?: string}} */ (e).code = 'USERNAME_TAKEN';
      throw e;
    }
    throw err;
  }
  return true;
}

/**
 * 更新用户状态
 */
export async function updateStatus(env, userId, status) {
  const db = await getDB(env);
  if (!db) return false;
  await db
    .prepare('UPDATE users SET status = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(status, Date.now(), userId)
    .run();
  return true;
}

/**
 * 设置会员（手动赠送/系统开通通用）
 * @param {string|null} planId null = 清除会员
 * @param {number|null} expiresAt null = 清除
 */
export async function setMembership(env, userId, planId, expiresAt) {
  const db = await getDB(env);
  if (!db) return false;
  await db
    .prepare('UPDATE users SET plan_id = ?1, plan_expires_at = ?2, updated_at = ?3 WHERE id = ?4')
    .bind(planId, expiresAt, Date.now(), userId)
    .run();
  return true;
}

/**
 * 用户列表（管理后台，分页）
 */
export async function listUsers(env, { page = 1, pageSize = 20, keyword = '' } = {}) {
  const db = await getDB(env);
  if (!db) return { total: 0, items: [] };
  const offset = (page - 1) * pageSize;
  const kw = '%' + keyword + '%';
  const where = keyword ? 'WHERE username LIKE ?1' : '';
  const params = keyword ? [kw] : [];

  const totalRow = await db
    .prepare('SELECT COUNT(*) AS n FROM users ' + where)
    .bind(...params)
    .first();
  const result = await db
    .prepare('SELECT * FROM users ' + where + ' ORDER BY created_at DESC LIMIT ?' + (keyword ? '2' : '1') + ' OFFSET ?' + (keyword ? '3' : '2'))
    .bind(...params, pageSize, offset)
    .all();

  return {
    total: totalRow ? totalRow.n : 0,
    items: (result.results || []).map(toPublicUser)
  };
}

/**
 * 读取用户的通知配置（JSON → 对象；未设置返回 null）
 */
export async function getNotifyConfig(env, userId) {
  const db = await getDB(env);
  if (!db) return null;
  const r = await db.prepare('SELECT notify_config FROM users WHERE id = ?1').bind(userId).first();
  if (!r || !r.notify_config) return null;
  try {
    return JSON.parse(/** @type {string} */ (r.notify_config));
  } catch {
    return null;
  }
}

/**
 * 保存用户的通知配置
 */
export async function setNotifyConfig(env, userId, configObj) {
  const db = await getDB(env);
  if (!db) return false;
  await db
    .prepare('UPDATE users SET notify_config = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(JSON.stringify(configObj), Date.now(), userId)
    .run();
  return true;
}

/**
 * 公开对象转换
 */
export function publicUser(row) {
  return toPublicUser(row);
}

/**
 * 会员是否有效（free 判定）
 */
export function isMembershipActive(userRow) {
  if (!userRow) return false;
  if (!userRow.plan_id) return false;
  if (!userRow.plan_expires_at) return true; // 无过期时间 = 永久
  return userRow.plan_expires_at > Date.now();
}
