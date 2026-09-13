// @ts-check
/**
 * Vitest 配置文件
 *
 * 用 @cloudflare/vitest-pool-workers 把单测跑在真实的 workerd 运行时里，
 * 这样 KV / fetch / crypto.subtle 等 Cloudflare 平台 API 不需要 mock 即可工作。
 *
 * 用法：
 *   npm test          # 跑一次（CI）
 *   npm run test:watch # watch 模式
 */
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  // 让 vite 把 .html 当作文本字符串 import（与 wrangler 生产环境的 text loader 行为一致）
  assetsInclude: ['**/*.html'],
  test: {
    include: ['tests/**/*.test.js'],
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: '2024-09-23',
          compatibilityFlags: ['nodejs_compat'],
          kvNamespaces: ['SUBSCRIPTIONS_KV'],
          // D1 本地模拟（schema 由 db.js 首次访问自动建表）
          d1Databases: ['DB']
        },
        // 让生产环境用的 .html 文本 import 在测试中也能工作
        // 注意：miniflare 本地模拟会忽略 wrangler.toml 中 KV/D1 的占位 ID（REPLACE_WITH_*），
        // 与 wrangler.dev.toml 的 local-dev-kv-placeholder 行为一致，CI/本地均可直接运行
        wrangler: {
          configPath: './wrangler.toml'
        }
      }
    }
  }
});
