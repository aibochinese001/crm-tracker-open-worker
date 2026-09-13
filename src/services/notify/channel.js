// @ts-check
/**
 * 通知渠道统一适配器协议
 *
 * 所有渠道实现均遵循此 shape：
 *
 *   export const xxxChannel = {
 *     name: 'xxx',                        // 渠道名（必须与 ENABLED_NOTIFIERS / 配置 key 保持一致）
 *     validateConfig(config) { ... },     // 返回 { ok: true } 或 { ok: false, error: '...' }
 *     async send(payload, config) { ... },// 实际发送
 *     async test(config) { ... }          // 用配置发送一条测试通知
 *   };
 *
 * 这样 dispatch / 通知日志 / 配置页测试按钮可以用同一份代码处理 9 种渠道。
 *
 */

/**
 * @typedef {Object} ChannelPayload 通知内容载荷
 * @property {string} title 标题
 * @property {string} content 正文（Markdown 风格，由各渠道按需转换）
 * @property {Object} [metadata] 元数据（tags、subscriptionId 等）
 */

/**
 * @typedef {Object} ChannelResult 渠道发送结果
 * @property {boolean} success 是否成功
 * @property {string} channel 渠道名
 * @property {string} [error] 失败原因（HTTP 错误、API 拒绝等）
 * @property {any} [raw] 三方接口原始返回，便于排查
 */

/**
 * @typedef {Object} ValidateResult
 * @property {boolean} ok
 * @property {string} [error]
 */

/**
 * @typedef {Object} Channel
 * @property {string} name
 * @property {(config: any) => ValidateResult} validateConfig
 * @property {(payload: ChannelPayload, config: any) => Promise<ChannelResult>} send
 * @property {(config: any) => Promise<ChannelResult>} test
 */

/**
 * Telegram MarkdownV2 转义。
 *
 * 修复 #81：客户名包含 `_*[]()~`>#+-=|{}.!\\` 时 Telegram 会拒绝消息。
 * 注意：这个函数只用于发往 Telegram 的内容，不要污染其他渠道。
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeMarkdownV2(text = '') {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * 把 commonContent 中的 Markdown 标记移除（用于纯文本渠道）。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdown(text = '') {
  return String(text).replace(/(\*\*|\*|##|#|`)/g, '');
}

/**
 * 构造统一的成功结果。
 *
 * @param {string} name
 * @param {any} [raw]
 * @returns {ChannelResult}
 */
export function ok(name, raw) {
  return { success: true, channel: name, raw };
}

/**
 * 构造统一的失败结果。
 *
 * @param {string} name
 * @param {string} error
 * @param {any} [raw]
 * @returns {ChannelResult}
 */
export function fail(name, error, raw) {
  return { success: false, channel: name, error, raw };
}

/**
 * 把任意 error 转字符串（兼容 fetch 抛出的 TypeError、Response 等）。
 *
 * @param {any} err
 * @returns {string}
 */
export function errorMessage(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
