// @ts-check
/**
 * 调试页（仅登录后可见）
 *
 * 用途：
 * - 检查 KV 绑定、配置完整性、JWT 密钥状态
 * - 新增"时区诊断"区块，直观展示 UTC vs 用户 TZ 的当前小时差异
 *   这是 #91 / #52 / #166 类问题的自助排查入口
 *
 */
import { getConfig } from '../data/config.js';
import {
  getNowInTimezone,
  formatTimezoneDisplay,
  getTimezoneOffset
} from '../core/time.js';
import * as schedLogs from '../data/scheduler-logs.repo.js';

/** 简单 HTML 转义，防止配置中的字符串污染页面 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
async function handleDebug(request, env) {
  try {
    const url = new URL(request.url);

    // 子路由：导出最近 N 条调度日志（JSON）
    if (url.searchParams.get('export') === 'sched_logs') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      const logs = await schedLogs.getRecent(env, limit);
      return new Response(JSON.stringify(logs, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="scheduler-logs-${Date.now()}.json"`
        }
      });
    }

    const config = await getConfig(env);
    const tz = config.TIMEZONE || 'UTC';
    const now = getNowInTimezone(tz);

    const notificationHours = Array.isArray(config.NOTIFICATION_HOURS)
      ? config.NOTIFICATION_HOURS.map((h) => String(h).padStart(2, '0'))
      : [];
    const inWindow =
      notificationHours.length === 0 ||
      notificationHours.includes('*') ||
      notificationHours.includes('ALL') ||
      notificationHours.includes(now.hourString);

    const debugInfo = {
      timestamp: now.utc.toISOString(),
      pathname: url.pathname,
      kvBinding: !!env.SUBSCRIPTIONS_KV,
      configExists: !!config,
      adminUsername: config.ADMIN_USERNAME,
      hasJwtSecret: !!config.JWT_SECRET,
      jwtSecretLength: config.JWT_SECRET ? config.JWT_SECRET.length : 0,
      timezone: tz,
      timezoneDisplay: formatTimezoneDisplay(tz),
      timezoneOffsetHours: getTimezoneOffset(tz),
      utcIso: now.utc.toISOString(),
      localIso: now.isoLocal,
      currentHour: now.hourString,
      configuredHours: notificationHours,
      inNotificationWindow: inWindow
    };

    return new Response(
      `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>调试信息 - 客户管理系统</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace; padding: 20px; background: #f5f5f5; color: #333; }
    h1 { font-size: 22px; }
    .info { background: white; padding: 15px 20px; margin: 12px 0; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .info h3 { margin-top: 0; font-size: 16px; color: #555; border-bottom: 1px solid #eee; padding-bottom: 8px; }
    .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
    .row .k { color: #666; }
    .row .v { font-weight: 600; color: #1a1a1a; }
    .success { color: #16a34a; }
    .error { color: #dc2626; }
    .warn { color: #ca8a04; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>系统调试信息</h1>

  <div class="info">
    <h3>基本</h3>
    <div class="row"><span class="k">UTC 时间</span><span class="v">${esc(debugInfo.timestamp)}</span></div>
    <div class="row"><span class="k">访问路径</span><span class="v">${esc(debugInfo.pathname)}</span></div>
    <div class="row"><span class="k">KV 绑定</span><span class="v ${debugInfo.kvBinding ? 'success' : 'error'}">${debugInfo.kvBinding ? '✓ 已绑定' : '✗ 未绑定'}</span></div>
    <div class="row"><span class="k">配置可读</span><span class="v ${debugInfo.configExists ? 'success' : 'error'}">${debugInfo.configExists ? '✓' : '✗'}</span></div>
    <div class="row"><span class="k">管理员用户名</span><span class="v">${esc(debugInfo.adminUsername || '(未设置)')}</span></div>
    <div class="row"><span class="k">JWT 密钥</span><span class="v ${debugInfo.hasJwtSecret ? 'success' : 'error'}">${debugInfo.hasJwtSecret ? `✓ 已设置 (${debugInfo.jwtSecretLength} 字符)` : '✗ 缺失'}</span></div>
  </div>

  <div class="info">
    <h3>时区诊断</h3>
    <div class="row"><span class="k">配置的时区</span><span class="v">${esc(debugInfo.timezoneDisplay)}</span></div>
    <div class="row"><span class="k">时区偏移</span><span class="v">UTC${debugInfo.timezoneOffsetHours >= 0 ? '+' : ''}${debugInfo.timezoneOffsetHours} 小时</span></div>
    <div class="row"><span class="k">当前 UTC</span><span class="v">${esc(debugInfo.utcIso)}</span></div>
    <div class="row"><span class="k">当前用户本地时间</span><span class="v">${esc(debugInfo.localIso)}</span></div>
    <div class="row"><span class="k">用于通知时段判断的小时</span><span class="v">${esc(debugInfo.currentHour)}</span></div>
    <div class="row"><span class="k">配置的通知小时（用户 TZ）</span><span class="v">${notificationHours.length === 0 ? '<em class="warn">空（默认全天发送）</em>' : `<code>${esc(notificationHours.join(', '))}</code>`}</span></div>
    <div class="row"><span class="k">现在是否允许发送</span><span class="v ${debugInfo.inNotificationWindow ? 'success' : 'warn'}">${debugInfo.inNotificationWindow ? '✓ 在窗口内' : '✗ 不在窗口内'}</span></div>
  </div>

  <div class="info">
    <h3>提示</h3>
    <p>1. 如果时区诊断中"当前小时"与你预期不符，请检查配置中的 <code>TIMEZONE</code> 是否与你所在地匹配。</p>
    <p>2. 本版本 <code>NOTIFICATION_HOURS</code> <strong>按你配置的时区</strong>解释（不再是 UTC）。例如想让北京时间 8 点收到通知，<code>TIMEZONE=Asia/Shanghai</code> 时填 <code>08</code>。</p>
    <p>3. 详细发送记录请前往后台"通知历史"页（后续版本提供）。</p>
    <p>4. <a href="/admin">返回管理后台</a></p>
    <p>5. <a href="/debug?export=sched_logs&limit=50">📥 导出最近 50 条调度执行日志（JSON）</a></p>
  </div>
</body>
</html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  } catch (error) {
    return new Response(`调试页面错误: ${error && error.message ? error.message : error}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

export { handleDebug };
