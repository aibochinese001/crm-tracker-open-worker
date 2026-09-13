// @ts-check
/**
 * Gotify 通知渠道（自托管）
 */
import { ok, fail, errorMessage, stripMarkdown } from './channel.js';

/** @type {import('./channel.js').Channel} */
export const gotifyChannel = {
  name: 'gotify',

  validateConfig(config) {
    if (!config.GOTIFY_SERVER_URL) return { ok: false, error: '缺少 GOTIFY_SERVER_URL' };
    if (!config.GOTIFY_APP_TOKEN) return { ok: false, error: '缺少 GOTIFY_APP_TOKEN' };
    return { ok: true };
  },

  async send(payload, config) {
    const v = gotifyChannel.validateConfig(config);
    if (!v.ok) return fail('gotify', v.error || '配置无效');

    const url =
      String(config.GOTIFY_SERVER_URL).replace(/\/+$/, '') +
      '/message?token=' +
      encodeURIComponent(String(config.GOTIFY_APP_TOKEN));

    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: payload.title || '通知',
          message: stripMarkdown(payload.content) || '',
          priority: 5
        })
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return fail('gotify', `HTTP ${r.status}`, text);
      }
      return ok('gotify');
    } catch (err) {
      return fail('gotify', errorMessage(err));
    }
  },

  async test(config) {
    return gotifyChannel.send(
      { title: '客户管理 - 测试通知', content: '这是一条 Gotify 测试通知。' },
      config
    );
  }
};

/** @deprecated 旧版兼容函数 */
export async function sendGotifyNotification(title, content, config) {
  const r = await gotifyChannel.send({ title, content }, config);
  if (!r.success) console.error('[Gotify]', r.error);
  return r.success;
}
