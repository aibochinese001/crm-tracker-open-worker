// @ts-check
/**
 * 时区核心模块
 *
 * ── 设计原则 ────────────────────────────────────────────────
 * 1. 数据存储层：所有日期一律 ISO 8601 UTC 字符串（如 "2026-05-24T17:30:00.000Z"）
 * 2. 业务逻辑层：判断"通知时段""剩余天数"前先把 UTC 时刻转到用户配置的时区下取
 *    年/月/日/时；本模块是这层的"唯一真相源"
 * 3. 展示层：所有面向用户的日期显示都走 formatLocalDate / formatTimezoneDisplay
 *
 * ── 关键设计 ────────────────────────────────────────────
 * - 旧 getCurrentTimeInTimezone() 只 `return new Date()`，把"当前 UTC 时刻"
 *   伪装成"用户本地时间"对象返回；调用方把它当作时区相关 Date 用，导致
 *   严重误用（#52 / #91 / #166）。本版本改为：
 *   - 保留 getCurrentTimeInTimezone(tz) 作为兼容 wrapper（返回原生 Date 即 UTC 时刻）
 *   - 新增 getNowInTimezone(tz) 返回结构体 {utc, parts, hourString, isoLocal}
 *     强制调用方显式选择"我要的是 UTC 时刻"还是"用户 TZ 下的字段"
 * - 新增 getDaysBetween(fromIso, toIso, tz) 基于"用户 TZ 各自零点"算整天数差，
 *   修复"凌晨 0–8 点创建客户默认日期变前一天"的 #166
 * - 所有公开函数 JSDoc 标注 + 中文用途说明，从此可被 // @ts-check 守护
 *
 */

/** 一小时的毫秒数 */
export const MS_PER_HOUR = 1000 * 60 * 60;
/** 一天的毫秒数 */
export const MS_PER_DAY = MS_PER_HOUR * 24;

/**
 * @typedef {Object} TimezoneDateParts 时区下的日期分量
 * @property {number} year 年（4 位整数）
 * @property {number} month 月（1-12）
 * @property {number} day 日（1-31）
 * @property {number} hour 时（0-23）
 * @property {number} minute 分（0-59）
 * @property {number} second 秒（0-59）
 */

/**
 * @typedef {Object} TimezoneNow 当前时刻在某时区下的完整快照
 * @property {Date} utc 原生 Date（UTC 时刻，等价于 new Date()）
 * @property {TimezoneDateParts} parts 该时刻在 timezone 下的年月日时分秒
 * @property {string} hourString parts.hour 的两位字符串（如 "08"），调度器对比通知时段直接用它
 * @property {string} isoLocal "YYYY-MM-DDTHH:mm:ss" 本地表示（不带时区后缀，用于展示）
 * @property {string} timezone 实际生效的时区（无效时回退 'UTC'）
 */

/**
 * 判断字符串是否为 IANA 合法时区。
 *
 * @param {string} timezone
 * @returns {boolean}
 */
export function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || timezone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * 兜底获取一个安全可用的时区字符串。
 *
 * @param {string=} timezone 用户传入的时区
 * @returns {string} 合法 IANA 时区，非法时返回 'UTC'
 */
function safeTimezone(timezone) {
  if (timezone && isValidTimezone(timezone)) return timezone;
  return 'UTC';
}

/**
 * 将一个 Date / ISO 字符串 / 时间戳分解为目标时区下的年月日时分秒。
 *
 * 内部用 Intl.DateTimeFormat（en-US 12h=false）解析，无 DST/夏令时手算坑。
 *
 * @param {Date | string | number} date
 * @param {string} [timezone='UTC']
 * @returns {TimezoneDateParts}
 */
export function getTimezoneDateParts(date, timezone = 'UTC') {
  const tz = safeTimezone(timezone);
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    // 无效输入，返回当前时间作为兜底
    return getTimezoneDateParts(new Date(), tz);
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const parts = formatter.formatToParts(d);
    const pick = (type) => {
      const part = parts.find((item) => item.type === type);
      return part ? Number(part.value) : 0;
    };
    let hour = pick('hour');
    // Intl 在某些 runtime 把 24 显示为 0/24 不一致，归一化到 0–23
    if (hour === 24) hour = 0;
    return {
      year: pick('year'),
      month: pick('month'),
      day: pick('day'),
      hour,
      minute: pick('minute'),
      second: pick('second')
    };
  } catch {
    // 极少数 runtime 不支持该时区，回退 UTC
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds()
    };
  }
}

/**
 * 获取"当前时刻"在指定时区下的完整快照。
 *
 * 业务代码请优先使用本函数而非 `getCurrentTimeInTimezone`，
 * 因为本函数明确告诉你：
 * - utc：UTC 原生 Date（用于持久化、计算时间差）
 * - parts.hour：你设置的时区下的当前小时（用于通知时段判断）
 * - hourString：直接拿来和 NOTIFICATION_HOURS 字符串数组比较
 *
 * @param {string} [timezone='UTC']
 * @param {Date} [now] 可选注入当前时间（测试用）
 * @returns {TimezoneNow}
 */
export function getNowInTimezone(timezone = 'UTC', now) {
  const tz = safeTimezone(timezone);
  const utc = now instanceof Date ? new Date(utcMillis(now)) : new Date();
  const parts = getTimezoneDateParts(utc, tz);
  const hourString = String(parts.hour).padStart(2, '0');
  const isoLocal = formatPartsAsIsoLocal(parts);
  return { utc, parts, hourString, isoLocal, timezone: tz };
}

/**
 * 获取指定时刻在某时区下的小时（两位字符串）。
 *
 * 调度器判断"现在是不是允许发送通知的小时"专用。
 *
 * @param {Date | string | number} [date]
 * @param {string} [timezone='UTC']
 * @returns {string} "00" – "23"
 */
export function getTimezoneHourString(date, timezone = 'UTC') {
  const d = date == null ? new Date() : date;
  const parts = getTimezoneDateParts(d, timezone);
  return String(parts.hour).padStart(2, '0');
}

/**
 * 计算 from → to 在指定时区下"跨过几个本地零点"的整天数。
 *
 * 例：
 *   from = "2026-05-24T16:00:00Z"  to = "2026-05-25T16:00:00Z"  tz=UTC
 *   → 1 天
 *
 *   from = "2026-05-24T16:00:00Z"  to = "2026-05-25T16:00:00Z"  tz=Asia/Shanghai
 *   → 1 天（本地 24:00 → 次日 00:00）
 *
 *   from = "2026-05-24T20:00:00Z"  to = "2026-05-24T22:00:00Z"  tz=Asia/Shanghai
 *   → 0 天（本地 04:00 → 06:00 同一天）
 *
 * 当 to < from 时返回负数。
 *
 * @param {Date | string | number} from
 * @param {Date | string | number} to
 * @param {string} [timezone='UTC']
 * @returns {number}
 */
export function getDaysBetween(from, to, timezone = 'UTC') {
  const tz = safeTimezone(timezone);
  const fromMid = getTimezoneMidnightTimestamp(from, tz);
  const toMid = getTimezoneMidnightTimestamp(to, tz);
  return Math.round((toMid - fromMid) / MS_PER_DAY);
}

/**
 * 计算指定时刻在某时区下的"零点"对应的 UTC 时间戳。
 *
 * 例：date=2026-05-24T15:30:00Z, tz=Asia/Shanghai → 2026-05-24 23:30 北京时间
 *     → 该日北京零点 = 2026-05-24T16:00:00Z (因为北京 00:00 = UTC 前一天 16:00)
 *     → 返回 1748015200000
 *
 * @param {Date | string | number} date
 * @param {string} [timezone='UTC']
 * @returns {number} UTC ms 时间戳
 */
export function getTimezoneMidnightTimestamp(date, timezone = 'UTC') {
  const tz = safeTimezone(timezone);
  const { year, month, day } = getTimezoneDateParts(date, tz);
  // 通过反推：tz 下 (year,month,day) 0:00 对应的 UTC 时刻
  // 算法：构造一个临时 UTC 时刻 t0 = Date.UTC(y,m-1,d), 求它在 tz 下的偏移分钟数 offsetMin,
  //      则 tz 下零点的 UTC ms = t0 - offsetMin*60_000
  const t0 = Date.UTC(year, month - 1, day, 0, 0, 0);
  const probeParts = getTimezoneDateParts(new Date(t0), tz);
  const probeAsUtc = Date.UTC(
    probeParts.year,
    probeParts.month - 1,
    probeParts.day,
    probeParts.hour,
    probeParts.minute,
    probeParts.second
  );
  const offsetMs = probeAsUtc - t0;
  return t0 - offsetMs;
}

/**
 * 把日期分量拼成 "YYYY-MM-DDTHH:mm:ss" 本地表示。
 *
 * @param {TimezoneDateParts} parts
 * @returns {string}
 */
function formatPartsAsIsoLocal(parts) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

/**
 * 把日期分量拼成 "YYYY-MM-DD"。
 *
 * @param {{ year: number, month: number, day: number }} parts
 * @returns {string}
 */
function formatPartsAsDateOnly(parts) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * 把 Date 转成 UTC ms 整数（兼容 Date 与时间戳）。
 *
 * @param {Date | number} d
 * @returns {number}
 */
function utcMillis(d) {
  return d instanceof Date ? d.getTime() : Number(d);
}

/**
 * 根据目标时区下的本地日期分量，反推对应的 UTC 时间戳。
 *
 * @param {{ year: number, month: number, day: number, hour?: number, minute?: number, second?: number }} parts
 * @param {string} [timezone='UTC']
 * @returns {number}
 */
export function getTimestampForTimezoneParts(parts, timezone = 'UTC') {
  const tz = safeTimezone(timezone);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour || 0);
  const minute = Number(parts.minute || 0);
  const second = Number(parts.second || 0);

  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    Number.isNaN(probe.getTime()) ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    return Number.NaN;
  }

  const t0 = probe.getTime();
  const probeParts = getTimezoneDateParts(probe, tz);
  const probeAsUtc = Date.UTC(
    probeParts.year,
    probeParts.month - 1,
    probeParts.day,
    probeParts.hour,
    probeParts.minute,
    probeParts.second
  );
  const offsetMs = probeAsUtc - t0;
  return t0 - offsetMs;
}

/**
 * 以指定时区的本地零点解释 "YYYY-MM-DD" 日期输入。
 *
 * 若输入是完整 ISO / 时间戳，则保持其绝对时刻语义直接解析。
 *
 * @param {Date | string | number} value
 * @param {string} [timezone='UTC']
 * @returns {Date}
 */
export function parseDateInputInTimezone(value, timezone = 'UTC') {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      const ts = getTimestampForTimezoneParts(
        {
          year: Number(match[1]),
          month: Number(match[2]),
          day: Number(match[3]),
          hour: 0,
          minute: 0,
          second: 0
        },
        timezone
      );
      return new Date(ts);
    }
  }
  return new Date(value);
}

/**
 * 把某个时刻格式化为指定时区下的日期输入值 "YYYY-MM-DD"。
 *
 * @param {Date | string | number} value
 * @param {string} [timezone='UTC']
 * @returns {string}
 */
export function formatDateInputInTimezone(value, timezone = 'UTC') {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return formatPartsAsDateOnly(getTimezoneDateParts(d, timezone));
}

/**
 * 获取指定时区下"今天"的 YYYY-MM-DD。
 *
 * @param {string} [timezone='UTC']
 * @param {Date} [now]
 * @returns {string}
 */
export function getTodayDateStringInTimezone(timezone = 'UTC', now) {
  const current = getNowInTimezone(timezone, now);
  return formatPartsAsDateOnly(current.parts);
}

/**
 * 在指定时区的本地日期语义下增加日/月/年周期，并返回新时刻（本地零点）。
 *
 * @param {Date | string | number} value
 * @param {number} amount
 * @param {'day'|'month'|'year'} unit
 * @param {string} [timezone='UTC']
 * @param {{ endOfMonth?: boolean }} [options] endOfMonth=true 时（仅公历 month）落到目标月最后一天
 * @returns {Date}
 */
export function addCalendarPeriodInTimezone(value, amount, unit, timezone = 'UTC', options = {}) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return new Date(Number.NaN);

  const parts = getTimezoneDateParts(d, timezone);
  let year = parts.year;
  let month = parts.month;
  let day = parts.day;

  if (unit === 'day') {
    const temp = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
    temp.setUTCDate(temp.getUTCDate() + amount);
    year = temp.getUTCFullYear();
    month = temp.getUTCMonth() + 1;
    day = temp.getUTCDate();
  } else if (unit === 'month') {
    // 先移到目标月，再用 day=0 取月末，或保留原日（JS overflow 行为）
    const targetMonthIndex = month - 1 + amount;
    if (options && options.endOfMonth) {
      // 目标月最后一天：下月的第 0 天
      const last = new Date(Date.UTC(year, targetMonthIndex + 1, 0));
      year = last.getUTCFullYear();
      month = last.getUTCMonth() + 1;
      day = last.getUTCDate();
    } else {
      const temp = new Date(Date.UTC(year, targetMonthIndex, day, 0, 0, 0));
      // 若溢出到下月（如 1/31 + 1 月），钳制到目标月最后一天更符合「同号续费」预期
      // 这里保持与历史 JS setUTCMonth 一致：允许溢出，避免改变既有用户行为
      year = temp.getUTCFullYear();
      month = temp.getUTCMonth() + 1;
      day = temp.getUTCDate();
    }
  } else if (unit === 'year') {
    if (options && options.endOfMonth && month === 2 && day >= 28) {
      // 年末月场景少见；仍按年推进后取该月最后一天
      const last = new Date(Date.UTC(year + amount, month, 0));
      year = last.getUTCFullYear();
      month = last.getUTCMonth() + 1;
      day = last.getUTCDate();
    } else {
      const temp = new Date(Date.UTC(year + amount, month - 1, day, 0, 0, 0));
      year = temp.getUTCFullYear();
      month = temp.getUTCMonth() + 1;
      day = temp.getUTCDate();
    }
  }

  const ts = getTimestampForTimezoneParts(
    {
      year,
      month,
      day,
      hour: 0,
      minute: 0,
      second: 0
    },
    timezone
  );
  return new Date(ts);
}

/**
 * 在指定时区下格式化日期。
 *
 * 不同 fmt 用于：
 * - 'date'      → "2026/05/24"
 * - 'datetime'  → "2026/05/24 17:30:00"
 * - 'full'（默认）→ 带星期等本地化完整字符串
 * - 'isoLocal'  → "2026-05-24T17:30:00"（无时区后缀）
 *
 * @param {Date | string | number} time
 * @param {string} [timezone='UTC']
 * @param {'date'|'datetime'|'full'|'isoLocal'} [format='full']
 * @returns {string}
 */
export function formatLocalDate(time, timezone = 'UTC', format = 'full') {
  const tz = safeTimezone(timezone);
  const d = time instanceof Date ? time : new Date(time);
  if (Number.isNaN(d.getTime())) return '';

  if (format === 'isoLocal') {
    return formatPartsAsIsoLocal(getTimezoneDateParts(d, tz));
  }

  try {
    if (format === 'date') {
      return d.toLocaleDateString('zh-CN', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
    }
    if (format === 'datetime') {
      return d.toLocaleString('zh-CN', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    }
    return d.toLocaleString('zh-CN', { timeZone: tz });
  } catch {
    return d.toISOString();
  }
}

/**
 * 同 formatLocalDate，保留原命名以兼容老调用方。
 *
 * @param {Date | string | number} time
 * @param {string} [timezone='UTC']
 * @param {'date'|'datetime'|'full'|'isoLocal'} [format='full']
 * @returns {string}
 */
export function formatTimeInTimezone(time, timezone = 'UTC', format = 'full') {
  return formatLocalDate(time, timezone, format);
}

/**
 * 计算时区相对 UTC 的整小时偏移量（夏令时下取当前时刻偏移）。
 *
 * @param {string} [timezone='UTC']
 * @returns {number} 偏移小时数（如 +8 表示 UTC+8）
 */
export function getTimezoneOffset(timezone = 'UTC') {
  const tz = safeTimezone(timezone);
  try {
    const now = new Date();
    const parts = getTimezoneDateParts(now, tz);
    const zoned = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    // 用 `+ 0` 归一化 -0 为 +0，避免 Object.is 比较时困扰
    return Math.round((zoned - now.getTime()) / MS_PER_HOUR) + 0;
  } catch {
    return 0;
  }
}

/**
 * 生成时区显示文本。
 *
 * 例：formatTimezoneDisplay('Asia/Shanghai') → "中国标准时间 (UTC+8)"
 *
 * @param {string} [timezone='UTC']
 * @returns {string}
 */
export function formatTimezoneDisplay(timezone = 'UTC') {
  const tz = safeTimezone(timezone);
  try {
    const offset = getTimezoneOffset(tz);
    const offsetStr = offset >= 0 ? `+${offset}` : `${offset}`;
    const names = {
      UTC: '世界标准时间',
      'Asia/Shanghai': '中国标准时间',
      'Asia/Hong_Kong': '香港时间',
      'Asia/Taipei': '台北时间',
      'Asia/Singapore': '新加坡时间',
      'Asia/Tokyo': '日本时间',
      'Asia/Seoul': '韩国时间',
      'America/New_York': '美国东部时间',
      'America/Los_Angeles': '美国太平洋时间',
      'America/Chicago': '美国中部时间',
      'America/Denver': '美国山地时间',
      'Europe/London': '英国时间',
      'Europe/Paris': '巴黎时间',
      'Europe/Berlin': '柏林时间',
      'Europe/Moscow': '莫斯科时间',
      'Australia/Sydney': '悉尼时间',
      'Australia/Melbourne': '墨尔本时间',
      'Pacific/Auckland': '奥克兰时间'
    };
    const cn = names[tz] || tz;
    return `${cn} (UTC${offsetStr})`;
  } catch {
    return tz;
  }
}

/**
 * 北京时间快捷格式化函数。
 *
 * @param {Date | string | number} [date=new Date()]
 * @param {'date'|'datetime'|'full'|'isoLocal'} [format='full']
 * @returns {string}
 */
export function formatBeijingTime(date = new Date(), format = 'full') {
  return formatLocalDate(date, 'Asia/Shanghai', format);
}

/**
 * 从请求中推断时区：query > Header > Accept-Language。
 *
 * 注意：本版本前端展示用的是 config.TIMEZONE（用户配置的时区），
 * 此函数主要用于 API 兼容场景。
 *
 * @param {Request} request
 * @returns {string}
 */
export function extractTimezone(request) {
  try {
    const url = new URL(request.url);
    const tzParam = url.searchParams.get('timezone');
    if (tzParam && isValidTimezone(tzParam)) return tzParam;

    const tzHeader = request.headers.get('X-Timezone');
    if (tzHeader && isValidTimezone(tzHeader)) return tzHeader;

    const accept = request.headers.get('Accept-Language') || '';
    if (accept.includes('zh')) return 'Asia/Shanghai';
    if (accept.includes('en-US')) return 'America/New_York';
    if (accept.includes('en-GB')) return 'Europe/London';
  } catch {
    /* noop */
  }
  return 'UTC';
}

// ─────────────────────────────────────────────────────────────
// 兼容层（仅供旧调用方使用，新代码请用上面的 getNowInTimezone）
// ─────────────────────────────────────────────────────────────

/**
 * 兼容老调用：返回当前 UTC 时刻的 Date。
 *
 * 老 API 名字误导（"InTimezone"），但语义就是"当前时刻"。
 * 后续 Task 会把所有调用方迁移到 getNowInTimezone。
 *
 * @param {string} [timezone='UTC']
 * @returns {Date}
 */
export function getCurrentTimeInTimezone(timezone = 'UTC') {
  void timezone; // 仅占位保持签名；Date 本身就是 UTC 时刻
  return new Date();
}

/**
 * 兼容老调用：返回当前 UTC ms 时间戳。
 *
 * @param {string} [timezone='UTC']
 * @returns {number}
 */
export function getTimestampInTimezone(timezone = 'UTC') {
  void timezone;
  return Date.now();
}

/**
 * 兼容老调用：把 UTC 时刻"转换到"目标时区。
 *
 * 注意：这是个语义陷阱——Date 本身永远是 UTC 时刻（绝对时刻），
 * "转到"另一个时区只影响显示，不影响 Date 实例。本函数仅返回原 Date 拷贝。
 *
 * @param {Date | string | number} utcTime
 * @param {string} [timezone='UTC']
 * @returns {Date}
 */
export function convertUTCToTimezone(utcTime, timezone = 'UTC') {
  void timezone;
  return utcTime instanceof Date ? new Date(utcTime.getTime()) : new Date(utcTime);
}
