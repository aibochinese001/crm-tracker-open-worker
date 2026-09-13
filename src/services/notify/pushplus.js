// @ts-check
/**
 * PushPlus 通知渠道
 */
import { ok, fail, errorMessage } from './channel.js';

/** @type {import('./channel.js').Channel} */
export const pushplusChannel = {
  name: 'pushplus',

  validateConfig(config) {
    if (!config.PUSHPLUS_TOKEN) return { ok: false, error: '缺少 PUSHPLUS_TOKEN' };
    return { ok: true };
  },

  async send(payload, config) {
    const v = pushplusChannel.validateConfig(config);
    if (!v.ok) return fail('pushplus', v.error || '配置无效');

    /** @type {Record<string, any>} */
    const body = {
      token: config.PUSHPLUS_TOKEN,
      title: payload.title || '到期提醒',
      content: `## ${payload.title || '到期提醒'}\n\n${payload.content || ''}`,
      template: 'markdown'
    };
    if (config.PUSHPLUS_TOPIC) body.topic = config.PUSHPLUS_TOPIC;
    if (config.PUSHPLUS_CHANNEL) body.channel = config.PUSHPLUS_CHANNEL;

    try {
      const r = await fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await r.json().catch(() => ({}));
      return result && result.code === 200
        ? ok('pushplus', result)
        : fail('pushplus', `PushPlus 返回 code=${result?.code} ${result?.msg || ''}`, result);
    } catch (err) {
      return fail('pushplus', errorMessage(err));
    }
  },

  async test(config) {
    return pushplusChannel.send(
      { title: '客户管理 - 测试通知', content: '这是一条 PushPlus 测试通知。' },
      config
    );
  }
};

/** @deprecated 旧版兼容函数 */
export async function sendPushPlusNotification(title, content, config) {
  const r = await pushplusChannel.send({ title, content }, config);
  if (!r.success) console.error('[PushPlus]', r.error);
  return r.success;
}
