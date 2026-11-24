/**
 * 插件运行体：缓存官方余额，并维护本机全部 DSH 会话的增量用量索引。
 * 启动时用 sessionPersistence 元数据筛出当天可能有事件的会话，再由 sessionQuery 读取；之后只消费 session/event。
 */

import { stat as fsStat } from 'node:fs/promises'
import { requestDeepSeekBalance, DEFAULT_BALANCE_URL, DEFAULT_TIMEOUT_MS } from './balance.mjs'
import {
  applySessionUsageEvent,
  beijingDayKey,
  foldSessionUsage,
  summarizeSessionUsage,
} from './usage.mjs'

export const DEFAULT_BALANCE_MAX_AGE_MS = 5 * 60 * 1000
const HISTORY_BATCH_SIZE = 4

export class DeepSeekAccountRuntime {
  constructor(ctx, config = {}, dependencies = {}) {
    if (typeof ctx?.credentials?.resolve !== 'function'
      || typeof ctx?.sessionQuery?.listSessions !== 'function'
      || typeof ctx?.sessionQuery?.readSession !== 'function'
      || typeof ctx?.sessionPersistence?.list !== 'function'
      || typeof ctx?.on !== 'function') {
      throw new TypeError('dsh-deepseek-account: credentials/sessionQuery/sessionPersistence/ctx.on 不可用')
    }
    this.ctx = ctx
    this.credentialRef = config.credentialRef ?? 'DEEPSEEK_API_KEY'
    this.baseUrl = config.baseUrl ?? DEFAULT_BALANCE_URL
    this.balanceMaxAgeMs = config.balanceMaxAgeMs ?? DEFAULT_BALANCE_MAX_AGE_MS
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = dependencies.now ?? (() => Date.now())
    this.fetchImpl = dependencies.fetchImpl ?? ((...args) => globalThis.fetch(...args))
    this.stat = dependencies.stat ?? fsStat
    this.sessions = new Map()
    this.pendingEvents = new Map()
    this.loadingSessions = new Map()
    this.failedSessions = new Set()
    this.usageStatus = 'loading'
    this.usageUpdatedAt = null
    this.usagePromise = null
    this.balancePromise = null
    this.lastBalanceAttempt = null
    this.balance = {
      status: 'loading',
      isAvailable: false,
      balances: [],
      updatedAt: null,
      error: null,
    }
    this.started = false
    this.disposed = false
    this.disposeListener = null
  }

  /** 启动事件订阅与唯一一次全量历史建索引。 */
  start() {
    if (this.started || this.disposed) return
    this.started = true
    this.disposeListener = this.ctx.on('session/event', (session, event) => {
      try {
        this._onSessionEvent(session, event)
      } catch {
        // 观感插件的事件监听器不得把异常抛回 Agent/Session 提交流。
        if (typeof session?.id === 'string') this.failedSessions.add(session.id)
      }
    })
    this.usagePromise = this._scanUsage()
  }

  /** 刷新状态；普通轮询受余额 TTL 限制，点击刷新会强制请求并重试失败会话。 */
  async refresh(force = false) {
    this.start()
    if (force && (this.usageStatus === 'error' || this.failedSessions.size > 0)) {
      this.usagePromise = this._scanUsage()
    }
    await Promise.all([this.usagePromise, this._refreshBalance(force)])
    return this.snapshot()
  }

  /** 当前可序列化、已脱敏状态。 */
  snapshot() {
    const day = beijingDayKey(this.now())
    const usage = summarizeSessionUsage(this.sessions.values(), day)
    return {
      balance: { ...this.balance, balances: this.balance.balances.map((entry) => ({ ...entry })) },
      usage: {
        status: this.failedSessions.size > 0 ? 'partial' : this.usageStatus,
        day,
        ...usage,
        failedSessions: this.failedSessions.size,
        updatedAt: this.usageUpdatedAt,
      },
    }
  }

  /** 停止接收事件；进行中的请求完成后也不能再修改已卸载实例。 */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.disposeListener?.()
    this.disposeListener = null
  }

  /** 新事件优先增量折叠；尚未建索引的会话先排队，再读取完整日志。 */
  _onSessionEvent(session, event) {
    if (this.disposed || typeof session?.id !== 'string') return
    const id = session.id
    const cache = this.sessions.get(id)
    if (cache !== undefined) {
      applySessionUsageEvent(cache, event)
      this.usageUpdatedAt = this.now()
      return
    }
    const pending = this.pendingEvents.get(id) ?? []
    pending.push(event)
    this.pendingEvents.set(id, pending)
    // 不覆盖全量扫描的 promise；刷新可能仍在等待其他历史会话。
    void this._loadSession(id)
  }

  /** 分批读取历史，限制冷启动时的持久化 I/O 并发。 */
  async _scanUsage() {
    this.usageStatus = 'loading'
    try {
      const [records, persisted] = await Promise.all([
        this.ctx.sessionQuery.listSessions(),
        this.ctx.sessionPersistence.list(),
      ])
      const persistedById = new Map(persisted.map((record) => [record.header.id, record]))
      const dayStart = Date.parse(beijingDayKey(this.now()) + 'T00:00:00+08:00')
      const candidates = []
      for (const record of records) {
        if (await this._mayHaveUsageToday(record, persistedById.get(record.header.id), dayStart)) {
          candidates.push(record)
        }
      }
      // live 会话优先；其余保持 sessionQuery 的创建时间倒序，让首屏尽快覆盖近期活动。
      candidates.sort((left, right) => Number(right.live) - Number(left.live))
      for (let offset = 0; offset < candidates.length; offset += HISTORY_BATCH_SIZE) {
        const batch = candidates.slice(offset, offset + HISTORY_BATCH_SIZE)
        await Promise.all(batch.map((record) => this._loadSession(record.header.id)))
        if (this.disposed) return
      }
      this.usageStatus = 'ready'
    } catch {
      this.usageStatus = 'error'
    } finally {
      this.usageUpdatedAt = this.now()
    }
  }

  /**
   * 判断会话是否可能在北京时间今天产生过事件。
   * live 会话始终读取；JSONL 是追加写日志，文件 mtime 早于日界即可安全跳过。
   * 非文件后端、未物化会话或元数据读取失败时仍读取，避免漏算来换取速度。
   */
  async _mayHaveUsageToday(record, persisted, dayStart) {
    if (record.live) return true
    const location = persisted?.location
    if (location?.kind !== 'jsonl' || typeof location.path !== 'string') return true
    try {
      const metadata = await this.stat(location.path)
      return metadata.mtimeMs >= dayStart
    } catch {
      return true
    }
  }

  /** 读取一个会话并吸收读取期间到达的排队事件；同会话并发加载合并。 */
  _loadSession(id) {
    const existing = this.loadingSessions.get(id)
    if (existing !== undefined) return existing
    const promise = (async () => {
      try {
        const snapshot = await this.ctx.sessionQuery.readSession(id)
        if (this.disposed) return
        const cache = foldSessionUsage(snapshot.events, snapshot.inheritedEventCount)
        const pending = this.pendingEvents.get(id) ?? []
        for (const event of pending) applySessionUsageEvent(cache, event)
        this.pendingEvents.delete(id)
        this.sessions.set(id, cache)
        this.failedSessions.delete(id)
      } catch {
        this.failedSessions.add(id)
      } finally {
        this.loadingSessions.delete(id)
        this.usageUpdatedAt = this.now()
      }
    })()
    this.loadingSessions.set(id, promise)
    return promise
  }

  /** 余额 TTL 与单飞请求；每次操作重新解析凭据，使 Models 页改 key 后无需重启。 */
  _refreshBalance(force) {
    if (this.balancePromise !== null) return this.balancePromise
    const now = this.now()
    if (!force && this.lastBalanceAttempt !== null
      && now - this.lastBalanceAttempt < this.balanceMaxAgeMs) return Promise.resolve()
    this.lastBalanceAttempt = now
    this.balancePromise = (async () => {
      try {
        let credential
        try {
          credential = await this.ctx.credentials.resolve(this.credentialRef)
        } catch {
          if (!this.disposed) {
            this.balance = { ...this.balance, status: 'error', error: '无法读取 DeepSeek API Key' }
          }
          return
        }
        if (this.disposed) return
        if (credential === undefined) {
          this.balance = {
            status: 'unconfigured', isAvailable: false, balances: [],
            updatedAt: this.now(), error: null,
          }
          return
        }
        const result = await requestDeepSeekBalance({
          apiKey: credential.value,
          baseUrl: this.baseUrl,
          timeoutMs: this.timeoutMs,
          fetchImpl: this.fetchImpl,
        })
        if (this.disposed) return
        this.balance = {
          status: 'ready', ...result, updatedAt: this.now(), error: null,
        }
      } catch (error) {
        if (this.disposed) return
        this.balance = {
          ...this.balance,
          status: 'error',
          error: typeof error?.message === 'string' ? error.message.slice(0, 200) : '余额查询失败',
        }
      } finally {
        this.balancePromise = null
      }
    })()
    return this.balancePromise
  }
}
