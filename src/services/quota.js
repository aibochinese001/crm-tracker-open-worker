// @ts-check
/**
 * 配额检查（免费用户创建客户上限）
 *
 * 规则：
 * - 会员有效（plan_id 非空且未过期）：不限（maxSubscriptions=-1 预留按套餐限制）
 * - 免费用户：FREE_QUOTA 上限（settings 表 FREE_QUOTA，默认 3）
 * - admin：不受限
 */

import { getSetting } from '../data/saas.repo.js';
import { isMembershipActive } from '../data/users.repo.js';
import { count } from '../data/subscriptions.repo.js';

const DEFAULT_FREE_QUOTA = 3;

/**
 * 检查用户能否再创建一条客户。
 *
 * @param {{ DB?: D1Database, __ownerScope?: string, __authUser?: Object }} env
 * @returns {Promise<{ allowed: boolean, reason?: string, used?: number, quota?: number }>}
 */
export async function checkSubscriptionQuota(env) {
  const user = env.__authUser;
  if (!user) return { allowed: true }; // cron / 兜底登录不限制
  if (user.role === 'admin') return { allowed: true };

  // 会员有效 → 不限
  if (isMembershipActive({ plan_id: user.planId, plan_expires_at: user.planExpiresAt })) {
    return { allowed: true };
  }

  // 免费用户 → 配额检查
  let quota = DEFAULT_FREE_QUOTA;
  const configured = await getSetting(env, 'FREE_QUOTA');
  const n = Number(configured);
  if (Number.isFinite(n) && n >= 0) quota = Math.floor(n);

  const used = await count(env, { ownerUserId: user.id });
  if (used >= quota) {
    return {
      allowed: false,
      reason: `免费版最多可创建 ${quota} 条客户记录，当前 ${used} 条。开通会员即可不限数量。`,
      used,
      quota
    };
  }
  return { allowed: true, used, quota };
}
