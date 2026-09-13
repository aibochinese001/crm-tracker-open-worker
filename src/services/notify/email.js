// @ts-check
/**
 * 邮件通知渠道（Resend API）
 */
import { ok, fail, errorMessage, stripMarkdown } from './channel.js';
import { formatLocalDate } from '../../core/time.js';

/**
 * 构造 HTML 模板。
 * @param {string} title
 * @param {string} content
 * @param {string} timezone
 */
function buildHtml(title, content, timezone) {
  const safe = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] || c));
  const ts = formatLocalDate(new Date(), timezone || 'UTC', 'datetime');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${safe(title)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 0; background-color: #f5f5f5; }
.container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
.header { background: linear-gradient(135deg, #667eea, #764ba2); padding: 30px 20px; text-align: center; }
.header h1 { color: white; margin: 0; font-size: 24px; }
.content { padding: 30px 20px; }
.highlight { background-color: #e3f2fd; padding: 15px; border-radius: 8px; margin: 20px 0; }
.footer { background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 14px; }
</style></head>
<body>
<div class="container">
  <div class="header"><h1>📅 ${safe(title)}</h1></div>
  <div class="content">
    <div class="highlight">${safe(stripMarkdown(content)).replace(/\n/g, '<br>')}</div>
    <p style="color:#666;line-height:1.6;">此邮件由客户管理系统自动发送，请及时处理相关客户事务。</p>
  </div>
  <div class="footer"><p>客户管理系统 | 发送时间: ${safe(ts)}</p></div>
</div>
</body></html>`;
}

/** @type {import('./channel.js').Channel} */
export const emailChannel = {
  name: 'email',

  validateConfig(config) {
    if (!config.RESEND_API_KEY) return { ok: false, error: '缺少 RESEND_API_KEY' };
    if (!config.EMAIL_FROM) return { ok: false, error: '缺少 EMAIL_FROM' };
    if (!config.EMAIL_TO) return { ok: false, error: '缺少 EMAIL_TO' };
    return { ok: true };
  },

  async send(payload, config) {
    const v = emailChannel.validateConfig(config);
    if (!v.ok) return fail('email', v.error || '配置无效');

    const fromEmail = config.EMAIL_FROM_NAME
      ? `${config.EMAIL_FROM_NAME} <${config.EMAIL_FROM}>`
      : config.EMAIL_FROM;

    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: fromEmail,
          to: config.EMAIL_TO,
          subject: payload.title,
          html: buildHtml(payload.title, payload.content, config.TIMEZONE),
          text: stripMarkdown(payload.content)
        })
      });
      const result = await r.json().catch(() => ({}));
      return r.ok && result && result.id
        ? ok('email', result)
        : fail('email', result?.message || `HTTP ${r.status}`, result);
    } catch (err) {
      return fail('email', errorMessage(err));
    }
  },

  async test(config) {
    return emailChannel.send(
      { title: '客户管理 - 测试通知', content: '这是一条邮件测试通知。' },
      config
    );
  }
};

/** @deprecated 旧版兼容函数 */
export async function sendEmailNotification(title, content, config) {
  const r = await emailChannel.send({ title, content }, config);
  if (!r.success) console.error('[Email]', r.error);
  return r.success;
}
