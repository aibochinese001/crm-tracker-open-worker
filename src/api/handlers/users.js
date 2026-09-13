// @ts-check
/**
 * 用户管理路由（admin 专用）
 */

import * as usersRepo from '../../data/users.repo.js';
import { hashPassword } from '../../core/password.js';
import * as subRepo from '../../data/subscriptions.repo.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * @returns {Promise<Response|null>}
 */
export async function handleUserRoutes(request, env, path, method, adminUser) {
  if (!path.startsWith('/users')) return null;
  if (adminUser.role !== 'admin') return json({ success: false, message: '需要管理员权限' }, 403);

  // GET /users — 列表（分页 + 搜索）
  if (path === '/users' && method === 'GET') {
    const url = new URL(request.url);
    const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
    const keyword = (url.searchParams.get('keyword') || '').trim().slice(0, 50);
    const result = await usersRepo.listUsers(env, { page, pageSize: 20, keyword });
    // 批量补客户数（列表页显示；一次 GROUP BY 查询，避免 N+1）
    const db = await import('../../data/db.js').then((m) => m.getDB(env));
    if (db) {
      const counts = await db
        .prepare('SELECT owner_user_id, COUNT(*) AS n FROM subscriptions GROUP BY owner_user_id')
        .all();
      const countMap = {};
      for (const r of counts.results || []) countMap[r.owner_user_id] = r.n;
      for (const u of result.items) u.subscriptionCount = countMap[u.id] || 0;
    } else {
      for (const u of result.items) u.subscriptionCount = 0;
    }
    return json({ success: true, data: result });
  }

  // GET /users/:id — 详情（含客户数）
  const detailMatch = path.match(/^\/users\/([a-zA-Z0-9_-]+)$/);
  if (detailMatch && method === 'GET') {
    const row = await usersRepo.getRowById(env, detailMatch[1]);
    if (!row) return json({ success: false, message: '用户不存在' }, 404);
    const subCount = await subRepo.count(env, { ownerUserId: /** @type {string} */ (row.id) });
    return json({ success: true, data: { ...usersRepo.publicUser(row), subscriptionCount: subCount } });
  }

  // POST /users/:id/status — 启用/禁用
  const statusMatch = path.match(/^\/users\/([a-zA-Z0-9_-]+)\/status$/);
  if (statusMatch && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const status = body.status === 'disabled' ? 'disabled' : 'active';
    const target = await usersRepo.getRowById(env, statusMatch[1]);
    if (!target) return json({ success: false, message: '用户不存在' }, 404);
    if (target.role === 'admin') return json({ success: false, message: '管理员账号不可禁用' }, 403);
    await usersRepo.updateStatus(env, statusMatch[1], status);
    return json({ success: true, message: status === 'disabled' ? '已禁用' : '已启用' });
  }

  // POST /users/:id/username — 修改用户名（admin 改任意用户）
  const nameMatch = path.match(/^\/users\/([a-zA-Z0-9_-]+)\/username$/);
  if (nameMatch && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const newUsername = String(body.username || '').trim();
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(newUsername)) {
      return json({ success: false, message: '用户名需 3-32 位字母、数字或下划线' }, 400);
    }
    const target = await usersRepo.getRowById(env, nameMatch[1]);
    if (!target) return json({ success: false, message: '用户不存在' }, 404);
    if (target.role === 'admin') return json({ success: false, message: '管理员账号不可改名' }, 403);
    if (newUsername === target.username) return json({ success: true, message: '用户名未变化' });

    const dup = await usersRepo.getRowByUsername(env, newUsername);
    if (dup) return json({ success: false, message: '用户名已被占用' }, 409);

    await usersRepo.updateUsername(env, nameMatch[1], newUsername);
    return json({ success: true, message: '用户名已修改为 ' + newUsername });
  }

  // POST /users/:id/password — 重置密码（admin 设置新密码）
  const pwdMatch = path.match(/^\/users\/([a-zA-Z0-9_-]+)\/password$/);
  if (pwdMatch && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const newPassword = String(body.newPassword || '');
    if (newPassword.length < 8) return json({ success: false, message: '密码至少 8 位' }, 400);
    const target = await usersRepo.getRowById(env, pwdMatch[1]);
    if (!target) return json({ success: false, message: '用户不存在' }, 404);
    const { hash, salt } = await hashPassword(newPassword);
    await usersRepo.updatePassword(env, pwdMatch[1], hash, salt);
    return json({ success: true, message: '密码已重置' });
  }

  return null;
}
