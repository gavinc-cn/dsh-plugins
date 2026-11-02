/**
 * @gavinc-cn/dsh-session-live-metrics 宿主入口。
 *
 * 注册 `sessionLiveMetrics` 投影：按完整 session 事件流累计逐请求费用与最近 5 分钟
 * decode 样本。注册 rides 当前插件 fiber，停用/卸载即撤掉 key。
 * 失败只 warn：观感指标不能把宿主启动或工具调用弄崩。
 */

import { sessionLiveMetricsDefinition } from './projection.mjs'

export const name = 'dsh-session-live-metrics'

export const inject = ['sessionProjections']

/**
 * 注册投影。
 * @param {object} ctx - Cordis 宿主上下文。
 */
export function apply(ctx) {
  try {
    ctx.sessionProjections.register(sessionLiveMetricsDefinition)
  } catch (error) {
    console.warn('[dsh-session-live-metrics] 注册投影失败', error)
  }
}
