// @gavinc-cn/dsh-feishu —— DSH 飞书桥插件入口与 Host 总装
//
// 目的：把 Task 2–10 的协议件/存储/会话/答复/文档/交互模块装配成一个有明确生命
// 周期的 Runtime，并提供 owner-only 管理 API 的运行时能力。
//
// 设计约束：
//   - 无凭据：只报 provision-needed，不建 WS、不发任何网络请求；
//   - 有凭据：start 自动启动 WS；start/stop/dispose 幂等，stop 关闭
//     inbound/replies/interactions/provisioner/store 并等待收口；
//   - 恢复：inbox 的 pending/processing 由 FeishuInbound 负责；outbox 的 pending
//     重新 follow/track，processing（上次投递中断）转 failed 等人工重试，绝不自动重发；
//   - 重推：prompt 级失败的 outbox（kind=failure）在飞书重推同一 message_id 时由
//     `FeishuReplies.track` 复位为 pending 并重新 follow，避免「重新 prompt 成功但
//     没有 follower」丢答复；交付级失败（kind=reply）仍只走显式 retry；
//   - 秘密只经 Store/credentials；status/log 只输出脱敏文本、打码 open_id，且不回传
//     outbox 正文或 device_code；
//   - REST 适配器按当前凭据动态解析，并显式设置普通/二进制/流式超时；
//   - 所有后台 worker/回调自身 catch，插件卸载后不留下未观察的 rejection。
//
// 生效链路：package.json 声明 dsh.client.platform = "web"，由 UI bundle 注册行加载；
// `apply` 创建 runtime、注册 routes、启动连接，并在 ctx 卸载时逆序清理。
import { createHash } from 'node:crypto'

import { BindingCodes, BINDING_CODE_TTL_MS } from './binding.mjs'
import { preparePromptContent } from './attachments.mjs'
import { FeishuDocuments } from './documents.mjs'
import { FeishuInbound } from './inbound.mjs'
import { FeishuInteractions } from './interactions.mjs'
import { FeishuProvisioner } from './provision.mjs'
import { FeishuReplies } from './replies.mjs'
import { FeishuSessions } from './sessions.mjs'
import { openFeishuStore } from './store.mjs'
import * as restApi from './feishu/rest.mjs'
import { redactError } from './utils.mjs'
import { registerFeishuRoutes } from './routes.mjs'

export const name = 'dsh-feishu'

/** Host 服务依赖；缺少任一关键服务时 Cordis 不会调用 apply。 */
export const inject = [
  'sessionController',
  'fileUploads',
  'attachments',
  'credentials',
  'storageDomain',
  'connection',
]

/** 文档标题/小节时间戳固定使用 Asia/Shanghai（与 spec 的交付口径一致）。 */
export const DOCUMENT_TIME_ZONE = 'Asia/Shanghai'

/** 默认 REST 超时（秒）：普通请求 / 二进制 / 流式。 */
export const DEFAULT_REST_TIMEOUT_S = 15
export const DEFAULT_BYTES_TIMEOUT_S = 60
export const DEFAULT_STREAM_TIMEOUT_S = 120

/** 非秘密配置的边界（与 routes 的校验保持同一口径）。 */
export const MAX_CWD_CHARS = 4096
export const MAX_FILE_MAX_BYTES = 1024 * 1024 * 1024

/** opaque bindingKey 的形状：sha256(open_id) 前 16 个 hex（64 bit，固定小写）。 */
export const BINDING_KEY_PATTERN = /^[0-9a-f]{16}$/

/**
 * 由完整 open_id 派生稳定的 opaque bindingKey。
 *
 * 为什么用 sha256 前缀而不是随机值/序号：panel 只能拿到打码 open_id，需要一个
 * 不泄露完整 open_id、又能在进程重启/插件重载后保持不变的稳定句柄。sha256(open_id)
 * 是确定性的；只取 16 hex 足够短，且碰撞时 runtime 会拒绝删除（歧义保护）。
 * @param {string} openId
 * @returns {string} 16 位小写 hex；非法输入返回空串
 */
export function bindingKeyForOpenId(openId) {
  if (typeof openId !== 'string' || openId === '') return ''
  return createHash('sha256').update(openId, 'utf8').digest('hex').slice(0, 16)
}

/** 状态列表上限：面板只需要最近若干条失败。 */
const MAX_STATUS_FAILURES = 20

const EMPTY_INBOUND_STATUS = Object.freeze({
  running: false,
  active: null,
  queued: 0,
  pending: 0,
  processing: 0,
  done: 0,
  failed: 0,
  lastError: '',
})

/** 判定普通对象（排除 null/数组）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 安全日志：日志出口自身失败不影响主流程。 */
function safeLog(log, level, message) {
  try {
    log(level, redactError(String(message)))
  } catch {
    // 忽略日志出口异常。
  }
}

/**
 * open_id 打码：保留前 4/后 4（短值只保留前 2），保证状态里绝不出现完整 open_id。
 * @param {unknown} openId
 * @returns {string}
 */
export function maskOpenId(openId) {
  if (typeof openId !== 'string' || openId.length === 0) return ''
  if (openId.length <= 8) return `${openId.slice(0, 2)}***`
  return `${openId.slice(0, 4)}***${openId.slice(-4)}`
}

/** provision 状态里普通字符串的上限（错误/步骤说明）。 */
const MAX_PROVISION_TEXT_CHARS = 600

/**
 * QR data URL 的独立上限：二维码是完整 SVG/PNG 的 base64，不能按普通文案截断，
 * 否则浏览器拿到的是坏图。256 KiB 足以覆盖常见二维码，同时仍给 status 响应封顶。
 */
const MAX_QR_DATA_URL_CHARS = 256 * 1024

/**
 * 去掉错误文本里的堆栈行（`    at fn (file:line:col)` / `at file:line:col`）。
 * status 只回 message，不能把宿主文件路径与调用栈带给浏览器。
 * @param {string} text
 * @returns {string}
 */
function stripStack(text) {
  return text.replace(/\n\s*at\s+.*$/gm, '').trim()
}

/**
 * 状态错误文案：只取 Error.message（不取 stack），脱敏、去堆栈并截断。
 * @param {unknown} value
 * @param {number} [max=300]
 * @returns {string}
 */
function statusErrorText(value, max = 300) {
  const raw = value instanceof Error
    ? value.message
    : (typeof value === 'string' ? value : String(value ?? ''))
  return stripStack(redactError(raw)).slice(0, max)
}

/**
 * 深度清洗 provisioner 状态：删掉任何 Secret/device_code/access_token 键，字符串统一
 * 脱敏并截断。状态形状由 Task 4 保证不含 Secret，这里是 API 出口的最后一道防线。
 *
 * 例外：`qr` 键与 `data:` URL 是二维码图片本体，必须保留完整内容（只做较高上限），
 * 否则面板显示的是一张被截断的坏图（Task 11 review B1）。
 * @param {unknown} value
 * @param {number} [depth=0]
 * @param {string} [key=''] 当前字段名（用于识别 qr）
 * @returns {unknown}
 */
function sanitizeProvisionValue(value, depth = 0, key = '') {
  if (depth > 6) return undefined
  if (typeof value === 'string') {
    const clean = stripStack(redactError(value))
    if (key === 'qr' || clean.startsWith('data:')) {
      return clean.slice(0, MAX_QR_DATA_URL_CHARS)
    }
    return clean.slice(0, MAX_PROVISION_TEXT_CHARS)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeProvisionValue(item, depth + 1, key))
  }
  if (!isPlainObject(value)) return undefined
  const out = {}
  for (const [field, item] of Object.entries(value)) {
    if (/secret|token|authorization|device[_-]?code/i.test(field)) continue
    const clean = sanitizeProvisionValue(item, depth + 1, field)
    if (clean !== undefined) out[field] = clean
  }
  return out
}

/** 校验 cwd：空串或绝对路径，限长且不含 NUL。 */
function assertCwd(value) {
  if (typeof value !== 'string') throw new TypeError('defaultCwd 必须是字符串')
  if (value.length > MAX_CWD_CHARS) throw new TypeError('defaultCwd 过长')
  if (value.includes('\0')) throw new TypeError('defaultCwd 含非法字符')
  if (value.trim() === '') return ''
  if (!(value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))) {
    throw new TypeError('defaultCwd 必须是绝对路径')
  }
  return value
}

/** 校验 fileMaxBytes：正整数且 <=1 GiB。 */
function assertFileMaxBytes(value) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_FILE_MAX_BYTES) {
    throw new TypeError(`fileMaxBytes 必须是 1..${MAX_FILE_MAX_BYTES} 的整数`)
  }
  return value
}

/** 正数配置项；非法值退回默认。 */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 创建绑定当前凭据的 REST 适配器。凭据在每次调用时从 getCredentials 读取，因此扫码
 * 成功后无需重建适配器；无凭据时抛错（不静默发匿名请求）。
 * @param {object} options
 * @param {() => {appId: string, appSecret: string} | undefined} options.getCredentials
 * @param {Function} [options.fetch] 测试/私有部署的 fetch 缝
 * @param {{rest: number, bytes: number, stream: number}} options.timeouts 秒
 */
function createBoundRest({ getCredentials, fetch: fetchImpl, timeouts }) {
  const requireCfg = () => {
    const cfg = getCredentials()
    if (cfg === undefined || cfg === null
      || typeof cfg.appId !== 'string' || cfg.appId === ''
      || typeof cfg.appSecret !== 'string' || cfg.appSecret === '') {
      throw new Error('飞书应用未配置（appId/appSecret 缺失）')
    }
    return cfg
  }
  const withFetch = (options) => (
    fetchImpl === undefined ? options : { ...options, fetch: fetchImpl }
  )
  return {
    async rest(method, path, options = {}) {
      return restApi.rest(method, path, withFetch({
        params: options.params,
        jsonBody: options.jsonBody,
        cfg: requireCfg(),
        timeout: options.timeout ?? timeouts.rest,
      }))
    },
    async restBytes(method, path, options = {}) {
      return restApi.restBytes(method, path, withFetch({
        params: options.params,
        cfg: requireCfg(),
        timeout: options.timeout ?? timeouts.bytes,
      }))
    },
    async restStream(method, path, options = {}) {
      return restApi.restStream(method, path, withFetch({
        ...options,
        cfg: requireCfg(),
        timeout: options.timeout ?? timeouts.stream,
      }))
    },
    async restReply(messageId, text) {
      return restApi.restReply(messageId, text, requireCfg(), {
        timeout: timeouts.rest,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      })
    },
    async sendText(openId, text, { uuid } = {}) {
      return restApi.restSendText(openId, text, requireCfg(), {
        ...(uuid === undefined ? {} : { uuid }),
        timeout: timeouts.rest,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      })
    },
    async sendCard(openId, card, { uuid } = {}) {
      return restApi.restSendCard(openId, card, requireCfg(), {
        ...(uuid === undefined ? {} : { uuid }),
        timeout: timeouts.rest,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      })
    },
  }
}

/** 运行时实现：所有模块在这里组装，生命周期由 start/stop 统一管理。 */
class FeishuRuntime {
  /**
   * @param {object} ctx Host 上下文
   * @param {object} [config] 部署配置（只允许非秘密项与测试缝）
   */
  constructor(ctx, config = {}) {
    if (!isPlainObject(ctx)) throw new TypeError('createFeishuRuntime: ctx 必须是对象')
    if (typeof ctx.sessionController?.create !== 'function'
      || typeof ctx.sessionController?.prompt !== 'function'
      || typeof ctx.sessionController?.follow !== 'function') {
      throw new TypeError('createFeishuRuntime: ctx.sessionController 不可用')
    }
    if (ctx.credentials === undefined || ctx.credentials === null) {
      throw new TypeError('createFeishuRuntime: ctx.credentials 不可用')
    }
    if (ctx.storageDomain === undefined || ctx.storageDomain === null) {
      throw new TypeError('createFeishuRuntime: ctx.storageDomain 不可用')
    }
    if (config !== undefined && !isPlainObject(config)) {
      throw new TypeError('createFeishuRuntime: config 必须是对象')
    }

    this.ctx = ctx
    this.config = { ...(config ?? {}) }
    this.log = typeof this.config.log === 'function' ? this.config.log : () => {}
    this.now = typeof this.config.now === 'function' ? this.config.now : Date.now
    this._timeZone = typeof this.config.timeZone === 'string' && this.config.timeZone !== ''
      ? this.config.timeZone
      : DOCUMENT_TIME_ZONE
    this._timeouts = {
      rest: positiveNumber(this.config.restTimeoutSeconds, DEFAULT_REST_TIMEOUT_S),
      bytes: positiveNumber(this.config.bytesTimeoutSeconds, DEFAULT_BYTES_TIMEOUT_S),
      stream: positiveNumber(this.config.streamTimeoutSeconds, DEFAULT_STREAM_TIMEOUT_S),
    }
    this._restOverride = isPlainObject(this.config.rest) ? this.config.rest : undefined

    this._credentials = undefined
    this._credentialsConfigured = false
    this._started = false
    this._starting = null
    this._stopping = null
    this._closed = false
    this._lastError = ''
    this._lastStatus = null

    // 模块引用在 _buildModules 中创建；测试/路由通过公开字段只读访问。
    this.store = null
    this.bindings = null
    this.rest = null
    this.documents = null
    this.replies = null
    this.sessions = null
    this.interactions = null
    this.inbound = null
    this.provisioner = null
  }

  // ── 组装 ─────────────────────────────────────────────────────────────────

  /** 打开 Store 并组装全部模块（不启动网络）。 */
  async _buildModules() {
    this.store = await openFeishuStore(this.ctx)
    // 只读凭据用于 status 的 connected/disconnected/provision-needed 判定；不触网。
    try {
      this._credentials = await this.store.loadCredentials()
    } catch (error) {
      this._credentials = undefined
      safeLog(this.log, 'warn', `读取飞书凭据失败: ${redactError(error)}`)
    }
    this._credentialsConfigured = this._credentials !== undefined
    this.bindings = new BindingCodes({ store: this.store, now: this.now })
    this.rest = this._restOverride ?? createBoundRest({
      getCredentials: () => this._credentials,
      fetch: this.config.fetch,
      timeouts: this._timeouts,
    })

    this.documents = new FeishuDocuments({
      store: this.store,
      rest: this.rest,
      cfg: () => this._credentials,
      sendText: (openId, text, options) => this.rest.sendText(openId, text, options),
      now: this.now,
      timeZone: this._timeZone,
      log: this.log,
    })

    this.replies = new FeishuReplies({
      store: this.store,
      sessionController: this.ctx.sessionController,
      deliver: (record) => this.documents.deliver(record),
      rest: this.rest,
      now: this.now,
      log: this.log,
    })

    this.interactions = new FeishuInteractions({
      ctx: this.ctx,
      owns: (sessionId) => this._owns(sessionId),
      store: this.store,
      rest: this.rest,
      sendText: (openId, text) => this.rest.sendText(openId, text),
      now: this.now,
      log: this.log,
    })

    this.sessions = new FeishuSessions({
      store: this.store,
      sessionController: this.ctx.sessionController,
      replies: this.replies,
      // 不向 sessions 传 config：Store global 是管理 API 唯一可写的配置源。
      prepareContent: (message, options) => this._prepareContent(message, options),
      interactions: this.interactions,
      now: this.now,
      log: this.log,
    })

    this.inbound = new FeishuInbound({
      store: this.store,
      bindings: this.bindings,
      onMessage: (message) => this._onMessage(message),
      onCard: (payload) => this.interactions.handleCard(payload),
      rest: this.rest,
      now: this.now,
      log: this.log,
      ...(typeof this.config.createWsClient === 'function'
        ? { createWsClient: this.config.createWsClient }
        : {}),
      ...(this.config.WebSocket === undefined ? {} : { WebSocket: this.config.WebSocket }),
      ...(this.config.fetch === undefined ? {} : { fetch: this.config.fetch }),
      ...(this.config.autoReconnect === undefined
        ? {}
        : { autoReconnect: this.config.autoReconnect }),
    })

    this.provisioner = new FeishuProvisioner({
      store: this.store,
      onCredentials: (credentials) => this._onCredentials(credentials),
      ...(this.config.fetch === undefined ? {} : { fetch: this.config.fetch }),
    })
  }

  /**
   * 会话归属：只有出现在某个绑定记录 sessionIds 里的 session 才是本插件自有的。
   * @param {string} sessionId
   * @returns {boolean}
   */
  _owns(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '' || this.store === null) return false
    try {
      return this.store.bindingEntries().some(([, record]) => (
        Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId)
      ))
    } catch {
      return false
    }
  }

  /**
   * 附件适配：注入 DSH 的 imageLimits/fileUploads/REST，文件上限每次从 Store 读最新值。
   * @param {object} message NormalizedMessage
   * @param {{sessionId: string, signal: AbortSignal}} options
   */
  async _prepareContent(message, options) {
    let fileMaxBytes
    try {
      const global = this.store.getConfig()
      if (isPlainObject(global)) fileMaxBytes = global.fileMaxBytes
    } catch (error) {
      safeLog(this.log, 'warn', `读取文件上限失败: ${redactError(error)}`)
    }
    return preparePromptContent(message, {
      sessionId: options?.sessionId,
      restClient: this.rest,
      fileUploads: this.ctx.fileUploads,
      imageLimits: this.ctx.attachments?.imageLimits,
      ...(fileMaxBytes === undefined ? {} : { fileMaxBytes }),
      signal: options?.signal,
    })
  }

  /**
   * 入站消息总入口：先按命令路由（响应经 REST 回发），普通消息交 sessions.submit。
   * 命令响应发送失败只记日志，避免把已执行的 `/new` 等命令打回 failed 后被重推重复执行。
   * @param {object} message NormalizedMessage
   */
  async _onMessage(message) {
    const openId = message?.openId
    const text = typeof message?.text === 'string' ? message.text : ''

    const command = await this.sessions.command(openId, text)
    if (command?.handled === true) {
      await this._sendResponse(openId, command.response)
      return
    }

    const result = await this.sessions.submit(message)
    if (result?.handled === true && typeof result.response === 'string') {
      await this._sendResponse(openId, result.response)
    }
  }

  /** 发送命令响应；空响应不发，失败只记脱敏日志。 */
  async _sendResponse(openId, response) {
    if (typeof response !== 'string' || response.trim() === '') return
    try {
      await this.rest.sendText(openId, response)
    } catch (error) {
      safeLog(this.log, 'warn', `命令响应发送失败: ${redactError(error)}`)
    }
  }

  /**
   * 扫码成功回调：更新内存凭据并启动/重启 inbound（换应用时 inbound 自行撤销旧绑定）。
   * @param {{appId: string, appSecret: string}} credentials
   */
  async _onCredentials(credentials) {
    this._credentials = credentials
    this._credentialsConfigured = true
    if (this._closed || this._stopping !== null) return
    if (this._started) {
      await this.inbound.stop()
      this._started = false
      // await 期间可能被 stop/dispose：不要在已关闭的运行时上重新开 WS。
      if (this._closed || this._stopping !== null) return
    }
    await this.inbound.start(credentials)
    if (this._closed || this._stopping !== null) {
      // start 期间被 stop：收口掉刚建立的连接，避免泄漏。
      try {
        await this.inbound.stop()
      } catch {
        // stop 自身已记录；这里只保证不把 _started 标成 true。
      }
      return
    }
    this._started = true
    await this._recoverOutbox()
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────

  /**
   * 启动：读取凭据；无凭据只进入 provision-needed。有凭据时启动 WS 并恢复 outbox。
   * 重复调用幂等；网络/存储错误只进 status，不向宿主抛出。
   * @returns {Promise<object>} status()
   */
  async start() {
    if (this._starting !== null) return this._starting
    const run = this._start()
    this._starting = run
    try {
      return await run
    } finally {
      if (this._starting === run) this._starting = null
    }
  }

  async _start() {
    // stop/dispose 之后再 start：重新打开 Store 并组装一套全新模块（等同于重载）。
    if (this._closed) {
      this._closed = false
      this._lastStatus = null
      this._lastError = ''
      this._credentials = undefined
      this._credentialsConfigured = false
      try {
        await this._buildModules()
      } catch (error) {
        this._closed = true
        this._lastError = statusErrorText(error)
        safeLog(this.log, 'error', `飞书桥重建失败: ${this._lastError}`)
        return this.status()
      }
    }
    if (this._started) return this.status()

    let credentials
    try {
      credentials = await this.store.loadCredentials()
    } catch (error) {
      this._lastError = statusErrorText(error)
      safeLog(this.log, 'error', `读取飞书凭据失败: ${this._lastError}`)
      credentials = undefined
    }
    this._credentials = credentials
    this._credentialsConfigured = credentials !== undefined
    if (credentials === undefined) return this.status()

    try {
      await this.inbound.start(credentials)
      this._started = true
    } catch (error) {
      this._lastError = statusErrorText(error)
      safeLog(this.log, 'error', `飞书入站启动失败: ${this._lastError}`)
      return this.status()
    }
    await this._recoverOutbox()
    return this.status()
  }

  /**
   * 停止：关闭 inbound/replies/interactions/provisioner/store 并等待全部收口。
   * 幂等；关闭后 start 会重新组装（重载路径），不会复用已关闭的 Store。
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._stopping !== null) return this._stopping
    if (this._closed) return undefined
    // 若 start 仍在读凭据/启动 WS，先等它落定再关闭，避免关掉一半的模块。
    if (this._starting !== null) {
      try {
        await this._starting
      } catch {
        // start 自身已把错误折进 status；这里只等待它结束。
      }
    }
    const run = this._stop()
    this._stopping = run
    try {
      await run
    } finally {
      if (this._stopping === run) this._stopping = null
    }
    return undefined
  }

  async _stop() {
    // 先拍一份脱敏快照：Store 关闭后 status() 仍能回答最后状态。
    try {
      this._lastStatus = this._buildStatus()
    } catch {
      this._lastStatus = null
    }

    const tasks = [
      ['inbound', async () => { await this.inbound?.stop() }],
      ['replies', async () => { await this.replies?.close() }],
      ['interactions', async () => { await this.interactions?.close() }],
      ['provisioner', async () => { this.provisioner?.dispose() }],
    ]
    for (const [label, task] of tasks) {
      try {
        await task()
      } catch (error) {
        safeLog(this.log, 'warn', `${label} 停止失败: ${redactError(error)}`)
      }
    }
    try {
      await this.store?.close()
    } catch (error) {
      safeLog(this.log, 'warn', `Store 关闭失败: ${redactError(error)}`)
    }

    this._started = false
    this._closed = true
    this._credentials = undefined
    this._credentialsConfigured = this._lastStatus?.credentialsConfigured === true
    if (this._lastStatus !== null) {
      this._lastStatus = {
        ...this._lastStatus,
        connection: this._credentialsConfigured ? 'disconnected' : 'provision-needed',
        inbound: { ...EMPTY_INBOUND_STATUS },
      }
    }
  }

  /** dispose 是 stop 的别名（Host 卸载路径统一调用它）。 */
  async dispose() {
    return this.stop()
  }

  // ── 恢复 ─────────────────────────────────────────────────────────────────

  /**
   * outbox 恢复：
   *   - pending：重新 `replies.track` 监听（幂等；交付 uuid=requestId 由飞书去重）；
   *   - processing：上次在投递途中崩溃，改 failed 等人工 retry（不自动重发，避免
   *     文档追加产生重复正文）；
   *   - done/failed：不动。failed 不会自动重试。
   * @returns {Promise<void>}
   */
  async _recoverOutbox() {
    let entries
    try {
      entries = this.store.outboxEntries()
    } catch (error) {
      safeLog(this.log, 'error', `outbox 恢复读取失败: ${redactError(error)}`)
      return
    }
    entries.sort((a, b) => (a[1]?.createdAt ?? 0) - (b[1]?.createdAt ?? 0))
    for (const [requestId, record] of entries) {
      if (!isPlainObject(record)) continue
      if (record.state === 'processing') {
        try {
          await this.store.updateOutbox(requestId, (current) => {
            if (current.state !== 'processing') return current
            return {
              ...current,
              state: 'failed',
              nextAttemptAt: 0,
              error: '投递中断：上次进程退出时仍在发送，需在面板显式重试',
            }
          })
        } catch (error) {
          safeLog(this.log, 'error', `outbox 中断恢复失败 request=${requestId}: ${redactError(error)}`)
        }
        continue
      }
      if (record.state !== 'pending') continue
      try {
        await this.replies.track({
          requestId,
          openId: record.openId,
          sessionId: record.sessionId,
        })
      } catch (error) {
        // 归属冲突/绑定已撤销等：保留记录，等人工处理，不阻塞其它恢复项。
        safeLog(this.log, 'warn', `outbox 恢复 follow 失败 request=${requestId}: ${redactError(error)}`)
      }
    }
  }

  // ── 状态 ─────────────────────────────────────────────────────────────────

  /**
   * 脱敏状态快照：连接态、inbound 计数、脱敏绑定、最近失败、非秘密配置、扫码状态。
   * 绝不包含 Secret、device_code、绑定码、outbox 正文或 inbox raw。
   * @returns {object}
   */
  status() {
    if (this._closed && this._lastStatus !== null) return { ...this._lastStatus }
    try {
      this._lastStatus = this._buildStatus()
    } catch (error) {
      safeLog(this.log, 'warn', `状态组装失败: ${redactError(error)}`)
    }
    return this._lastStatus ?? {
      connection: 'provision-needed',
      credentialsConfigured: false,
      inbound: { ...EMPTY_INBOUND_STATUS },
      bindings: [],
      failures: { inbox: [], outbox: [] },
      config: { defaultCwd: '', fileMaxBytes: 0 },
      provision: null,
      lastError: this._lastError,
    }
  }

  _buildStatus() {
    const inbound = this.inbound?.status() ?? { ...EMPTY_INBOUND_STATUS }
    const credentialsConfigured = this._credentialsConfigured || this._credentials !== undefined
    // connected 必须反映真实 socket 状态：inbound.running 只表示「Runtime 认为自己在跑」，
    // FeishuWsClient auto reconnect 期间它仍为 true，但 socket 已断开。优先消费 Task 5
    // 新增的 connected 字段；旧版本没有该字段时回退 running（兼容）。
    const socketConnected = typeof inbound.connected === 'boolean'
      ? inbound.connected
      : inbound.running === true
    const connection = this._started && socketConnected
      ? 'connected'
      : (credentialsConfigured ? 'disconnected' : 'provision-needed')

    const bindings = []
    const failures = { inbox: [], outbox: [] }
    let config = { defaultCwd: '', fileMaxBytes: 0 }
    if (this.store !== null) {
      try {
        config = this.store.getConfig()
      } catch {
        // Store 不可用时保留空配置。
      }
      try {
        for (const [openId, record] of this.store.bindingEntries()) {
          bindings.push({
            openId: maskOpenId(openId),
            // 稳定 opaque 句柄：面板用它撤销绑定，既不需要也不允许拿到完整 open_id。
            bindingKey: bindingKeyForOpenId(openId),
            sessionCount: Array.isArray(record?.sessionIds) ? record.sessionIds.length : 0,
            hasCurrent: typeof record?.currentSessionId === 'string'
              && record.currentSessionId !== '',
            docs: isPlainObject(record?.docs) ? Object.keys(record.docs).length : 0,
            updatedAt: typeof record?.updatedAt === 'number' ? record.updatedAt : 0,
          })
        }
      } catch (error) {
        safeLog(this.log, 'warn', `绑定状态读取失败: ${redactError(error)}`)
      }
      try {
        for (const [id, record] of this.store.inboxEntries()) {
          if (record?.state !== 'failed') continue
          failures.inbox.push({
            id: String(id),
            state: record.state,
            attempts: record.attempts ?? 0,
            error: statusErrorText(record.error),
            receivedAt: record.receivedAt ?? 0,
          })
        }
      } catch (error) {
        safeLog(this.log, 'warn', `入站失败列表读取失败: ${redactError(error)}`)
      }
      try {
        for (const [requestId, record] of this.store.outboxEntries()) {
          if (record?.state !== 'failed') continue
          failures.outbox.push({
            requestId: String(requestId),
            openId: maskOpenId(record.openId),
            state: record.state,
            kind: record.kind,
            attempts: record.attempts ?? 0,
            // 只报长度，绝不回传正文；面板可提示「有内容」但不泄露内容。
            textChars: typeof record.text === 'string' ? record.text.length : 0,
            hasDocument: typeof record.documentId === 'string' && record.documentId !== '',
            error: statusErrorText(record.error),
            createdAt: record.createdAt ?? 0,
            nextAttemptAt: record.nextAttemptAt ?? 0,
          })
        }
      } catch (error) {
        safeLog(this.log, 'warn', `出站失败列表读取失败: ${redactError(error)}`)
      }
    }

    bindings.sort((a, b) => b.updatedAt - a.updatedAt)
    failures.inbox.sort((a, b) => b.receivedAt - a.receivedAt)
    failures.outbox.sort((a, b) => b.createdAt - a.createdAt)

    let provision = null
    try {
      provision = sanitizeProvisionValue(this.provisioner?.status())
    } catch (error) {
      safeLog(this.log, 'warn', `扫码状态读取失败: ${redactError(error)}`)
    }

    return {
      connection,
      credentialsConfigured,
      inbound: {
        running: inbound.running === true,
        active: inbound.active ?? null,
        queued: inbound.queued ?? 0,
        pending: inbound.pending ?? 0,
        processing: inbound.processing ?? 0,
        done: inbound.done ?? 0,
        failed: inbound.failed ?? 0,
        lastError: statusErrorText(inbound.lastError),
      },
      bindings,
      failures: {
        inbox: failures.inbox.slice(0, MAX_STATUS_FAILURES),
        outbox: failures.outbox.slice(0, MAX_STATUS_FAILURES),
      },
      config: {
        defaultCwd: typeof config.defaultCwd === 'string' ? config.defaultCwd : '',
        fileMaxBytes: Number.isInteger(config.fileMaxBytes) ? config.fileMaxBytes : 0,
      },
      provision,
      lastError: this._lastError,
    }
  }

  // ── 管理动作（路由转发；秘密/正文不出现在返回值里）───────────────────────

  /**
   * 显式 provision 动作。publish 只会由这里被 `action='publish'` 触发。
   * @param {'start'|'cancel'|'apply'|'publish'} action
   * @param {{force?: boolean}} [options]
   * @returns {Promise<object>} 清洗后的 provision 状态
   */
  async provision(action, options = {}) {
    if (!['start', 'cancel', 'apply', 'publish'].includes(action)) {
      throw new TypeError('provision: action 必须是 start/cancel/apply/publish')
    }
    if (this.provisioner === null) throw new Error('provision: 运行时未就绪')
    const force = options?.force === true
    let status
    switch (action) {
      case 'start':
        status = await this.provisioner.start(force)
        break
      case 'cancel':
        status = this.provisioner.cancel()
        break
      case 'apply':
        status = await this.provisioner.apply()
        break
      case 'publish':
        status = await this.provisioner.publish()
        break
      default:
        throw new TypeError('provision: 不可达动作')
    }
    return sanitizeProvisionValue(status)
  }

  /**
   * 生成一次性绑定码（只在本次响应里出现，绝不进 status/日志/存储）。
   * @returns {{code: string, expiresAt: number}}
   */
  issueBindCode() {
    if (this.bindings === null) throw new Error('issueBindCode: 运行时未就绪')
    return {
      code: this.bindings.issue(),
      expiresAt: this.now() + BINDING_CODE_TTL_MS,
    }
  }

  /**
   * 显式撤销一个 open_id 的绑定；不删除 DSH 会话历史。
   * @param {string} openId
   * @returns {Promise<boolean>}
   */
  async revokeBinding(openId) {
    if (typeof openId !== 'string' || openId.trim() === '' || openId.includes('\0')) {
      throw new TypeError('revokeBinding: openId 必须是非空字符串')
    }
    return this.bindings.revoke(openId)
  }

  /**
   * 按 opaque bindingKey 撤销绑定：只在 key 唯一命中当前绑定记录时删除。
   *
   * 不猜 open_id：0 个命中返回 found:false；>1 个命中（理论上的 sha256 前缀碰撞）返回
   * ambiguous:true 且不删除任何记录。返回值不含完整 open_id。
   * @param {string} bindingKey 16 位小写 hex
   * @returns {Promise<{found: boolean, revoked: boolean, ambiguous: boolean}>}
   */
  async revokeBindingByKey(bindingKey) {
    if (typeof bindingKey !== 'string' || !BINDING_KEY_PATTERN.test(bindingKey)) {
      throw new TypeError('revokeBindingByKey: bindingKey 必须是 16 位小写 hex')
    }
    if (this._closed) throw new Error('revokeBindingByKey: 运行时已停止')
    const matches = this.store.bindingEntries()
      .filter(([openId]) => bindingKeyForOpenId(openId) === bindingKey)
    if (matches.length === 0) return { found: false, revoked: false, ambiguous: false }
    if (matches.length > 1) return { found: true, revoked: false, ambiguous: true }
    const revoked = await this.bindings.revoke(matches[0][0])
    return { found: true, revoked, ambiguous: false }
  }

  /**
   * 显式重连：停旧 WS，用当前持久凭据重连；无凭据只更新状态，不发网络请求。
   * @returns {Promise<object>} status()
   */
  async reconnect() {
    if (this._closed) throw new Error('reconnect: 运行时已停止')
    let credentials
    try {
      credentials = await this.store.loadCredentials()
    } catch (error) {
      this._lastError = statusErrorText(error)
      safeLog(this.log, 'error', `重连读取凭据失败: ${this._lastError}`)
      return this.status()
    }
    this._credentials = credentials
    this._credentialsConfigured = credentials !== undefined
    if (credentials === undefined) {
      this._lastError = ''
      return this.status()
    }
    // loadCredentials 是异步的：期间可能已被 stop/dispose，必须重新检查。
    if (this._closed || this._stopping !== null) return this.status()
    if (this._started) {
      await this.inbound.stop()
      this._started = false
      if (this._closed || this._stopping !== null) return this.status()
    }
    try {
      await this.inbound.start(credentials)
      if (this._closed || this._stopping !== null) {
        try {
          await this.inbound.stop()
        } catch {
          // 关闭失败由 inbound 记录；这里不标记 _started。
        }
        return this.status()
      }
      this._started = true
      this._lastError = ''
      await this._recoverOutbox()
    } catch (error) {
      this._lastError = statusErrorText(error)
      safeLog(this.log, 'error', `飞书重连失败: ${this._lastError}`)
    }
    return this.status()
  }

  /**
   * 更新非秘密配置（defaultCwd/fileMaxBytes），返回持久后的完整配置。
   * @param {{defaultCwd?: string, fileMaxBytes?: number}} patch
   * @returns {Promise<object>}
   */
  async updateConfig(patch) {
    if (!isPlainObject(patch)) throw new TypeError('updateConfig: patch 必须是对象')
    const allowed = ['defaultCwd', 'fileMaxBytes']
    const unknown = Object.keys(patch).filter((key) => !allowed.includes(key))
    if (unknown.length > 0) throw new TypeError(`updateConfig: 不支持的字段 ${unknown.join(',')}`)
    if (!('defaultCwd' in patch) && !('fileMaxBytes' in patch)) {
      throw new TypeError('updateConfig: 至少提供 defaultCwd 或 fileMaxBytes')
    }
    const next = {}
    if ('defaultCwd' in patch) next.defaultCwd = assertCwd(patch.defaultCwd)
    if ('fileMaxBytes' in patch) next.fileMaxBytes = assertFileMaxBytes(patch.fileMaxBytes)
    return this.store.setConfig(next)
  }

  /**
   * 显式重试一条失败投递/失败入站。requestId 固定为 `feishu:<message_id>`：
   *   - 有对应 outbox 且 failed：重投该次答复；
   *   - 没有 outbox 但同 message_id 的 inbox failed：把 inbox failed→pending 重新入队
   *     （失败 inbox 不会自动重试，只能走这个显式动作）。
   * 其余状态都是 no-op，返回真实状态。
   * @param {string} requestId 形如 `feishu:<message_id>`
   * @returns {Promise<{retried: boolean, state: string}>}
   */
  async retryOutbox(requestId) {
    if (typeof requestId !== 'string' || !requestId.startsWith('feishu:')
      || requestId.length <= 'feishu:'.length) {
      throw new TypeError('retryOutbox: requestId 必须是 feishu:<message_id>')
    }
    const messageId = requestId.slice('feishu:'.length)
    const record = this.store.getOutbox(requestId)

    if (record === undefined) {
      // 面板「重试失败入站」：没有 outbox 时只重投对应 inbox。
      const queued = await this.inbound.retry(messageId)
      if (!queued) return { retried: false, state: 'missing' }
      const afterInbox = this.store.getInbox(messageId)
      return { retried: true, state: afterInbox?.state ?? 'pending' }
    }
    if (record.state !== 'failed') return { retried: false, state: record.state }

    // kind='failure' 是 prompt 准入失败的占位记录：真正要重做的是 inbox 那条消息，
    // 而不是把「本次消息处理失败」再发一遍。否则面板无论点「重试入站」还是
    // 「重试投递」都只补发失败摘要，inbox 永远停在 failed、prompt 永远不重发。
    if (record.kind === 'failure') {
      let inboxRecord
      try {
        inboxRecord = this.store.getInbox(messageId)
      } catch (error) {
        safeLog(this.log, 'warn', `重试读取 inbox 失败 request=${requestId}: ${redactError(error)}`)
      }
      // 已经在重投队列里：不重复 prompt，也不并发补发失败摘要。
      if (inboxRecord?.state === 'pending' || inboxRecord?.state === 'processing') {
        return { retried: false, state: inboxRecord.state }
      }
      const queued = await this.inbound.retry(messageId)
      if (queued) {
        const afterInbox = this.store.getInbox(messageId)
        return { retried: true, state: afterInbox?.state ?? 'pending' }
      }
      // 没有可重投的 failed inbox（例如记录已被处理/清理）：退回补发失败摘要。
    }

    await this.replies.retry(requestId)
    const after = this.store.getOutbox(requestId)
    return { retried: true, state: after?.state ?? 'unknown' }
  }
}

/**
 * 创建飞书桥 Runtime：打开 Store 并组装所有模块，但不启动网络（start 负责）。
 * @param {object} ctx Host 上下文
 * @param {object} [config] 部署配置/测试缝
 * @returns {Promise<FeishuRuntime>}
 */
export async function createFeishuRuntime(ctx, config = {}) {
  const runtime = new FeishuRuntime(ctx, config)
  await runtime._buildModules()
  return runtime
}

/**
 * Cordis 插件入口：创建 runtime、注册 owner-only routes、启动连接，并挂载清理器。
 * @param {object} ctx Host 上下文
 * @param {object} [config] 部署配置
 * @returns {Promise<void>}
 */
export async function apply(ctx, config = {}) {
  const runtime = await createFeishuRuntime(ctx, config)
  let disposeRoutes = async () => {}
  try {
    disposeRoutes = await registerFeishuRoutes(ctx, runtime)
  } catch (error) {
    await runtime.dispose()
    throw error
  }

  try {
    await ctx.effect(async () => async () => {
      await disposeRoutes()
      await runtime.dispose()
    }, 'feishu-runtime')
  } catch (error) {
    await disposeRoutes()
    await runtime.dispose()
    throw error
  }

  try {
    await runtime.start()
  } catch (error) {
    // start 自身已把错误折进 status；这里只保证插件加载不因网络失败而整体回滚。
    try {
      ctx.logger?.warn?.(`dsh-feishu: 启动失败: ${redactError(error)}`)
    } catch {
      // 日志出口异常忽略。
    }
  }
}
