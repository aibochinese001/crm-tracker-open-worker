// @ts-check
/**
 * 时区核心模块单元测试
 *
 * 覆盖范围：
 * - getNowInTimezone：注入式时间 + 各时区分量
 * - getTimezoneHourString：调度器通知时段判断主路径
 * - getDaysBetween：跨零点 / 跨夏令时 / #166 场景
 * - getTimezoneMidnightTimestamp：用户 TZ 零点反推
 * - formatLocalDate：4 种格式
 * - 向后兼容 wrapper：getCurrentTimeInTimezone / convertUTCToTimezone
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MS_PER_DAY,
  MS_PER_HOUR,
  isValidTimezone,
  getTimezoneDateParts,
  getNowInTimezone,
  getTimezoneHourString,
  getDaysBetween,
  getTimezoneMidnightTimestamp,
  formatLocalDate,
  formatTimeInTimezone,
  formatBeijingTime,
  formatTimezoneDisplay,
  getTimezoneOffset,
  getCurrentTimeInTimezone,
  getTimestampInTimezone,
  convertUTCToTimezone,
  extractTimezone
} from '../../src/core/time.js';

describe('isValidTimezone', () => {
  it('合法 IANA 时区返回 true', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
  });

  it('非法字符串返回 false', () => {
    expect(isValidTimezone('FooBar/Baz')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(/** @type {any} */ (null))).toBe(false);
  });
});

describe('getTimezoneDateParts', () => {
  it('UTC 时区下 UTC 时刻分量正确', () => {
    const d = new Date('2026-05-24T03:30:45.000Z');
    expect(getTimezoneDateParts(d, 'UTC')).toEqual({
      year: 2026,
      month: 5,
      day: 24,
      hour: 3,
      minute: 30,
      second: 45
    });
  });

  it('Asia/Shanghai 比 UTC 快 8 小时（夏令时无影响）', () => {
    const d = new Date('2026-05-24T16:00:00.000Z'); // UTC 16:00 = 北京 24:00 = 5/25 00:00
    const parts = getTimezoneDateParts(d, 'Asia/Shanghai');
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(5);
    expect(parts.day).toBe(25);
    expect(parts.hour).toBe(0);
  });

  it('America/New_York 夏令时（5 月）差 4 小时', () => {
    const d = new Date('2026-05-24T16:00:00.000Z'); // UTC 16:00 = NYC 12:00 (DST)
    const parts = getTimezoneDateParts(d, 'America/New_York');
    expect(parts.day).toBe(24);
    expect(parts.hour).toBe(12);
  });

  it('America/New_York 冬令时（1 月）差 5 小时', () => {
    const d = new Date('2026-01-15T16:00:00.000Z'); // UTC 16:00 = NYC 11:00 (no DST)
    const parts = getTimezoneDateParts(d, 'America/New_York');
    expect(parts.day).toBe(15);
    expect(parts.hour).toBe(11);
  });

  it('非法时区回退 UTC 不抛异常', () => {
    const d = new Date('2026-05-24T03:30:45.000Z');
    const parts = getTimezoneDateParts(d, 'Foo/Bar');
    expect(parts.year).toBe(2026);
    expect(parts.hour).toBe(3); // 走兜底路径
  });
});

describe('getNowInTimezone（业务主入口）', () => {
  it('注入特定时刻：UTC 0 点 + Asia/Shanghai → 北京 8 点', () => {
    const fixed = new Date('2026-05-24T00:00:00.000Z');
    const now = getNowInTimezone('Asia/Shanghai', fixed);
    expect(now.utc.toISOString()).toBe('2026-05-24T00:00:00.000Z');
    expect(now.parts).toEqual({ year: 2026, month: 5, day: 24, hour: 8, minute: 0, second: 0 });
    expect(now.hourString).toBe('08');
    expect(now.isoLocal).toBe('2026-05-24T08:00:00');
    expect(now.timezone).toBe('Asia/Shanghai');
  });

  it('UTC 23:30 + Asia/Shanghai → 次日 07:30', () => {
    const fixed = new Date('2026-05-24T23:30:00.000Z');
    const now = getNowInTimezone('Asia/Shanghai', fixed);
    expect(now.parts.day).toBe(25);
    expect(now.hourString).toBe('07');
  });

  it('未注入时间时取 new Date()', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-31T16:00:00.000Z'));
    try {
      const now = getNowInTimezone('Asia/Shanghai');
      expect(now.parts.year).toBe(2027);
      expect(now.parts.month).toBe(1);
      expect(now.parts.day).toBe(1);
      expect(now.hourString).toBe('00');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getTimezoneHourString（调度器通知时段比对）', () => {
  it('始终返回两位字符串', () => {
    const d = new Date('2026-05-24T01:00:00.000Z');
    expect(getTimezoneHourString(d, 'UTC')).toBe('01');
    expect(getTimezoneHourString(d, 'Asia/Shanghai')).toBe('09');
  });

  it('00 / 23 边界', () => {
    expect(getTimezoneHourString(new Date('2026-05-24T00:00:00Z'), 'UTC')).toBe('00');
    expect(getTimezoneHourString(new Date('2026-05-24T23:00:00Z'), 'UTC')).toBe('23');
  });
});

describe('getTimezoneMidnightTimestamp', () => {
  it('UTC 时区下：等价 Date.UTC(y,m-1,d)', () => {
    const ts = getTimezoneMidnightTimestamp(new Date('2026-05-24T15:00:00Z'), 'UTC');
    expect(ts).toBe(Date.UTC(2026, 4, 24));
  });

  it('Asia/Shanghai：北京零点 = UTC 前一天 16:00', () => {
    const ts = getTimezoneMidnightTimestamp(new Date('2026-05-24T15:00:00Z'), 'Asia/Shanghai');
    expect(new Date(ts).toISOString()).toBe('2026-05-23T16:00:00.000Z');
  });

  it('Asia/Shanghai 跨 UTC 日界（UTC 18:00 → 北京次日 02:00 → 当日零点 = 当日 UTC 16:00）', () => {
    const ts = getTimezoneMidnightTimestamp(new Date('2026-05-24T18:00:00Z'), 'Asia/Shanghai');
    expect(new Date(ts).toISOString()).toBe('2026-05-24T16:00:00.000Z');
  });
});

describe('getDaysBetween（剩余天数计算 / #166 修复）', () => {
  it('同一 UTC 日的不同时刻 → 0 天', () => {
    expect(
      getDaysBetween('2026-05-24T01:00:00Z', '2026-05-24T23:59:00Z', 'UTC')
    ).toBe(0);
  });

  it('跨 UTC 日 → 1 天', () => {
    expect(
      getDaysBetween('2026-05-24T23:30:00Z', '2026-05-25T00:30:00Z', 'UTC')
    ).toBe(1);
  });

  it('Asia/Shanghai：UTC 17:00 与 UTC 23:00 同一北京日 → 0 天', () => {
    expect(
      getDaysBetween('2026-05-24T17:00:00Z', '2026-05-24T23:00:00Z', 'Asia/Shanghai')
    ).toBe(0);
  });

  it('Asia/Shanghai：UTC 15:00 与 UTC 17:00 跨北京日 → 1 天', () => {
    // UTC 15:00 = 北京 23:00 (5/24)
    // UTC 17:00 = 北京 01:00 (5/25)
    expect(
      getDaysBetween('2026-05-24T15:00:00Z', '2026-05-24T17:00:00Z', 'Asia/Shanghai')
    ).toBe(1);
  });

  it('#166 场景：UTC 凌晨 02:00（北京 10:00）创建订阅，期望"今天"是北京 5/24 而非 UTC 5/24', () => {
    // 用户在北京时间 2026-05-24 10:00 创建订阅，开始日期取"今日"
    // 此时 UTC 是 2026-05-24 02:00
    const utcNow = new Date('2026-05-24T02:00:00Z');
    const userTzNow = getNowInTimezone('Asia/Shanghai', utcNow);
    expect(userTzNow.parts.day).toBe(24);
    expect(userTzNow.parts.hour).toBe(10);

    // 选一个明显落在北京 5/27 中段的到期时刻（北京 5/27 14:00 = UTC 06:00）
    const expiry = new Date('2026-05-27T06:00:00Z');
    expect(getDaysBetween(utcNow, expiry, 'Asia/Shanghai')).toBe(3);
  });

  it('#166 边界场景：UTC 23:30（北京次日 07:30）创建订阅，"今日"应是次日北京日期', () => {
    const utcNow = new Date('2026-05-23T23:30:00Z');
    const userTzNow = getNowInTimezone('Asia/Shanghai', utcNow);
    expect(userTzNow.parts.day).toBe(24); // 北京 5/24
    expect(userTzNow.parts.hour).toBe(7);
  });

  it('to 早于 from 时返回负数', () => {
    expect(
      getDaysBetween('2026-05-25T00:00:00Z', '2026-05-23T00:00:00Z', 'UTC')
    ).toBe(-2);
  });
});

describe('formatLocalDate', () => {
  const utcInstant = '2026-05-24T03:30:45.000Z';

  it('format=date 返回本地日期', () => {
    const s = formatLocalDate(utcInstant, 'Asia/Shanghai', 'date');
    expect(s).toContain('2026');
    expect(s).toContain('05'); // 11:30 北京 5/24
  });

  it('format=datetime 包含时分秒', () => {
    const s = formatLocalDate(utcInstant, 'Asia/Shanghai', 'datetime');
    expect(s).toContain('11');
    expect(s).toContain('30');
  });

  it('format=isoLocal 返回 YYYY-MM-DDTHH:mm:ss 无时区后缀', () => {
    const s = formatLocalDate(utcInstant, 'Asia/Shanghai', 'isoLocal');
    expect(s).toBe('2026-05-24T11:30:45');
  });

  it('无效输入返回空串', () => {
    expect(formatLocalDate('not a date', 'UTC', 'date')).toBe('');
  });

  it('formatTimeInTimezone 与 formatLocalDate 等价（兼容老调用）', () => {
    expect(formatTimeInTimezone(utcInstant, 'UTC', 'isoLocal')).toBe('2026-05-24T03:30:45');
  });

  it('formatBeijingTime 走 Asia/Shanghai', () => {
    expect(formatBeijingTime(utcInstant, 'isoLocal')).toBe('2026-05-24T11:30:45');
  });
});

describe('getTimezoneOffset & formatTimezoneDisplay', () => {
  it('UTC 偏移 0', () => {
    expect(getTimezoneOffset('UTC')).toBe(0);
  });

  it('Asia/Shanghai 偏移 +8', () => {
    expect(getTimezoneOffset('Asia/Shanghai')).toBe(8);
  });

  it('formatTimezoneDisplay 包含中文名 + 偏移', () => {
    const s = formatTimezoneDisplay('Asia/Shanghai');
    expect(s).toContain('中国');
    expect(s).toContain('+8');
  });
});

describe('extractTimezone', () => {
  it('?timezone=Asia/Tokyo 优先级最高', () => {
    const req = new Request('https://x/?timezone=Asia/Tokyo', {
      headers: { 'X-Timezone': 'UTC', 'Accept-Language': 'en-US' }
    });
    expect(extractTimezone(req)).toBe('Asia/Tokyo');
  });

  it('Header X-Timezone 次之', () => {
    const req = new Request('https://x/', {
      headers: { 'X-Timezone': 'Asia/Tokyo', 'Accept-Language': 'en-US' }
    });
    expect(extractTimezone(req)).toBe('Asia/Tokyo');
  });

  it('Accept-Language zh → Asia/Shanghai', () => {
    const req = new Request('https://x/', { headers: { 'Accept-Language': 'zh-CN' } });
    expect(extractTimezone(req)).toBe('Asia/Shanghai');
  });

  it('无任何提示 → UTC', () => {
    expect(extractTimezone(new Request('https://x/'))).toBe('UTC');
  });

  it('非法 ?timezone 被忽略，回退到 Header / Accept-Language', () => {
    const req = new Request('https://x/?timezone=Foo/Bar', {
      headers: { 'Accept-Language': 'zh' }
    });
    expect(extractTimezone(req)).toBe('Asia/Shanghai');
  });
});

describe('向后兼容 wrapper', () => {
  it('getCurrentTimeInTimezone 返回 Date 实例（UTC 时刻）', () => {
    const d = getCurrentTimeInTimezone('Asia/Shanghai');
    expect(d).toBeInstanceOf(Date);
    expect(Math.abs(d.getTime() - Date.now())).toBeLessThan(1000);
  });

  it('getTimestampInTimezone 返回数字时间戳', () => {
    const t = getTimestampInTimezone('UTC');
    expect(typeof t).toBe('number');
    expect(Math.abs(t - Date.now())).toBeLessThan(1000);
  });

  it('convertUTCToTimezone 返回的 Date 与原始相同 UTC 时刻', () => {
    const orig = new Date('2026-05-24T03:30:00Z');
    const converted = convertUTCToTimezone(orig, 'Asia/Shanghai');
    expect(converted.getTime()).toBe(orig.getTime());
    expect(converted).not.toBe(orig); // 拷贝
  });
});

describe('常量', () => {
  it('MS_PER_HOUR 与 MS_PER_DAY', () => {
    expect(MS_PER_HOUR).toBe(3600_000);
    expect(MS_PER_DAY).toBe(86_400_000);
  });
});
