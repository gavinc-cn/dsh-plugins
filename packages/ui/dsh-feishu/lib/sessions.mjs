// @gavinc-cn/dsh-feishu —— 每用户 DSH 会话、命令路由与 prompt 准入
//
// 目的：把归一后的飞书私聊消息落到「该 open_id 自己的」独立 DSH 会话集合：
// 首条普通消息惰性创建会话（标题 `飞书对话 <MM-DD HH:mm>`），后续消息复用当前
// 会话并以 `mode:'queue'` 排队；斜杠命令（含中文别名）只操作本人绑定，绝不触达
// 他人会话。
//
// 设计约束：
//   - 会话归属只认 Store 里的 `bindings[open_id]`：currentSessionId 必须存在于该
//     binding 的 sessionIds 中，否则视为无当前会话并新建；消息里携带的任何
//     sessionId/currentSessionId 字段一律忽略（防跨用户注入）。
//   - requestId 恒为 `feishu:<message.id>`。只有 Store 里已存在该 requestId 的 outbox
//     记录（恢复/飞书重推）才调用 `replies.hasPrompt` 查 durable 日志；全新消息跳过
//     这次昂贵的全量回扫，直接依赖 DSH 对同一 requestId 的去重作为兜底。
//   - 顺序固定：prepareContent（附件全有或全无）→ replies.track（先持久 outbox）→
//     sessionController.prompt({mode:'queue'})。prompt 失败调用 replies.fail 后原样
//     向上抛，由 inbound 记录 failed；fail 自身失败不得吞掉原始错误。
//   - 命令全部不产生 prompt：`/new [标题]`、`/sessions`、`/use <序号>`、`/current`、
//     `/leave`、`/stop`、`/unbind`、`/answer`、`/approve`、`/deny`、`/help`，并接受
//     以 `/` 或 `／` 开头的中文别名（/新建、/会话、/切换…）。裸中文命令词按普通
//     聊天投递，避免“停止 一下”这类句子被误路由；未知 `/` 命令返回帮助。
//     `/answer /approve /deny` 交给注入的 interactions.handleText。
//   - 同一 open_id 的会话解析与命令写操作串行化，避免并发首条消息创建两个会话；
//     `/stop` 只读当前绑定后 cancel，不持锁，避免被附件准备阻塞。
//   - 命令响应有界（MAX_RESPONSE_CHARS），错误只回固定安全文案；日志走 redactError，
//     不记录 open_id、消息正文或 Secret。
//   - 默认 cwd：构造注入的 config.defaultCwd 优先，其次 Store 的 global 配置；为空时
//     不向 create 传 cwd。create 不传 agentPreset，保留部署默认 preset。
//
// 生效链路：Task 11 总装创建 FeishuSessions({store, sessionController, replies,
// prepareContent, config, interactions})，把 inbound 的 onMessage 接到 submit，
// 并必须把 submit/command 返回的 response 通过飞书 REST 私聊发回用户（否则命令
// 与绑定引导只有返回值、用户看不到）。Task 10 的 FeishuInteractions.handleText
// 处理 answer/approve/deny；本模块不直接 import Task 6，附件适配器由总装注入以便测试。
//
// 已知边界：
//   - 会话标题只存在内存缓存（BindingRecord 没有 title 字段）；进程重启后
//     `/sessions` 对旧会话显示 `会话 <序号>`，DSH 侧真实标题不受影响。标题缓存
//     只在 rename 成功后写入，并受 MAX_CACHED_TITLES 上限约束。
//   - `/sessions` 最多展示 MAX_SESSION_LINES 个，但 `/use <序号>` 仍接受完整
//     sessionIds 范围内的序号（序号即该数组下标 + 1，集合不变时稳定）；截断提示
//     会给出真实的 /use 范围。
//   - create 成功与 putBinding 不是同一事务：putBinding 失败时 DSH 里会留下一个
//     未被任何 binding 引用的会话（孤儿）。不引入清理 API，重试会新建另一个会话；
//     孤儿只占历史空间，不能被飞书侧再次选中。
//   - 恢复补投以 outbox 的 sessionId 为准（仅当它属于该 open_id 的 binding）：若用户
//     已 `/leave` 或切到别的会话，迟到重推仍会落回原会话，不跟随 current。
//   - 本模块不创建绑定：未绑定 open_id 的会话命令返回绑定引导，普通消息返回
//     handled=false（inbound 已在更早的入口拦截未绑定用户）。
import { redactError } from './utils.mjs'

/** 命令响应最大字符数（按 UTF-16 code unit 计），防止把整段日志/列表私聊出去。 */
export const MAX_RESPONSE_CHARS = 2_000

/** 会话标题最大字符数。 */
export const MAX_TITLE_CHARS = 80

/** `/sessions` 单次最多展示的会话行数。 */
export const MAX_SESSION_LINES = 10

/** 内存标题缓存上限；超出后淘汰最旧条目，避免长期运行无限增长。 */
export const MAX_CACHED_TITLES = 100

/** 稳定 requestId 前缀；完整值为 `feishu:<message_id>`。 */
export const REQUEST_ID_PREFIX = 'feishu:'

/** 未绑定用户的统一引导文案。 */
export const NO_BINDING_TEXT = '尚未绑定 DSH 账号：请先在 DSH 飞书桥面板生成绑定码，'
  + '然后发送 /bind <绑定码>。'

/** 帮助文本（有界、不含任何运行时状态）。 */
export const HELP_TEXT = [
  '飞书桥命令（必须以 / 开头）：',
  '/new [标题]  新建并切换到新会话',
  '/sessions    查看本人会话',
  '/use <序号>  切换会话',
  '/current     查看当前会话',
  '/leave       离开当前会话（保留历史）',
  '/stop        停止当前会话',
  '/answer <答案>  回答待处理问题',
  '/approve /deny  批准或拒绝审批',
  '/unbind      解除绑定（保留 DSH 历史）',
  '/help        显示本帮助',
  '中文别名同样需要斜杠：/新建 /会话 /切换 /当前 /离开 /停止 /解绑 /帮助。',
].join('\n')

/**
 * 斜杠命令与中文别名映射。键必须是 `/` 开头的首 token；英文命令大小写不敏感。
 * 裸中文词不在此表，普通句子因此不会被误当成命令。
 */
const COMMAND_ALIASES = new Map([
  ['/new', 'new'], ['/新建', 'new'],
  ['/sessions', 'sessions'], ['/会话', 'sessions'], ['/列表', 'sessions'],
  ['/use', 'use'], ['/切换', 'use'], ['/选择', 'use'],
  ['/current', 'current'], ['/当前', 'current'],
  ['/leave', 'leave'], ['/离开', 'leave'],
  ['/stop', 'stop'], ['/停止', 'stop'],
  ['/unbind', 'unbind'], ['/解绑', 'unbind'],
  ['/answer', 'answer'], ['/回答', 'answer'],
  ['/approve', 'approve'], ['/批准', 'approve'], ['/同意', 'approve'],
  ['/deny', 'deny'], ['/拒绝', 'deny'],
  ['/help', 'help'], ['/帮助', 'help'], ['/?', 'help'],
])

/** 判断普通对象（排除 null/数组）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 校验非空字符串身份参数。
 * @param {string} kind 字段名（错误文案用）
 * @param {unknown} value 待校验值
 * @returns {string} 原值
 */
function assertId(kind, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`FeishuSessions: ${kind} 必须是非空字符串`)
  }
  return value
}

/** 两位补零。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 生成稳定默认标题 `飞书对话 <MM-DD HH:mm>`（本地时区）。
 * @param {number} nowMs 毫秒时间戳
 * @returns {string}
 */
function defaultTitle(nowMs) {
  const date = new Date(nowMs)
  if (Number.isNaN(date.getTime())) return '飞书对话'
  return `飞书对话 ${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * 清洗用户提供的标题：控制字符压成空格、折叠空白、截断到 MAX_TITLE_CHARS。
 * @param {unknown} value `/new` 后面的标题文本
 * @returns {string} 清洗后的标题；空串表示使用默认标题
 */
function sanitizeTitle(value) {
  if (typeof value !== 'string') return ''
  const singleLine = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(singleLine).slice(0, MAX_TITLE_CHARS).join('')
}

/**
 * 响应截断：保证不拆开 UTF-16 代理对，结果长度不超过 MAX_RESPONSE_CHARS。
 * @param {unknown} value 待输出文本
 * @returns {string}
 */
function boundText(value) {
  const text = String(value)
  if (text.length <= MAX_RESPONSE_CHARS) return text
  let cut = text.slice(0, MAX_RESPONSE_CHARS - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}…`
}

/**
 * 归一 sessionIds：只保留非空字符串并去重，保持原有顺序（序号因此稳定）。
 * @param {unknown} value BindingRecord.sessionIds
 * @returns {string[]}
 */
function normalizeSessionIds(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const result = []
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/**
 * 取绑定里真正属于该集合的 currentSessionId；不在 sessionIds 内一律视为无当前。
 * @param {object} binding BindingRecord
 * @returns {string}
 */
function ownedCurrentSessionId(binding) {
  if (!isPlainObject(binding)) return ''
  const ids = normalizeSessionIds(binding.sessionIds)
  const current = binding.currentSessionId
  return typeof current === 'string' && ids.includes(current) ? current : ''
}

/**
 * 解析命令文本。返回 null 表示普通消息；`name:'unknown'` 表示未知斜杠命令。
 * 只接受 `/` 或首字符全角 `／` 开头的命令（中文别名同样要带斜杠）；英文命令
 * 大小写不敏感。裸中文词一律按普通聊天处理，避免吞掉正常句子。
 * @param {string} text 消息正文
 * @returns {{name: string, args: string} | null}
 */
function parseCommand(text) {
  if (typeof text !== 'string') return null
  let trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('／')) trimmed = `/${trimmed.slice(1)}`
  if (!trimmed.startsWith('/')) return null

  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (match === null) return null
  const rawToken = match[1]
  const args = (match[2] ?? '').trim()
  const name = COMMAND_ALIASES.get(rawToken.toLowerCase())
  return { name: name ?? 'unknown', args }
}

/**
 * 每用户 DSH 会话与命令路由。所有依赖可注入，测试不触网、不写真实存储。
 */
export class FeishuSessions {
  /**
   * @param {object} options
   * @param {object} options.store Task 3 Store（bindings + global 配置）
   * @param {object} options.sessionController DSH sessionController（create/rename/prompt/cancel）
   * @param {object} options.replies Task 7 FeishuReplies（track/fail/hasPrompt）
   * @param {(message: object, options: {sessionId: string, signal: AbortSignal}) =>
   *   Promise<object[]>} options.prepareContent Task 6 附件适配器（总装注入）
   * @param {{defaultCwd?: string}} [options.config] 部署配置（优先于 Store global）
   * @param {() => number} [options.now] 时钟（测试注入）
   * @param {(level: string, message: string) => void} [options.log] 脱敏日志出口
   * @param {{handleText: (openId: string, command: string, args: string) =>
   *   Promise<{handled: boolean, response?: string}>}} [options.interactions]
   *   Task 10 交互处理器（answer/approve/deny）
   */
  constructor({
    store,
    sessionController,
    replies,
    prepareContent,
    config,
    now = Date.now,
    log = () => {},
    interactions,
  } = {}) {
    if (store === null || store === undefined
      || typeof store.getBinding !== 'function'
      || typeof store.putBinding !== 'function'
      || typeof store.deleteBinding !== 'function') {
      throw new TypeError('FeishuSessions: 必须提供 store（getBinding/putBinding/deleteBinding）')
    }
    if (sessionController === null || sessionController === undefined
      || typeof sessionController.create !== 'function'
      || typeof sessionController.prompt !== 'function'
      || typeof sessionController.cancel !== 'function') {
      throw new TypeError(
        'FeishuSessions: sessionController 必须提供 create/prompt/cancel',
      )
    }
    if (replies === null || replies === undefined
      || typeof replies.track !== 'function'
      || typeof replies.fail !== 'function'
      || typeof replies.hasPrompt !== 'function') {
      throw new TypeError('FeishuSessions: replies 必须提供 track/fail/hasPrompt')
    }
    if (typeof prepareContent !== 'function') {
      throw new TypeError('FeishuSessions: prepareContent 必须是函数')
    }
    if (config !== undefined && !isPlainObject(config)) {
      throw new TypeError('FeishuSessions: config 必须是对象')
    }
    if (typeof now !== 'function') {
      throw new TypeError('FeishuSessions: now 必须是函数')
    }
    if (interactions !== undefined
      && (interactions === null || typeof interactions.handleText !== 'function')) {
      throw new TypeError('FeishuSessions: interactions.handleText 必须是函数')
    }

    this._store = store
    this._sessionController = sessionController
    this._replies = replies
    this._prepareContent = prepareContent
    this._config = config
    this._now = now
    this._logFn = typeof log === 'function' ? log : () => {}
    this._interactions = interactions

    /** sessionId → 本进程内创建/改名的标题（BindingRecord 无 title 字段）。 */
    this._titles = new Map()
    /** openId → 串行化链尾，避免并发首条消息重复建会话。 */
    this._locks = new Map()
  }

  // ── 公开接口 ─────────────────────────────────────────────────────────────

  /**
   * 处理一条普通消息：命令直接路由；否则确保当前会话后准备内容、track、queue prompt。
   * @param {object} message Task 5 NormalizedMessage
   * @returns {Promise<{handled: boolean, response?: string, sessionId?: string,
   *   requestId?: string}>}
   */
  async submit(message) {
    if (!isPlainObject(message)) {
      throw new TypeError('FeishuSessions.submit: message 必须是对象')
    }
    const openId = assertId('openId', message.openId)
    assertId('id', message.id)

    // 群聊在本插件范围内零执行；group 字段即使被伪造也绝不落会话。
    if (message.chatType === 'group') return { handled: false }

    const text = typeof message.text === 'string' ? message.text : ''
    const command = parseCommand(text)
    if (command !== null) return this.command(openId, text)

    const resources = Array.isArray(message.resources) ? message.resources : []
    if (text.trim() === '' && resources.length === 0) return { handled: false }

    return this._withLock(openId, () => this._submitLocked(message))
  }

  /**
   * 路由一条命令；未识别为非命令时返回 handled=false。命令永不 prompt。
   * @param {string} openId 飞书 open_id
   * @param {string} text 消息正文
   * @returns {Promise<{handled: boolean, response?: string}>}
   */
  async command(openId, text) {
    assertId('openId', openId)
    const parsed = parseCommand(text)
    if (parsed === null) return { handled: false }

    try {
      switch (parsed.name) {
        case 'new':
          return await this._withLock(openId, () => this._newLocked(openId, parsed.args))
        case 'sessions':
          return this._sessions(openId)
        case 'use':
          return await this._withLock(openId, () => this._useLocked(openId, parsed.args))
        case 'current':
          return this._currentCommand(openId)
        case 'leave':
          return await this._withLock(openId, () => this._leaveLocked(openId))
        case 'stop':
          // 不持锁：附件准备/会话创建不应阻塞用户停止当前轮次。
          return await this._stop(openId)
        case 'unbind':
          return await this._withLock(openId, () => this._unbindLocked(openId))
        case 'answer':
        case 'approve':
        case 'deny':
          return await this._delegate(openId, parsed.name, parsed.args)
        case 'help':
          return this._ok(HELP_TEXT)
        default:
          return this._ok(`未识别该命令。\n\n${HELP_TEXT}`)
      }
    } catch (error) {
      // 命令响应只回固定安全文案；错误细节只进脱敏日志。
      this._log('warn', `命令 ${parsed.name} 失败: ${redactError(error)}`)
      return this._ok('操作失败，请稍后重试。')
    }
  }

  /**
   * 读取绑定与当前会话快照；无绑定返回 undefined，损坏的 current 视为空。
   * @param {string} openId 飞书 open_id
   * @returns {object | undefined}
   */
  current(openId) {
    assertId('openId', openId)
    const binding = this._binding(openId)
    if (binding === undefined) return undefined
    const sessionIds = normalizeSessionIds(binding.sessionIds)
    const currentSessionId = ownedCurrentSessionId(binding)
    const index = currentSessionId === '' ? 0 : sessionIds.indexOf(currentSessionId) + 1
    return {
      openId,
      sessionIds,
      currentSessionId,
      title: currentSessionId === '' ? '' : this._titleFor(currentSessionId, index),
      index,
      docs: isPlainObject(binding.docs) ? { ...binding.docs } : {},
      updatedAt: typeof binding.updatedAt === 'number' ? binding.updatedAt : 0,
    }
  }

  // ── prompt 主流程 ────────────────────────────────────────────────────────

  /**
   * 持锁的普通消息处理：先看该 requestId 是否有 outbox（仅恢复路径才 hasPrompt），
   * 再解析/创建会话，最后 prepare → track → prompt。
   * @param {object} message NormalizedMessage
   * @returns {Promise<object>}
   */
  async _submitLocked(message) {
    const openId = message.openId
    const binding = this._binding(openId)
    if (binding === undefined) return { handled: false }

    const text = typeof message.text === 'string' ? message.text : ''
    const resources = Array.isArray(message.resources) ? message.resources : []
    if (text.trim() === '' && resources.length === 0) return { handled: false }

    const requestId = `${REQUEST_ID_PREFIX}${message.id}`
    const recoverySessionId = this._outboxSessionFor(openId, binding, requestId)
    if (recoverySessionId !== '') {
      // 只有 Store 里已有该 requestId 的 outbox 才做 durable 回扫；这是恢复/重推路径。
      if (await this._replies.hasPrompt(requestId, recoverySessionId)) {
        return { handled: true, sessionId: recoverySessionId, requestId }
      }
      // outbox 已绑定某个自有会话：补投必须落回同一会话，否则 track 会冲突；
      // 即使 current 已被 /leave 或 /new 改掉也不跟随。
      const sessionIds = normalizeSessionIds(binding.sessionIds)
      await this._persistBinding(
        openId,
        binding,
        sessionIds,
        ownedCurrentSessionId(binding),
      )
      return this._promptMessage(message, openId, recoverySessionId, requestId)
    }

    const sessionId = await this._ensureSession(openId, binding)
    return this._promptMessage(message, openId, sessionId, requestId)
  }

  /**
   * 找到可复用的恢复会话：outbox 存在、属于本人、且 sessionId 仍在该 binding 内。
   * 不满足任何一项都返回空串（不回扫、不信任外来 sid）。
   * @param {string} openId
   * @param {object} binding 读取时的 BindingRecord
   * @param {string} requestId `feishu:<message_id>`
   * @returns {string} 恢复会话 id；'' 表示全新消息
   */
  _outboxSessionFor(openId, binding, requestId) {
    if (typeof this._store.getOutbox !== 'function') return ''
    let record
    try {
      record = this._store.getOutbox(requestId)
    } catch (error) {
      // 读失败按“无 outbox”处理：宁可让 DSH 的 requestId 去重兜底，也不阻塞消息。
      this._log('warn', `读取 outbox 失败 request=${requestId}: ${redactError(error)}`)
      return ''
    }
    if (!isPlainObject(record)) return ''
    // 显式记录了他人的 outbox 一律不信任；旧记录缺 openId 时按 key（requestId）归属。
    if (typeof record.openId === 'string' && record.openId !== openId) return ''
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
    if (sessionId === '') return ''
    if (!normalizeSessionIds(binding.sessionIds).includes(sessionId)) return ''
    return sessionId
  }

  /**
   * 附件准备 → track → queue prompt；prompt 失败先 replies.fail 再原样抛错。
   * @param {object} message NormalizedMessage
   * @param {string} openId
   * @param {string} sessionId
   * @param {string} requestId
   * @returns {Promise<object>}
   */
  async _promptMessage(message, openId, sessionId, requestId) {
    const controller = new AbortController()
    try {
      const content = await this._prepareContent(message, {
        sessionId,
        signal: controller.signal,
      })
      this._assertPromptContent(content)

      // 先持久 pending outbox，再让 prompt 进 DSH 队列；顺序不可交换。
      await this._replies.track({ requestId, openId, sessionId })
      try {
        await this._sessionController.prompt({
          requestId,
          sessionId,
          mode: 'queue',
          content,
        }, controller.signal)
      } catch (error) {
        try {
          await this._replies.fail(requestId, error)
        } catch (failError) {
          // fail 自身失败不能覆盖原始 prompt 错误；只留脱敏日志。
          this._log('error', `答复失败标记失败 request=${requestId}: ${redactError(failError)}`)
        }
        throw error
      }
    } finally {
      controller.abort()
    }

    return { handled: true, sessionId, requestId }
  }

  /**
   * 确保当前会话可用：已有合法 current 就复用（并刷新 updatedAt），否则新建并切换。
   * @param {string} openId
   * @param {object} binding 读取时的 BindingRecord
   * @returns {Promise<string>} sessionId
   */
  async _ensureSession(openId, binding) {
    const sessionIds = normalizeSessionIds(binding.sessionIds)
    const current = ownedCurrentSessionId(binding)
    if (current !== '') {
      await this._persistBinding(openId, binding, sessionIds, current)
      return current
    }

    const created = await this._createSession()
    const nextIds = sessionIds.includes(created.sessionId)
      ? sessionIds
      : [...sessionIds, created.sessionId]
    await this._persistBinding(openId, binding, nextIds, created.sessionId)
    return created.sessionId
  }

  /**
   * 创建会话并尽力改标题；cwd 为空时省略字段，绝不传 agentPreset。
   * @param {string} [title] 用户指定标题；空则用默认标题
   * @returns {Promise<{sessionId: string, title: string, titleFailed: boolean}>}
   */
  async _createSession(title) {
    const request = {}
    const cwd = this._defaultCwd()
    if (cwd !== '') request.cwd = cwd

    const created = await this._sessionController.create(request)
    if (!isPlainObject(created)
      || typeof created.sessionId !== 'string'
      || created.sessionId.length === 0) {
      throw new Error('FeishuSessions: sessionController.create 未返回有效 sessionId')
    }

    const resolvedTitle = sanitizeTitle(title) || this._defaultTitle()
    let titleFailed = false
    if (typeof this._sessionController.rename !== 'function') {
      // 没有 rename 就无法确认 DSH 标题已写入：不缓存标题，响应按失败提示。
      titleFailed = true
    } else {
      try {
        await this._sessionController.rename({
          sessionId: created.sessionId,
          title: resolvedTitle,
        })
        // 只有 rename 成功后才缓存；失败时 /sessions 显示稳定序号占位。
        this._cacheTitle(created.sessionId, resolvedTitle)
      } catch (error) {
        // 标题只是展示信息：改名失败不阻断消息投递，最终以 DSH 实际标题为准。
        titleFailed = true
        this._log('warn', `会话标题设置失败 session=${created.sessionId}: ${redactError(error)}`)
      }
    }
    return { sessionId: created.sessionId, title: resolvedTitle, titleFailed }
  }

  /**
   * 解析默认 cwd：构造 config 优先，其次 Store global；都为空返回 ''。
   * @returns {string}
   */
  _defaultCwd() {
    let cwd = ''
    if (isPlainObject(this._config) && typeof this._config.defaultCwd === 'string') {
      cwd = this._config.defaultCwd.trim()
    }
    if (cwd === '' && typeof this._store.getConfig === 'function') {
      try {
        const globalConfig = this._store.getConfig()
        if (isPlainObject(globalConfig) && typeof globalConfig.defaultCwd === 'string') {
          cwd = globalConfig.defaultCwd.trim()
        }
      } catch (error) {
        this._log('warn', `读取默认 cwd 失败: ${redactError(error)}`)
      }
    }
    return cwd
  }

  /**
   * 持久化绑定并刷新 updatedAt；docs 始终取写链上的最新值，未知字段不写入。
   *
   * 并发安全：优先走 `store.updateBinding`（domain 写链 + 共享 per-openId 锁），
   * 保证与云文档交付并发时 docs 不被旧快照覆盖；旧替身缺该方法时退回 putBinding。
   * @param {string} openId
   * @param {object} binding 读取时的 BindingRecord（仅用于旧实现兜底）
   * @param {string[]} sessionIds 新集合
   * @param {string} currentSessionId 新当前会话
   * @returns {Promise<object>} 持久后的记录
   */
  async _persistBinding(openId, binding, sessionIds, currentSessionId) {
    const updatedAt = this._now()
    if (typeof this._store.updateBinding === 'function') {
      return this._store.updateBinding(openId, (current) => {
        const base = current ?? binding
        return {
          sessionIds: [...sessionIds],
          currentSessionId,
          // 以写链上的最新 docs 为准：并发文档交付写入的条目不能被本命令抹掉。
          docs: isPlainObject(base?.docs) ? { ...base.docs } : {},
          updatedAt,
        }
      })
    }
    const record = {
      sessionIds: [...sessionIds],
      currentSessionId,
      docs: isPlainObject(binding.docs) ? { ...binding.docs } : {},
      updatedAt,
    }
    await this._store.putBinding(openId, record)
    return record
  }

  // ── 命令实现 ─────────────────────────────────────────────────────────────

  /** `/new [标题]`：创建、改名并切换。 */
  async _newLocked(openId, args) {
    const binding = this._binding(openId)
    if (binding === undefined) return this._ok(NO_BINDING_TEXT)

    const created = await this._createSession(args)
    const sessionIds = normalizeSessionIds(binding.sessionIds)
    const nextIds = sessionIds.includes(created.sessionId)
      ? sessionIds
      : [...sessionIds, created.sessionId]
    await this._persistBinding(openId, binding, nextIds, created.sessionId)

    const suffix = created.titleFailed ? '（DSH 标题设置失败）' : ''
    return this._ok(`已新建并切换到会话「${created.title}」。${suffix}`)
  }

  /** `/sessions`：只列本人、稳定序号、有界输出。 */
  _sessions(openId) {
    const binding = this._binding(openId)
    if (binding === undefined) return this._ok(NO_BINDING_TEXT)

    const sessionIds = normalizeSessionIds(binding.sessionIds)
    if (sessionIds.length === 0) {
      return this._ok('还没有会话。发送任意消息会自动新建，或使用 /new [标题]。')
    }

    const current = ownedCurrentSessionId(binding)
    const lines = [`会话列表（共 ${sessionIds.length} 个）：`]
    const shown = sessionIds.slice(0, MAX_SESSION_LINES)
    for (let index = 0; index < shown.length; index += 1) {
      const sessionId = shown[index]
      const marker = sessionId === current ? '（当前）' : ''
      lines.push(`${index + 1}. ${this._titleFor(sessionId, index + 1)}${marker}`)
    }
    if (sessionIds.length > shown.length) {
      lines.push(`…另有 ${sessionIds.length - shown.length} 个会话未显示；`
        + `/use 序号范围 1-${sessionIds.length}。`)
    }
    lines.push('用 /use <序号> 切换，/new [标题] 新建。')
    return this._ok(lines.join('\n'))
  }

  /** `/use <序号>`：只在本 binding 的 sessionIds 内切换。 */
  async _useLocked(openId, args) {
    const binding = this._binding(openId)
    if (binding === undefined) return this._ok(NO_BINDING_TEXT)

    const sessionIds = normalizeSessionIds(binding.sessionIds)
    const match = /^([0-9]+)$/.exec(args.trim())
    if (match === null) {
      return this._ok('用法：/use <序号>，序号来自 /sessions。')
    }
    const index = Number(match[1])
    if (!Number.isSafeInteger(index) || index < 1 || index > sessionIds.length) {
      if (sessionIds.length === 0) return this._ok('还没有会话，请先用 /new 新建。')
      return this._ok(`序号超出范围：请输入 1-${sessionIds.length} 之间的序号。`)
    }

    const sessionId = sessionIds[index - 1]
    await this._persistBinding(openId, binding, sessionIds, sessionId)
    return this._ok(`已切换到会话「${this._titleFor(sessionId, index)}」。`)
  }

  /** `/current`：查看本人当前会话。 */
  _currentCommand(openId) {
    const binding = this._binding(openId)
    if (binding === undefined) return this._ok(NO_BINDING_TEXT)

    const current = ownedCurrentSessionId(binding)
    if (current === '') {
      return this._ok('当前没有会话；发送任意消息会自动新建。')
    }
    const index = normalizeSessionIds(binding.sessionIds).indexOf(current) + 1
    return this._ok(`当前会话（第 ${index} 个）：${this._titleFor(current, index)}`)
  }

  /** `/leave`：清空 current，保留 sessionIds 与 DSH 历史。 */
  async _leaveLocked(openId) {
    const binding = this._binding(openId)
    if (binding === undefined) return this._ok(NO_BINDING_TEXT)

    const sessionIds = normalizeSessionIds(binding.sessionIds)
    if (ownedCurrentSessionId(binding) === '') {
      return this._ok('当前没有会话；发送任意消息会自动新建。')
    }
    await this._persistBinding(openId, binding, sessionIds, '')
    return this._ok('已离开当前会话；历史会话仍保留，下一条消息会自动新建。')
  }

  /** `/stop`：cancel 本人当前会话；不产生 prompt。 */
  async _stop(openId) {
    const binding = this._binding(openId)
    const current = binding === undefined ? '' : ownedCurrentSessionId(binding)
    if (current === '') return this._ok('当前没有可停止的会话。')
    await this._sessionController.cancel({ sessionId: current })
    return this._ok('已请求停止当前会话。')
  }

  /** `/unbind`：删除本人绑定，保留 DSH 会话历史。 */
  async _unbindLocked(openId) {
    const binding = this._binding(openId)
    if (binding === undefined) return this._ok('当前没有绑定，无需解绑。')

    const deleted = await this._store.deleteBinding(openId)
    if (deleted === false) return this._ok('当前没有绑定，无需解绑。')
    for (const sessionId of normalizeSessionIds(binding.sessionIds)) {
      this._titles.delete(sessionId)
    }
    return this._ok('已解除绑定；DSH 会话历史仍保留。')
  }

  /** `/answer /approve /deny`：交给 Task 10 的交互处理器，绝不 prompt。 */
  async _delegate(openId, name, args) {
    let result
    if (this._interactions !== undefined
      && typeof this._interactions.handleText === 'function') {
      result = await this._interactions.handleText(openId, `/${name}`, args)
    }
    if (isPlainObject(result) && typeof result.handled === 'boolean') {
      const response = typeof result.response === 'string' ? result.response : undefined
      return response === undefined
        ? { handled: result.handled }
        : { handled: result.handled, response: boundText(response) }
    }
    return this._ok('当前没有待处理的问题或审批。')
  }

  // ── 内部工具 ─────────────────────────────────────────────────────────────

  /** 读取绑定；不存在/null 统一视为 undefined。 */
  _binding(openId) {
    const binding = this._store.getBinding(openId)
    return isPlainObject(binding) ? binding : undefined
  }

  /** 记录 rename 成功的标题；刷新插入顺序并按上限淘汰最旧条目。 */
  _cacheTitle(sessionId, title) {
    this._titles.delete(sessionId)
    this._titles.set(sessionId, title)
    while (this._titles.size > MAX_CACHED_TITLES) {
      const oldest = this._titles.keys().next().value
      if (oldest === undefined) break
      this._titles.delete(oldest)
    }
  }

  /** 会话标题：优先本进程缓存，未知时用稳定序号占位。 */
  _titleFor(sessionId, index) {
    return this._titles.get(sessionId) ?? `会话 ${index}`
  }

  /** 默认标题使用注入时钟，保证测试可固定。 */
  _defaultTitle() {
    return defaultTitle(this._now())
  }

  /** 构造成功响应；响应统一截断。 */
  _ok(response) {
    return { handled: true, response: boundText(response) }
  }

  /**
   * 校验 prepareContent 结果：必须是非空数组，且至少有一个非空白 text 或非 text part。
   * @param {unknown} content Task 6 输出
   * @returns {void}
   */
  _assertPromptContent(content) {
    if (!Array.isArray(content) || content.length === 0) {
      throw new TypeError('FeishuSessions: prepareContent 必须返回非空内容数组')
    }
    const usable = content.some((part) => {
      if (!isPlainObject(part)) return false
      if (part.type === 'text') {
        return typeof part.text === 'string' && part.text.trim() !== ''
      }
      return true
    })
    if (!usable) throw new TypeError('FeishuSessions: 消息内容为空，拒绝 prompt')
  }

  /**
   * 同一 openId 串行化：前一个任务失败不阻塞后一个。
   * @param {string} openId
   * @param {() => Promise<unknown>} task 待执行任务
   * @returns {Promise<unknown>} task 的结果/异常
   */
  _withLock(openId, task) {
    const previous = this._locks.get(openId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(task)
    const tail = run.then(() => {}, () => {})
    this._locks.set(openId, tail)
    return run.finally(() => {
      if (this._locks.get(openId) === tail) this._locks.delete(openId)
    })
  }

  /** 脱敏日志出口：日志出口自身失败不影响主流程。 */
  _log(level, message) {
    try {
      this._logFn(level, redactError(String(message)))
    } catch {
      // 忽略日志出口异常。
    }
  }
}
