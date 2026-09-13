// @ts-check
/**
 * 通知调度入口
 *
 * 旧 sendNotificationToAllChannels 现在是 dispatch.dispatch 的薄壳，
 * 保留签名向后兼容。新代码请直接使用 dispatch / testChannel。
 *
 */
import { dispatch } from './dispatch.js';

/**
 * @param {string} title
 * @param {string} commonContent
 * @param {any} config
 * @param {string} [logPrefix='[定时任务]']
 * @param {{ env?: any, subId?: string, ruleId?: string, metadata?: Object }} [options]
 */
export async function sendNotificationToAllChannels(
  title,
  commonContent,
  config,
  logPrefix = '[定时任务]',
  options = {}
) {
  const result = await dispatch(
    { title, content: commonContent },
    config,
    {
      logPrefix,
      env: options.env,
      subId: options.subId,
      ruleId: options.ruleId,
      metadata: options.metadata
    }
  );

  // 旧调用方期望的字段名
  return {
    attempted: result.attempted,
    successCount: result.successCount,
    failedCount: result.failedCount,
    channelResults: result.channelResults
  };
}

export { dispatch, testChannel } from './dispatch.js';
