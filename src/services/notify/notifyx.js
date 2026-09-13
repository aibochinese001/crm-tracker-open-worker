// @ts-check
/**
 * NotifyX 通知渠道（https://www.notifyx.cn）
 */
import { ok, fail, errorMessage } from './channel.js';

/** @type {import('./channel.js').Channel} */
export const notifyxChannel = {
  name: 'notifyx',

  validateConfig(config) {
    if (!config.NOTIFYX_API_KEY) return { ok: false, error: '缺少 NOTIFYX_API_KEY' };
    return { ok: true };
  },

  async send(payload, config) {
    const v = notifyxChannel.validateConfig(config);
    if (!v.ok) return fail('notifyx', v.error || '配置无效');

    const url = `https://www.notifyx.cn/api/v1/send/${config.NOTIFYX_API_KEY}`;
    const body = JSON.stringify({
      title: payload.title || '到期提醒',
      content: `## ${payload.title || '到期提醒'}\n\n${payload.content || ''}`,
      description: '到期提醒'
    });

    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      const result = await r.json();
      return result.status === 'queued'
        ? ok('notifyx', result)
        : fail('notifyx', `NotifyX 返回 ${result.status || 'unknown'}`, result);
    } catch (err) {
      return fail('notifyx', errorMessage(err));
    }
  },

  async test(config) {
    return notifyxChannel.send(
      { title: '客户管理 - 测试通知', content: '这是一条 NotifyX 测试通知。' },
      config
    );
  }
};

/** @deprecated 旧版兼容函数 */
export async function sendNotifyXNotification(title, content, _description, config) {
  // 早期接口签名带一个 description 参数；新接口已弃用此字段
  void _description;
  const r = await notifyxChannel.send({ title, content }, config);
  if (!r.success) console.error('[NotifyX]', r.error);
  return r.success;
}
