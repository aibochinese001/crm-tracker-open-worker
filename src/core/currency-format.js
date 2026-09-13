// @ts-check
/**
 * 货币格式化共享工具
 *
 * 早期版本曾在不同代码路径（添加表单 / 列表 / 通知正文 / 历史 / 第三方触发）
 * 中重复定义了 currencySymbols，且偶尔默认回退 ¥（CNY 符号）造成币种与展示不一致。
 *
 * 统一使用本模块：
 *   formatAmount(123.45, 'USD')   → '$123.45'
 *   formatAmount(123.45, 'JPY')   → 'JP¥123.45'   （JPY 与 CNY 同符号但加前缀以避免歧义）
 *   formatAmount(null, 'USD')     → ''
 *
 */

/**
 * 币种 → 符号（前缀）映射。
 * JPY 故意使用 'JP¥' 前缀以避免与 CNY 的 ¥ 混淆。
 */
export const CURRENCY_SYMBOLS = {
  CNY: '¥',
  USD: '$',
  HKD: 'HK$',
  TWD: 'NT$',
  JPY: 'JP¥',
  EUR: '€',
  GBP: '£',
  KRW: '₩',
  TRY: '₺'
};

/**
 * 取币种符号，未知币种回退到币种代码本身。
 *
 * @param {string} [currency='CNY']
 * @returns {string}
 */
export function getCurrencySymbol(currency = 'CNY') {
  const code = String(currency || 'CNY').toUpperCase();
  return CURRENCY_SYMBOLS[code] || code + ' ';
}

/**
 * 格式化金额字符串，amount 为空时返回空串。
 *
 * @param {number|string|null|undefined} amount
 * @param {string} [currency='CNY']
 * @param {{ withDecimal?: boolean }} [opts]
 * @returns {string}
 */
export function formatAmount(amount, currency = 'CNY', opts = {}) {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = Number(amount);
  if (Number.isNaN(n)) return '';
  const sym = getCurrencySymbol(currency);
  const fixed = opts.withDecimal === false ? String(Math.round(n)) : n.toFixed(2);
  return sym + fixed;
}
