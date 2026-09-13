// @ts-check
/**
 * 会员到期自动降级
 *
 * cron 每小时执行：扫描 users 表中 plan_expires_at 已过期的用户，
 * 清空 plan_id/plan_expires_at（降级为免费用户）。
 *
 * 设计：
 * - 降级只清会员字段，用户数据不动（已有客户只读策略在前端/配额层实施）
 * - 单条 UPDATE ... WHERE 条件扫描，天然幂等
 * - 返回降级人数，供 cron 日志记录
 */

/**
 * 执行会员到期降级。
 *
 * @param {{ DB?: D1Database }} env
 * @returns {Promise<{ downgraded: number }>}
 */
export async function downgradeExpiredMemberships(env) {
  if (!env.DB) return { downgraded: 0 };
  const now = Date.now();
  // plan_expires_at 非空且已过期 → 清空会员（免费用户）
  const result = await env.DB
    .prepare(
      "UPDATE users SET plan_id = NULL, plan_expires_at = NULL, updated_at = ?1 " +
      "WHERE plan_id IS NOT NULL AND plan_expires_at IS NOT NULL AND plan_expires_at <= ?1"
    )
    .bind(now)
    .run();
  const downgraded = (result.meta && result.meta.changes) || 0;
  if (downgraded > 0) {
    console.log('[membership] 会员到期自动降级:', downgraded, '人');
  }
  return { downgraded };
}
