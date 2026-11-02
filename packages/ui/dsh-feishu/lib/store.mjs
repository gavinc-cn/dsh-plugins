// @gavinc-cn/dsh-feishu —— credentials 与 storageDomain 持久化
//
// 目的：把飞书桥需要跨重启存活的状态收敛到一个 Store：秘密只放 ctx.credentials，
// 业务状态（绑定、入站、出站、非秘密配置）放 ctx.storageDomain 的 `dsh_feishu`
// 域（version 1，三张表 bindings/inbox/outbox + global 配置）。
//
// 设计约束：
//   - 秘密（App ID/Secret）只经 credentials 的 set/resolve/unset；本模块不记录任何日志，
//     也不把凭据写进 domain / 事件 / 错误文本；
//   - domain 层只在「重开校验」时跑 schema，因此本模块在每次 put/update 前用同一份
//     zod schema 再校验一次，非法状态在落盘前就以 ZodError 拒绝；
//   - update 走 domain 的单条写链（KvTable.update），同一 key 的并发更新严格串行，
//     返回持久后的新记录；变换必须是同步纯函数（domain 写链不支持 async transform）；
//   - close 幂等；重开由调用方新建 Store 完成，domain 负责读回并校验旧记录。
//
// 生效链路：Task 11 的 Host 总装调用 openFeishuStore(ctx)，把返回的 Store 传给
// inbound/replies/sessions/provision/routes；插件的 ctx.effect 清理时调用 close()。
//
// 已知边界：
//   - domain 名为什么是 `dsh_feishu` 而不是包名里的 `dsh-feishu`：宿主 storage-domain 的
//     UNIT_NAME_RE 为 /^[a-z][a-z0-9_]*$/，连字符会让 defineDomain 在模块加载期直接抛错。
//     域名字段是持久化契约，按宿主语法取合法形式；插件名/日志仍用 `dsh-feishu`。
//   - `DSH_FEISHU_APP_ID` / `DSH_FEISHU_APP_SECRET` 以字符串形式交给 credentials 服务。
//     本包没有声明 `@deepseek-ai/dsh-credentials` 依赖（Task 1 只声明 storage-domain 与
//     zod 两个 optional peer），而凭据服务在运行时以字符串本质接收 CredentialRef
//     （brandString 为恒等），因此这里不 import 凭据包，避免新增运行时依赖。
//   - saveCredentials 不是跨两个 ref 的事务：第二个 set 失败时第一个可能已写入；
//     下一次扫码/保存会整体覆盖，读侧只有两个 ref 都解析成功才算已配置。
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** App ID 的 CredentialRef 名（环境变量/POSIX 标识符形状）。 */
export const APP_ID_REF = 'DSH_FEISHU_APP_ID'

/** App Secret 的 CredentialRef 名（环境变量/POSIX 标识符形状）。 */
export const APP_SECRET_REF = 'DSH_FEISHU_APP_SECRET'

/** 记录状态枚举：持久层只允许这四个值。 */
export const RECORD_STATES = Object.freeze(['pending', 'processing', 'done', 'failed'])

/** 非秘密配置默认值：默认 cwd 为空（由会话创建时决定），文件上限 50 MiB。 */
export const DEFAULT_CONFIG = Object.freeze({
  defaultCwd: '',
  fileMaxBytes: 52_428_800,
})

const recordStateSchema = z.enum(RECORD_STATES)

/** 绑定记录：一个 open_id 自有的会话集合、当前会话与每会话云文档。 */
export const BindingRecordSchema = z
  .object({
    sessionIds: z.array(z.string()),
    currentSessionId: z.string(),
    docs: z.record(z.string(), z.object({
      documentId: z.string(),
      url: z.string(),
    }).strict()),
    updatedAt: z.number(),
  })
  .strict()

/** 入站记录：message_id 为 key，raw 保留原始事件文本用于恢复解析。 */
export const InboxRecordSchema = z
  .object({
    openId: z.string(),
    raw: z.string(),
    state: recordStateSchema,
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.number(),
    error: z.string(),
    receivedAt: z.number(),
  })
  .strict()

/** 出站记录：request_id 为 key，交付类型只允许 reply/failure。 */
export const OutboxRecordSchema = z
  .object({
    openId: z.string(),
    sessionId: z.string(),
    requestId: z.string(),
    kind: z.enum(['reply', 'failure']),
    text: z.string(),
    documentId: z.string().optional(),
    url: z.string().optional(),
    state: recordStateSchema,
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.number(),
    error: z.string(),
    createdAt: z.number(),
  })
  .strict()

/** 非秘密全局配置；strict 保证任何 Secret 字段（如 appSecret）在写入前被拒绝。 */
export const ConfigSchema = z
  .object({
    defaultCwd: z.string().default(DEFAULT_CONFIG.defaultCwd),
    fileMaxBytes: z.number().int().positive().default(DEFAULT_CONFIG.fileMaxBytes),
  })
  .strict()

/**
 * `dsh_feishu` 域的静态声明。字段名、版本与表名是持久化契约，改动必须同步迁移方案。
 * 导出名特意带 STORE：`lib/feishu/{rest,ws}.mjs` 已把 `FEISHU_DOMAIN` 用作 open.feishu.cn
 * 的 HTTP 域名，同名的 spec 常量会在统一 re-export 时产生歧义（device.mjs 同样用
 * `ACCOUNTS_FEISHU_DOMAIN` 规避）。
 * global 的 initial 让首次打开返回默认配置，且不写入介质（首次 setConfig 才落盘）。
 */
export const FEISHU_STORE_DOMAIN = defineDomain({
  name: 'dsh_feishu',
  version: 1,
  tables: {
    bindings: domainTable(BindingRecordSchema),
    inbox: domainTable(InboxRecordSchema),
    outbox: domainTable(OutboxRecordSchema),
  },
  global: {
    schema: ConfigSchema,
    initial: { ...DEFAULT_CONFIG },
  },
})

/**
 * 校验表记录 key（表 key 不在 zod 记录 schema 内，单独把关）。
 * @param {string} kind 表名，用于错误文案
 * @param {unknown} key 待校验 key
 * @returns {string} 原 key
 */
function assertKey(kind, key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError(`${kind}: key 必须是非空字符串`)
  }
  return key
}

/**
 * 校验一次同步变换的结果是普通记录（而不是 Promise），再交给 schema 校验。
 * @param {unknown} value 变换返回值
 * @returns {unknown} 原值
 */
function assertSyncTransform(value) {
  if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
    throw new TypeError('update 回调必须是同步纯函数，不能返回 Promise')
  }
  return value
}

/**
 * 打开飞书桥持久化 Store。
 * @param {object} ctx Host 上下文，需要 `ctx.storageDomain` 与 `ctx.credentials`
 * @returns {Promise<object>} Store 实例；调用方负责 close()
 */
export async function openFeishuStore(ctx) {
  const storageDomain = ctx?.storageDomain
  if (storageDomain === undefined || storageDomain === null) {
    throw new Error('openFeishuStore: ctx.storageDomain 不可用')
  }
  const credentials = ctx?.credentials
  if (credentials === undefined || credentials === null) {
    throw new Error('openFeishuStore: ctx.credentials 不可用')
  }

  // domain 由本 Store 独占并负责关闭；重复 open 同名域会由 facility 拒绝。
  const domain = await storageDomain.open(FEISHU_STORE_DOMAIN)
  const bindings = domain.table('bindings')
  const inbox = domain.table('inbox')
  const outbox = domain.table('outbox')

  let closing
  /**
   * open_id → 绑定读改写串行链（与 domain 写链配合）。
   *
   * 为什么在 Store 上再加一层进程内串行：domain 的 `table.update` 只保证同一 key 的
   * 队列顺序，但「key 尚不存在」时无法走 update（会 reject missing-key）。把
   * 「首次创建 / 已存在 update」放在同一条 openId 锁内，保证 sessions 的 `/new` 与
   * documents 的文档引用写入不会一个用旧快照覆盖另一个；两个模块共享同一 Store 实例，
   * 因此这是本进程内真正共享的锁，而不是各模块各持一把。
   */
  const bindingChains = new Map()

  /**
   * 同一 openId 串行化：前一个任务失败不阻塞后续任务。
   * @param {string} openId
   * @param {() => Promise<unknown>} task
   * @returns {Promise<unknown>} task 的结果/异常
   */
  function withBindingChain(openId, task) {
    const previous = bindingChains.get(openId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(task)
    const tail = run.then(() => {}, () => {})
    bindingChains.set(openId, tail)
    return run.finally(() => {
      if (bindingChains.get(openId) === tail) bindingChains.delete(openId)
    })
  }

  return {
    // ── credentials：秘密只在这里进出，绝不落 domain ──────────────────────────

    /**
     * 读取完整的一对应用凭据；任一缺失/为空都视为未配置（扫码入口状态）。
     * @returns {Promise<{appId: string, appSecret: string} | undefined>}
     */
    async loadCredentials() {
      const appId = await credentials.resolve(APP_ID_REF)
      const appSecret = await credentials.resolve(APP_SECRET_REF)
      if (appId === undefined || appSecret === undefined) return undefined
      if (appId.value.length === 0 || appSecret.value.length === 0) return undefined
      return { appId: appId.value, appSecret: appSecret.value }
    },

    /**
     * 持久化一对应用凭据（写 provider 管理的可写来源）。
     * @param {{appId?: unknown, appSecret?: unknown}} value 扫码结果
     * @returns {Promise<void>}
     */
    async saveCredentials(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('saveCredentials: 参数必须是 {appId, appSecret} 对象')
      }
      const { appId, appSecret } = value
      // 错误文案只带字段名，绝不带值，避免秘密进入日志。
      if (typeof appId !== 'string' || appId.length === 0) {
        throw new TypeError('saveCredentials: appId 必须是非空字符串')
      }
      if (typeof appSecret !== 'string' || appSecret.length === 0) {
        throw new TypeError('saveCredentials: appSecret 必须是非空字符串')
      }
      await credentials.set(APP_ID_REF, appId)
      await credentials.set(APP_SECRET_REF, appSecret)
    },

    /**
     * 清除应用凭据；provider 对不存在的 ref 是 no-op，因此可重复调用。
     * @returns {Promise<void>}
     */
    async clearCredentials() {
      await credentials.unset(APP_ID_REF)
      await credentials.unset(APP_SECRET_REF)
    },

    // ── bindings：open_id → 自有会话集合 ─────────────────────────────────────

    /**
     * 读取绑定记录。
     * @param {string} openId
     * @returns {object | undefined}
     */
    getBinding(openId) {
      assertKey('getBinding', openId)
      return bindings.get(openId)
    },

    /**
     * 写入绑定记录。
     * @param {string} openId
     * @param {object} value BindingRecord
     * @returns {Promise<object>} 持久后的记录
     */
    async putBinding(openId, value) {
      assertKey('putBinding', openId)
      const record = BindingRecordSchema.parse(value)
      await bindings.put(openId, record)
      return record
    },

    /**
     * 原子读改写绑定记录：同一 openId 的并发写入严格串行，返回持久后的新记录。
     *
     * 实现分两层：
     *   1. `withBindingChain` 是本 Store 内的 per-openId 锁（sessions / documents /
     *      routes 共享），把「记录不存在 → 首次创建」与「已存在 → domain.update」
     *      放进同一临界区，避免首次写入的竞态；
     *   2. 已存在时走 domain 的 `table.update`（单条写链），转换函数拿到的是队列槽位
     *      上的最新值，绝不基于旧快照覆盖并发写入的其它字段。
     *
     * 转换函数必须是同步纯函数（返回 Promise 会被拒绝）；首次创建时以 `undefined`
     * 调用它，调用方负责基于默认记录构造完整 BindingRecord。
     * @param {string} openId
     * @param {(current: object | undefined) => object} fn 同步变换
     * @returns {Promise<object>} 持久后的记录
     */
    async updateBinding(openId, fn) {
      assertKey('updateBinding', openId)
      if (typeof fn !== 'function') {
        throw new TypeError('updateBinding: fn 必须是同步函数')
      }
      return withBindingChain(openId, async () => {
        const current = bindings.get(openId)
        if (current === undefined) {
          const record = BindingRecordSchema.parse(assertSyncTransform(fn(undefined)))
          await bindings.put(openId, record)
          return record
        }
        return bindings.update(openId, (value) => (
          BindingRecordSchema.parse(assertSyncTransform(fn(value)))
        ))
      })
    },

    /**
     * 删除绑定记录。
     * @param {string} openId
     * @returns {Promise<boolean>} 删除前是否存在
     */
    async deleteBinding(openId) {
      assertKey('deleteBinding', openId)
      return bindings.delete(openId)
    },

    /**
     * 遍历全部绑定记录（快照数组）。
     * @returns {Array<[string, object]>}
     */
    bindingEntries() {
      return [...bindings.entries()]
    },

    // ── inbox：message_id → 原始入站事件与处理状态 ───────────────────────────

    /**
     * 读取入站记录。
     * @param {string} id message_id
     * @returns {object | undefined}
     */
    getInbox(id) {
      assertKey('getInbox', id)
      return inbox.get(id)
    },

    /**
     * 写入完整入站记录。
     * @param {string} id message_id
     * @param {object} value InboxRecord
     * @returns {Promise<object>} 持久后的记录
     */
    async putInbox(id, value) {
      assertKey('putInbox', id)
      const record = InboxRecordSchema.parse(value)
      await inbox.put(id, record)
      return record
    },

    /**
     * 更新入站记录：对象 = 完整替换；函数 = 在 domain 写链上同步变换。
     * @param {string} id message_id
     * @param {object | ((current: object) => object)} value
     * @returns {Promise<object>} 持久后的记录
     */
    async updateInbox(id, value) {
      assertKey('updateInbox', id)
      if (typeof value === 'function') {
        return inbox.update(id, (current) => InboxRecordSchema.parse(assertSyncTransform(value(current))))
      }
      const record = InboxRecordSchema.parse(value)
      await inbox.put(id, record)
      return record
    },

    /**
     * 遍历全部入站记录（快照数组）。
     * @returns {Array<[string, object]>}
     */
    inboxEntries() {
      return [...inbox.entries()]
    },

    // ── outbox：request_id → 待投递答复 ──────────────────────────────────────

    /**
     * 读取出站记录。
     * @param {string} id request_id
     * @returns {object | undefined}
     */
    getOutbox(id) {
      assertKey('getOutbox', id)
      return outbox.get(id)
    },

    /**
     * 写入完整出站记录。
     * @param {string} id request_id
     * @param {object} value OutboxRecord
     * @returns {Promise<object>} 持久后的记录
     */
    async putOutbox(id, value) {
      assertKey('putOutbox', id)
      const record = OutboxRecordSchema.parse(value)
      await outbox.put(id, record)
      return record
    },

    /**
     * 更新出站记录：对象 = 完整替换；函数 = 在 domain 写链上同步变换。
     * @param {string} id request_id
     * @param {object | ((current: object) => object)} value
     * @returns {Promise<object>} 持久后的记录
     */
    async updateOutbox(id, value) {
      assertKey('updateOutbox', id)
      if (typeof value === 'function') {
        return outbox.update(id, (current) => OutboxRecordSchema.parse(assertSyncTransform(value(current))))
      }
      const record = OutboxRecordSchema.parse(value)
      await outbox.put(id, record)
      return record
    },

    /**
     * 遍历全部出站记录（快照数组）。
     * @returns {Array<[string, object]>}
     */
    outboxEntries() {
      return [...outbox.entries()]
    },

    // ── 非秘密配置（global）──────────────────────────────────────────────────

    /**
     * 读取当前配置副本。
     * @returns {{defaultCwd: string, fileMaxBytes: number}}
     */
    getConfig() {
      return { ...domain.global.get() }
    },

    /**
     * 部分更新非秘密配置；未知字段（如 Secret）由 strict schema 拒绝。
     * @param {{defaultCwd?: string, fileMaxBytes?: number}} value
     * @returns {Promise<object>} 持久后的配置
     */
    async setConfig(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('setConfig: 参数必须是配置对象')
      }
      const next = ConfigSchema.parse({ ...domain.global.get(), ...value })
      await domain.global.set(next)
      return { ...next }
    },

    // ── 生命周期 ─────────────────────────────────────────────────────────────

    /**
     * 关闭域；幂等，重复调用共享同一个 teardown Promise。
     * @returns {Promise<void>}
     */
    close() {
      closing ??= domain.close()
      return closing
    },
  }
}
