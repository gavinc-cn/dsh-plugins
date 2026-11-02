/**
 * DeepSeek 模型 token 计价的纯函数。
 *
 * 设计约束：
 *  - 价格来自官方人民币价格页（2026-10-29 抓取），以「纳元/token」整数保存，避免浮点误差；
 *  - 高峰按北京时间工作日两个窗口，排除 2026 法定节假日；周末（含调休上班周末）一律空闲；
 *  - 只认本机两条 DeepSeek 官方 route：API-key 的 `deepseek-official` 与账号授权的
 *    `deepseek-account`（同一 Messages 传输、同一官方价格）；未知 provider/model/usage
 *    一律返回 unpriced，绝不套默认价格；
 *  - 所有函数无 I/O、无全局状态，可在宿主 projection 与单测中同步调用。
 */

export const PRICE_VERSION = '2026-10-29'

/**
 * 官方价格（人民币/百万 tokens）→ 纳元/token。
 * 40 / 2000 / 8000 分别对应 0.04 / 2 / 8 元每百万。
 */
const RATES = {
  'deepseek-flash': {
    peak: { cacheHit: 40, cacheMiss: 2000, output: 8000 },
    offPeak: { cacheHit: 20, cacheMiss: 1000, output: 4000 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHit: 300, cacheMiss: 9000, output: 27000 },
    offPeak: { cacheHit: 150, cacheMiss: 4500, output: 13500 },
  },
}

/** 官方旧名仍由 Flash 服务并按 Flash 价格计费。 */
const MODEL_ALIASES = {
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
}

/**
 * 本机可计价的两条 DeepSeek 官方 route。
 * `deepseek-official` 走 API key；`deepseek-account` 走 DSH 账号授权，
 * 两者共用官方 Messages 传输与人民币价格表，不能把账号 route 误判为第三方模型。
 */
const DEEPSEEK_PROVIDERS = new Set(['deepseek-official', 'deepseek-account'])

/**
 * 2026 年法定节假日（国办发明电〔2025〕7 号）。
 * 只列放假日期；周末调休上班不改变「周末=空闲」的官方价格规则。
 */
const HOLIDAYS_2026 = new Set([
  ...[1, 2, 3].map((day) => `1-${day}`), // 元旦
  ...range(2, 15, 23), // 春节
  ...range(4, 4, 6), // 清明
  ...range(5, 1, 5), // 劳动节
  ...range(6, 19, 21), // 端午
  ...range(9, 25, 27), // 中秋
  ...range(10, 1, 7), // 国庆
])

/**
 * 生成闭区间日期键。
 * @param {number} month - 月份（1-12）。
 * @param {number} from - 起始日。
 * @param {number} to - 结束日。
 * @returns {string[]} `month-day` 键。
 */
function range(month, from, to) {
  const keys = []
  for (let day = from; day <= to; day += 1) keys.push(`${month}-${day}`)
  return keys
}

/**
 * 取模型的标准价格键。
 * @param {unknown} model - 请求/消息声明的模型名。
 * @returns {'deepseek-flash' | 'deepseek-v4-pro' | null} 可计价模型键，未知返回 null。
 */
export function canonicalModel(model) {
  return typeof model === 'string' && Object.hasOwn(MODEL_ALIASES, model) ? MODEL_ALIASES[model] : null
}

/**
 * 是否处于高峰时段。
 * 北京时间没有夏令时，直接加 8 小时再用 UTC getter，避免测试机/宿主时区影响。
 * @param {number} atMs - 请求开始时间（epoch ms）。
 * @returns {{ peak: boolean, holidayTableMissing: boolean }} 峰谷与节假日覆盖情况。
 */
export function isPeakTime(atMs) {
  if (!Number.isFinite(atMs)) return { peak: false, holidayTableMissing: false }
  const beijingTime = new Date(atMs + 8 * 60 * 60 * 1000)
  const year = beijingTime.getUTCFullYear()
  const month = beijingTime.getUTCMonth() + 1
  const day = beijingTime.getUTCDate()
  const weekday = beijingTime.getUTCDay()
  const hour = beijingTime.getUTCHours()
  const holidayTableMissing = year !== 2026
  const holiday = year === 2026 && HOLIDAYS_2026.has(`${month}-${day}`)
  const weekdayPeak = weekday >= 1 && weekday <= 5
  const inWindow = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
  return { peak: weekdayPeak && inWindow && !holiday, holidayTableMissing }
}

/**
 * 校验一个 token 计数：安全、非负整数。
 * @param {unknown} value - 待校验计数。
 * @param {boolean} optional - 允许 undefined（按 0 处理）。
 * @returns {boolean} 是否合法。
 */
function isCount(value, optional = false) {
  if (value === undefined && optional) return true
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * 规范化 usage 的三个计费桶。
 * @param {unknown} usage - provider 报告的 usage。
 * @returns {{ cacheMiss: number, cacheHit: number, output: number, cacheWrite: number } | null} 规范化桶，非法返回 null。
 */
function normalizeUsage(usage) {
  if (typeof usage !== 'object' || usage === null) return null
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return null
  if (!isCount(usage.cacheReadTokens, true) || !isCount(usage.cacheWriteTokens, true)) return null
  return {
    cacheMiss: usage.inputTokens,
    cacheHit: usage.cacheReadTokens ?? 0,
    output: usage.outputTokens,
    cacheWrite: usage.cacheWriteTokens ?? 0,
  }
}

/**
 * 给一次请求计价。
 * @param {object} input - `{ provider, model, usage, atMs }`。
 * @param {unknown} input.provider - provider id。
 * @param {unknown} input.model - provider 模型 id。
 * @param {unknown} input.usage - provider token usage。
 * @param {unknown} input.atMs - 请求开始时间（epoch ms）。
 * @returns {{ kind: 'priced', nanoYuan: number, modelKey: string, period: 'peak'|'offPeak' }
 *   | { kind: 'unpriced', reason: string }} 计价结果。
 */
export function priceUsage({ provider, model, usage, atMs } = {}) {
  if (!DEEPSEEK_PROVIDERS.has(provider)) return { kind: 'unpriced', reason: 'unknown-provider' }
  const modelKey = canonicalModel(model)
  if (modelKey === null) return { kind: 'unpriced', reason: 'unknown-model' }
  if (!Number.isFinite(atMs)) return { kind: 'unpriced', reason: 'invalid-time' }

  const buckets = normalizeUsage(usage)
  if (buckets === null) return { kind: 'unpriced', reason: 'invalid-usage' }
  if (buckets.cacheWrite > 0) return { kind: 'unpriced', reason: 'unsupported-cache-write' }

  const peak = isPeakTime(atMs)
  const period = peak.peak ? 'peak' : 'offPeak'
  const rate = RATES[modelKey][period]
  const total = BigInt(buckets.cacheMiss) * BigInt(rate.cacheMiss)
    + BigInt(buckets.cacheHit) * BigInt(rate.cacheHit)
    + BigInt(buckets.output) * BigInt(rate.output)
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: 'unpriced', reason: 'cost-overflow' }
  return {
    kind: 'priced',
    nanoYuan: Number(total),
    modelKey,
    period,
    holidayTableMissing: peak.holidayTableMissing,
  }
}
