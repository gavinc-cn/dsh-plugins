// @gavinc-cn/dsh-feishu —— owner-only 管理 API 路由
//
// 目的：把规格里的 7 条 exact API 注册到 Host 的 `ctx.connection.fetch`。GUI 的
// owner-only 由 Connection 统一提供（exact Fetch route 命中时 peer 必须是 owner，
// 否则直接 403），本模块只负责：方法白名单、请求体大小/字段/类型/长度校验、
// 显式动作转发，以及把错误收敛成不含堆栈/秘密的 JSON。
//
// 设计约束：
//   - 只注册 7 条 exact path，不做前缀/通配路由；status 只 GET，其余只 POST；
//   - body 必须是小 JSON 对象（<= 8 KiB）；每个 POST 校验允许字段，未知字段直接 400；
//   - publish / revoke / retry 只由请求显式触发，路由自身不产生任何自动动作；
//   - 返回给浏览器的 status 由 runtime.status() 负责脱敏；路由不拼装正文、device_code、
//     Secret 或完整 outbox text；
//   - disposer 幂等，只卸载本模块注册的 route，不影响其它插件。
//
// 生效链路：`lib/index.mjs` 的 apply 在 runtime 创建后调用
// `registerFeishuRoutes(ctx, runtime)`，插件卸载时先执行返回的 disposer。
import { redactError } from './utils.mjs'

/** 规格中的 7 条 exact API（浏览器请求的是 `/api/feishu/*`）。 */
export const FEISHU_ROUTE_PATHS = Object.freeze({
  status: '/api/feishu/status',
  provision: '/api/feishu/provision',
  bindCode: '/api/feishu/bind-code',
  revokeBinding: '/api/feishu/bindings/revoke',
  reconnect: '/api/feishu/reconnect',
  config: '/api/feishu/config',
  outboxRetry: '/api/feishu/outbox/retry',
})

/** 单次 POST body 上限：管理面只需要几个短字段，8 KiB 足够且能挡住误发的大对象。 */
export const MAX_BODY_BYTES = 8 * 1024

/** 配置路径长度上限（POSIX PATH_MAX 常用 4096）。 */
export const MAX_CWD_CHARS = 4096

/** 非秘密文件上限的允许范围：>0 且 <=1 GiB（DSH 附件/内存约束）。 */
export const MAX_FILE_MAX_BYTES = 1024 * 1024 * 1024

/** open_id / requestId 长度上限（飞书实际远小于此）。 */
export const MAX_OPEN_ID_CHARS = 128
export const MAX_REQUEST_ID_CHARS = 256

/** opaque bindingKey 的形状：sha256(open_id) 前 16 个 hex（固定小写）。 */
export const BINDING_KEY_PATTERN = /^[0-9a-f]{16}$/

/** 显式 provision 动作白名单。 */
export const PROVISION_ACTIONS = Object.freeze(['start', 'cancel', 'apply', 'publish'])

/** requestId 的固定前缀（与 sessions 的 `feishu:<message_id>` 一致）。 */
const REQUEST_ID_PREFIX = 'feishu:'

/** 路由校验错误文案上限：未知字段名等用户输入不得无界反射到响应。 */
export const MAX_ROUTE_ERROR_CHARS = 300

/** 带 HTTP 状态码的路由校验错误（内部使用，不外泄堆栈）。 */
class RouteError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} message 安全文案（超过 300 字符自动截断）
   */
  constructor(status, message) {
    super(String(message ?? '').slice(0, MAX_ROUTE_ERROR_CHARS))
    this.name = 'RouteError'
    this.status = status
  }
}

/** 判定普通对象（排除 null/数组）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 生成 JSON 响应（禁止缓存，避免面板读到旧状态）。 */
function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * 读取并校验 JSON body：空 body 视为 `{}`；超过上限 413；非对象/非法 JSON 400。
 * 先看 content-length 早退，避免把超大请求体读进内存。
 * @param {Request} request
 * @returns {Promise<object>}
 */
async function readJsonBody(request) {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RouteError(413, '请求体过大')
  }
  let text
  try {
    text = await request.text()
  } catch {
    throw new RouteError(400, '无法读取请求体')
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new RouteError(413, '请求体过大')
  }
  if (text.trim() === '') return {}
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new RouteError(400, '请求体必须是合法 JSON')
  }
  if (!isPlainObject(body)) throw new RouteError(400, '请求体必须是 JSON 对象')
  return body
}

/**
 * 校验 body 只含允许字段；未知字段直接拒绝（防止把 Secret/任意字段写进配置）。
 * @param {object} body
 * @param {string[]} allowed
 */
function assertAllowedFields(body, allowed) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new RouteError(400, `不支持的字段: ${unknown.slice(0, 3).join(', ')}`)
  }
}

/** 校验非空字符串并限制长度。 */
function requireString(body, field, maxChars) {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RouteError(400, `${field} 必须是非空字符串`)
  }
  if (value.length > maxChars) throw new RouteError(400, `${field} 过长`)
  if (value.includes('\0')) throw new RouteError(400, `${field} 含非法字符`)
  return value
}

/**
 * 校验默认 cwd：空串（表示交给会话创建时决定）或绝对路径；限制长度与 NUL。
 * 同时接受 POSIX `/...` 与 Windows `C:\...` 形式（本插件跨平台）。
 * @param {unknown} value
 * @returns {string}
 */
function assertCwd(value) {
  if (typeof value !== 'string') throw new RouteError(400, 'defaultCwd 必须是字符串')
  if (value.length > MAX_CWD_CHARS) throw new RouteError(400, 'defaultCwd 过长')
  if (value.includes('\0')) throw new RouteError(400, 'defaultCwd 含非法字符')
  if (value.trim() === '') return ''
  const absolute = value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
  if (!absolute) throw new RouteError(400, 'defaultCwd 必须是绝对路径')
  return value
}

/**
 * 调用 runtime 并把异常收敛成安全响应：校验错误保留状态码，其余统一 500 + 脱敏 message。
 * @param {() => Promise<Response> | Response} task
 * @returns {Promise<Response>}
 */
async function guard(task) {
  try {
    return await task()
  } catch (error) {
    if (error instanceof RouteError) {
      return json({ ok: false, error: error.message.slice(0, MAX_ROUTE_ERROR_CHARS) }, error.status)
    }
    // 只回 message（redactError(Error) 会带 stack，这里先取 message 再脱敏），并截断。
    const message = redactError(error instanceof Error ? error.message : error).slice(0, 300)
    return json({ ok: false, error: message === '' ? '内部错误' : message }, 500)
  }
}

/**
 * 组装 7 条 route 的 handler。所有 handler 先校验方法，再读 body/转发 runtime。
 * @param {object} runtime createFeishuRuntime 返回值
 */
function routeHandlers(runtime) {
  return {
    status: async (request) => {
      if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
      return guard(async () => json({ ok: true, status: runtime.status() }))
    },

    provision: async (request) => {
      if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
      return guard(async () => {
        const body = await readJsonBody(request)
        assertAllowedFields(body, ['action', 'force'])
        const action = body.action
        if (!PROVISION_ACTIONS.includes(action)) {
          throw new RouteError(400, `action 必须是 ${PROVISION_ACTIONS.join('/')} 之一`)
        }
        const options = {}
        if (body.force !== undefined) {
          if (action !== 'start') throw new RouteError(400, 'force 只适用于 start')
          if (typeof body.force !== 'boolean') throw new RouteError(400, 'force 必须是布尔值')
          options.force = body.force
        }
        const status = await runtime.provision(action, options)
        return json({ ok: true, status })
      })
    },

    bindCode: async (request) => {
      if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
      return guard(async () => {
        const body = await readJsonBody(request)
        assertAllowedFields(body, [])
        const issued = runtime.issueBindCode()
        return json({ ok: true, code: issued.code, expiresAt: issued.expiresAt })
      })
    },

    revokeBinding: async (request) => {
      if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
      return guard(async () => {
        const body = await readJsonBody(request)
        assertAllowedFields(body, ['openId', 'bindingKey'])
        const hasOpenId = Object.hasOwn(body, 'openId')
        const hasBindingKey = Object.hasOwn(body, 'bindingKey')
        // 必须且只能二选一：同时给两个或都不给都无法确定撤销目标。
        if (hasOpenId === hasBindingKey) {
          throw new RouteError(400, 'openId 与 bindingKey 必须二选一')
        }
        if (hasOpenId) {
          const openId = requireString(body, 'openId', MAX_OPEN_ID_CHARS)
          const revoked = await runtime.revokeBinding(openId)
          return json({ ok: true, revoked: revoked === true })
        }
        const bindingKey = requireString(body, 'bindingKey', 16)
        if (!BINDING_KEY_PATTERN.test(bindingKey)) {
          throw new RouteError(400, 'bindingKey 必须是 16 位小写 hex')
        }
        const result = await runtime.revokeBindingByKey(bindingKey)
        if (result?.ambiguous === true) {
          return json({ ok: false, revoked: false, error: 'binding_key_ambiguous' }, 409)
        }
        if (result?.found !== true) {
          return json({ ok: false, revoked: false, error: 'binding_not_found' }, 404)
        }
        return json({ ok: true, revoked: result.revoked === true })
      })
    },

    reconnect: async (request) => {
      if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
      return guard(async () => {
        const body = await readJsonBody(request)
        assertAllowedFields(body, [])
        return json({ ok: true, status: await runtime.reconnect() })
      })
    },

    config: async (request) => {
      if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
      return guard(async () => {
        const body = await readJsonBody(request)
        assertAllowedFields(body, ['defaultCwd', 'fileMaxBytes'])
        if (!('defaultCwd' in body) && !('fileMaxBytes' in body)) {
          throw new RouteError(400, '至少提供 defaultCwd 或 fileMaxBytes')
        }
        const patch = {}
        if ('defaultCwd' in body) patch.defaultCwd = assertCwd(body.defaultCwd)
        if ('fileMaxBytes' in body) {
          const value = body.fileMaxBytes
          if (!Number.isInteger(value) || value <= 0 || value > MAX_FILE_MAX_BYTES) {
            throw new RouteError(400, `fileMaxBytes 必须是 1..${MAX_FILE_MAX_BYTES} 的整数`)
          }
          patch.fileMaxBytes = value
        }
        return json({ ok: true, config: await runtime.updateConfig(patch) })
      })
    },

    outboxRetry: async (request) => {
      if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
      return guard(async () => {
        const body = await readJsonBody(request)
        assertAllowedFields(body, ['requestId'])
        const requestId = requireString(body, 'requestId', MAX_REQUEST_ID_CHARS)
        if (!requestId.startsWith(REQUEST_ID_PREFIX)
          || requestId.slice(REQUEST_ID_PREFIX.length).trim() === '') {
          throw new RouteError(400, `requestId 必须形如 ${REQUEST_ID_PREFIX}<message_id>`)
        }
        const result = await runtime.retryOutbox(requestId)
        return json({ ok: true, retried: result.retried === true, state: result.state })
      })
    },
  }
}

/**
 * 注册 owner-only 管理 API。owner-only 由 Connection 的 exact Fetch route 统一实现，
 * 本函数只保证路径/方法/字段与生命周期。
 * @param {object} ctx Host 上下文，需要 `ctx.connection.fetch.register`
 * @param {object} runtime createFeishuRuntime 返回值
 * @returns {Promise<() => Promise<void>>} 幂等 disposer（只卸载本模块注册的 route）
 */
export async function registerFeishuRoutes(ctx, runtime) {
  const register = ctx?.connection?.fetch?.register
  if (typeof register !== 'function') {
    throw new TypeError('registerFeishuRoutes: ctx.connection.fetch.register 不可用')
  }
  for (const method of ['status', 'provision', 'issueBindCode', 'revokeBinding',
    'revokeBindingByKey', 'reconnect', 'updateConfig', 'retryOutbox']) {
    if (typeof runtime?.[method] !== 'function') {
      throw new TypeError(`registerFeishuRoutes: runtime.${method} 必须是函数`)
    }
  }

  const handlers = routeHandlers(runtime)
  const specs = [
    [FEISHU_ROUTE_PATHS.status, ['GET'], handlers.status],
    [FEISHU_ROUTE_PATHS.provision, ['POST'], handlers.provision],
    [FEISHU_ROUTE_PATHS.bindCode, ['POST'], handlers.bindCode],
    [FEISHU_ROUTE_PATHS.revokeBinding, ['POST'], handlers.revokeBinding],
    [FEISHU_ROUTE_PATHS.reconnect, ['POST'], handlers.reconnect],
    [FEISHU_ROUTE_PATHS.config, ['POST'], handlers.config],
    [FEISHU_ROUTE_PATHS.outboxRetry, ['POST'], handlers.outboxRetry],
  ]

  const disposers = []
  try {
    for (const [path, methods, fetch] of specs) {
      // register 返回的每个 disposer 只删除自己注册的 exact path。
      const disposer = register({ path, methods, requestBody: 'buffered', fetch })
      if (typeof disposer === 'function') disposers.push(disposer)
    }
  } catch (error) {
    // 半注册失败不能留下孤儿 route。
    await Promise.allSettled(disposers.map((dispose) => dispose()))
    throw error
  }

  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    // 逆序卸载；某一个 disposer 抛错不影响其余 route 的清理。
    await Promise.allSettled(disposers.reverse().map((dispose) => dispose()))
  }
}
