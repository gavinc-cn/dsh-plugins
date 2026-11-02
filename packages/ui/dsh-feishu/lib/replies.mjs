// @gavinc-cn/dsh-feishu —— durable 答复归集与 outbox 文本投递
//
// 目的：Track 一个已进入 DSH prompt 队列的飞书 requestId，持久一条 outbox，
// 通过 `sessionController.follow` 消费该会话的 durable 事件；用 user/message 的
// `source.rpcId` 关联 requestId，在 turn/end 时把 assistant/message 里的 text
// 恰好投递一次。默认投递是飞书短文本（uuid=requestId，飞书侧幂等去重），Task 9
// 会用云文档 deliver 替换。
//
// 设计约束：
//   - track 必须先 `putOutbox` 持久 pending（kind=reply），再开始 follow；进程在
//     两步之间崩溃时，恢复侧仍能看到 outbox 记录。
//   - follow 只消费 durable 事件：snapshot.records 与 live `type:'event'` 帧按 seq
//     去重；`assistant-stream` 帧、reasoning block、tool-call 等一律不读取。
//   - 每个 sessionId 只开一个 follower，多个 requestId 在同一流上按 rpcId 关联；
//     follower 的 snapshot 是 opening cut，live 从 cursor 之后无缝继续。
//   - turn/end 对每个已关联 requestId 只收口一次（内存 finalized 标记 + outbox
//     done/failed 状态双重判断）；completed 交付正文，error/aborted 等非 completed
//     原因只追加固定安全摘要，绝不把 DSH 错误对象拼进用户消息或日志。
//   - 投递失败：attempts+1、state=failed、nextAttemptAt=now+retryDelayMs*2^(n-1)
//     （封顶 1 小时），只持久退避，不自动定时重试；`retry(requestId)` 只处理 failed。
//   - hasPrompt 以 durable 会话日志/page 为准：先取 follow opening snapshot 的
//     cursor，再把 `sessionController.page({throughSeq: cursor, beforeSeq?})` 从新到旧
//     翻页，找 user/message 的 source.rpcId；pending outbox 本身不算已 prompt。
//     page 的 cut 固定为 opening cursor（DSH 要求 throughSeq 不得越过当前游标）。
//   - close 幂等：abort 全部 follower 并等待其 finally 收口；关闭后拒绝新 track。
//   - 不记录正文、open_id、Secret；日志只留 requestId/sessionId/attempts 与脱敏错误。
//
// 已知边界：
//   - DSH 的 user/message 事件本身不带 turn 字段，turn 由之前的 turn/start 决定。
//     page/snapshot 可能从 turn/start 之后切起，此时用「下一条 assistant/message 或
//     turn/end 的 data.turn」作为 fallback 绑定最早一个未关联 requestId；该 fallback
//     只在同一 turn 内单请求时准确，批量 prompt 同 turn 时仍以 rpcId 为主。
//   - 一个 turn 内若 DSH 合并了多条排队 prompt（batch），assistant/message 的正文
//     会记到该 turn 关联的全部 requestId 上；这是 DSH 不提供 per-message 关联时的
//     已知歧义，正常逐条 prompt 不受影响。
//   - error/aborted 只发固定摘要，不尝试解释具体错误码；面板重试仍可投递失败记录。
//   - hasPrompt 为取 cursor 会短暂打开一次 follow（maxMessages:1）后立即关闭；真实
//     DSH 的 follow 会激活 cold session，这是当前 sessionController 唯一暴露 cursor
//     的读取路径，Task 8 只在恢复路径调用它。
//
// 生效链路：Task 11 总装创建 FeishuReplies({store, sessionController, rest, ...})，
// Task 8 在 prompt 前 track、prompt 失败时 fail、恢复前 hasPrompt；Task 9 替换 deliver。
import * as restApi from './feishu/rest.mjs'
import { redactError } from './utils.mjs'

/** 默认首次投递失败后的退避时间（毫秒）；后续按 2 的幂增长。 */
export const DEFAULT_RETRY_DELAY_MS = 30_000

/** 退避上限（毫秒），避免 attempts 很大时溢出或无限等待。 */
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1000

/** 持久错误文本上限，避免把整段堆栈写进 outbox/面板。 */
const MAX_ERROR_LENGTH = 500

/** hasPrompt 翻页时每页请求的 message 数（DSH 默认 50）。 */
const PAGE_MAX_MESSAGES = 50

/** 翻页保护上限，防止异常 page 实现返回 hasMore 永不收敛。 */
const MAX_PAGE_LOOPS = 1_000

/** 非 completed turn 的安全摘要（固定文案，绝不拼接错误原文）。 */
export const TURN_SUMMARIES = Object.freeze({
  aborted: '本轮已取消，未生成答复。',
  blocked: '本轮被阻塞，未生成答复。',
  error: '本轮处理失败，未生成完整答复，请稍后重试。',
  'max-tokens': '答复因长度限制被截断。',
  interrupted: '本轮已中断，未生成答复。',
  forked: '本轮在分支点中断，未生成答复。',
})

/** 未知非 completed 原因的回退摘要。 */
const DEFAULT_TURN_SUMMARY = '本轮未生成答复。'

/** prompt 准入失败（尚未产生 durable turn）时写入 outbox 的安全正文。 */
export const PROMPT_FAILURE_TEXT = '本次消息处理失败，请稍后重试。'

/**
 * 把任意错误转成可持久化的安全文本：先 redactError，再截断。
 * @param {unknown} error
 * @returns {string}
 */
function safeErrorText(error) {
  const text = redactError(error)
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text
}

/**
 * 取出 assistant/message 中所有 text block 的正文，按事件内顺序用换行连接。
 * reasoning/tool-call 等非 text block 一律忽略。
 * @param {object} event durable assistant/message 事件
 * @returns {string}
 */
function assistantText(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 从 durable event 信封里取出事件本体（兼容 snapshot record 与 live 裸事件）。 */
function eventOf(record) {
  if (record === null || typeof record !== 'object') return undefined
  if (record.event !== null && typeof record.event === 'object') return record.event
  if (typeof record.type === 'string' && Number.isSafeInteger(record.seq)) return record
  return undefined
}

/** 校验非空字符串身份参数。 */
function assertId(kind, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`FeishuReplies: ${kind} 必须是非空字符串`)
  }
  return value
}

/**
 * 飞书答复归集器。所有依赖可注入，测试不触网、不读真实凭据。
 */
export class FeishuReplies {
  /**
   * @param {object} options
   * @param {object} options.store Task 3 Store（至少 get/put/updateOutbox）
   * @param {object} options.sessionController DSH sessionController（follow，hasPrompt 还用 page）
   * @param {(record: object) => Promise<{kind: string, documentId?: string, url?: string}>} [options.deliver]
   * @param {object} [options.rest] REST 客户端：`sendText(openId,text,{uuid})` 或 Task 2 的
   *   `restSendText(openId,text,cfg,{uuid})`（此时需带 `credentials`/`cfg`）
   * @param {() => number} [options.now] 时钟（测试注入）
   * @param {number} [options.retryDelayMs] 首次失败退避毫秒
   * @param {(level: string, message: string) => void} [options.log] 脱敏日志出口
   */
  constructor({
    store,
    sessionController,
    deliver,
    rest = restApi,
    now = Date.now,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    log = () => {},
  } = {}) {
    if (store === null || store === undefined) {
      throw new TypeError('FeishuReplies: 必须提供 store')
    }
    if (sessionController === null || sessionController === undefined
      || typeof sessionController.follow !== 'function') {
      throw new TypeError('FeishuReplies: sessionController.follow 必须是函数')
    }
    if (typeof now !== 'function') throw new TypeError('FeishuReplies: now 必须是函数')
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
      throw new TypeError('FeishuReplies: retryDelayMs 必须是非负有限数')
    }
    if (deliver !== undefined && typeof deliver !== 'function') {
      throw new TypeError('FeishuReplies: deliver 必须是函数')
    }

    this._store = store
    this._sessionController = sessionController
    this._rest = rest
    this._deliver = deliver ?? ((record) => this._defaultDeliver(record))
    this._now = now
    this._retryDelayMs = retryDelayMs
    this._logFn = typeof log === 'function' ? log : () => {}

    /** requestId → 进行中的归集状态（正文缓冲、turn、finalized）。 */
    this._requests = new Map()
    /** sessionId → follower 生命周期。 */
    this._sessions = new Map()
    /** 正在投递的 requestId，防止 retry/finalize 并发重复发送。 */
    this._delivering = new Set()
    this._closed = false
    this._closing = null
  }

  /**
   * 持久 pending outbox 后开始监听该会话；重复 track 同一 requestId 是幂等的。
   * @param {{requestId: string, openId: string, sessionId: string}} value
   * @returns {Promise<void>} 持久并启动 follower 后 resolve，不等待 turn 结束
   */
  async track(value) {
    this._assertOpen()
    if (value === null || typeof value !== 'object') {
      throw new TypeError('FeishuReplies.track: 参数必须是 {requestId, openId, sessionId}')
    }
    const requestId = assertId('requestId', value.requestId)
    const openId = assertId('openId', value.openId)
    const sessionId = assertId('sessionId', value.sessionId)

    const existing = await this._getOutbox(requestId)
    if (existing !== undefined) {
      if (existing.sessionId !== sessionId || existing.openId !== openId) {
        throw new Error(`FeishuReplies.track: requestId ${requestId} 已属于其他会话/用户`)
      }
      // 已收口的不再重开。失败分两类：
      //   - kind='failure' 来自 prompt 准入失败（没有任何 durable 用户消息），飞书重推
      //     同一 message_id 时 sessions 会再次 prompt；这里必须把记录复位成 pending
      //     并重新 follow，否则「重新 prompt 成功但永远没有 follower」会丢失答复。
      //   - kind='reply' 是交付级失败（已有正文），只允许显式 retry，避免重复私聊。
      if (existing.state === 'done') return
      if (existing.state === 'failed') {
        if (existing.kind !== 'failure') return
        await this._updateOutbox(requestId, (current) => ({
          ...current,
          kind: 'reply',
          text: '',
          state: 'pending',
          nextAttemptAt: 0,
          error: '',
        }))
      }
      this._registerRequest({ requestId, openId, sessionId })
      this._ensureFollower(sessionId)
      await this._waitReady(sessionId)
      return
    }

    const record = {
      openId,
      sessionId,
      requestId,
      kind: 'reply',
      text: '',
      state: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      error: '',
      createdAt: this._now(),
    }
    // 先持久再 follow：任一步崩溃都留下可恢复的 pending outbox。
    if (typeof this._store.putOutbox !== 'function') {
      throw new TypeError('FeishuReplies: store.putOutbox 必须是函数')
    }
    await this._store.putOutbox(requestId, record)
    this._assertOpen()
    this._registerRequest({ requestId, openId, sessionId })
    this._ensureFollower(sessionId)
    await this._waitReady(sessionId)
  }

  /**
   * 标记 requestId 的 prompt 准入失败：写 failed（kind=failure），不产生 turn 监听正文。
   * 若记录已有正文则保留，否则写入安全失败摘要，供 retry 显式补发。
   * @param {string} requestId
   * @param {unknown} error
   * @returns {Promise<void>}
   */
  async fail(requestId, error) {
    this._assertOpen()
    assertId('requestId', requestId)
    const record = await this._getOutbox(requestId)
    if (record === undefined) {
      this._dropRequest(requestId)
      return
    }
    if (record.state === 'done') return
    const message = this._safeError(error)
    const text = typeof record.text === 'string' && record.text.trim().length > 0
      ? record.text
      : PROMPT_FAILURE_TEXT
    const request = this._requests.get(requestId)
    if (request !== undefined) request.finalized = true
    try {
      await this._updateOutbox(requestId, (current) => ({
        ...current,
        kind: 'failure',
        text,
        state: 'failed',
        nextAttemptAt: this._now(),
        error: message,
      }))
    } finally {
      this._dropRequest(requestId)
    }
    this._log('warn', `答复请求失败 request=${requestId}: ${message}`)
  }

  /**
   * 判断该 requestId 是否已经作为 durable user/message 进入目标会话。
   * 只以 durable 日志/page 为准；pending/processing/failed 的 outbox 都不算已 prompt。
   * @param {string} requestId
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async hasPrompt(requestId, sessionId) {
    this._assertOpen()
    assertId('requestId', requestId)
    assertId('sessionId', sessionId)

    // 只认 durable 日志：outbox 的 done 也可能来自 prompt 失败后的「失败摘要」补发，
    // 不能作为 prompt 已进入会话的证据。
    if (typeof this._sessionController.page !== 'function') return false
    const cursor = await this._cursorFor(sessionId)
    if (cursor === undefined) return false

    const address = { kind: 'session', sessionId }
    const controller = new AbortController()
    let beforeSeq
    try {
      for (let loop = 0; loop < MAX_PAGE_LOOPS; loop += 1) {
        const page = await this._sessionController.page({
          address,
          throughSeq: cursor,
          maxMessages: PAGE_MAX_MESSAGES,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        }, controller.signal)
        const records = Array.isArray(page?.records) ? page.records : []
        for (const entry of records) {
          const event = eventOf(entry)
          if (event?.type !== 'user/message') continue
          if (event.data?.source?.rpcId === requestId) return true
        }
        if (page?.hasMore !== true) return false
        const firstSeq = eventOf(records[0])?.seq
        if (!Number.isSafeInteger(firstSeq) || firstSeq === beforeSeq) return false
        beforeSeq = firstSeq
      }
      return false
    } catch (error) {
      this._log('warn', `答复恢复查询失败 session=${sessionId}: ${this._safeError(error)}`)
      return false
    } finally {
      controller.abort()
    }
  }

  /**
   * 显式重投一条 failed 记录；其他状态一律 no-op（不会因重复点击产生第二条私聊）。
   * @param {string} requestId
   * @returns {Promise<void>}
   */
  async retry(requestId) {
    this._assertOpen()
    assertId('requestId', requestId)
    const record = await this._getOutbox(requestId)
    if (record === undefined || record.state !== 'failed') return
    if (this._delivering.has(requestId)) return
    const text = typeof record.text === 'string' ? record.text : ''
    if (text.length === 0) return
    await this._attemptDelivery(requestId, text)
  }

  /**
   * 关闭全部 follower；幂等，重复调用返回同一个 Promise。
   * @returns {Promise<void>}
   */
  close() {
    this._closing ??= this._doClose()
    return this._closing
  }

  // ── 内部：生命周期 ────────────────────────────────────────────────────────

  /** 关闭实现：先置 closed（阻止新 follower），再 abort 并等待全部流收口。 */
  async _doClose() {
    this._closed = true
    const sessions = [...this._sessions.values()]
    for (const session of sessions) session.controller.abort()
    await Promise.allSettled(sessions.map((session) => session.promise))
    this._sessions.clear()
    this._requests.clear()
    this._delivering.clear()
  }

  /** 关闭后拒绝公开写操作；读操作也不会再启动 follower。 */
  _assertOpen() {
    if (this._closed) throw new Error('FeishuReplies 已关闭')
  }

  /** 统一脱敏日志出口；日志自身失败不得影响投递主流程。 */
  _log(level, message) {
    try {
      this._logFn(level, redactError(String(message)))
    } catch {
      // 日志出口故障忽略。
    }
  }

  /**
   * 错误脱敏：在 redactError 基础上再抹掉当前 REST 凭据里的裸 Secret 值，避免
   * 「错误文案直接拼了 appSecret 原文」这种键值正则覆盖不到的情况。
   */
  _safeError(error) {
    let text = safeErrorText(error)
    const rest = this._rest
    const cfg = rest !== null && typeof rest === 'object'
      ? (rest.credentials ?? rest.cfg ?? rest.config)
      : undefined
    const secret = cfg !== null && typeof cfg === 'object' ? cfg.appSecret : undefined
    if (typeof secret === 'string' && secret.length > 0) {
      text = text.split(secret).join('[REDACTED]')
    }
    return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text
  }

  // ── 内部：request/session 状态 ────────────────────────────────────────────

  /** 登记一个待归集请求；重复调用保留已有正文缓冲。 */
  _registerRequest({ requestId, openId, sessionId }) {
    if (this._requests.has(requestId)) return
    this._requests.set(requestId, {
      requestId,
      openId,
      sessionId,
      turn: null,
      texts: [],
      finalized: false,
    })
    // follower 可能已由同一会话的前一个 requestId 建立；新请求要加入它的关联集合。
    const session = this._sessions.get(sessionId)
    if (session !== undefined) session.requests.add(requestId)
  }

  /** 收口后删除请求状态；session 的 request 集合同步清理。 */
  _dropRequest(requestId) {
    const request = this._requests.get(requestId)
    if (request === undefined) return
    this._requests.delete(requestId)
    const session = this._sessions.get(request.sessionId)
    if (session === undefined) return
    session.requests.delete(requestId)
    // 该会话已无待归集请求：主动 abort 并释放 follower（含 seen 集合），
    // 避免每个会话长期泄漏一条 DSH follow 订阅；后续 track 会按需重新建流。
    if (session.requests.size === 0) this._retireFollower(session)
  }

  /**
   * 优雅退役 follower：先标记 finished，让随后到来的 track 立即新建流而不复用
   * 正在 abort 的旧流；再 abort signal。旧的 `_runFollower` 会在 finally 里按
   * 身份判断清理自己，不会误删新建的 follower。
   */
  _retireFollower(session) {
    if (this._closed || session.finished) return
    session.finished = true
    session.controller.abort()
  }

  /** 为会话启动唯一 follower；已存在（且未结束）时复用。 */
  _ensureFollower(sessionId) {
    if (this._closed) return
    const existing = this._sessions.get(sessionId)
    if (existing !== undefined && !existing.finished) return

    const controller = new AbortController()
    const session = {
      sessionId,
      controller,
      finished: false,
      seen: new Set(),
      cursor: undefined,
      currentTurn: null,
      turnRequests: new Map(),
      unassigned: [],
      requests: new Set(),
      resolveReady: null,
      ready: null,
      promise: null,
    }
    session.ready = new Promise((resolve) => { session.resolveReady = resolve })
    // 恢复路径可能先登记了 requestId 再建 follower：把同会话的待归集请求全部纳入。
    for (const request of this._requests.values()) {
      if (request.sessionId === sessionId && !request.finalized) session.requests.add(request.requestId)
    }
    this._sessions.set(sessionId, session)
    session.promise = this._runFollower(sessionId, session)
  }

  /** 等待 follower 的 opening snapshot（或流提前结束），让 track 返回时监听已就位。 */
  async _waitReady(sessionId) {
    const session = this._sessions.get(sessionId)
    if (session === undefined) return
    await session.ready
  }

  /**
   * 消费一条 follow 流。任何异常都在内部收口（脱敏日志）；未完成的请求保持 pending，
   * 由后续 track/恢复重新建流，绝不向宿主抛未处理拒绝。
   */
  async _runFollower(sessionId, session) {
    let iterator
    try {
      const iterable = this._sessionController.follow({
        address: { kind: 'session', sessionId },
        maxMessages: PAGE_MAX_MESSAGES,
      }, session.controller.signal)
      iterator = iterable[Symbol.asyncIterator]()
      while (!this._closed && !session.controller.signal.aborted) {
        const next = await this._nextOrAbort(iterator, session.controller.signal)
        if (next.aborted === true) break
        if (next.done === true) break
        await this._consumeFrame(session, next.value)
      }
    } catch (error) {
      if (!this._closed && !session.controller.signal.aborted) {
        this._log('error', `答复监听失败 session=${sessionId}: ${this._safeError(error)}`)
      }
    } finally {
      session.finished = true
      session.resolveReady?.(undefined)
      try {
        await iterator?.return?.()
      } catch {
        // 关闭流时的二次异常无需上报。
      }
      if (this._sessions.get(sessionId) === session) this._sessions.delete(sessionId)
      if (!this._closed && !session.controller.signal.aborted && session.requests.size > 0) {
        // 流意外结束：未完成的 request 保持 pending，由恢复/重新 track 再建流。
        this._log('warn', `答复监听结束 session=${sessionId}，未完成请求保持 pending`)
      }
    }
  }

  /**
   * 取下一帧，并允许 abort 立即决出（即使底层 async iterable 暂未响应 signal）。
   * 被放弃的 next() 仍挂 catch，避免产生未处理拒绝。
   */
  async _nextOrAbort(iterator, signal) {
    if (signal.aborted) return { aborted: true }
    let onAbort
    const abortPromise = new Promise((resolve) => {
      onAbort = () => resolve({ aborted: true })
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const pending = iterator.next()
    try {
      const result = await Promise.race([
        pending.then((value) => ({ value })),
        abortPromise,
      ])
      if (result.aborted === true) {
        pending.catch(() => {})
        return { aborted: true }
      }
      return result.value
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  // ── 内部：durable 事件消费 ─────────────────────────────────────────────────

  /** 处理 snapshot / live event；assistant-stream 帧不读取。 */
  async _consumeFrame(session, frame) {
    if (frame === null || typeof frame !== 'object') return
    if (frame.type === 'snapshot') {
      if (Number.isSafeInteger(frame.cursor)) session.cursor = frame.cursor
      session.resolveReady?.(session.cursor)
      const records = Array.isArray(frame.records) ? frame.records : []
      for (const entry of records) await this._consumeEvent(session, eventOf(entry))
      return
    }
    // 本适配器从不 opt-in assistantStream；即使对端送来也不得读取流式正文。
    if (frame.type === 'assistant-stream') return
    if (frame.type === 'event') {
      await this._consumeEvent(session, eventOf(frame))
      return
    }
    // 防御：某些替身/旧 carrier 直接把裸事件当帧。
    await this._consumeEvent(session, eventOf(frame))
  }

  /** 消费一条 durable 事件；按 seq 幂等，snapshot 重放不会重复收口。 */
  async _consumeEvent(session, event) {
    if (event === undefined || typeof event.type !== 'string' || !Number.isSafeInteger(event.seq)) return
    if (session.seen.has(event.seq)) return
    session.seen.add(event.seq)
    // hasPrompt 用这个游标作为 page 的 throughSeq：只允许取已确认 durable 的 cut。
    if (!Number.isSafeInteger(session.cursor) || event.seq > session.cursor) session.cursor = event.seq

    switch (event.type) {
      case 'turn/start': {
        if (Number.isSafeInteger(event.data?.turn)) session.currentTurn = event.data.turn
        return
      }
      case 'user/message': {
        const rpcId = event.data?.source?.rpcId
        if (typeof rpcId !== 'string' || !session.requests.has(rpcId)) return
        const request = this._requests.get(rpcId)
        if (request === undefined || request.finalized) return
        if (session.currentTurn === null) {
          // fallback：snapshot 的 cut 可能晚于 turn/start，先挂起，等下一个带 turn 的事件。
          if (!session.unassigned.includes(rpcId)) session.unassigned.push(rpcId)
          return
        }
        this._assignTurn(session, rpcId, session.currentTurn)
        return
      }
      case 'assistant/message': {
        const turn = event.data?.turn
        if (!Number.isSafeInteger(turn)) return
        if (session.currentTurn === null) session.currentTurn = turn
        // fallback：turn/start 被 snapshot cut 掉时，用最早未关联的 requestId 绑定本 turn。
        this._maybeAssignUnassigned(session, turn)
        const text = assistantText(event)
        const assigned = session.turnRequests.get(turn)
        if (text.length === 0 || assigned === undefined) return
        for (const requestId of assigned) {
          const request = this._requests.get(requestId)
          if (request === undefined || request.finalized) continue
          request.texts.push(text)
        }
        return
      }
      case 'turn/end': {
        const turn = event.data?.turn
        if (!Number.isSafeInteger(turn)) return
        if (session.currentTurn === null) session.currentTurn = turn
        this._maybeAssignUnassigned(session, turn)
        const assigned = session.turnRequests.get(turn)
        if (assigned === undefined) {
          session.turnRequests.delete(turn)
          return
        }
        for (const requestId of [...assigned]) {
          await this._finalizeTurn(requestId, event.data?.reason)
        }
        session.turnRequests.delete(turn)
        return
      }
      default:
        // reasoning/tool/attempt/stream 等事件不参与答复归集。
        return
    }
  }

  /** 把一个 requestId 绑定到指定 turn（从 unassigned 队列中移除）。 */
  _assignTurn(session, requestId, turn) {
    const request = this._requests.get(requestId)
    if (request === undefined || request.finalized) return
    request.turn = turn
    let assigned = session.turnRequests.get(turn)
    if (assigned === undefined) {
      assigned = new Set()
      session.turnRequests.set(turn, assigned)
    }
    assigned.add(requestId)
    const index = session.unassigned.indexOf(requestId)
    if (index >= 0) session.unassigned.splice(index, 1)
  }

  /** fallback：仅当该 turn 还没有任何关联时，绑定最早一个未关联 requestId。 */
  _maybeAssignUnassigned(session, turn) {
    const assigned = session.turnRequests.get(turn)
    if (assigned !== undefined && assigned.size > 0) return
    if (session.unassigned.length === 0) return
    this._assignTurn(session, session.unassigned[0], turn)
  }

  /** turn/end 收口：每个 requestId 恰好一次；失败记录不自动重投。 */
  async _finalizeTurn(requestId, reason) {
    const request = this._requests.get(requestId)
    if (request === undefined || request.finalized) return
    request.finalized = true

    const record = await this._getOutbox(requestId)
    if (record === undefined || record.state === 'done' || record.state === 'failed') {
      this._dropRequest(requestId)
      return
    }

    const body = request.texts.join('\n')
    const normalized = body.trim().length > 0 ? body : ''
    const kind = reason?.kind
    const summary = kind === 'completed' || kind === undefined
      ? ''
      : (TURN_SUMMARIES[kind] ?? DEFAULT_TURN_SUMMARY)
    const text = summary.length === 0
      ? normalized
      : (normalized.length === 0 ? summary : `${normalized}\n\n${summary}`)

    if (text.length === 0) {
      // completed 但没有可见 text：不产生私聊，仍把 outbox 收口为 done。
      await this._updateOutbox(requestId, (current) => ({
        ...current,
        state: 'done',
        nextAttemptAt: 0,
        error: '',
      }))
      this._dropRequest(requestId)
      return
    }

    await this._attemptDelivery(requestId, text)
    this._dropRequest(requestId)
  }

  // ── 内部：投递 ────────────────────────────────────────────────────────────

  /** 投递一次并持久结果；失败进入 failed + 指数退避。 */
  async _attemptDelivery(requestId, text) {
    if (this._delivering.has(requestId)) return
    this._delivering.add(requestId)
    try {
      const current = await this._getOutbox(requestId)
      if (current === undefined || current.state === 'done') return

      const processing = await this._updateOutbox(requestId, (record) => ({
        ...record,
        text,
        state: 'processing',
        nextAttemptAt: 0,
      }))
      if (processing === undefined) return

      let result
      try {
        result = await this._deliver(processing)
      } catch (error) {
        const message = this._safeError(error)
        const attempts = (processing.attempts ?? 0) + 1
        const nextAttemptAt = this._now() + this._backoff(attempts)
        await this._updateOutbox(requestId, (record) => ({
          ...record,
          state: 'failed',
          attempts,
          nextAttemptAt,
          error: message,
        }))
        this._log('warn', `答复投递失败 request=${requestId} attempts=${attempts}: ${message}`)
        return
      }

      const outcome = result !== null && typeof result === 'object' ? result : {}
      await this._updateOutbox(requestId, (record) => ({
        ...record,
        state: 'done',
        attempts: (record.attempts ?? 0) + 1,
        nextAttemptAt: 0,
        error: '',
        ...(typeof outcome.documentId === 'string' && outcome.documentId.length > 0
          ? { documentId: outcome.documentId }
          : {}),
        ...(typeof outcome.url === 'string' && outcome.url.length > 0
          ? { url: outcome.url }
          : {}),
      }))
    } finally {
      this._delivering.delete(requestId)
    }
  }

  /** 指数退避：retryDelayMs * 2^(attempts-1)，封顶 MAX_RETRY_DELAY_MS。 */
  _backoff(attempts) {
    if (this._retryDelayMs === 0) return 0
    const exponent = Math.max(0, attempts - 1)
    const delay = this._retryDelayMs * (2 ** exponent)
    return Math.min(delay, MAX_RETRY_DELAY_MS)
  }

  /**
   * 默认 deliver：短文本直发，uuid=requestId 由飞书去重；返回 {kind:'text'}。
   * 空正文不发网络，直接视为成功（turn/end 无可见 text 的边界）。
   */
  async _defaultDeliver(record) {
    if (typeof record.text !== 'string' || record.text.length === 0) return { kind: 'text' }
    const sendText = this._resolveSendText()
    await sendText(record.openId, record.text, record.requestId)
    return { kind: 'text' }
  }

  /** 兼容两种 REST 注入形状，Task 11 可注入绑定好的 sendText 适配器。 */
  _resolveSendText() {
    const rest = this._rest
    if (rest !== null && typeof rest === 'object' && typeof rest.sendText === 'function') {
      return (openId, text, uuid) => rest.sendText(openId, text, { uuid })
    }
    if (rest !== null && typeof rest === 'object' && typeof rest.restSendText === 'function') {
      const cfg = rest.credentials ?? rest.cfg ?? rest.config
      if (cfg === undefined) {
        throw new TypeError('FeishuReplies: restSendText 需要 rest.credentials/cfg')
      }
      return (openId, text, uuid) => rest.restSendText(openId, text, cfg, {
        uuid,
        ...(rest.fetch === undefined ? {} : { fetch: rest.fetch }),
      })
    }
    throw new TypeError('FeishuReplies: rest 需要 sendText 或 restSendText')
  }

  // ── 内部：持久化与 hasPrompt 读取 ─────────────────────────────────────────

  /** 读取 outbox；Store v1 的 get 是同步的，这里用 await 兼容 Promise 实现。 */
  async _getOutbox(requestId) {
    if (typeof this._store.getOutbox !== 'function') return undefined
    return this._store.getOutbox(requestId)
  }

  /**
   * 更新 outbox：优先走 Store 的原子 updateOutbox（同步变换）；测试/旧替身缺该方法时
   * 退化为 get+put。
   */
  async _updateOutbox(requestId, transform) {
    if (typeof this._store.updateOutbox === 'function') {
      return this._store.updateOutbox(requestId, transform)
    }
    const current = await this._getOutbox(requestId)
    if (current === undefined) return undefined
    const next = transform({ ...current })
    if (typeof this._store.putOutbox !== 'function') {
      throw new TypeError('FeishuReplies: store 缺少 updateOutbox/putOutbox')
    }
    return this._store.putOutbox(requestId, next)
  }

  /**
   * 取目标会话当前 durable cursor：
   *   - 已有活跃 follower：优先返回已消费到的最新 live seq，未拿到时等 opening snapshot；
   *   - 否则短暂打开一次 maxMessages:1 的 follow，只取 snapshot.cursor 后立即关闭。
   * @returns {Promise<number | undefined>}
   */
  async _cursorFor(sessionId) {
    const active = this._sessions.get(sessionId)
    if (active !== undefined && !active.finished) {
      // 优先用已消费到的 live seq，避免活跃 follower 的旧 opening cursor 漏掉新 prompt。
      if (Number.isSafeInteger(active.cursor)) return active.cursor
      const cursor = await active.ready
      return Number.isSafeInteger(cursor) ? cursor : undefined
    }

    const controller = new AbortController()
    let iterator
    try {
      const iterable = this._sessionController.follow({
        address: { kind: 'session', sessionId },
        maxMessages: 1,
      }, controller.signal)
      iterator = iterable[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done === true) return undefined
      if (first.value?.type !== 'snapshot') return undefined
      return Number.isSafeInteger(first.value.cursor) ? first.value.cursor : undefined
    } catch (error) {
      this._log('warn', `答复恢复游标读取失败 session=${sessionId}: ${this._safeError(error)}`)
      return undefined
    } finally {
      controller.abort()
      try {
        await iterator?.return?.()
      } catch {
        // 关闭探测流时的二次异常忽略。
      }
    }
  }
}
