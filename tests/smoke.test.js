// @ts-check
/**
 * Smoke 测试 —— 仅验证测试基础设施本身能跑起来，不耦合业务代码。
 *
 * 后续 Task 会替换/扩展这里的内容；现在保持最简单：
 *   - 能 import vitest API
 *   - 能 import Cloudflare Workers env
 *   - 能跑一个 Hono 实例
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

describe('smoke', () => {
  it('vitest 跑得起来', () => {
    expect(1 + 1).toBe(2);
  });

  it('Hono 可以实例化并响应请求', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text('ok'));

    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
