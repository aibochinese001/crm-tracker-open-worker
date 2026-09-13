// @ts-check
/**
 * 易支付（Epay）网关集成
 *
 * 规范（与 PayOne/彩虹易支付一致）：
 * - 下单：GET/跳转 submit.php?pid=&type=&out_trade_no=&notify_url=&return_url=&name=&money=&sign=&sign_type=MD5
 *   签名：ksort 参数 → k=v& 拼接（排除 sign/sign_type/空值）→ 尾拼 KEY → md5 小写
 * - 回调：notify_url 收 GET 参数，同样验签；返回纯文本 "success"
 *
 * 金额单位：元（字符串，两位小数）；订单表存分（cents）
 */

import { getConfig } from '../../data/config.js';
import * as saasRepo from '../../data/saas.repo.js';
import * as usersRepo from '../../data/users.repo.js';

/**
 * 易支付签名（MD5）
 * @param {Record<string, string>} params 含待签名参数（不含 sign/sign_type）
 * @param {string} key 商户密钥
 * @returns {Promise<string>} 小写 md5 hex
 */
export async function epaySign(params, key) {
  const sorted = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort();
  const raw = sorted.map((k) => `${k}=${params[k]}`).join('&') + key;
  const data = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest('MD5', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 验证回调签名
 * @param {URLSearchParams} query 回调全部 GET 参数
 * @param {string} key
 */
export async function epayVerifyNotify(query, key) {
  /** @type {Record<string, string>} */
  const params = {};
  for (const [k, v] of query.entries()) {
    params[k] = v;
  }
  const expected = await epaySign(params, key);
  const got = (params.sign || '').toLowerCase();
  if (expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * 向网关主动查单（易支付 mapi.php 标准接口），用于回调丢失时的对账补单。
 *
 * @param {{ DB?: D1Database, SUBSCRIPTIONS_KV?: KVNamespace }} env
 * @param {Object} order pending 订单
 * @returns {Promise<{queried: boolean, paid: boolean, tradeNo?: string, error?: string}>}
 */
async function queryGatewayOrder(env, order) {
  const config = await getConfig(env);
  if (!config.EPAY_API_URL || !config.EPAY_PID || !config.EPAY_KEY) {
    return { queried: false, paid: false, error: '支付通道未配置' };
  }
  const qs = new URLSearchParams({
    act: 'order',
    pid: String(config.EPAY_PID),
    key: String(config.EPAY_KEY),
    out_trade_no: order.outTradeNo
  });
  // PayOne 查单是 /api.php?act=order&pid=&key=&out_trade_no=（标准易支付同构）；
  // mapi.php 是下单接口。优先 api.php，404 时回退 mapi.php。
  const base = config.EPAY_API_URL.replace(/\/$/, '');
  const urls = [`${base}/api.php?${qs}`, `${base}/mapi.php?${qs}`];
  let lastError = '网关无响应';
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await res.json().catch(() => null);
      if (!data) { lastError = '网关响应非 JSON'; continue; }
      if (Number(data.code) === -1 && String(data.msg || '').includes('订单号不存在')) {
        return { queried: true, paid: false, error: '网关无此订单' };
      }
      if (Number(data.code) !== 1) { lastError = data.msg || '网关拒绝查单'; continue; }
      // status: 1=已支付 0=未支付
      if (Number(data.status) === 1) {
        // 金额校验
        const expectedMoney = (order.amountCents / 100).toFixed(2);
        const gotMoney = String(data.money || '');
        if (Number(gotMoney) + 0.001 < Number(expectedMoney)) {
          return { queried: true, paid: false, error: `金额不符: 回调${gotMoney} 期望${expectedMoney}` };
        }
        const updated = await saasRepo.markOrderPaid(env, order.outTradeNo, data.trade_no || null, JSON.stringify(data).slice(0, 3000));
        if (updated && updated.status === 'paid') {
          await grantMembershipForOrder(env, order);
        }
        return { queried: true, paid: true, tradeNo: data.trade_no };
      }
      return { queried: true, paid: false };
    } catch (err) {
      lastError = '查单请求失败: ' + (err && err.message ? err.message : String(err));
    }
  }
  return { queried: true, paid: false, error: lastError };
}

/**
 * 订单支付后开通/叠加会员（回调与查单对账共用）
 */
async function grantMembershipForOrder(env, order) {
  const userRow = await usersRepo.getRowById(env, order.userId);
  if (!userRow) return;
  const plan = await saasRepo.getPlan(env, order.planId);
  if (!plan) return;
  const base = userRow.plan_expires_at && /** @type {number} */ (userRow.plan_expires_at) > Date.now()
    ? /** @type {number} */ (userRow.plan_expires_at)
    : Date.now();
  const expiresAt = base + /** @type {number} */ (plan.durationDays) * 86400 * 1000;
  await usersRepo.setMembership(env, order.userId, plan.id, expiresAt);
  console.log('[epay] 会员开通(对账):', userRow.username, plan.name, '至', new Date(expiresAt).toISOString());
}

/**
 * 用户下单：创建 pending 订单并返回支付跳转 URL
 * POST /api/orders/checkout { planId }
 */
async function handleCheckout(request, env, user) {
  const config = await getConfig(env);
  if (!config.EPAY_API_URL || !config.EPAY_PID || !config.EPAY_KEY) {
    return json({ success: false, message: '支付通道未配置，请联系管理员' }, 503);
  }

  const body = await request.json().catch(() => null);
  const planId = String(body?.planId || '');
  const plan = await saasRepo.getPlan(env, planId);
  if (!plan || !plan.isActive) {
    return json({ success: false, message: '套餐不存在或已下架' }, 404);
  }
  if (plan.priceCents <= 0) {
    return json({ success: false, message: '该套餐无需支付，请联系管理员开通' }, 400);
  }
  // payType 白名单：仅允许后台「开放支付方式」勾选的渠道
  const requestedType = String(body?.payType || 'alipay');
  const openChannels = Array.isArray(config.PAY_CHANNELS) && config.PAY_CHANNELS.length > 0
    ? config.PAY_CHANNELS
    : ['alipay', 'wxpay'];
  if (!openChannels.includes(requestedType)) {
    return json({ success: false, message: '该支付方式未开放' }, 400);
  }

  const origin = new URL(request.url).origin;
  const orderId = 'ord_' + crypto.randomUUID();
  const outTradeNo = 'CRM' + Date.now() + Math.floor(Math.random() * 1000).toString().padStart(3, '0');

  const order = {
    id: orderId,
    userId: user.id,
    planId: plan.id,
    planName: plan.name,
    amountCents: plan.priceCents,
    outTradeNo,
    createdAt: Date.now()
  };
  await saasRepo.createOrder(env, order);

  // 构造支付参数（美元定价：money 传美元数值，订单名带 USD 标识）
  const payParams = {
    pid: String(config.EPAY_PID),
    type: requestedType,
    out_trade_no: outTradeNo,
    notify_url: `${origin}/api/payment/notify`,
    return_url: `${origin}/pay/result?out_trade_no=${outTradeNo}`,
    name: `${plan.name} (USD)`,
    money: (plan.priceCents / 100).toFixed(2)
  };
  const sign = await epaySign(payParams, config.EPAY_KEY);
  const qs = new URLSearchParams({ ...payParams, sign, sign_type: 'MD5' }).toString();
  const payUrl = `${config.EPAY_API_URL.replace(/\/$/, '')}/submit.php?${qs}`;

  return json({ success: true, data: { orderId, outTradeNo, payUrl } });
}

/**
 * 支付回调（易支付 GET notify）
 * GET /api/payment/notify?pid=...&trade_no=...&out_trade_no=...&type=...&name=...&money=...&trade_status=TRADE_SUCCESS&sign=...
 */
async function handleNotify(request, env) {
  const url = new URL(request.url);
  const config = await getConfig(env);

  if (!config.EPAY_KEY) return new Response('fail', { status: 500 });

  // 参数来源：GET → query string；POST → body（PayOne do_notify 以 k1=v1&k2=v2 形式 POST）
  let searchParams;
  if (request.method === 'POST') {
    const raw = await request.text();
    searchParams = new URLSearchParams(raw);
    // body 里缺 sign 时回看 query（兼容混合形式）
    if (!searchParams.get('sign')) {
      for (const [k, v] of url.searchParams) searchParams.append(k, v);
    }
  } else {
    searchParams = url.searchParams;
  }

  // 1. 验签
  const ok = await epayVerifyNotify(searchParams, config.EPAY_KEY);
  if (!ok) {
    console.warn('[epay] 回调验签失败:', request.method, url.pathname, (url.search || '').slice(0, 100));
    return new Response('sign error', { status: 403 });
  }

  // 2. 基础校验
  const outTradeNo = searchParams.get('out_trade_no') || '';
  const tradeStatus = searchParams.get('trade_status') || '';
  const money = searchParams.get('money') || '';
  const epayTradeNo = searchParams.get('trade_no') || '';

  const order = await saasRepo.getOrderByOutTradeNo(env, outTradeNo);
  if (!order) return new Response('order not found', { status: 404 });

  // 3. 金额校验（防篡改）
  const expectedMoney = (order.amountCents / 100).toFixed(2);
  if (Number(money) < Number(expectedMoney) - 0.001) {
    console.warn('[epay] 金额不符:', money, '期望', expectedMoney, outTradeNo);
    return new Response('money mismatch', { status: 400 });
  }

  // 4. 状态机幂等：pending → paid；已 paid 直接 success
  if (tradeStatus === 'TRADE_SUCCESS') {
    if (order.status === 'paid') return new Response('success');

    const updated = await saasRepo.markOrderPaid(env, outTradeNo, epayTradeNo, (request.method === 'POST' ? 'POST ' : '') + url.search + ' body:' + (searchParams.toString().slice(0, 500)));
    if (updated && updated.status === 'paid') {
      // 5. 开通/叠加会员
      await grantMembershipForOrder(env, updated);
    }
    return new Response('success');
  }

  return new Response('success'); // 其他状态也返回 success 防止重发
}

/**
 * 结果页轮询对账：pending 订单触发网关查单补单。
 * GET /api/orders/query-status?out_trade_no=xxx （登录用户，仅本人订单）
 */
async function handleQueryStatus(request, env, user) {
  const url = new URL(request.url);
  const outTradeNo = url.searchParams.get('out_trade_no') || '';
  if (!outTradeNo) return json({ success: false, message: '缺少 out_trade_no' }, 400);

  const order = await saasRepo.getOrderByOutTradeNo(env, outTradeNo);
  if (!order) return json({ success: false, message: '订单不存在' }, 404);
  // 越权防护：普通用户只能查自己的订单
  if (user.role !== 'admin' && order.userId !== user.id) {
    return json({ success: false, message: '无权查询该订单' }, 403);
  }

  let reconciliation = null;
  if (order.status === 'pending') {
    reconciliation = await queryGatewayOrder(env, order);
  }

  const fresh = await saasRepo.getOrderByOutTradeNo(env, outTradeNo);
  return json({ success: true, data: { status: fresh.status, reconciliation } });
}

export { handleCheckout, handleNotify, handleQueryStatus };
