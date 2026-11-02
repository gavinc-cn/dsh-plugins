/**
 * 会话近 1 分钟速度与费用 — 浏览器半。
 *
 * 目的：在官方 composer 状态栏新增两个胶囊，读取宿主 `sessionLiveMetrics` projection：
 *   - `60s 96 tok/s`：已完成模型请求在最近 60 秒内的 decode 加权速度；
 *   - `¥0.1234`：当前主 session 的 DeepSeek 模型 token 费用估算。
 *
 * 设计约束：
 *  - 模块 id 必须等于包名，否则 DSH 报 "loaded without registering"；
 *  - 只读 projection，不在浏览器端重新解析会话事件；
 *  - 无数据/未计价/投影缺失一律降级，不抛异常、不显示上一个会话的旧值；
 *  - 每秒 tick 只为推进 60 秒窗口，卸载时清理 timer。
 *
 * 已知边界：outputTokens 在请求结算后才准确，所以滚动速度天然滞后于流式生成；
 * 这里不用字符数估算 token。
 */

window.__ModuleLoader__.load({
  id: '@gavinc-cn/dsh-session-live-metrics',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const NS = 'session-live-metrics'
    const SPEED_WINDOW_MS = 60_000

    const zh = {
      'speed.label': '60s {tps} tok/s',
      'speed.empty': '60s —',
      'speed.title': '最近 60 秒 decode 加权速度；样本 {samples} 个。只统计已结算请求，不含 TTFT、工具和空闲。',
      'speed.staleTitle': '最近 60 秒无已结算请求；显示最近一次结果（最后结算 {time}，样本 {samples} 个）。不含 TTFT、工具和空闲。',
      'cost.title': '当前主 session 模型 token 估算（DeepSeek 价格表 2026-10-29）。',
      'cost.empty': '当前 session 尚无已计价请求。',
      'cost.line': '{model} · {period} · {cost} · {calls} 次',
      'cost.unpriced': '含 {count} 个未计价请求：{reasons}',
      'cost.approximate': '其中 {count} 笔使用事件时间近似峰谷。',
      'cost.holidayMissing': '其中 {count} 笔的年份没有内置节假日表，峰谷可能不准。',
    }

    const en = {
      'speed.label': '60s {tps} tok/s',
      'speed.empty': '60s —',
      'speed.title': '60-second decode-weighted speed from {samples} settled samples. Excludes TTFT, tool time, and idle time.',
      'speed.staleTitle': 'No settled request in the last 60 seconds; showing the last result (last settled {time}, {samples} samples). Excludes TTFT, tool time, and idle time.',
      'cost.title': 'Estimated model-token cost for this main session (DeepSeek price table 2026-10-29).',
      'cost.empty': 'No priced request in this session yet.',
      'cost.line': '{model} · {period} · {cost} · {calls} calls',
      'cost.unpriced': '{count} unpriced request(s): {reasons}',
      'cost.approximate': '{count} call(s) use event time for an approximate peak/off-peak period.',
      'cost.holidayMissing': '{count} call(s) fall in a year without a built-in holiday table; peak/off-peak may be inaccurate.',
    }

    const ROOT_STYLE = {
      minWidth: 0,
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
      display: 'inline-flex',
    }

    const PILL_STYLE = {
      boxSizing: 'border-box',
      borderRadius: 'var(--dsw-radius-sm)',
      maxWidth: '100%',
      color: 'var(--dsw-alias-label-tertiary)',
      font: 'inherit',
      fontVariantNumeric: 'tabular-nums',
      lineHeight: 'inherit',
      whiteSpace: 'nowrap',
      background: 'transparent',
      border: 'none',
      alignItems: 'center',
      gap: '6px',
      padding: '1px 8px',
      display: 'inline-flex',
    }

    /**
     * 把纳元格式化为人民币。浏览器半独立于宿主 bundle，保留同一显示精度。
     * @param {number} nanoYuan - 纳元整数。
     * @returns {string} 显示金额。
     */
    function formatCny(nanoYuan) {
      const yuan = nanoYuan / 1_000_000_000
      return `¥${yuan < 10 ? yuan.toFixed(4) : yuan.toFixed(2)}`
    }

    /**
     * 近 60 秒 decode 加权速度（与宿主 rollingSpeed 同公式）。
     * @param {unknown} samples - projection 样本。
     * @param {number} nowMs - 当前时间。
     * @returns {{ tokensPerSecond: number | null, samples: number }} 速度与纳入样本数。
     */
    function rollingSpeed(samples, nowMs) {
      if (!Array.isArray(samples) || !Number.isFinite(nowMs)) return { tokensPerSecond: null, samples: 0 }
      const start = nowMs - SPEED_WINDOW_MS
      let tokens = 0
      let decodeMs = 0
      let included = 0
      for (const sample of samples) {
        const first = sample?.firstTokenTime
        const completed = sample?.completedTime
        const output = sample?.outputTokens
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(completed) || !Number.isSafeInteger(output)) continue
        const duration = completed - first
        if (duration <= 0) continue
        const overlap = Math.min(completed, nowMs) - Math.max(first, start)
        if (overlap <= 0) continue
        tokens += output * (overlap / duration)
        decodeMs += overlap
        included += 1
      }
      return decodeMs > 0
        ? { tokensPerSecond: (tokens / decodeMs) * 1000, samples: included }
        : { tokensPerSecond: null, samples: 0 }
    }

    /** 取最近一个已经结算、且 decode 区间合法的样本完成时间。 */
    function lastCompletedTime(samples, nowMs) {
      if (!Array.isArray(samples) || !Number.isFinite(nowMs)) return null
      let latest = null
      for (const sample of samples) {
        const first = sample?.firstTokenTime
        const completed = sample?.completedTime
        const output = sample?.outputTokens
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(completed) || !Number.isSafeInteger(output)) continue
        if (completed - first <= 0 || completed > nowMs) continue
        if (latest === null || completed > latest) latest = completed
      }
      return latest
    }

    /**
     * 速度显示值：当前 60 秒窗口有样本就用当前值；窗口滑空后冻结在最后一次结算时刻的结果。
     * 这样空闲时不会从数字突然变成 `—`，同时不会把最后一次结果冒充成“当前 60 秒”。
     * @param {unknown} samples - projection 样本。
     * @param {number} nowMs - 当前时间。
     * @returns {{ tokensPerSecond: number | null, samples: number, asOf: number | null, stale: boolean }}
     *   速度、纳入样本数、结果对应时间与是否为冻结值。
     */
    function displaySpeed(samples, nowMs) {
      const current = rollingSpeed(samples, nowMs)
      if (current.tokensPerSecond !== null) {
        return { ...current, asOf: nowMs, stale: false }
      }
      const latest = lastCompletedTime(samples, nowMs)
      if (latest === null) return { ...current, asOf: null, stale: false }
      const fallback = rollingSpeed(samples, latest)
      if (fallback.tokensPerSecond === null) return { ...current, asOf: null, stale: false }
      return { ...fallback, asOf: latest, stale: true }
    }

    /** 把时间戳格式化为本地 `HH:MM:SS`，只用于 title 说明冻结结果的时点。 */
    function formatClock(timeMs) {
      const date = new Date(timeMs)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** 每秒刷新一次“当前时间”，让 60 秒窗口自然滑动。 */
    function useNow() {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1_000)
        return () => clearInterval(timer)
      }, [])
      return now
    }

    /** 胶囊外壳：沿用 composer stats 的尺寸、颜色与 hover 语义。 */
    function Pill({ stat, label, title }) {
      return h('span', {
        style: ROOT_STYLE,
        'data-composer-stat': stat,
        role: 'note',
        'aria-label': label,
        title,
      }, h('span', {
        style: PILL_STYLE,
      }, h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, label)))
    }

    /** 速度胶囊。 */
    function SpeedPill({ useProjection, t }) {
      const view = useProjection('sessionLiveMetrics')
      const now = useNow()
      if (view === undefined || view === null) return null
      const speed = displaySpeed(view.samples, now)
      const label = speed.tokensPerSecond === null
        ? t('speed.empty')
        : t('speed.label', { tps: Math.round(speed.tokensPerSecond) })
      const title = speed.stale
        ? t('speed.staleTitle', { samples: speed.samples, time: formatClock(speed.asOf) })
        : t('speed.title', { samples: speed.samples })
      return h(Pill, { stat: 'live-speed', label, title })
    }

    /** 费用胶囊。 */
    function CostPill({ useProjection, t }) {
      const view = useProjection('sessionLiveMetrics')
      useNow()
      if (view === undefined || view === null) return null

      const priced = Number.isSafeInteger(view.pricedCalls) ? view.pricedCalls : 0
      const unpriced = Number.isSafeInteger(view.unpricedCalls) ? view.unpricedCalls : 0
      const amount = Number.isSafeInteger(view.nanoYuan) ? view.nanoYuan : 0
      const label = priced === 0
        ? '¥—'
        : `${formatCny(amount)}${unpriced > 0 ? '+' : ''}`

      const lines = [t('cost.title')]
      if (priced === 0) lines.push(t('cost.empty'))
      for (const entry of Array.isArray(view.breakdown) ? view.breakdown : []) {
        lines.push(t('cost.line', {
          model: entry.model,
          period: entry.period,
          cost: formatCny(entry.nanoYuan),
          calls: entry.calls,
        }))
      }
      if (unpriced > 0) {
        const reasons = Object.entries(view.unpricedReasons ?? {})
          .map(([reason, count]) => `${reason} ×${count}`)
          .join(', ')
        lines.push(t('cost.unpriced', { count: unpriced, reasons }))
      }
      if (Number.isSafeInteger(view.approximateCalls) && view.approximateCalls > 0) {
        lines.push(t('cost.approximate', { count: view.approximateCalls }))
      }
      if (Number.isSafeInteger(view.holidayTableMissingCalls) && view.holidayTableMissingCalls > 0) {
        lines.push(t('cost.holidayMissing', { count: view.holidayTableMissingCalls }))
      }
      return h(Pill, { stat: 'live-cost', label, title: lines.join('\n') })
    }

    /**
     * 客户端插件体：注册 locale 与两个 composer.dock 条目。
     * @param {object} ctx - 客户端 Cordis 上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-live-metrics: dictionaries')
      ctx.slots.inject('conversation.composer.dock', function* () {
        yield ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'live-speed',
          order: 2,
          locale: NS,
        }, SpeedPill)
        yield ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'live-cost',
          order: 3,
          locale: NS,
        }, CostPill)
      })
    }

    exports.apply = apply
    exports.inject = ['locale', 'slots']
    exports.SpeedPill = SpeedPill
    exports.CostPill = CostPill
    return module.exports
  },
})
