/** DeepSeek 官方余额接口的宿主侧适配；API Key 不离开本模块与 runtime。 */

export const DEFAULT_BALANCE_URL = 'https://api.deepseek.com'
export const DEFAULT_TIMEOUT_MS = 10_000

/** 官方金额字段是非负十进制字符串；保留字符串以免浮点改写账单数值。 */
function isAmount(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
}

/**
 * 校验并规范化 GET /user/balance 响应。
 * @param {unknown} payload - 响应 JSON。
 * @returns {{isAvailable:boolean, balances:Array<object>}} 可安全传给浏览器的值。
 */
export function parseBalancePayload(payload) {
  if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.balance_infos)) {
    throw new Error('DeepSeek 余额响应格式异常')
  }
  const balances = payload.balance_infos.map((entry) => {
    if (typeof entry !== 'object' || entry === null
      || (entry.currency !== 'CNY' && entry.currency !== 'USD')
      || !isAmount(entry.total_balance)
      || !isAmount(entry.granted_balance)
      || !isAmount(entry.topped_up_balance)) {
      throw new Error('DeepSeek 余额响应格式异常')
    }
    return {
      currency: entry.currency,
      total: entry.total_balance,
      granted: entry.granted_balance,
      toppedUp: entry.topped_up_balance,
    }
  })
  return { isAvailable: payload.is_available === true, balances }
}

/**
 * 请求 DeepSeek 当前余额。网络、HTTP、超时和响应错误统一转成固定安全文案，
 * 不反射响应正文或请求头，避免把 API Key 带进 UI 与日志。
 */
export async function requestDeepSeekBalance({
  apiKey,
  baseUrl = DEFAULT_BALANCE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    let response
    try {
      response = await fetchImpl(baseUrl.replace(/\/+$/, '') + '/user/balance', {
        method: 'GET',
        headers: { accept: 'application/json', authorization: 'Bearer ' + apiKey },
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) throw new Error('DeepSeek 余额请求超时')
      throw new Error('无法连接 DeepSeek 余额接口', { cause: error })
    }
    if (response?.ok !== true) {
      throw new Error('DeepSeek 余额接口返回 HTTP ' + (Number(response?.status) || 0))
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error('DeepSeek 余额响应不是合法 JSON')
    }
    return parseBalancePayload(payload)
  } finally {
    clearTimeout(timer)
  }
}
