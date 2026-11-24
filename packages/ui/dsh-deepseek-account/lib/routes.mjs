/** owner-only 状态路由；浏览器永远接触不到 credential.value。 */

export const ACCOUNT_ROUTE_PATHS = Object.freeze({
  status: '/api/deepseek-account/status',
  refresh: '/api/deepseek-account/refresh',
})

/** 生成禁止缓存的 JSON 响应。 */
function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/** 注册 GET 状态与 POST 强制刷新两条 exact route，并返回幂等清理器。 */
export function registerAccountRoutes(ctx, runtime) {
  const register = ctx?.connection?.fetch?.register
  if (typeof register !== 'function') throw new TypeError('ctx.connection.fetch.register 不可用')
  const specs = [
    [ACCOUNT_ROUTE_PATHS.status, ['GET'], async () => json({ ok: true, ...await runtime.refresh(false) })],
    [ACCOUNT_ROUTE_PATHS.refresh, ['POST'], async () => json({ ok: true, ...await runtime.refresh(true) })],
  ]
  const disposers = []
  try {
    for (const [path, methods, fetch] of specs) {
      disposers.push(register({ path, methods, requestBody: 'buffered', fetch }))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose?.()
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) dispose?.()
  }
}
