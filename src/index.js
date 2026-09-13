// @ts-check
/**
 * Worker 入口
 *
 * fetch handler 委托给 Hono 应用（src/app.js）。
 * scheduled handler 触发定时任务执行。
 *
 */

import app from './app.js';
import { ensureMigrations } from './data/migrate.js';
import { checkExpiringSubscriptions } from './services/scheduler.js';
import { downgradeExpiredMemberships } from './services/membership.js';

export default {
  fetch: app.fetch,

  /**
   * 每小时由 Cron 触发一次。
   *
   * @param {ScheduledEvent} event
   * @param {{ SUBSCRIPTIONS_KV: KVNamespace, DB?: D1Database }} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(event, env, ctx) {
    void ctx;
    try {
      await ensureMigrations(env);
    } catch (err) {
      console.error('[index] scheduled 迁移失败:', err);
    }
    console.log(
      '[Workers] 定时任务触发',
      'cron:',
      event?.cron || '(unknown)',
      'UTC:',
      new Date().toISOString()
    );
    await checkExpiringSubscriptions(env);
    try {
      await downgradeExpiredMemberships(env);
    } catch (err) {
      console.error('[index] 会员降级失败:', err);
    }
  }
};
