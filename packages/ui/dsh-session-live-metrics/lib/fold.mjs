/**
 * `sessionLiveMetrics` 投影的纯折叠。
 *
 * 输入是完整 SessionEvent 流；输出是可直接 JSON 序列化的状态与 wire view。
 * 设计约束：
 *  - 只按事件自身记录的 provider/model/usage/时间计价，不读“当前选中模型”；
 *  - 同 seq 幂等；未知事件返回原 state 引用（投影框架据此跳过下游）；
 *  - usage 缺失/非法不抛异常，只累计 unpriced 原因；
 *  - 速度样本只来自已结算 assistant 事件，保留 5 分钟，供浏览器截 60 秒窗口。
 */

import { priceUsage } from './pricing.mjs'

export const SPEED_WINDOW_MS = 60_000
export const SAMPLE_RETENTION_MS = 5 * 60_000

/**
 * 空日志的初始状态。
 * @returns {object} 可 JSON 序列化的投影状态。
 */
export function initialLiveMetricsState() {
  return {
    lastSeq: -1,
    route: null,
    requestStartedAt: null,
    nanoYuan: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    unpricedReasons: {},
    approximateCalls: 0,
    holidayTableMissingCalls: 0,
    breakdown: {},
    samples: [],
    latestEventTime: 0,
  }
}

/** 是否为安全、非负整数。 */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 是否为合法的零或正数时间戳。 */
function isTime(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 从事件里取 route（只有字符串 provider/model 才有效）。 */
function routeOf(provider, model) {
  return typeof provider === 'string' && provider.length > 0
    && typeof model === 'string' && model.length > 0
    ? { provider, model }
    : null
}

/** 从 `request/header` 提取 route。 */
function headerRoute(event) {
  const config = event?.data?.header?.config
  return routeOf(config?.provider, config?.model)
}

/** 从 assistant message 自身的 source 提取 route。 */
function messageRoute(event) {
  const source = event?.data?.message?.source
  return routeOf(source?.provider, source?.model)
}

/** 复制并增加一条未计价原因。 */
function addUnpriced(state, reason) {
  return {
    ...state,
    unpricedCalls: state.unpricedCalls + 1,
    unpricedReasons: {
      ...state.unpricedReasons,
      [reason]: (state.unpricedReasons[reason] ?? 0) + 1,
    },
  }
}

/** 合并一笔已计价费用到分模型/峰谷 breakdown。 */
function addPriced(state, priced, usage) {
  const nextNanoYuan = state.nanoYuan + priced.nanoYuan
  if (!Number.isSafeInteger(nextNanoYuan)) return addUnpriced(state, 'cost-overflow')
  const key = `${priced.modelKey}\u0000${priced.period}`
  const previous = state.breakdown[key] ?? {
    model: priced.modelKey,
    period: priced.period,
    cacheMissTokens: 0,
    cacheHitTokens: 0,
    outputTokens: 0,
    calls: 0,
    nanoYuan: 0,
  }
  const nextEntry = {
    ...previous,
    cacheMissTokens: previous.cacheMissTokens + usage.inputTokens,
    cacheHitTokens: previous.cacheHitTokens + (usage.cacheReadTokens ?? 0),
    outputTokens: previous.outputTokens + usage.outputTokens,
    calls: previous.calls + 1,
    nanoYuan: previous.nanoYuan + priced.nanoYuan,
  }
  return {
    ...state,
    nanoYuan: nextNanoYuan,
    pricedCalls: state.pricedCalls + 1,
    holidayTableMissingCalls: state.holidayTableMissingCalls + (priced.holidayTableMissing ? 1 : 0),
    breakdown: { ...state.breakdown, [key]: nextEntry },
  }
}

/** 读取紧凑 stream 的最后一个 raw usage chunk。 */
function lastUsageFromStream(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/**
 * 从紧凑 stream 重建首个 token 的时间。
 * 兼容 text/reasoning/tool-call 的打包 run 与 raw chunk；语义与 DSH `isTokenDelta` 一致。
 * @param {unknown} stream - AssistantStreamRecord[]。
 * @returns {number | undefined} 首 token 时间。
 */
export function firstTokenTimeFromStream(stream) {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record?.type === 'text-chunks' || record?.type === 'reasoning-chunks') {
      let time = record.time0
      const members = record.texts
      if (!isTime(time) || !Array.isArray(members) || !Array.isArray(record.dt)) return undefined
      for (let index = 0; index < members.length; index += 1) {
        if (index > 0) {
          const gap = record.dt[index - 1]
          if (!isCount(gap)) return undefined
          time += gap
        }
        if (typeof members[index] === 'string' && members[index].length > 0) return time
      }
      continue
    }
    if (record?.type === 'tool-call-chunks') {
      if (!isTime(record.time0) || !Array.isArray(record.args)) return undefined
      if (Object.hasOwn(record, 'name')) return record.time0
      let time = record.time0
      for (let index = 0; index < record.args.length; index += 1) {
        if (index > 0) {
          const gap = record.dt?.[index - 1]
          if (!isCount(gap)) return undefined
          time += gap
        }
        if (typeof record.args[index] === 'string' && record.args[index].length > 0) return time
      }
      continue
    }
    if (record?.type !== 'chunk' || !isTime(record.time)) continue
    const chunk = record.chunk
    if ((chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta')
      && typeof chunk.text === 'string' && chunk.text.length > 0) {
      return record.time
    }
    if (chunk?.type === 'tool-call-delta'
      && (Object.hasOwn(chunk, 'name')
        || (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.length > 0))) return record.time
  }
  return undefined
}

/**
 * 追加一个已结算 decode 样本，并按最新事件时间淘汰 5 分钟前样本。
 * @param {object} state - 当前状态。
 * @param {object | undefined} usage - 已结算 usage（只用于 outputTokens）。
 * @param {number | undefined} firstTokenTime - 首 token 时间。
 * @param {number} completedTime - 结算时间。
 * @returns {object} 新状态（无合法样本时原 state）。
 */
function appendSample(state, usage, firstTokenTime, completedTime) {
  if (!isCount(usage?.outputTokens) || !isTime(firstTokenTime) || !isTime(completedTime)) return state
  if (completedTime <= firstTokenTime) return state
  const latest = Math.max(state.latestEventTime, completedTime)
  const cutoff = latest - SAMPLE_RETENTION_MS
  const kept = state.samples.filter((sample) => sample.completedTime >= cutoff)
  return {
    ...state,
    latestEventTime: latest,
    samples: [...kept, { firstTokenTime, completedTime, outputTokens: usage.outputTokens }],
  }
}

/**
 * 记录一笔已结算模型调用：先计价，再独立建立速度样本。
 * 模型/时点缺失、usage 缺失、非法 usage 都只影响计价，不阻断速度。
 */
function recordUsage(state, usage, provider, model, atMs, stream, completedTime, approximate) {
  let next = state
  if (usage === undefined || usage === null) {
    next = addUnpriced(next, 'missing-usage')
  } else if (provider === null || model === null || !isTime(atMs)) {
    next = addUnpriced(next, 'missing-route')
  } else {
    const priced = priceUsage({ provider, model, usage, atMs })
    next = priced.kind === 'priced' ? addPriced(next, priced, usage) : addUnpriced(next, priced.reason)
  }
  if (approximate) next = { ...next, approximateCalls: next.approximateCalls + 1 }
  return appendSample(next, usage, firstTokenTimeFromStream(stream), completedTime)
}

/**
 * 折叠一个 SessionEvent。
 * @param {object} state - 当前状态。
 * @param {unknown} event - 下一条提交事件。
 * @returns {object} 新状态；无关事件返回原引用。
 */
export function applyLiveMetricsEvent(state, event) {
  if (typeof event !== 'object' || event === null) return state
  if (!isTime(event.seq) || !isTime(event.time)) return state
  if (event.seq <= state.lastSeq) return state

  const next = { ...state, lastSeq: event.seq, latestEventTime: Math.max(state.latestEventTime, event.time) }

  switch (event.type) {
    case 'request/header': {
      const route = headerRoute(event)
      return { ...next, route, requestStartedAt: event.time }
    }
    case 'request/context': {
      // request/header 只在配置变化时落盘；request/context 才携带每次路由变化。
      const route = routeOf(event.data?.provider, event.data?.model)
      return route === null ? next : { ...next, route }
    }
    case 'step/start': {
      // 每个 step 都是一次新模型请求；request/header 可能早已落盘，不可沿用旧时间。
      return { ...next, requestStartedAt: event.time }
    }
    case 'llm/retry-started': {
      // 重试复用同一 step/start；真正发起重试时已过退避等待，必须用重试开始时间定峰谷。
      return { ...next, requestStartedAt: event.time }
    }
    case 'assistant/message': {
      const route = messageRoute(event) ?? state.route
      const usage = event.data?.usage ?? lastUsageFromStream(event.data?.stream)
      const stream = event.data?.stream
      return recordUsage(
        next,
        usage,
        route?.provider ?? null,
        route?.model ?? null,
        state.requestStartedAt,
        stream,
        event.time,
        false,
      )
    }
    case 'assistant/attempt': {
      const route = state.route
      const stream = event.data?.stream
      return recordUsage(
        next,
        lastUsageFromStream(stream),
        route?.provider ?? null,
        route?.model ?? null,
        state.requestStartedAt,
        stream,
        event.time,
        false,
      )
    }
    case 'compaction/summary': {
      const route = routeOf(event.data?.provider, event.data?.model)
      const usage = event.data?.usage
      // 压缩调用没有可以证明的请求开始时间；当天事件时间就是唯一可用时点。
      return recordUsage(
        next,
        usage,
        route?.provider ?? null,
        route?.model ?? null,
        event.time,
        undefined,
        event.time,
        true,
      )
    }
    default:
      return state
  }
}

/**
 * 计算近 60 秒 decode 加权速度。
 * @param {unknown} samples - 已完成样本。
 * @param {number} nowMs - 当前时间（epoch ms）。
 * @returns {{ tokensPerSecond: number | null, samples: number, decodeMs: number }} 窗口结果。
 */
export function rollingSpeed(samples, nowMs) {
  if (!Array.isArray(samples) || !Number.isFinite(nowMs)) {
    return { tokensPerSecond: null, samples: 0, decodeMs: 0 }
  }
  const windowStart = nowMs - SPEED_WINDOW_MS
  let tokens = 0
  let decodeMs = 0
  let included = 0
  for (const sample of samples) {
    if (!isTime(sample?.firstTokenTime) || !isTime(sample?.completedTime) || !isCount(sample?.outputTokens)) continue
    const decodeDuration = sample.completedTime - sample.firstTokenTime
    if (decodeDuration <= 0) continue
    const overlapMs = Math.min(sample.completedTime, nowMs) - Math.max(sample.firstTokenTime, windowStart)
    if (overlapMs <= 0) continue
    tokens += sample.outputTokens * (overlapMs / decodeDuration)
    decodeMs += overlapMs
    included += 1
  }
  if (decodeMs <= 0) return { tokensPerSecond: null, samples: 0, decodeMs: 0 }
  return { tokensPerSecond: (tokens / decodeMs) * 1000, samples: included, decodeMs }
}

/**
 * 把宿主状态投影成客户端 wire view（剔除 route/lastSeq 等宿主字段）。
 * @param {object} state - 投影状态。
 * @returns {object} 只含客户端需要的字段。
 */
export function toLiveMetricsView(state) {
  const breakdown = Object.values(state.breakdown).sort((left, right) => (
    left.model.localeCompare(right.model) || left.period.localeCompare(right.period)
  ))
  return {
    nanoYuan: state.nanoYuan,
    pricedCalls: state.pricedCalls,
    unpricedCalls: state.unpricedCalls,
    unpricedReasons: { ...state.unpricedReasons },
    approximateCalls: state.approximateCalls,
    holidayTableMissingCalls: state.holidayTableMissingCalls,
    breakdown: breakdown.map((entry) => ({ ...entry })),
    samples: state.samples.map((sample) => ({ ...sample })),
  }
}
