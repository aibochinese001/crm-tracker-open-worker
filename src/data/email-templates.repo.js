// @ts-check
/**
 * 邮件模板仓库（D1，owner 隔离）
 */

import { getDB } from './db.js';

function rowToTemplate(r) {
  return {
    id: r.id,
    name: r.name,
    subject: r.subject,
    body: r.body,
    isDefault: !!r.is_default,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export async function listTemplates(env, ownerUserId) {
  const db = await getDB(env);
  if (!db) return [];
  const result = await db
    .prepare('SELECT * FROM email_templates WHERE owner_user_id = ?1 ORDER BY is_default DESC, created_at ASC')
    .bind(ownerUserId)
    .all();
  return (result.results || []).map(rowToTemplate);
}

export async function getTemplate(env, ownerUserId, id) {
  const db = await getDB(env);
  if (!db) return null;
  const r = await db
    .prepare('SELECT * FROM email_templates WHERE id = ?1 AND owner_user_id = ?2')
    .bind(id, ownerUserId)
    .first();
  return r ? rowToTemplate(r) : null;
}

export async function getDefaultTemplate(env, ownerUserId) {
  const db = await getDB(env);
  if (!db) return null;
  const r = await db
    .prepare('SELECT * FROM email_templates WHERE owner_user_id = ?1 AND is_default = 1 LIMIT 1')
    .bind(ownerUserId)
    .first();
  return r ? rowToTemplate(r) : null;
}

/**
 * 保存模板（新建或更新）。设为默认时清除同 owner 其他默认。
 */
export async function saveTemplate(env, ownerUserId, tpl) {
  const db = await getDB(env);
  if (!db) throw new Error('数据库不可用');
  const now = Date.now();
  if (tpl.isDefault) {
    await db
      .prepare('UPDATE email_templates SET is_default = 0 WHERE owner_user_id = ?1')
      .bind(ownerUserId)
      .run();
  }
  await db
    .prepare(
      'INSERT INTO email_templates (id, owner_user_id, name, subject, body, is_default, created_at, updated_at) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) ' +
      'ON CONFLICT(id) DO UPDATE SET name=?3, subject=?4, body=?5, is_default=?6, updated_at=?7'
    )
    .bind(tpl.id, ownerUserId, tpl.name, tpl.subject, tpl.body, tpl.isDefault ? 1 : 0, now)
    .run();
  return getTemplate(env, ownerUserId, tpl.id);
}

export async function deleteTemplate(env, ownerUserId, id) {
  const db = await getDB(env);
  if (!db) return false;
  const result = await db
    .prepare('DELETE FROM email_templates WHERE id = ?1 AND owner_user_id = ?2')
    .bind(id, ownerUserId)
    .run();
  return (result.meta && result.meta.changes > 0) || false;
}
