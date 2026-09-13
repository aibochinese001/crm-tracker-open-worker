// @ts-check
/**
 * auth + currency 边界
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import { generateJWT, verifyJWT } from '../../src/core/auth.js';
import { convertToCNY, getDynamicRates } from '../../src/core/currency.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(clearKv);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('convertToCNY', () => {
  const rates = { CNY: 1, USD: 7, EUR: 8 };

  it('CNY 原样', () => {
    expect(convertToCNY(10, 'CNY', rates)).toBe(10);
  });

  it('USD 用 rate 换算 amount/rate', () => {
    expect(convertToCNY(14, 'USD', rates)).toBe(2);
  });

  it('未知币种不抛错，返回原金额', () => {
    expect(convertToCNY(5, 'XYZ', rates)).toBe(5);
  });

  it('非正金额返回 0', () => {
    expect(convertToCNY(0, 'USD', rates)).toBe(0);
    expect(convertToCNY(-1, 'USD', rates)).toBe(0);
  });
});

describe('getDynamicRates', () => {
  it('API 失败时返回 FALLBACK', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }));
    const rates = await getDynamicRates(env);
    expect(rates.CNY).toBe(1);
    expect(rates.USD).toBeTruthy();
  });

  it('API 成功时合并并缓存', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ rates: { USD: 7.1, EUR: 8.2 } })
    }));
    const rates = await getDynamicRates(env);
    expect(rates.USD).toBe(7.1);
    // 第二次应走缓存，不再 fetch
    let called = 0;
    vi.stubGlobal('fetch', async () => {
      called++;
      return { ok: true, json: async () => ({ rates: { USD: 1 } }) };
    });
    const rates2 = await getDynamicRates(env);
    expect(called).toBe(0);
    expect(rates2.USD).toBe(7.1);
  });
});

describe('JWT 边界', () => {
  it('空 token/secret → null', async () => {
    expect(await verifyJWT('', 's')).toBeNull();
    expect(await verifyJWT('a.b.c', '')).toBeNull();
  });

  it('格式错误 → null', async () => {
    expect(await verifyJWT('not-a-jwt', 's')).toBeNull();
  });
});
