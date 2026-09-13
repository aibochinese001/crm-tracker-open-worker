// @ts-check
/**
 * SaaS 路由：套餐 / 订单（P1: 套餐浏览 + 订单查询；P2/P3: 手动开通 + 支付闭环）
 */

import * as saasRepo from '../../data/saas.repo.js';
import * as usersRepo from '../../data/users.repo.js';

import { handleCheckout, handleNotify, handleQueryStatus } from './payment.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * @returns {Promise<Response|null>} null = 未命中路由，交给后续路由处理
 */
export async function handleSaasRoutes(request, env, path, method, user) {
  const isAdmin = user.role === 'admin';

  /* ---- 套餐 ---- */

  // 所有登录用户可看在售套餐（用于会员页展示）；admin 可带 ?all=1 看全部
  if (path === '/plans' && method === 'GET') {
    await saasRepo.ensureDefaultPlans(env);
    const wantAll = isAdmin && new URL(request.url).searchParams.get('all') === '1';
    const plans = await saasRepo.listPlans(env, { includeInactive: wantAll });
    // 开放的支付方式（供用户端渲染支付按钮；未开放的渠道自动隐藏）
    const { getConfig } = await import('../../data/config.js');
    const cfg = await getConfig(env);
    const payChannels = Array.isArray(cfg.PAY_CHANNELS) && cfg.PAY_CHANNELS.length > 0
      ? cfg.PAY_CHANNELS
      : ['alipay', 'wxpay'];
    return json({ success: true, data: plans, payChannels });
  }

  // 套餐 CRUD（admin）
  if (path === '/plans' && method === 'POST' && isAdmin) {
    const body = await request.json().catch(() => null);
    if (!body || !body.name || !Number.isFinite(Number(body.durationDays))) {
      return json({ success: false, message: '参数不完整' }, 400);
    }
    const plan = {
      id: body.id || 'plan_' + crypto.randomUUID(),
      name: String(body.name).slice(0, 50),
      durationDays: Math.max(1, Math.floor(Number(body.durationDays))),
      priceCents: Math.max(0, Math.floor(Number(body.priceCents) || 0)),
      maxSubscriptions: Number.isFinite(Number(body.maxSubscriptions))
        ? Math.floor(Number(body.maxSubscriptions))
        : -1,
      isActive: body.isActive !== false,
      sort: Math.floor(Number(body.sort) || 0),
      createdAt: Date.now()
    };
    await saasRepo.savePlan(env, plan);
    return json({ success: true, data: plan });
  }

  if (path.startsWith('/plans/') && method === 'DELETE' && isAdmin) {
    const planId = path.slice('/plans/'.length);
    const ok = await saasRepo.deletePlan(env, planId);
    return json({ success: ok, message: ok ? '已删除' : '套餐不存在' }, ok ? 200 : 404);
  }

  // 下单（支付跳转）
  if (path === '/orders/checkout' && method === 'POST') {
    return handleCheckout(request, env, user);
  }

  // 结果页轮询对账（回调丢失时主动查网关补单）
  if (path === '/orders/query-status' && method === 'GET') {
    return handleQueryStatus(request, env, user);
  }

  /* ---- admin 统计（订单管理页） ---- */

  if (path === '/admin-stats' && method === 'GET' && isAdmin) {
    const db = await import('../../data/db.js').then(m => m.getDB(env));
    if (!db) return json({ success: false, message: '数据库不可用' }, 503);

    const now = Date.now();
    const dayStart = now - (now % 86400000); // UTC 今日零点
    const monthStart = new Date();
    monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);

    const paidCond = "status = 'paid' AND amount_cents > 0";
    const [ordersTotal, ordersPaid, ordersPending, usersTotal, usersMember, usersActive7d, subTotal] = await Promise.all([
      db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS sum FROM orders WHERE ' + paidCond).first(),
      db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS sum FROM orders WHERE ' + paidCond + ' AND paid_at >= ?1').bind(dayStart).first(),
      db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").first(),
      db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = \'user\'').first(),
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'user' AND plan_id IS NOT NULL AND (plan_expires_at IS NULL OR plan_expires_at > ?1)").bind(now).first(),
      db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = \'user\' AND created_at >= ?1').bind(now - 7 * 86400000).first(),
      db.prepare('SELECT COUNT(*) AS n FROM subscriptions').first()
    ]);
    const monthPaid = await db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS sum FROM orders WHERE ' + paidCond + ' AND paid_at >= ?1')
      .bind(monthStart.getTime())
      .first();

    return json({
      success: true,
      data: {
        revenue: {
          total: ordersTotal.sum,
          today: ordersPaid.sum,
          month: monthPaid.sum,
          paidOrders: ordersTotal.n,
          paidToday: ordersPaid.n,
          paidMonth: monthPaid.n
        },
        ordersPending: ordersPending.n,
        users: {
          total: usersTotal.n,
          members: usersMember.n,
          new7d: usersActive7d.n
        },
        subscriptions: subTotal.n
      }
    });
  }

  /* ---- 订单（用户查询自己的；admin 看全部） ---- */

  if (path === '/orders' && method === 'GET') {
    // 用户看自己的，admin 看全部；支持 status 过滤
    const url = new URL(request.url);
    const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('pageSize')) || 20)));
    const statusFilter = url.searchParams.get('status') === 'paid' || url.searchParams.get('status') === 'pending'
      ? url.searchParams.get('status')
      : null;
    const result = await saasRepo.listOrders(env, {
      userId: isAdmin ? null : user.id,
      page,
      pageSize,
      status: statusFilter
    });
    return json({ success: true, data: result });
  }

  // admin 手动调整用户会员（赠送/延期/取消）
  if (path.startsWith('/users/') && path.endsWith('/membership') && method === 'POST' && isAdmin) {
    const userId = path.slice('/users/'.length, -'/membership'.length);
    const body = await request.json().catch(() => null);
    if (!body) return json({ success: false, message: '参数错误' }, 400);

    const target = await usersRepo.getRowById(env, userId);
    if (!target) return json({ success: false, message: '用户不存在' }, 404);
    if (target.role === 'admin') return json({ success: false, message: '不能修改管理员会员' }, 403);

    if (body.action === 'cancel') {
      await usersRepo.setMembership(env, userId, null, null);
      return json({ success: true, message: '会员已取消' });
    }

    const plan = await saasRepo.getPlan(env, String(body.planId || ''));
    if (!plan) return json({ success: false, message: '套餐不存在' }, 404);

    // 未过期叠加，过期重算
    const base = target.plan_expires_at && /** @type {number} */ (target.plan_expires_at) > Date.now() ? /** @type {number} */ (target.plan_expires_at) : Date.now();
    const expiresAt = base + /** @type {number} */ (plan.durationDays) * 86400 * 1000;
    await usersRepo.setMembership(env, userId, plan.id, expiresAt);

    // 写一条手动开通订单留痕（直接落 paid 状态）
    const manualTradeNo = 'manual_' + crypto.randomUUID().slice(0, 12);
    await saasRepo.createOrder(env, {
      id: 'ord_' + crypto.randomUUID(),
      userId,
      planId: plan.id,
      planName: plan.name + '（手动开通）',
      amountCents: 0,
      outTradeNo: manualTradeNo,
      createdAt: Date.now()
    });
    await saasRepo.markOrderPaid(env, manualTradeNo, null, 'admin_manual');

    return json({ success: true, message: '会员已更新', data: { expiresAt } });
  }

  return null;
}
