import {
  getAllSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  manualRenewSubscription,
  deletePaymentRecord,
  updatePaymentRecord,
  toggleSubscriptionStatus
} from '../../data/subscriptions.js';
import { getConfig } from '../../data/config.js';
import { sendNotificationToAllChannels } from '../../services/notify/index.js';
import { lunarCalendar } from '../../core/lunar.js';
import { formatTimeInTimezone, formatTimezoneDisplay, getTimezoneDateParts } from '../../core/time.js';
import { formatAmount } from '../../core/currency-format.js';
import { extractTagsFromSubscriptions } from '../utils.js';

async function testSingleSubscriptionNotification(id, env) {
  try {
    const subscription = await getSubscription(id, env);
    if (!subscription) {
      return { success: false, message: '未找到该客户' };
    }
    const config = await getConfig(env);

    // 用户级通知配置优先（提醒设置页保存的），回退全局 config
    const ownerRow = env.__authUser ? await (async () => {
      const { getRowById } = await import('../../data/users.repo.js');
      return getRowById(env, env.__authUser.id);
    })() : null;
    let effConfig = config;
    if (ownerRow && ownerRow.notify_config) {
      try {
        const userCfg = JSON.parse(ownerRow.notify_config);
        if (Array.isArray(userCfg.ENABLED_NOTIFIERS) && userCfg.ENABLED_NOTIFIERS.length > 0) {
          effConfig = {
            ...config,
            ENABLED_NOTIFIERS: userCfg.ENABLED_NOTIFIERS,
            TG_BOT_TOKEN: userCfg.TG_BOT_TOKEN || config.TG_BOT_TOKEN,
            TG_CHAT_ID: userCfg.TG_CHAT_ID || config.TG_CHAT_ID,
            BARK_DEVICE_KEY: userCfg.BARK_DEVICE_KEY || config.BARK_DEVICE_KEY,
            WEBHOOK_URL: userCfg.WEBHOOK_URL || config.WEBHOOK_URL,
            WECHATBOT_WEBHOOK: userCfg.WECHATBOT_WEBHOOK || config.WECHATBOT_WEBHOOK,
            WECHATBOT_MSG_TYPE: userCfg.WECHATBOT_MSG_TYPE || 'text'
          };
        }
      } catch { /* 解析失败回退全局 */ }
    }

    const title = `手动测试通知: ${subscription.name}`;

    const showLunar = config.SHOW_LUNAR === true;
    let lunarExpiryText = '';

    if (showLunar) {
      const timezoneForLunar = config?.TIMEZONE || 'UTC';
      const expiryParts = getTimezoneDateParts(subscription.expiryDate, timezoneForLunar);
      const lunarExpiry = lunarCalendar.solar2lunar(expiryParts.year, expiryParts.month, expiryParts.day);
      lunarExpiryText = lunarExpiry ? ` (农历: ${lunarExpiry.fullStr})` : '';
    }

    const timezone = config?.TIMEZONE || 'UTC';
    const formattedExpiryDate = formatTimeInTimezone(new Date(subscription.expiryDate), timezone, 'date');
    const currentTime = formatTimeInTimezone(new Date(), timezone, 'datetime');

    const calendarType = subscription.useLunar ? '农历' : '公历';
    const autoRenewText = subscription.autoRenew ? '是' : '否';
    const formattedAmount = formatAmount(subscription.amount, subscription.currency || 'CNY');
    const amountText = formattedAmount ? `\n金额: ${formattedAmount}/周期` : '';

    const categoryText = subscription.category ? subscription.category : '未分类';

    const commonContent = `**客户详情**
类型: ${subscription.customType || '其他'}${amountText}
分类: ${categoryText}
日历类型: ${calendarType}
到期日期: ${formattedExpiryDate}${lunarExpiryText}
自动续期: ${autoRenewText}
备注: ${subscription.notes || '无'}
发送时间: ${currentTime}
当前时区: ${formatTimezoneDisplay(timezone)}`;

    const tags = extractTagsFromSubscriptions([subscription]);
    const notifyResult = await sendNotificationToAllChannels(title, commonContent, effConfig, '[手动测试]', {
      env, subId: id, ruleId: 'manual-test',
      metadata: { tags }
    });

    // 客户专属测试邮件：客户填了邮箱 + 用户配了 SMTP + 有可用模板 → 单独发一封
    let customerEmailSent = false;
    let customerEmailError = null;
    if (subscription.customerEmail && ownerRow) {
      try {
        const smtpCfg = JSON.parse(ownerRow.notify_config || '{}');
        if (smtpCfg.SMTP_EMAIL && smtpCfg.SMTP_AUTH_CODE) {
          const { getDefaultTemplate, listTemplates } = await import('../../data/email-templates.repo.js');
          const userTemplates = await listTemplates(env, ownerRow.id);
          const tpl = (subscription.notifyTemplateId && userTemplates.find((t) => t.id === subscription.notifyTemplateId))
            || await getDefaultTemplate(env, ownerRow.id)
            || userTemplates[0];
          if (tpl) {
            const { sendCustomerEmail } = await import('./email-templates.js');
            // 剩余天数与调度器同一套时区算法（修复：此前硬编码 7）
            const { getDaysBetween, getNowInTimezone } = await import('../../core/time.js');
            const tz = effConfig.TIMEZONE || config.TIMEZONE || 'Asia/Shanghai';
            const nowUtc = getNowInTimezone(tz).utc;
            const realDaysLeft = Math.ceil(getDaysBetween(nowUtc, new Date(subscription.expiryDate), tz));
            const r = await sendCustomerEmail(env, ownerRow, tpl, subscription, {
              '客户名': subscription.name,
              '到期日期': new Date(subscription.expiryDate).toISOString().slice(0, 10),
              '剩余天数': realDaysLeft,
              '金额': subscription.amount != null ? `${subscription.amount} ${subscription.currency || ''}`.trim() : '',
              '分类': subscription.category || subscription.customType || ''
            });
            if (r.ok) customerEmailSent = true;
            else customerEmailError = r.error;
          }
        }
      } catch (e) {
        customerEmailError = e.message;
      }
    }

    const attempted = notifyResult?.attempted || 0;
    const successCount = notifyResult?.successCount || 0;
    const failedCount = notifyResult?.failedCount || 0;

    // 客户邮件结果合并进消息
    const parts = [];
    if (successCount > 0) parts.push(`你的渠道成功 ${successCount} 个`);
    if (failedCount > 0) parts.push(`失败 ${failedCount} 个`);
    if (customerEmailSent) parts.push('客户专属邮件已发送');
    if (customerEmailError) parts.push(`客户邮件失败(${customerEmailError})`);

    if (attempted === 0 && !customerEmailSent) {
      return { success: false, message: '未启用任何通知渠道，请先在「提醒设置」中开启至少一种通知方式' };
    }

    if (successCount === 0 && !customerEmailSent) {
      const reason = (customerEmailError && attempted > 0)
        ? `你的渠道失败（已尝试 ${attempted} 个）`
        : `测试通知发送失败（已尝试 ${attempted} 个渠道）`;
      return { success: false, message: reason };
    }

    if (failedCount > 0 || customerEmailError) {
      return { success: true, message: `测试通知已发送：${parts.join('；')}` };
    }

    return { success: true, message: `测试通知发送成功：${parts.join('；')}` };
  } catch (error) {
    console.error('[手动测试] 发送失败:', error);
    return { success: false, message: '发送时发生错误: ' + error.message };
  }
}

async function handleSubscriptions(request, env, path) {
  const method = request.method;

  if (path === '/subscriptions') {
    if (method === 'GET') {
      const subscriptions = await getAllSubscriptions(env);
      return new Response(JSON.stringify(subscriptions), { headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'POST') {
      // 免费配额检查（会员/admin 不限）
      const { checkSubscriptionQuota } = await import('../../services/quota.js');
      const quota = await checkSubscriptionQuota(env);
      if (!quota.allowed) {
        return new Response(
          JSON.stringify({ success: false, message: quota.reason, code: 'QUOTA_EXCEEDED' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      let subscription;
      try {
        subscription = await request.json();
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: '请求体不是合法 JSON' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const result = await createSubscription(subscription, env);
      // 创建成功后写入提醒规则，并同步 legacy 提醒字段（列表展示依赖）
      if (result.success && result.subscription) {
        try {
          const remindersRepo = await import('../../data/reminders.repo.js');
          const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
          const incoming = Array.isArray(subscription.reminderRules)
            ? subscription.reminderRules
            : null;
          const rules = incoming && incoming.length > 0
            ? incoming.map(remindersRepo.normalizeRule)
            : remindersRepo.defaultPresetRules();
          await remindersRepo.replaceForSubscription(env, result.subscription.id, rules);
          await syncLegacyReminderFields(env, result.subscription.id, rules);
        } catch (err) {
          console.error('[subscriptions] 写入提醒规则失败（客户本身已创建）:', err);
        }
      }
      return new Response(JSON.stringify(result), {
        status: result.success ? 201 : 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  if (path.startsWith('/subscriptions/')) {
    const parts = path.split('/');
    const id = parts[2];

    if (parts[3] === 'toggle-status' && method === 'POST') {
      const body = await request.json();
      const result = await toggleSubscriptionStatus(id, body.isActive, env);
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (parts[3] === 'test-notify' && method === 'POST') {
      const result = await testSingleSubscriptionNotification(id, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'renew' && method === 'POST') {
      let options = {};
      try {
        const body = await request.json();
        options = body || {};
      } catch (e) {
        // empty
      }
      const result = await manualRenewSubscription(id, env, options);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'payments' && method === 'GET') {
      const subscription = await getSubscription(id, env);
      if (!subscription) {
        return new Response(JSON.stringify({ success: false, message: '客户不存在' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ success: true, payments: subscription.paymentHistory || [] }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'payments' && parts[4] && method === 'DELETE') {
      const paymentId = parts[4];
      const result = await deletePaymentRecord(id, paymentId, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'payments' && parts[4] && method === 'PUT') {
      const paymentId = parts[4];
      const paymentData = await request.json();
      const result = await updatePaymentRecord(id, paymentId, paymentData, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'GET') {
      const subscription = await getSubscription(id, env);
      if (!subscription) {
        return new Response(
          JSON.stringify({ success: false, message: '客户不存在' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify(subscription), { headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'PUT') {
      let subscription;
      try {
        subscription = await request.json();
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: '请求体不是合法 JSON' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const result = await updateSubscription(id, subscription, env);
      // 与创建路径对称：若 body 带 reminderRules 则整体替换并同步 legacy
      if (result.success && Array.isArray(subscription.reminderRules)) {
        try {
          const remindersRepo = await import('../../data/reminders.repo.js');
          const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
          const rules = subscription.reminderRules.map(remindersRepo.normalizeRule);
          await remindersRepo.replaceForSubscription(env, id, rules);
          await syncLegacyReminderFields(env, id, rules);
        } catch (err) {
          console.error('[subscriptions] 更新提醒规则失败（客户本体已更新）:', err);
        }
      }
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'DELETE') {
      const result = await deleteSubscription(id, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return null;
}

export { handleSubscriptions };
