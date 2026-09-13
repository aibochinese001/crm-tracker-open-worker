// @ts-check
/**
 * 提醒规则触发引擎单元测试（表驱动）
 */
import { describe, it, expect } from 'vitest';
import { shouldFire } from '../../../src/services/notify/reminder-engine.js';

/**
 * @param {Partial<import('../../../src/data/reminders.repo.js').ReminderRule>} r
 */
function rule(r) {
  return {
    id: 'r1',
    type: 'before_expiry',
    value: 7,
    unit: 'days',
    repeatInterval: null,
    repeatUntil: 'renewed',
    isEnabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...r
  };
}

describe('shouldFire 通用', () => {
  it('isEnabled=false → 不触发', () => {
    const r = rule({ isEnabled: false });
    expect(shouldFire(r, { daysDiff: 7, hoursDiff: 168 }).fire).toBe(false);
  });

  it('未知 type → 不触发', () => {
    const r = rule({ type: /** @type {any} */ ('xxx') });
    expect(shouldFire(r, { daysDiff: 7, hoursDiff: 168 }).fire).toBe(false);
  });

  it('NaN diff → 不触发', () => {
    const r = rule({});
    expect(shouldFire(r, { daysDiff: NaN, hoursDiff: 0 }).fire).toBe(false);
  });
});

describe('before_expiry / days', () => {
  /** @type {Array<[number, number, boolean, string]>} */
  const cases = [
    [7, 7, true, '到期前 7 天命中 value=7'],
    [7, 8, false, '到期前 8 天不命中 value=7'],
    [7, 6, false, '到期前 6 天不命中 value=7'],
    [7, 0, false, '到期当天不命中 value=7（要 on_expiry 类型）'],
    [7, -1, false, '已过期 1 天不命中 before_expiry'],
    [3, 3, true, '到期前 3 天命中 value=3'],
    [1, 1, true, '到期前 1 天命中 value=1'],
    [0, 0, true, 'value=0 到期当天命中（等价 on_expiry）'],
    [0, 1, false, 'value=0 非到期日不命中']
  ];
  cases.forEach(([v, days, expected, desc]) => {
    it(desc, () => {
      const r = rule({ type: 'before_expiry', value: v, unit: 'days' });
      expect(shouldFire(r, { daysDiff: days, hoursDiff: days * 24 }).fire).toBe(expected);
    });
  });
});

describe('before_expiry / hours', () => {
  it('value=12, hoursDiff=12 → 命中', () => {
    const r = rule({ type: 'before_expiry', value: 12, unit: 'hours' });
    expect(shouldFire(r, { daysDiff: 0, hoursDiff: 12 }).fire).toBe(true);
  });

  it('value=12, hoursDiff=11 → 不命中（精确匹配）', () => {
    const r = rule({ type: 'before_expiry', value: 12, unit: 'hours' });
    expect(shouldFire(r, { daysDiff: 0, hoursDiff: 11 }).fire).toBe(false);
  });

  it('value=0 hours, 0<=hoursDiff<1 → 命中', () => {
    const r = rule({ type: 'before_expiry', value: 0, unit: 'hours' });
    expect(shouldFire(r, { daysDiff: 0, hoursDiff: 0.5 }).fire).toBe(true);
    expect(shouldFire(r, { daysDiff: 0, hoursDiff: 0 }).fire).toBe(true);
    expect(shouldFire(r, { daysDiff: 0, hoursDiff: 1 }).fire).toBe(false);
  });

  it('hoursDiff=-1（已过期）→ 不命中', () => {
    const r = rule({ type: 'before_expiry', value: 12, unit: 'hours' });
    expect(shouldFire(r, { daysDiff: 0, hoursDiff: -1 }).fire).toBe(false);
  });
});

describe('on_expiry', () => {
  it('daysDiff=0 → 命中', () => {
    const r = rule({ type: 'on_expiry', value: 0, unit: 'days' });
    expect(shouldFire(r, { daysDiff: 0, hoursDiff: 1 }).fire).toBe(true);
  });

  it('daysDiff=1 → 不命中', () => {
    const r = rule({ type: 'on_expiry', value: 0, unit: 'days' });
    expect(shouldFire(r, { daysDiff: 1, hoursDiff: 24 }).fire).toBe(false);
  });

  it('daysDiff=-1（昨天到期）→ 不命中', () => {
    const r = rule({ type: 'on_expiry', value: 0, unit: 'days' });
    expect(shouldFire(r, { daysDiff: -1, hoursDiff: -24 }).fire).toBe(false);
  });
});

describe('after_expiry', () => {
  it('未到期（daysDiff>=0）→ 不命中', () => {
    const r = rule({ type: 'after_expiry', value: 0, unit: 'days', repeatInterval: 24 });
    expect(shouldFire(r, { daysDiff: 0, hoursDiff: 1 }).fire).toBe(false);
    expect(shouldFire(r, { daysDiff: 7, hoursDiff: 168 }).fire).toBe(false);
  });

  it('已过期 + 没有 lastFireAt → 首次触发', () => {
    const r = rule({ type: 'after_expiry', value: 0, unit: 'days', repeatInterval: 24 });
    expect(shouldFire(r, { daysDiff: -1, hoursDiff: -24 }).fire).toBe(true);
  });

  it('已过期 + lastFireAt 在 interval 内 → 不重复触发', () => {
    const r = rule({ type: 'after_expiry', value: 0, unit: 'days', repeatInterval: 24 });
    const result = shouldFire(r, {
      daysDiff: -2,
      hoursDiff: -48,
      lastFireAtIso: '2026-05-24T10:00:00Z',
      nowIso: '2026-05-24T18:00:00Z' // 8h 后，未到 24h
    });
    expect(result.fire).toBe(false);
  });

  it('已过期 + lastFireAt 超过 interval → 重新触发', () => {
    const r = rule({ type: 'after_expiry', value: 0, unit: 'days', repeatInterval: 24 });
    const result = shouldFire(r, {
      daysDiff: -2,
      hoursDiff: -48,
      lastFireAtIso: '2026-05-23T10:00:00Z',
      nowIso: '2026-05-24T18:00:00Z' // 32h 后
    });
    expect(result.fire).toBe(true);
  });

  it('未指定 repeatInterval → 默认 24h', () => {
    const r = rule({ type: 'after_expiry', value: 0, unit: 'days', repeatInterval: null });
    const result = shouldFire(r, {
      daysDiff: -2,
      hoursDiff: -48,
      lastFireAtIso: '2026-05-24T10:00:00Z',
      nowIso: '2026-05-24T20:00:00Z' // 10h 后，未到 24h
    });
    expect(result.fire).toBe(false);
  });
});
