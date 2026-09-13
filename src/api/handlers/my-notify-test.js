// @ts-check
/**
 * 普通用户「提醒设置」页的测试通知
 *
 * POST /api/my/notify-test  { channel: 'telegram' | 'bark' | 'wechatbot' | 'email' | 'webhook' }
 *
 * 用该用户已保存的 notify_config 构造有效配置；若请求体带了临时字段（用户还没点保存
 * 就想先测试），则临时值优先。发送结果写 notify_log 归属该用户。
 */

import { dispatch } from '../../services/notify/index.js';
import * as usersRepo from '../../data/users.repo.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const ALLOWED_CHANNELS = ['telegram', 'bark', 'wechatbot', 'email', 'webhook'];

/** 用户 notify_config + 临时覆盖 → dispatch 可用的 config（渠道白名单内的单渠道发送） */
function buildUserCfg(userCfg, body) {
  const pick = (saved, incoming, max = 500) => {
    const v = typeof incoming === 'string' ? incoming.trim() : '';
    return v || saved || '';
  };
  return {
    ENABLED_NOTIFIERS: [String(body.channel)],
    TG_BOT_TOKEN: pick(userCfg.TG_BOT_TOKEN, body.TG_BOT_TOKEN, 200),
    TG_CHAT_ID: pick(userCfg.TG_CHAT_ID, body.TG_CHAT_ID, 100),
    BARK_DEVICE_KEY: pick(userCfg.BARK_DEVICE_KEY, body.BARK_DEVICE_KEY, 200),
    WECHATBOT_WEBHOOK: pick(userCfg.WECHATBOT_WEBHOOK, body.WECHATBOT_WEBHOOK),
    WECHATBOT_MSG_TYPE: body.WECHATBOT_MSG_TYPE === 'markdown' || userCfg.WECHATBOT_MSG_TYPE === 'markdown'
      ? 'markdown'
      : 'text',
    RESEND_API_KEY: pick(userCfg.RESEND_API_KEY, body.RESEND_API_KEY, 200),
    EMAIL_FROM: pick(userCfg.EMAIL_FROM, body.EMAIL_FROM, 200),
    EMAIL_TO: pick(userCfg.EMAIL_TO, body.EMAIL_TO, 200),
    WEBHOOK_URL: pick(userCfg.WEBHOOK_URL, body.WEBHOOK_URL)
  };
}

export async function handleMyNotifyTest(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, message: '请求体不是合法 JSON' }, 400);
  }
  const channel = String(body.channel || '').trim();
  if (!ALLOWED_CHANNELS.includes(channel)) {
    return json({ success: false, message: '不支持的渠道: ' + (channel || '(空)') }, 400);
  }

  const userCfg = (await usersRepo.getNotifyConfig(env, user.id)) || {};
  const effCfg = buildUserCfg(userCfg, { ...body, channel });

  // 前置校验：目标字段缺失直接提示，不浪费网关调用
  const required = {
    telegram: ['TG_BOT_TOKEN', 'TG_CHAT_ID'],
    bark: ['BARK_DEVICE_KEY'],
    wechatbot: ['WECHATBOT_WEBHOOK'],
    email: ['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_TO'],
    webhook: ['WEBHOOK_URL']
  };
  const missing = (required[channel] || []).filter((k) => !effCfg[k]);
  if (missing.length > 0) {
    return json({ success: false, message: '请先填写并保存：' + missing.join(', ') });
  }

  const result = await dispatch(
    {
      title: '提醒设置测试',
      content: '这是一条测试通知，验证你的「' + channel + '」渠道配置是否正常。\n\n用户: ' + user.username + '\n时间: ' + new Date().toISOString()
    },
    effCfg,
    {
      env,
      subId: 'notify-test',
      ruleId: 'manual-test',
      logPrefix: '[用户测试通知]',
      metadata: { ownerUserId: user.id }
    }
  );

  if (result.successCount > 0) {
    return json({ success: true, message: '测试通知发送成功，请查收' });
  }
  const err = (result.results && result.results[0] && result.results[0].error) || '发送失败，请检查配置';
  return json({ success: false, message: err });
}
