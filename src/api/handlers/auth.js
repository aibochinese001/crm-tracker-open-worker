// @ts-check
/**
 * 认证 handler（v2 多用户版）
 *
 * 登录优先级：
 *   1. D1 用户表（PBKDF2 校验）—— 正常路径
 *   2. KV config ADMIN_USERNAME/ADMIN_PASSWORD —— 兜底（D1 迁移失败时保持可用）
 *
 * JWT payload 升级为 { uid, username, role, exp }；旧 token（只有 username）依然通过
 * verify 校验，但 getUserFromRequest 会补查用户表补齐 role。
 */

import { generateJWT, verifyJWT } from '../../core/auth.js';
import { verifyPassword, hashPassword } from '../../core/password.js';
import { getConfig } from '../../data/config.js';
import * as usersRepo from '../../data/users.repo.js';
import * as saasRepo from '../../data/saas.repo.js';
import { getCookieValue } from '../utils.js';

/**
 * @param {any} data
 * @param {number | { headers?: Record<string, string> }} [statusOrInit]
 * @returns {Response}
 */
function json(data, statusOrInit = 200) {
  const init = typeof statusOrInit === 'number'
    ? { status: statusOrInit, headers: { 'Content-Type': 'application/json' } }
    : {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...((statusOrInit && statusOrInit.headers) || {}) }
      };
  return new Response(JSON.stringify(data), init);
}

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

/* ---------------- 登录 ---------------- */

async function handleLogin(request, env) {
  const ip = getClientIP(request);

  if (await saasRepo.isLoginLocked(env, ip)) {
    return json({ success: false, message: '登录失败次数过多，请 15 分钟后再试' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, message: '请求格式错误' }, 400);
  }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) {
    return json({ success: false, message: '请输入用户名和密码' }, 400);
  }

  const config = await getConfig(env);
  const secret = config.JWT_SECRET;

  // 1) D1 用户表
  const row = await usersRepo.getRowByUsername(env, username);
  if (row) {
    if (row.status !== 'active') {
      return json({ success: false, message: '账号已被禁用，请联系管理员' }, 403);
    }
    const ok = await verifyPassword(password, /** @type {string} */ (row.salt), /** @type {string} */ (row.password_hash));
    if (ok) {
      await saasRepo.clearLoginAttempts(env, ip);
      const token = await generateJWTSalted({ uid: row.id, username: row.username, role: row.role }, secret);
      return json(
        { success: true, data: { role: row.role, username: row.username } },
        { headers: authCookie(token) }
      );
    }
  }

  // 2) KV 兜底（迁移窗口期 / D1 不可用）
  if (config.ADMIN_USERNAME && password && username === config.ADMIN_USERNAME && password === config.ADMIN_PASSWORD) {
    await saasRepo.clearLoginAttempts(env, ip);
    const token = await generateJWTSalted({ uid: 'kv-admin', username, role: 'admin' }, secret);
    return json(
      { success: true, data: { role: 'admin', username } },
      { headers: authCookie(token) }
    );
  }

  await saasRepo.recordLoginFailure(env, ip);
  return json({ success: false, message: '用户名或密码错误' }, 401);
}

function authCookie(token) {
  return {
    'Set-Cookie': 'token=' + token + '; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=604800'
  };
}

/** generateJWT 兼容包装：payload 附加 exp */
async function generateJWTSalted(payload, secret) {
  const withExp = { ...payload, exp: Math.floor(Date.now() / 1000) + 7 * 86400 };
  // 复用现有实现：它接受 username 并包 payload；这里直接内联同算法带完整 payload
  const header = { alg: 'HS256', typ: 'JWT' };
  const base64Header = btoa(JSON.stringify(header));
  const base64Payload = btoa(JSON.stringify(withExp));
  const signatureInput = base64Header + '.' + base64Payload;
  const signature = await hmacSHA256Hex(signatureInput, secret);
  return signatureInput + '.' + signature;
}

async function hmacSHA256Hex(message, key) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const buffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- 注册 ---------------- */

async function handleRegister(request, env) {
  const ip = getClientIP(request);

  const config = await getConfig(env);
  if (config.ALLOW_REGISTRATION === false) {
    return json({ success: false, message: '当前未开放注册' }, 403);
  }
  if (!(await saasRepo.isRegisterAllowed(env, ip))) {
    return json({ success: false, message: '注册过于频繁，请明天再试' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, message: '请求格式错误' }, 400);
  }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    return json({ success: false, message: '用户名需 3-32 位字母、数字或下划线' }, 400);
  }
  if (password.length < 8) {
    return json({ success: false, message: '密码至少 8 位' }, 400);
  }

  const existing = await usersRepo.getRowByUsername(env, username);
  if (existing) {
    return json({ success: false, message: '用户名已被占用' }, 409);
  }

  const { hash, salt } = await hashPassword(password);
  try {
    await usersRepo.createUser(env, { username, passwordHash: hash, salt, role: 'user' });
  } catch (err) {
    if (err.code === 'USERNAME_TAKEN') {
      return json({ success: false, message: '用户名已被占用' }, 409);
    }
    throw err;
  }
  await saasRepo.recordRegister(env, ip);

  const row = await usersRepo.getRowByUsername(env, username);
  const token = await generateJWTSalted({ uid: row.id, username, role: 'user' }, config.JWT_SECRET);
  return json(
    { success: true, data: { role: 'user', username } },
    { headers: authCookie(token) }
  );
}

/* ---------------- 修改密码 ---------------- */

async function handleChangePassword(request, env, me) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, message: '请求格式错误' }, 400);
  }
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');

  if (newPassword.length < 8) {
    return json({ success: false, message: '新密码至少 8 位' }, 400);
  }

  const row = await usersRepo.getRowById(env, me.id || me.uid);
  if (!row) {
    return json({ success: false, message: '用户不存在' }, 404);
  }
  const ok = await verifyPassword(oldPassword, /** @type {string} */ (row.salt), /** @type {string} */ (row.password_hash));
  if (!ok) {
    return json({ success: false, message: '旧密码错误' }, 401);
  }
  const { hash, salt } = await hashPassword(newPassword);
  await usersRepo.updatePassword(env, me.id || me.uid, hash, salt);
  return json({ success: true, message: '密码已更新' });
}

/* ---------------- 当前用户信息 ---------------- */

async function handleMe(env, token) {
  const config = await getConfig(env);
  let payload = token ? await verifyJWT(token, config.JWT_SECRET) : null;
  if (!payload) return { user: null, config };

  let user = null;
  if (payload.uid && payload.uid !== 'kv-admin') {
    const row = await usersRepo.getRowById(env, payload.uid);
    if (row) {
      user = usersRepo.publicUser(row);
      user.membershipActive = usersRepo.isMembershipActive(row);
      user.boundEmail = row.bound_email || '';
    } else {
      return { user: null, config }; // 用户被删，token 作废
    }
  } else {
    // 旧 token / kv-admin 兜底
    user = {
      id: payload.uid || 'kv-admin',
      username: payload.username,
      role: payload.role || 'admin',
      status: 'active',
      planId: null,
      planExpiresAt: null,
      membershipActive: false
    };
  }
  return { user, config };
}

/* ---------------- logout ---------------- */

function handleLogout() {
  return new Response('', {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': 'token=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0'
    }
  });
}

/* ---------------- getUserFromRequest（向后兼容签名） ---------------- */

async function getUserFromRequest(request, env) {
  const token = getCookieValue(request.headers.get('Cookie'), 'token');
  const { user, config } = await handleMe(env, token);
  return { user, config, token };
}

export { handleLogin, handleLogout, getUserFromRequest, handleRegister, handleChangePassword };
