// @gavinc-cn/dsh-feishu —— 入站持久 inbox、WS 生命周期与消息归一
//
// 目的：把飞书长连接收到的普通消息事件尽快 ACK（先持久 inbox），再由串行 worker 解析成
// `NormalizedMessage` 交给上层 `onMessage`。绑定码在这里消费：只有私聊的 `/bind <码>`
// 会写绑定，群聊、未绑定与未知类型都有明确处置。
//
// 设计约束：
//   - eventHandler 只做「解析信封 → 写 inbox → 排入 worker」；绝不 await 附件下载或
//     prompt，也不在回调里调用 onMessage。ACK 的 data 恒为 null（普通事件）。
//   - 持久 inbox 的 message_id 是幂等键：已存在的记录不覆盖、不重复入队；启动时恢复
//     pending 与上次中断的 processing（每条只补投一次，真正的 prompt 去重由 Task 8 的
//     `hasPrompt` 负责）。
//   - worker 串行：pending → processing → done/failed。failed 不自动重试，只留 error
//     （脱敏、截断）供面板/后续任务显式重试。
//   - stop：先让旧连接失效（generation 递增），再 close WS、等待当前 onMessage 收口；
//     排队但尚未开始的消息保留为 pending，下次 start 恢复。旧连接上的迟到事件/卡片
//     一律丢弃（不持久、不 prompt）。
//   - 换应用凭据（appId/appSecret 任一变化）时撤销全部旧绑定：open_id 是应用维度的，
//     换应用后旧绑定不得沿用。
//   - 不记录消息正文、open_id 或 Secret；日志只允许 message_id/类型/错误脱敏文本。
//
// 生效链路：Task 11 的 Host 总装创建 FeishuInbound，把 onMessage 接到 sessions、
// onCard 接到 interactions；start 由 runtime 在有凭据时调用。
import { BindingCodes, BINDING_MESSAGES } from './binding.mjs'
import { FeishuWsClient } from './feishu/ws.mjs'
import * as restApi from './feishu/rest.mjs'
import { redactError } from './utils.mjs'

/** 普通消息事件类型（其余未注册 event_type 回 ACK 500）。 */
export const MESSAGE_EVENT_TYPE = 'im.message.receive_v1'

/**
 * 卡片按钮回调的 event_type。真机把卡片动作作为 `type=event` 帧投递（不是 `type=card`），
 * SDK 注册名可能带 `p2.` 前缀，两种都接：交给 onCard，ACL/归属校验由 interactions 负责。
 */
export const CARD_ACTION_EVENT_TYPES = Object.freeze([
  'card.action.trigger',
  'p2.card.action.trigger',
])

/** 本插件支持归一的消息类型。 */
export const SUPPORTED_MESSAGE_TYPES = Object.freeze(['text', 'post', 'image', 'file'])

/** post 消息的 locale 包裹顺序（与飞书事件体一致：取第一个 dict）。 */
const POST_LOCALES = Object.freeze(['zh_cn', 'en_us', 'ja_jp'])

/** 未绑定私聊的引导文案（未绑定用户只收到这一条，绝不产生 prompt）。 */
export const UNBOUND_HINT = '尚未绑定 DSH 账号：请在 DSH 飞书桥面板生成绑定码，'
  + '然后在这里发送 /bind <绑定码>'

/** 未知/不支持消息类型的短提示。 */
export const UNSUPPORTED_HINT = '暂不支持该消息类型，请发送文字、图片或文件'

/** 判断普通对象（排除 null/数组/Buffer）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)
}

/**
 * 解析消息 content：飞书事件里是 JSON 字符串，测试/回调链里也可能已是对象。
 * @param {unknown} raw
 * @returns {object | null}
 */
function parseContent(raw) {
  if (isPlainObject(raw)) return raw
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 把 WS 回调载荷（Buffer/字符串/对象）解析成入站信封。
 *
 * 返回 `null` 表示不是可识别的消息载荷；字段缺失时给空串，由调用方决定是否忽略。
 * 普通文本会按 mentions[].key 去掉 `@_user_N` 占位符（保留用户可见文字），
 * 与既有 Touchstone 基线口径一致。
 *
 * @param {Buffer | string | object} input
 * @returns {{
 *   eventType: string, messageId: string, openId: string,
 *   chatType: 'p2p' | 'group', messageType: string, text: string,
 *   content: unknown, mentions: object[]
 * } | null}
 */
export function readEnvelope(input) {
  let root
  if (Buffer.isBuffer(input)) {
    try {
      root = JSON.parse(input.toString('utf8'))
    } catch {
      return null
    }
  } else if (typeof input === 'string') {
    try {
      root = JSON.parse(input)
    } catch {
      return null
    }
  } else if (isPlainObject(input)) {
    root = input
  } else {
    return null
  }
  if (!isPlainObject(root)) return null

  const header = isPlainObject(root.header) ? root.header : {}
  const event = isPlainObject(root.event) ? root.event : root
  if (!isPlainObject(event)) return null
  // message 可以缺席（未注册事件的 event 体可能没有 message）：仍要解出 event_type，
  // 交给 WS 回调按「未注册类型 ⇒ 抛错 ⇒ ACK 500」处理。
  const message = isPlainObject(event.message) ? event.message : null
  const sender = isPlainObject(event.sender) ? event.sender : null
  const senderId = sender !== null && isPlainObject(sender.sender_id) ? sender.sender_id : null
  const mentions = message !== null && Array.isArray(message.mentions) ? message.mentions : []

  let text = ''
  if (message !== null && message.message_type === 'text') {
    const content = parseContent(message.content)
    if (content !== null && typeof content.text === 'string') {
      text = content.text.trim()
      for (const mention of mentions) {
        if (!isPlainObject(mention)) continue
        if (typeof mention.key !== 'string' || mention.key.length === 0) continue
        text = text.split(mention.key).join('').trim()
      }
    }
  }

  return {
    eventType: typeof header.event_type === 'string' ? header.event_type : '',
    messageId: message !== null && typeof message.message_id === 'string' ? message.message_id : '',
    openId: senderId !== null && typeof senderId.open_id === 'string' ? senderId.open_id : '',
    chatType: message !== null && message.chat_type === 'group' ? 'group' : 'p2p',
    messageType: message !== null && typeof message.message_type === 'string' ? message.message_type : '',
    text,
    content: message !== null ? message.content : undefined,
    mentions,
  }
}

/**
 * 解析 post 消息内容（locale 包裹、标题、段落、图片），写入 text/resources。
 * @param {unknown} content 原始 content
 * @param {{text: string, resources: object[]}} target
 * @returns {void}
 */
function parsePost(content, target) {
  const parsed = parseContent(content)
  if (parsed === null) return
  let post = parsed
  for (const locale of POST_LOCALES) {
    if (isPlainObject(parsed[locale])) {
      post = parsed[locale]
      break
    }
  }

  const lines = []
  if (typeof post.title === 'string' && post.title.trim() !== '') {
    lines.push(post.title.trim())
  }
  if (Array.isArray(post.content)) {
    for (const paragraph of post.content) {
      if (!Array.isArray(paragraph)) continue
      let line = ''
      for (const block of paragraph) {
        if (!isPlainObject(block)) continue
        if (block.tag === 'text' || block.tag === 'a') {
          if (typeof block.text === 'string') line += block.text // a 只取显示文字，不取 href
        } else if (block.tag === 'img') {
          if (typeof block.image_key === 'string' && block.image_key.length > 0) {
            target.resources.push({ kind: 'image', key: block.image_key, name: '' })
          }
        }
      }
      if (line.trim() !== '') lines.push(line)
    }
  }
  target.text = lines.join('\n')
}

/**
 * 把一条原始事件归一成 `NormalizedMessage`。
 *
 * 只接受 text/post/image/file；其它类型（audio/media/sticker/...）与无法解析的载荷
 * 返回 `null`，由 worker 回支持范围提示。字段缺失时仍返回对象，空 text+空 resources
 * 由 worker 静默丢弃。
 *
 * @param {Buffer | string | object} input 原始事件或实现体
 * @returns {{
 *   id: string, openId: string, chatType: 'p2p' | 'group',
 *   kind: 'text' | 'post' | 'image' | 'file', text: string,
 *   resources: Array<{kind: 'image' | 'file', key: string, name: string, size?: number, mediaType?: string}>
 * } | null}
 */
export function parseMessage(input) {
  const envelope = readEnvelope(input)
  if (envelope === null || envelope.messageType === '') return null
  if (!SUPPORTED_MESSAGE_TYPES.includes(envelope.messageType)) return null
  if (envelope.messageId === '' || envelope.openId === '') return null

  const message = {
    id: envelope.messageId,
    openId: envelope.openId,
    chatType: envelope.chatType,
    kind: envelope.messageType,
    text: envelope.text,
    resources: [],
  }

  if (envelope.messageType === 'post') {
    message.text = ''
    parsePost(envelope.content, message)
    return message
  }

  const content = parseContent(envelope.content)
  if (envelope.messageType === 'text') {
    // text 已在 readEnvelope 里解出并剥离 @ 占位符。
    if (content !== null && typeof content.text === 'string') {
      message.text = envelope.text
    }
    return message
  }

  if (envelope.messageType === 'image') {
    if (content !== null && typeof content.image_key === 'string' && content.image_key.length > 0) {
      message.resources.push({ kind: 'image', key: content.image_key, name: '' })
    }
    return message
  }

  // file
  if (content !== null && typeof content.file_key === 'string' && content.file_key.length > 0) {
    const resource = {
      kind: 'file',
      key: content.file_key,
      name: typeof content.file_name === 'string' ? content.file_name : '',
    }
    const rawSize = content.file_size
    const size = typeof rawSize === 'number'
      ? (Number.isFinite(rawSize) && rawSize >= 0 ? Math.trunc(rawSize) : undefined)
      : (typeof rawSize === 'string' && /^[0-9]+$/.test(rawSize) ? Number(rawSize) : undefined)
    if (size !== undefined) resource.size = size
    message.resources.push(resource)
  }
  return message
}

/**
 * 识别 `/bind <码>` 命令。
 * @param {string} text 已剥离 @ 占位符的文本
 * @returns {string | null} null=不是绑定命令；''=命令缺码；否则为码
 */
function bindCommand(text) {
  if (typeof text !== 'string') return null
  const match = /^\/bind(?:\s+(\S+))?\s*$/i.exec(text.trim())
  if (match === null) return null
  return match[1] ?? ''
}

/**
 * 飞书入站运行时：拥有 WS 客户端、持久 inbox、串行 worker 与绑定命令消费。
 *
 * 构造依赖（全部可注入，生产由 Task 11 总装）：
 * - `store`：Task 3 Store（inbox/bindings 钩子）。
 * - `bindings`：可选 BindingCodes；缺省用同一个 store/now 新建。
 * - `onMessage(message)`：处理归一后的普通消息（prompt 等），可异步、可为慢操作。
 * - `onCard(payload)`：卡片回调，原样接收 WS payload。
 * - `rest`：REST 客户端（只用到 restReply/restSendText），缺省真实现。
 * - `now` / `log`：时钟与脱敏日志出口。
 * - `createWsClient(options)`：WS 客户端工厂（测试注入假客户端）。
 * - `WebSocket` / `fetch` / `autoReconnect`：透传给 FeishuWsClient（测试替身/重连策略）。
 */
export class FeishuInbound {
  constructor({
    store,
    bindings,
    onMessage,
    onCard,
    rest = restApi,
    now = Date.now,
    log = () => {},
    createWsClient,
    WebSocket,
    fetch,
    autoReconnect,
  } = {}) {
    if (store === null || store === undefined) {
      throw new TypeError('FeishuInbound: 必须提供 store')
    }
    if (typeof onMessage !== 'function') {
      throw new TypeError('FeishuInbound: onMessage 必须是函数')
    }
    if (typeof onCard !== 'function') {
      throw new TypeError('FeishuInbound: onCard 必须是函数')
    }
    if (typeof now !== 'function') throw new TypeError('FeishuInbound: now 必须是函数')

    this._store = store
    this._bindings = bindings ?? new BindingCodes({ store, now })
    this._onMessage = onMessage
    this._onCard = onCard
    this._rest = rest
    this._now = now
    this._logFn = typeof log === 'function' ? log : () => {}
    this._createWsClient = typeof createWsClient === 'function'
      ? createWsClient
      : (options) => new FeishuWsClient(options)
    this._WebSocket = WebSocket
    this._fetch = fetch
    this._autoReconnect = autoReconnect

    this._client = null
    this._credentials = null
    this._runPromise = null
    this._generation = 0
    this._queue = []
    this._knownIds = new Set()
    this._flights = new Set()
    this._pumping = false
    this._pumpPromise = null
    this._scheduled = null
    this._stopping = false
    this._activeId = null
    this._lastError = ''
  }

  // ---------------------------------------------------------------- 生命周期

  /**
   * 启动入站：校验凭据、换凭据时撤销旧绑定、构造 WS 客户端并恢复 inbox。
   *
   * 与 FeishuWsClient.start 的返回值语义解耦：`client.start()` 的 Promise 表示「连接
   * 生命周期结束」，本方法只把它挂到 `_runPromise` 上，不阻塞 start 返回；连接失败会
   * 记录脱敏 lastError，不向调用方抛网络错误（Task 11 的 runtime 以 status 展示）。
   *
   * @param {{appId: string, appSecret: string}} credentials
   * @returns {Promise<void>}
   */
  async start(credentials) {
    if (!isPlainObject(credentials)) {
      throw new TypeError('FeishuInbound.start: credentials 必须是 {appId, appSecret} 对象')
    }
    const appId = credentials.appId
    const appSecret = credentials.appSecret
    if (typeof appId !== 'string' || appId.length === 0
      || typeof appSecret !== 'string' || appSecret.length === 0) {
      throw new TypeError('FeishuInbound.start: appId/appSecret 必须是非空字符串')
    }

    if (this._client !== null) {
      if (this._sameCredentials({ appId, appSecret })) return
      // 换应用：先停旧连接、作废旧码，再撤销旧应用维度上的全部绑定。
      // 撤销失败会向上抛（fail closed），不会带着旧绑定启动新应用。
      await this.stop()
      this._resetBindingCodes()
      await this._revokeAllBindings()
    } else if (this._credentials !== null && !this._sameCredentials({ appId, appSecret })) {
      this._resetBindingCodes()
      await this._revokeAllBindings()
    }

    this._credentials = { appId, appSecret }
    const generation = ++this._generation
    const options = {
      appId,
      appSecret,
      eventHandler: (payload) => this._handleEventFrame(payload, generation),
      cardHandler: (payload) => this._handleCardFrame(payload, generation),
      log: (level, message) => this._log(level, message),
    }
    if (this._WebSocket !== undefined) options.WebSocket = this._WebSocket
    if (this._fetch !== undefined) options.fetch = this._fetch
    if (this._autoReconnect !== undefined) options.autoReconnect = this._autoReconnect

    const client = this._createWsClient(options)
    this._client = client
    this._lastError = ''

    const run = Promise.resolve().then(() => client.start())
    this._runPromise = run
      .catch((error) => {
        this._lastError = this._sanitizeError(error)
        this._log('error', `WS 退出: ${this._lastError}`)
      })
      .finally(() => {
        if (this._client === client) this._client = null
      })

    await this._recover()
  }

  /**
   * 停止入站：作废旧回调、关闭 WS、等待当前 worker 处理收口。
   * 排队未开始的消息保留为 pending，下次 start 恢复；重复调用幂等。
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._client === null && this._runPromise === null && !this._pumping
      && this._queue.length === 0 && this._scheduled === null) {
      this._generation += 1 // 让任何残留闭包失效
      return
    }

    this._stopping = true
    this._generation += 1
    if (this._scheduled !== null) {
      clearImmediate(this._scheduled)
      this._scheduled = null
    }
    // 尚未开始的消息保持 pending，交给下次 start 恢复；当前处理项继续跑完。
    this._queue.length = 0

    const client = this._client
    this._client = null
    if (client !== null && typeof client.close === 'function') {
      try {
        await client.close()
      } catch (error) {
        this._log('warn', `WS 关闭失败: ${this._sanitizeError(error)}`)
      }
    }

    // 等待已在途的事件/卡片回调（例如仍 await putInbox 的那种）收口，防止 stop 返回后
    // 它们再入队/再 prompt。迟到回调会在 putInbox 后重查 generation，只留 pending 记录。
    const flights = [...this._flights]
    if (flights.length > 0) await Promise.allSettled(flights)
    this._flights.clear()

    const run = this._runPromise
    this._runPromise = null
    if (run !== null) {
      try {
        await run
      } catch {
        // run 自身已 catch；这里只保证 stop 不因旧连接异常而拒绝。
      }
    }

    const pump = this._pumpPromise
    if (pump !== null) {
      try {
        await pump
      } catch {
        // worker 顶层已记录；stop 仍需收口。
      }
    }

    this._knownIds.clear()
    this._stopping = false
  }

  /**
   * 显式重试一条 failed inbox：failed → pending 后重新入队。
   *
   * 为什么不在启动时自动重试 failed：worker 可能在 prompt 已进入 DSH 后才失败，自动
   * 重放会重复投递；只有面板/管理 API 的显式动作才把记录放回队列。真正的 prompt 去重
   * 仍由 Task 8 的 `hasPrompt` 兜底。
   * @param {string} id message_id
   * @returns {Promise<boolean>} 是否把记录重新入队
   */
  async retry(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('FeishuInbound.retry: id 必须是非空字符串')
    }
    if (this._stopping) return false
    let record
    try {
      record = this._store.getInbox(id)
    } catch (error) {
      this._log('error', `重试读取入站失败 message_id=${id}: ${this._sanitizeError(error)}`)
      return false
    }
    if (record === undefined || record.state !== 'failed') return false
    try {
      await this._store.updateInbox(id, (current) => (
        current.state === 'failed'
          ? { ...current, state: 'pending', nextAttemptAt: 0, error: '' }
          : current
      ))
    } catch (error) {
      this._log('error', `重试状态写入失败 message_id=${id}: ${this._sanitizeError(error)}`)
      return false
    }
    if (this._knownIds.has(id)) return true
    this._knownIds.add(id)
    this._queue.push(id)
    this._schedulePump()
    return true
  }

  /**
   * 等待当前队列全部处理完（不关闭连接）。测试与优雅收尾使用。
   * @returns {Promise<void>}
   */
  async drain() {
    for (;;) {
      if (this._stopping) return
      if (this._queue.length > 0 && !this._pumping) this._pump()
      const current = this._pumpPromise
      if (current === null) {
        if (this._queue.length === 0) return
        continue
      }
      try {
        await current
      } catch {
        // _pump 已兜底；继续观察队列。
      }
      if (this._queue.length === 0 && !this._pumping) return
    }
  }

  /**
   * 当前状态（面板用）：只含运行态、队列/状态计数与最近一次脱敏错误。
   * @returns {object}
   */
  status() {
    const counts = { pending: 0, processing: 0, done: 0, failed: 0 }
    try {
      for (const [, record] of this._store.inboxEntries()) {
        if (Object.hasOwn(counts, record.state)) counts[record.state] += 1
      }
    } catch {
      // Store 不可用时只报运行态，避免面板因计数失败而崩。
    }
    return {
      // 真实 socket 状态：running 只表示 inbound 仍持有客户端，重连期间仍为 true。
      connected: this._client?.connected === true,
      running: this._client !== null && !this._stopping,
      active: this._activeId,
      queued: this._queue.length,
      pending: counts.pending,
      processing: counts.processing,
      done: counts.done,
      failed: counts.failed,
      lastError: this._lastError,
    }
  }

  // ---------------------------------------------------------------- WS 回调

  /** 旧连接（generation 不匹配）或 stop 中：回调一律丢弃。 */
  _accepts(generation) {
    return generation === this._generation && this._client !== null && !this._stopping
  }

  /**
   * 普通事件回调的外壳：同步注册到在途集合，便于 stop() 等待 putInbox 收口。
   * @param {Buffer | string} payload 合包后的 payload 字节
   * @param {number} generation 连接代次
   * @returns {Promise<null>} ACK data 恒为 null
   */
  _handleEventFrame(payload, generation) {
    if (!this._accepts(generation)) return Promise.resolve(null)
    const flight = this._handleEventFrameInner(payload, generation)
    this._trackFlight(flight)
    return flight
  }

  /**
   * 普通事件处理：解析信封 → 幂等检查 → 持久 inbox → 排入 worker，然后立即返回。
   * 未注册 event_type 按 Task 2 契约抛错（WS 回 ACK 500）。
   * @param {Buffer | string} payload
   * @param {number} generation
   * @returns {Promise<null>}
   */
  async _handleEventFrameInner(payload, generation) {
    const raw = Buffer.isBuffer(payload)
      ? payload.toString('utf8')
      : (typeof payload === 'string' ? payload : null)
    if (raw === null) return null

    const envelope = readEnvelope(raw)
    if (envelope === null) return null
    if (CARD_ACTION_EVENT_TYPES.includes(envelope.eventType)) {
      // 真机卡片动作走 type=event：不写 inbox、不 prompt，原始 payload 交给 onCard；
      // 返回 null ⇒ ACK 200（避免飞书把已送达的卡片动作当失败重推）。
      this._scheduleCardCallback(payload, generation)
      return null
    }
    if (envelope.eventType !== MESSAGE_EVENT_TYPE) {
      // Task 2 的 ACK 契约：handler 抛错 ⇒ ACK 500；不能静默 200 吞掉未注册事件。
      throw new Error(`processor not found, type: ${envelope.eventType || 'unknown'}`)
    }
    const id = envelope.messageId
    const openId = envelope.openId
    if (id === '' || openId === '') return null

    // 幂等：内存里的在途集合 + 持久记录；重复 message_id 不覆盖、不重复入队。
    if (this._knownIds.has(id)) return null
    let existing
    try {
      existing = this._store.getInbox(id)
    } catch (error) {
      // 本地持久层瞬时失败不能当成「已处理」：抛出后 WS 回 ACK 500，让飞书重推。
      this._log('error', `入站查询失败 message_id=${id}: ${this._sanitizeError(error, envelope.text)}`)
      throw error
    }
    if (existing !== undefined) {
      // 已持久化的记录默认不重复处理。唯一例外：failed 记录被飞书重推同一条消息
      // （用户/平台显式重发）时复位为 pending 重新入队；启动时仍然不会自动重试
      // failed（见 _recover），避免崩溃后未经确认的重复 prompt。
      if (existing.state !== 'failed') return null
      let requeued
      try {
        requeued = await this._store.updateInbox(id, (current) => (
          current.state === 'failed'
            ? { ...current, state: 'pending', nextAttemptAt: 0, error: '' }
            : current
        ))
      } catch (error) {
        this._log('error', `入站重推复位失败 message_id=${id}: ${this._sanitizeError(error, envelope.text)}`)
        throw error // ACK 500，让飞书稍后再推
      }
      if (generation !== this._generation || this._stopping) return null
      if (requeued?.state !== 'pending' || this._knownIds.has(id)) return null
      this._knownIds.add(id)
      this._queue.push(id)
      this._schedulePump()
      return null
    }

    this._knownIds.add(id)
    const record = {
      openId,
      raw,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      error: '',
      receivedAt: this._now(),
    }
    try {
      await this._store.putInbox(id, record)
    } catch (error) {
      this._knownIds.delete(id)
      this._log('error', `入站持久化失败 message_id=${id}: ${this._sanitizeError(error, envelope.text)}`)
      throw error // WS 层回 ACK 500，让飞书重推
    }

    // 等待 putInbox 期间可能已经 stop/换代次：记录已持久，但不得再入队或 prompt。
    // 只查 generation/_stopping（不查 _client）：自然断线时已接受的事件仍可交给 worker。
    if (generation !== this._generation || this._stopping) {
      this._knownIds.delete(id)
      return null
    }

    this._queue.push(id)
    this._schedulePump()
    return null
  }

  /**
   * 卡片回调：照 WS 客户端的线程语义另起一路，不 await、不让异常回到 WS。
   * 排入微任务后、真正执行前再核对 generation，避免 stop 后旧卡片仍被执行。
   * @param {Buffer | string} payload
   * @param {number} generation
   * @returns {void}
   */
  _handleCardFrame(payload, generation) {
    if (!this._accepts(generation)) return
    this._scheduleCardCallback(payload, generation)
  }

  /**
   * 把卡片 payload 交给 onCard：另起一路、不 await；执行前重查 generation/stopping，
   * 避免 stop 后旧卡片仍被执行。type=card 帧与 type=event 的 card.action.trigger 共用。
   * @param {Buffer | string} payload
   * @param {number} generation
   * @returns {void}
   */
  _scheduleCardCallback(payload, generation) {
    const flight = Promise.resolve()
      .then(() => {
        if (generation !== this._generation || this._stopping) return undefined
        return this._onCard(payload)
      })
      .catch((error) => this._log('error', `卡片处理失败: ${this._sanitizeError(error)}`))
    this._trackFlight(flight)
  }

  /**
   * 登记在途回调 Promise；settle 后自动移出。stop() 会等待快照里的所有 Promise。
   * @param {Promise<unknown>} promise
   * @returns {void}
   */
  _trackFlight(promise) {
    this._flights.add(promise)
    const remove = () => { this._flights.delete(promise) }
    promise.then(remove, remove)
  }

  // ---------------------------------------------------------------- worker

  /** 串行调度：setImmediate 保证 eventHandler 先返回、ACK 先发出。 */
  _schedulePump() {
    if (this._scheduled !== null || this._pumping || this._stopping) return
    this._scheduled = setImmediate(() => {
      this._scheduled = null
      this._pump()
    })
    if (typeof this._scheduled.unref === 'function') this._scheduled.unref()
  }

  /** 启动 worker 循环（幂等）。 */
  _pump() {
    if (this._pumping || this._stopping) return
    this._pumping = true
    this._pumpPromise = this._runQueue()
      .catch((error) => {
        this._lastError = this._sanitizeError(error)
        this._log('error', `入站 worker 异常: ${this._lastError}`)
      })
      .finally(() => this._finishPump())
  }

  /**
   * worker 收口：落旗后如果队列里又进了新项，补调度一次。
   * 覆盖「事件在 _runQueue 判空之后、finally 落旗之前入队」的窄窗口。
   * @returns {void}
   */
  _finishPump() {
    this._pumping = false
    this._pumpPromise = null
    if (!this._stopping && this._queue.length > 0) this._schedulePump()
  }

  /** 顺序处理队列；stop 后不再开始新项。 */
  async _runQueue() {
    while (!this._stopping && this._queue.length > 0) {
      const id = this._queue.shift()
      await this._process(id)
    }
  }

  /**
   * 处理单条 inbox：pending→processing→done/failed。
   * @param {string} id message_id
   * @returns {Promise<void>}
   */
  async _process(id) {
    let record
    try {
      record = this._store.getInbox(id)
    } catch (error) {
      this._knownIds.delete(id)
      this._log('error', `入站读取失败 message_id=${id}: ${redactError(error)}`)
      return
    }
    if (record === undefined || record.state === 'done') {
      this._knownIds.delete(id)
      return
    }

    let processing
    try {
      processing = await this._store.updateInbox(id, (current) => ({
        ...current,
        state: 'processing',
        attempts: current.attempts + 1,
        error: '',
      }))
    } catch (error) {
      this._knownIds.delete(id)
      this._log('error', `入站状态更新失败 message_id=${id}: ${redactError(error)}`)
      return
    }

    this._activeId = id
    try {
      await this._dispatch(processing)
      await this._store.updateInbox(id, (current) => ({
        ...current,
        state: 'done',
        error: '',
        nextAttemptAt: 0,
      }))
    } catch (error) {
      // onMessage 抛出的错误可能夹带正文/Secret：记录与日志都按「已知敏感值」再脱敏。
      const body = readEnvelope(processing.raw)?.text ?? ''
      const message = this._sanitizeError(error, body).slice(0, 1000)
      this._lastError = message
      try {
        await this._store.updateInbox(id, (current) => ({
          ...current,
          state: 'failed',
          error: message,
          nextAttemptAt: this._now() + 30_000,
        }))
      } catch (inner) {
        this._log('error', `入站失败状态写入失败 message_id=${id}: ${this._sanitizeError(inner, body)}`)
      }
      this._log('error', `入站处理失败 message_id=${id}: ${message}`)
    } finally {
      if (this._activeId === id) this._activeId = null
      this._knownIds.delete(id)
    }
  }

  /**
   * 按业务顺序处理一条已认领记录：群聊静默 → /bind → 未绑定引导 → 归一/提示 → onMessage。
   * @param {object} record InboxRecord
   * @returns {Promise<void>}
   */
  async _dispatch(record) {
    const envelope = readEnvelope(record.raw)
    if (envelope === null || envelope.eventType !== MESSAGE_EVENT_TYPE) return
    if (envelope.chatType !== 'p2p') return // 群聊：零 prompt、零回执
    if (envelope.openId === '' || envelope.messageId === '') return

    const code = bindCommand(envelope.text)
    if (code !== null) {
      if (code === '') {
        await this._reply(envelope.messageId, BINDING_MESSAGES.usage)
        return
      }
      let result
      try {
        result = await this._bindings.verify(code, envelope.openId)
      } catch (error) {
        this._log('error', `绑定校验失败 message_id=${envelope.messageId}: ${this._sanitizeError(error, envelope.text)}`)
        await this._reply(envelope.messageId, '绑定处理失败，请稍后重试')
        throw error // 绑定未写成功：进 failed，码未消费时可重试
      }
      await this._reply(envelope.messageId, result.message)
      return
    }

    let binding
    try {
      binding = this._store.getBinding(envelope.openId)
    } catch (error) {
      this._log('error', `绑定读取失败 message_id=${envelope.messageId}: ${this._sanitizeError(error, envelope.text)}`)
      throw error // 进 failed，保留显式重试机会
    }
    if (binding === undefined) {
      await this._reply(envelope.messageId, UNBOUND_HINT)
      return
    }

    const message = parseMessage(record.raw)
    if (message === null) {
      await this._reply(envelope.messageId, UNSUPPORTED_HINT)
      return
    }
    if (message.text.length === 0 && message.resources.length === 0) return
    await this._onMessage(message)
  }

  /**
   * 回执：失败只记脱敏日志，不把消息打回 failed（回执失败不影响已完成的业务处置）。
   * @param {string} messageId
   * @param {string} text
   * @returns {Promise<void>}
   */
  async _reply(messageId, text) {
    if (messageId === '') return
    try {
      await this._rest.restReply(messageId, text, this._credentials)
    } catch (error) {
      this._log('warn', `飞书回执失败 message_id=${messageId}: ${this._sanitizeError(error)}`)
    }
  }

  // ---------------------------------------------------------------- 恢复 / 撤销

  /**
   * 启动恢复：pending 直接排队；processing 视为上次中断、改回 pending 后排队。
   * 已完成/失败的不自动重试。
   * @returns {Promise<void>}
   */
  async _recover() {
    let entries
    try {
      entries = this._store.inboxEntries()
    } catch (error) {
      this._log('error', `inbox 恢复失败: ${this._sanitizeError(error)}`)
      return
    }
    entries.sort((a, b) => (a[1].receivedAt ?? 0) - (b[1].receivedAt ?? 0))
    for (const [id, record] of entries) {
      if (this._knownIds.has(id)) continue
      if (record.state === 'processing') {
        try {
          await this._store.updateInbox(id, (current) => ({ ...current, state: 'pending' }))
        } catch (error) {
          this._log('error', `inbox 恢复状态失败 message_id=${id}: ${this._sanitizeError(error)}`)
          continue
        }
      } else if (record.state !== 'pending') {
        continue
      }
      this._knownIds.add(id)
      this._queue.push(id)
    }
    if (this._queue.length > 0) this._schedulePump()
  }

  /**
   * 换凭据时清空内存里的未使用绑定码与限频记录。
   * @returns {void}
   */
  _resetBindingCodes() {
    if (this._bindings !== null && this._bindings !== undefined
      && typeof this._bindings.reset === 'function') {
      this._bindings.reset()
    }
  }

  /**
   * 换凭据时撤销全部绑定（逐 open_id 调用 BindingCodes.revoke）。
   * 失败必须向上抛：旧绑定无法确认撤销时不得启动新应用（fail closed）。
   * @returns {Promise<void>}
   */
  async _revokeAllBindings() {
    let entries
    try {
      entries = this._store.bindingEntries()
    } catch (error) {
      const message = `撤销旧绑定失败：无法读取绑定列表（${this._sanitizeError(error)}）`
      this._lastError = message
      this._log('error', message)
      throw new Error(message, { cause: error })
    }

    const failures = []
    for (const [openId] of entries) {
      try {
        await this._bindings.revoke(openId)
      } catch (error) {
        failures.push(error)
        this._log('error', `撤销绑定失败: ${this._sanitizeError(error)}`)
      }
    }
    if (failures.length > 0) {
      const message = `撤销旧绑定失败：${failures.length} 个 open_id 未被删除，已拒绝切换应用`
      this._lastError = message
      this._log('error', message)
      throw new Error(message, { cause: failures[0] })
    }
  }

  /** 凭据比较：只比字段，不落日志。 */
  _sameCredentials(credentials) {
    return this._credentials !== null
      && this._credentials.appId === credentials.appId
      && this._credentials.appSecret === credentials.appSecret
  }

  /** 统一日志出口：所有插值先脱敏；调用方只传元数据，不传正文。 */
  _log(level, message) {
    try {
      this._logFn(level, redactError(String(message)))
    } catch {
      // 日志出口自身失败不能影响入站主流程。
    }
  }

  /**
   * 错误脱敏：在 `redactError` 之上再抹掉「当前 App Secret」和调用方给的正文。
   * onMessage/store 抛出的错误可能把用户正文或 Secret 拼进 message，单纯键值脱敏
   * 覆盖不到裸值；这里按已知敏感值做值替换。
   * @param {unknown} error
   * @param {string} [text=''] 当前消息正文（可为空）
   * @returns {string}
   */
  _sanitizeError(error, text = '') {
    let out = redactError(error)
    const secret = this._credentials === null ? '' : this._credentials.appSecret
    if (typeof secret === 'string' && secret.length > 0) {
      out = out.split(secret).join('[REDACTED]')
    }
    if (typeof text === 'string' && text.length > 0) {
      out = out.split(text).join('[REDACTED]')
    }
    return out
  }
}
