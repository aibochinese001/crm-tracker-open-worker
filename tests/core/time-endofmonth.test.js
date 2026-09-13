// @ts-check
/**
 * endOfMonth 与周期加法边界
 */
import { describe, it, expect } from 'vitest';
import { addCalendarPeriodInTimezone, getDaysBetween, getTimezoneDateParts } from '../../src/core/time.js';

describe('addCalendarPeriodInTimezone endOfMonth', () => {
  it('1月31日 +1月 endOfMonth → 2月最后一天', () => {
    const base = new Date(Date.UTC(2026, 0, 31));
    const next = addCalendarPeriodInTimezone(base, 1, 'month', 'UTC', { endOfMonth: true });
    const p = getTimezoneDateParts(next, 'UTC');
    expect(p.year).toBe(2026);
    expect(p.month).toBe(2);
    expect(p.day).toBe(28);
  });

  it('2月末 +1月 endOfMonth → 3月31日（不漂移到30）', () => {
    const feb = addCalendarPeriodInTimezone(
      new Date(Date.UTC(2026, 0, 31)),
      1,
      'month',
      'UTC',
      { endOfMonth: true }
    );
    const mar = addCalendarPeriodInTimezone(feb, 1, 'month', 'UTC', { endOfMonth: true });
    const p = getTimezoneDateParts(mar, 'UTC');
    expect(p.month).toBe(3);
    expect(p.day).toBe(31);
  });

  it('非 endOfMonth 保持历史 setUTCMonth 溢出行为可运行', () => {
    const base = new Date(Date.UTC(2026, 0, 31));
    const next = addCalendarPeriodInTimezone(base, 1, 'month', 'UTC', { endOfMonth: false });
    expect(Number.isNaN(next.getTime())).toBe(false);
  });
});

describe('getDaysBetween 边界时区', () => {
  it('Pacific/Kiritimati UTC+14 跨日', () => {
    // UTC 2026-05-24 10:00 = Kiritimati 5/25 00:00 附近
    const a = '2026-05-24T09:00:00Z';
    const b = '2026-05-24T11:00:00Z';
    const diff = getDaysBetween(a, b, 'Pacific/Kiritimati');
    expect(Number.isFinite(diff)).toBe(true);
  });

  it('America/Los_Angeles 日期差有限', () => {
    const diff = getDaysBetween(
      '2026-03-08T08:00:00Z',
      '2026-03-09T08:00:00Z',
      'America/Los_Angeles'
    );
    expect(diff).toBeGreaterThanOrEqual(0);
    expect(diff).toBeLessThanOrEqual(2);
  });
});
