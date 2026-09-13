// @ts-check
/**
 * ntfy 通知渠道
 *
 * 文档：https://docs.ntfy.sh/publish/
 * 默认公共服务器 https://ntfy.sh，也可填自建地址。
 *
 * 配置：
 * - NTFY_SERVER  默认 https://ntfy.sh
 * - NTFY_TOPIC   主题名（必填）
 * - NTFY_TOKEN   可选 Bearer Token（受保护主题）
 */
import { ok, fail, errorMessage, stripMarkdown } from './channel.js';

/** @type {import('./channel.js').Channel} */
export const ntfyChannel = {
  name: 'ntfy',

  validateConfig(config) {
    if (!config.NTFY_TOPIC || !String(config.NTFY_TOPIC).trim()) {
      return { ok: false, error: '缺少 NTFY_TOPIC' };
    }
    return { ok: true };
  },

  async send(payload, config) {
    const v = ntfyChannel.validateConfig(config);
    if (!v.ok) return fail('ntfy', v.error || '配置无效');

    const server = String(config.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
    const topic = String(config.NTFY_TOPIC).trim().replace(/^\/+/, '');
    const url = `${server}/${encodeURIComponent(topic)}`;

    /** @type {Record<string, string>} */
    const headers = {
      Title: payload.title || '到期提醒',
      'Content-Type': 'text/plain; charset=utf-8'
    };
    const token = config.NTFY_TOKEN ? String(config.NTFY_TOKEN).trim() : '';
    if (token) {
      headers.Authorization = token.toLowerCase().startsWith('bearer ')
        ? token
        : `Bearer ${token}`;
    }

    const body = stripMarkdown(payload.content || '') || (payload.title || '通知');

    try {
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return fail('ntfy', `HTTP ${r.status}`, text);
      }
      // ntfy 成功通常返回 JSON，但也可能是空；不强制解析
      const raw = await r.json().catch(() => ({}));
      return ok('ntfy', raw);
    } catch (err) {
      return fail('ntfy', errorMessage(err));
    }
  },

  async test(config) {
    return ntfyChannel.send(
      { title: '客户管理 - 测试通知', content: '这是一条 ntfy 测试通知。' },
      config
    );
  }
};

/** @deprecated 旧版兼容函数 */
export async function sendNtfyNotification(title, content, config) {
  const r = await ntfyChannel.send({ title, content }, config);
  if (!r.success) console.error('[ntfy]', r.error);
  return r.success;
}
