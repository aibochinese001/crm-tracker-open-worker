// @ts-check
/**
 * 邮件模板 + SMTP 配置路由（每用户/管理员各自隔离）
 *
 * GET    /api/email-templates             列表
 * POST   /api/email-templates             创建/更新（带 id 即更新）
 * DELETE /api/email-templates/:id         删除
 * POST   /api/email-templates/:id/test    用该模板发测试邮件
 * POST   /api/my/smtp-test                测试 SMTP 通道连通性
 * POST   /api/my/bind-email               绑定用户自己的邮箱（接收 BCC）
 */

import * as tplRepo from '../../data/email-templates.repo.js';
import * as usersRepo from '../../data/users.repo.js';
import { sendViaBridge, wrapEmailHtml, renderTemplate, textToHtml } from '../../core/mail-bridge.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 构造用户的 SMTP 配置对象（从 notify_config 提取）
 */
function smtpCfgOf(userRow) {
  let cfg = {};
  try { cfg = userRow.notify_config ? JSON.parse(userRow.notify_config) : {}; } catch { /* ignore */ }
  return {
    SMTP_EMAIL: cfg.SMTP_EMAIL || '',
    SMTP_AUTH_CODE: cfg.SMTP_AUTH_CODE || '',
    SMTP_FROM_NAME: cfg.SMTP_FROM_NAME || '',
    EMAIL_BCC: cfg.EMAIL_BCC || ''
  };
}

/**
 * 渲染模板并发送（scheduler 与测试共用）
 *
 * @returns {Promise<{ok: boolean, error?: string, messageId?: string}>}
 */
export async function sendCustomerEmail(env, ownerRow, tpl, sub, vars) {
  const smtpCfg = smtpCfgOf(ownerRow);
  const merge = { ...vars, '你的用户名': ownerRow.username };
  const subject = renderTemplate(tpl.subject, merge);
  const bodyText = renderTemplate(tpl.body, merge);
  const html = wrapEmailHtml(subject, textToHtml(bodyText), smtpCfg.SMTP_FROM_NAME);

  // BCC：owner 配置的归档邮箱 + 用户绑定邮箱（去重，都不是收件人本身）
  const bccSet = new Set();
  if (smtpCfg.EMAIL_BCC && EMAIL_RE.test(smtpCfg.EMAIL_BCC)) bccSet.add(smtpCfg.EMAIL_BCC);
  if (ownerRow.bound_email && EMAIL_RE.test(ownerRow.bound_email)) bccSet.add(ownerRow.bound_email);
  bccSet.delete(sub.customerEmail);
  const bcc = [...bccSet].join(',') || undefined;

  return sendViaBridge(env, { ...smtpCfg, EMAIL_BCC: bcc }, {
    to: sub.customerEmail,
    subject,
    html
  });
}

/**
 * @returns {Promise<Response|null>} null = 未命中
 */
export async function handleEmailTemplateRoutes(request, env, path, method, user) {
  const owner = user.id;

  /* ---- 模板 CRUD ---- */

  if (path === '/email-templates' && method === 'GET') {
    const list = await tplRepo.listTemplates(env, owner);
    return json({ success: true, data: list });
  }

  if (path === '/email-templates' && method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || !body.name || !body.subject || !body.body) {
      return json({ success: false, message: '模板名/主题/正文不能为空' }, 400);
    }
    const saved = await tplRepo.saveTemplate(env, owner, {
      id: body.id || 'tpl_' + crypto.randomUUID(),
      name: String(body.name).slice(0, 50),
      subject: String(body.subject).slice(0, 200),
      body: String(body.body).slice(0, 10000),
      isDefault: !!body.isDefault
    });
    return json({ success: true, data: saved, message: '已保存' });
  }

  const delMatch = path.match(/^\/email-templates\/([a-zA-Z0-9_-]+)$/);
  if (delMatch && method === 'DELETE') {
    const ok = await tplRepo.deleteTemplate(env, owner, delMatch[1]);
    return json({ success: ok, message: ok ? '已删除' : '模板不存在' }, ok ? 200 : 404);
  }

  const testMatch = path.match(/^\/email-templates\/([a-zA-Z0-9_-]+)\/test$/);
  if (testMatch && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const to = String(body.to || '').trim();
    if (!EMAIL_RE.test(to)) return json({ success: false, message: '请填写有效的测试收件邮箱' }, 400);

    const tpl = await tplRepo.getTemplate(env, owner, testMatch[1]);
    if (!tpl) return json({ success: false, message: '模板不存在' }, 404);

    const ownerRow = await usersRepo.getRowById(env, owner);
    const result = await sendCustomerEmail(env, ownerRow, tpl, { customerEmail: to }, {
      '客户名': '测试客户',
      '到期日期': new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      '剩余天数': 7,
      '金额': '$9.99',
      '分类': '测试分类'
    });
    return json(result.ok
      ? { success: true, message: '测试邮件已发送至 ' + to }
      : { success: false, message: result.error });
  }

  /* ---- SMTP 通道测试 ---- */

  if (path === '/my/smtp-test' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const to = String(body.to || '').trim();
    if (!EMAIL_RE.test(to)) return json({ success: false, message: '请填写有效的测试收件邮箱' }, 400);

    const ownerRow = await usersRepo.getRowById(env, owner);
    const smtpCfg = smtpCfgOf(ownerRow);
    if (!smtpCfg.SMTP_EMAIL || !smtpCfg.SMTP_AUTH_CODE) {
      return json({ success: false, message: '请先保存发件邮箱和授权码' });
    }
    const { sendViaBridge, wrapEmailHtml } = await import('../../core/mail-bridge.js');
    const result = await sendViaBridge(env, smtpCfg, {
      to,
      subject: '【客户管理系统】SMTP 通道测试',
      html: wrapEmailHtml('SMTP 通道测试', '这是你配置的邮件发送通道测试。收到此邮件说明 QQ 邮箱 SMTP 配置正确。', smtpCfg.SMTP_FROM_NAME)
    });
    return json(result.ok
      ? { success: true, message: '测试邮件已发送至 ' + to }
      : { success: false, message: result.error });
  }

  /* ---- 绑定用户自己的邮箱（接收客户邮件 BCC） ---- */

  if (path === '/my/bind-email' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim();
    if (email && !EMAIL_RE.test(email)) {
      return json({ success: false, message: '邮箱格式不正确' }, 400);
    }
    const db = await import('../../data/db.js').then((m) => m.getDB(env));
    if (!db) return json({ success: false, message: '数据库不可用' }, 503);
    await db
      .prepare('UPDATE users SET bound_email = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(email || null, Date.now(), owner)
      .run();
    return json({ success: true, message: email ? '邮箱已绑定，客户专属邮件将抄送给您' : '已清除绑定邮箱' });
  }

  return null;
}
