import { handleLogin, handleLogout, getUserFromRequest, handleRegister, handleChangePassword } from './handlers/auth.js';
import { handleGetConfig, handleUpdateConfig } from './handlers/config.js';
import { handleDashboardStats } from './handlers/dashboard.js';
import { handleThirdPartyNotify } from './handlers/notify.js';
import { handleSubscriptions } from './handlers/subscriptions.js';
import { getConfig } from '../data/config.js';
import { handleTestNotification } from './handlers/test-notification.js';
import { handleExtraRoutes } from "./handlers/extras.js";
import { handleSaasRoutes } from './handlers/saas.js';
import { handleUserRoutes } from './handlers/users.js';
import { handleCheckout, handleNotify, handleQueryStatus } from './handlers/payment.js';
import * as usersRepo from '../data/users.repo.js';
import { handleEmailTemplateRoutes } from './handlers/email-templates.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.slice(4);
  const method = request.method;

  const config = await getConfig(env);

  // 公开路由：登录 / 注册
  if (path === '/login' && method === 'POST') {
    return handleLogin(request, env);
  }
  if (path === '/register' && method === 'POST') {
    return handleRegister(request, env);
  }

  if (path === '/logout' && (method === 'GET' || method === 'POST')) {
    return handleLogout();
  }

  // 第三方通知 API 使用独立 token 鉴权，必须在 JWT 门禁之前放行
  if (path.startsWith('/notify/')) {
    const thirdPartyResponse = await handleThirdPartyNotify(request, env, config, url);
    if (thirdPartyResponse) return thirdPartyResponse;
  }

  // 易支付回调：验签自证，必须公开放行（不要求登录）。
  // PayOne 的 do_notify 用 POST（query 参数放 body：k1=v1&k2=v2），标准易支付用 GET——两者都支持。
  if (path === '/payment/notify' && (method === 'GET' || method === 'POST')) {
    return handleNotify(request, env);
  }

  const { user, token } = await getUserFromRequest(request, env);
  if (!user && path !== '/login') {
    return json({ success: false, message: '未授权访问' }, 401);
  }

  // 请求级数据隔离：为本次请求创建 env 的 scoped 视图，repo 层读取 __ownerScope 自动过滤。
  // 用 Object.create 避免污染全局 env（Worker 实例跨请求复用）。
  // 注：user.id === 'kv-admin'（迁移窗口兜底登录）时不隔离，走全量（KV 兜底数据无 owner）。
  const effectiveUser = user && user.id !== 'kv-admin' ? user : null;
  if (effectiveUser) {
    env = Object.create(env);
    env.__ownerScope = effectiveUser.id;
    env.__authUser = effectiveUser;
  }

  /* ---------- 已登录用户路由 ---------- */

  if (path === '/me' && method === 'GET') {
    return json({ success: true, data: user });
  }

  if (path === '/password' && method === 'POST') {
    return handleChangePassword(request, env, user);
  }

  // SaaS 路由：套餐 / 订单（用户 + admin 混合权限，内部再分）
  const saasResponse = await handleSaasRoutes(request, env, path, method, user);
  if (saasResponse) return saasResponse;

  // 用户管理路由（admin）
  const userRoutesResponse = await handleUserRoutes(request, env, path, method, user);
  if (userRoutesResponse) return userRoutesResponse;

  // 邮件模板 / SMTP 测试 / 绑定邮箱（每用户隔离）
  const emailRoutesResponse = await handleEmailTemplateRoutes(request, env, path, method, user);
  if (emailRoutesResponse) return emailRoutesResponse;

  /* ---- 用户自己的通知配置（每用户隔离） ---- */

  // 测试通知（用该用户已保存的配置/临时值发一条测试消息）
  if (path === '/my/notify-test' && method === 'POST') {
    const { handleMyNotifyTest } = await import('./handlers/my-notify-test.js');
    return handleMyNotifyTest(request, env, user);
  }

  if (path === '/my/notify-config' && method === 'GET') {
    const cfg = await usersRepo.getNotifyConfig(env, user.id);
    return json({ success: true, data: cfg || {} });
  }

  if (path === '/my/notify-config' && method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json({ success: false, message: '参数错误' }, 400);
    }
    // 仅允许这些字段，防止注入任意配置
    const safe = {
      ENABLED_NOTIFIERS: Array.isArray(body.ENABLED_NOTIFIERS) ? body.ENABLED_NOTIFIERS.slice(0, 8).map(String) : [],
      TG_BOT_TOKEN: String(body.TG_BOT_TOKEN || '').slice(0, 200),
      TG_CHAT_ID: String(body.TG_CHAT_ID || '').slice(0, 100),
      BARK_DEVICE_KEY: String(body.BARK_DEVICE_KEY || '').slice(0, 200),
      WEBHOOK_URL: String(body.WEBHOOK_URL || '').slice(0, 500),
      SMTP_EMAIL: String(body.SMTP_EMAIL || '').slice(0, 200),
      SMTP_AUTH_CODE: String(body.SMTP_AUTH_CODE || '').slice(0, 200),
      SMTP_FROM_NAME: String(body.SMTP_FROM_NAME || '').slice(0, 100),
      EMAIL_BCC: String(body.EMAIL_BCC || '').slice(0, 200),
      WECHATBOT_WEBHOOK: String(body.WECHATBOT_WEBHOOK || '').slice(0, 500),
      WECHATBOT_MSG_TYPE: body.WECHATBOT_MSG_TYPE === 'markdown' ? 'markdown' : 'text',
      RESEND_API_KEY: String(body.RESEND_API_KEY || '').slice(0, 200),
      EMAIL_FROM: String(body.EMAIL_FROM || '').slice(0, 200),
      EMAIL_TO: String(body.EMAIL_TO || '').slice(0, 200),
      TIMEZONE: String(body.TIMEZONE || 'Asia/Shanghai').slice(0, 50),
      NOTIFICATION_HOURS: Array.isArray(body.NOTIFICATION_HOURS)
        ? body.NOTIFICATION_HOURS.slice(0, 24).map(String)
        : ['08', '20']
    };
    await usersRepo.setNotifyConfig(env, user.id, safe);
    return json({ success: true, message: '提醒设置已保存' });
  }

  /* ---- 管理员路由 ---------- */

  const isAdmin = user.role === 'admin';
  const adminOnlyPaths = ['/config', '/users', '/plans', '/orders', '/settings'];
  if (!isAdmin && adminOnlyPaths.some((p) => path === p || path.startsWith(p + '/'))) {
    return json({ success: false, message: '需要管理员权限' }, 403);
  }

  if (path === '/config') {
    if (method === 'GET') return handleGetConfig(env);
    if (method === 'POST') return handleUpdateConfig(request, env);
  }

  if (path === '/dashboard/stats' && method === 'GET') {
    return handleDashboardStats(env, config);
  }

  if (path === '/test-notification' && method === 'POST') {
    return handleTestNotification(request, env);
  }

  // 备份 / 恢复
  if (path === '/backup' && method === 'GET') {
    const { handleExportBackup } = await import('./handlers/backup.js');
    return handleExportBackup(request, env);
  }
  if (path === '/restore' && method === 'POST') {
    const { handleImportBackup } = await import('./handlers/backup.js');
    return handleImportBackup(request, env);
  }

  // 新增路由：提醒规则 / 通知日志 / 调度日志（提醒规则 / 通知日志 / 调度日志）
  const extraResponse = await handleExtraRoutes(request, env, path);
  if (extraResponse) return extraResponse;

  const subscriptionResponse = await handleSubscriptions(request, env, path);
  if (subscriptionResponse) return subscriptionResponse;

  const thirdPartyResponse = await handleThirdPartyNotify(request, env, config, url);
  if (thirdPartyResponse) return thirdPartyResponse;

  return new Response(
    JSON.stringify({ success: false, message: '未找到请求的资源' }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
}

export { handleApiRequest };
