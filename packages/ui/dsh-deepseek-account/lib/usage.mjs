/**
 * 跨会话、按北京时间分日的 DeepSeek 用量索引。
 *
 * 复用 dsh-session-live-metrics 的事件折叠与价格表，只观察每次折叠前后的
 * 费用差值，因此不会维护第二套计价规则。两个包在 npm 与 monorepo 中都是
 * 同一 scope 下的兄弟包，相对路径同时适用于仓库和安装后的布局。
 */

import {
  applyLiveMetricsEvent,
  initialLiveMetricsState,
} from '../../dsh-session-live-metrics/lib/fold.mjs'

export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 把 epoch 毫秒归到北京时间的日历日。
 * @param {unknown} timeMs - 请求开始时间或事件时间。
 * @returns {string | null} YYYY-MM-DD；非法时间返回 null。
 */
export function beijingDayKey(timeMs) {
  if (typeof timeMs !== 'number' || !Number.isSafeInteger(timeMs) || timeMs < 0) return null
  const shifted = new Date(timeMs + BEIJING_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

/** 创建一个会话的可增量更新索引。 */
export function createSessionUsage() {
  return {
    state: initialLiveMetricsState(),
    lastSeq: -1,
    days: {},
  }
}

/**
 * 折叠一个事件并记录其归属日费用。
 *
 * collect=false 用于 fork 继承前缀：前缀仍参与 route/requestStartedAt 的
 * 状态折叠，但不重复计入子会话费用；父会话已经贡献了同一批模型调用。
 * 同 seq 重放由 lastSeq 去重，无关事件也会推进 lastSeq。
 *
 * @param {object} cache - createSessionUsage 创建的索引。
 * @param {object} event - 完整 SessionEvent。
 * @param {boolean} collect - 是否把本事件的费用贡献计入 days。
 */
export function applySessionUsageEvent(cache, event, collect = true) {
  if (typeof event !== 'object' || event === null) return
  if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq <= cache.lastSeq) return
  if (!Number.isSafeInteger(event.time) || event.time < 0) return

  const before = cache.state
  const requestTime = event.type === 'compaction/summary' ? event.time : before.requestStartedAt
  const after = applyLiveMetricsEvent(before, event)
  cache.state = after
  cache.lastSeq = event.seq
  if (!collect) return

  const pricedCalls = after.pricedCalls - before.pricedCalls
  const unpricedCalls = after.unpricedCalls - before.unpricedCalls
  if (pricedCalls === 0 && unpricedCalls === 0) return

  // 已计价调用一定有请求时点；未计价调用缺 route/time 时用事件时间归入当天，
  // 让“存在未计价请求”的告警不会因缺字段而消失。
  const day = beijingDayKey(requestTime) ?? beijingDayKey(event.time)
  if (day === null) return
  const previous = cache.days[day] ?? { nanoYuan: 0, pricedCalls: 0, unpricedCalls: 0 }
  cache.days[day] = {
    nanoYuan: previous.nanoYuan + after.nanoYuan - before.nanoYuan,
    pricedCalls: previous.pricedCalls + pricedCalls,
    unpricedCalls: previous.unpricedCalls + unpricedCalls,
  }
}

/**
 * 从完整日志建立索引。
 * @param {unknown} events - 按 seq 升序排列的完整 SessionEvent 列表。
 * @param {unknown} inheritedEventCount - fork 继承前缀长度，默认 0。
 * @returns {object} 会话用量索引。
 */
export function foldSessionUsage(events, inheritedEventCount = 0) {
  const cache = createSessionUsage()
  if (!Array.isArray(events)) return cache
  const inherited = Number.isSafeInteger(inheritedEventCount) && inheritedEventCount > 0
    ? inheritedEventCount
    : 0
  for (let index = 0; index < events.length; index += 1) {
    applySessionUsageEvent(cache, events[index], index >= inherited)
  }
  return cache
}

/**
 * 汇总全部会话在某一天的贡献。
 * @param {Iterable<object>} caches - 各会话索引。
 * @param {string} day - 北京时间日历日。
 * @returns {{nanoYuan:number, pricedCalls:number, unpricedCalls:number, sessionCount:number}}
 */
export function summarizeSessionUsage(caches, day) {
  const total = { nanoYuan: 0, pricedCalls: 0, unpricedCalls: 0, sessionCount: 0 }
  for (const cache of caches) {
    const contribution = cache.days[day]
    if (contribution === undefined) continue
    total.nanoYuan += contribution.nanoYuan
    total.pricedCalls += contribution.pricedCalls
    total.unpricedCalls += contribution.unpricedCalls
    if (contribution.pricedCalls + contribution.unpricedCalls > 0) total.sessionCount += 1
  }
  return total
}
