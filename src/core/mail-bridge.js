// @ts-check
/**
 * SMTP 桥客户端 + 邮件渲染
 *
 * 桥：https://REPLACE_WITH_SMTP_BRIDGE_HOST/send（HMAC-SHA256 鉴权，BRIDGE_SECRET 存 Worker secret）
 * 每次请求携带该用户自己的 SMTP 凭证（桥不落盘）。
 */

import { getConfig } from '../data/config.js';

const BRIDGE_URL = 'https://REPLACE_WITH_SMTP_BRIDGE_HOST/send';

/**
 * 发送邮件（经 SMTP 桥）
 *
 * @param {{ SUBSCRIPTIONS_KV?: KVNamespace }} env
 * @param {{ SMTP_EMAIL: string, SMTP_AUTH_CODE: string, SMTP_FROM_NAME?: string, EMAIL_BCC?: string }} smtpCfg 用户的 SMTP 配置
 * @param {{ to: string, subject: string, html: string, text?: string }} mail
 * @returns {Promise<{ ok: boolean, messageId?: string, error?: string }>}
 */
export async function sendViaBridge(env, smtpCfg, mail) {
  const config = await getConfig(env);
  const secret = config.SMTP_BRIDGE_SECRET;
  if (!secret) return { ok: false, error: '桥密钥未配置（SMTP_BRIDGE_SECRET）' };
  if (!smtpCfg || !smtpCfg.SMTP_EMAIL || !smtpCfg.SMTP_AUTH_CODE) {
    return { ok: false, error: '未配置发件邮箱或授权码' };
  }

  const payload = {
    smtp: {
      host: 'smtp.qq.com',
      port: 465,
      secure: true,
      user: smtpCfg.SMTP_EMAIL,
      pass: smtpCfg.SMTP_AUTH_CODE
    },
    from: smtpCfg.SMTP_FROM_NAME
      ? `${smtpCfg.SMTP_FROM_NAME} <${smtpCfg.SMTP_EMAIL}>`
      : smtpCfg.SMTP_EMAIL,
    to: mail.to,
    bcc: smtpCfg.EMAIL_BCC || undefined,
    subject: mail.subject,
    html: mail.html,
    text: mail.text
  };

  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const sigBytes = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', sigBytes, new TextEncoder().encode(timestamp + '.' + body));
  const signature = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');

  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Timestamp': timestamp,
        'X-Bridge-Signature': signature
      },
      body,
      signal: AbortSignal.timeout(25000)
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.ok) {
      return { ok: true, messageId: data.messageId };
    }
    return { ok: false, error: (data && data.error) || `桥响应异常 HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: '桥请求失败: ' + (err && err.message ? err.message : String(err)) };
  }
}

/**
 * HTML 转义
 */
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 用品牌 HTML 壳包装正文
 */
export function wrapEmailHtml(title, bodyHtml, senderName) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;background:#f4f5f7;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:28px 24px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:22px">${esc(title)}</h1>
  </div>
  <div style="padding:28px 24px;color:#333;line-height:1.8;font-size:15px">${bodyHtml}</div>
  <div style="background:#f8f9fa;padding:16px 24px;color:#999;font-size:12px;text-align:center">
    ${esc(senderName || '客户管理系统')} · 此邮件由系统自动发送 · ${esc(ts)}
  </div>
</div>
</body></html>`;
}

/**
 * 模板变量渲染（body：纯文本，支持 \n 换行 → <br>；{{变量}} 替换）
 *
 * @param {string} template 模板正文/主题
 * @param {Record<string, string|number>} vars 变量集
 */
export function renderTemplate(template, vars) {
  let out = String(template || '');
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.split(`{{${k}}}`).join(String(v));
  }
  // 未识别变量清空，避免残留
  out = out.replace(/\{\{[^}]+\}\}/g, '');
  return out;
}

/**
 * 纯文本模板 → HTML（\n → <br>，保留基本安全）
 */
export function textToHtml(text) {
  return esc(text).replace(/\n/g, '<br>');
}
