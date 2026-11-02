// @gavinc-cn/dsh-feishu —— 一次性绑定码
//
// 目的：让 DSH 面板生成一个短码，用户在飞书私聊里发送 `/bind <码>` 完成 open_id 绑定。
// 绑定码只存内存（不落 domain/日志），随机、一次性、10 分钟过期；校验失败按 open_id
// 记在有界尝试表里限频，防止穷举。
//
// 设计约束：
//   - 码本身只在 issue() 的返回值里出现；本模块不接收 logger，任何错误/返回值都不含
//     Secret（App Secret / access token）。
//   - 成功校验才写 BindingRecord，且只写调用方传入的 open_id；已存在的绑定保留其
//     sessionIds/currentSessionId/docs，只刷新 updatedAt。
//   - 尝试表以 open_id 为键，超过 maxTrackedOpenIds 时淘汰最旧记录（Map 插入序），
//     内存占用有界；成功绑定或 revoke(openId) 会清掉该 open_id 的尝试记录。
//   - 限频检查先于码校验：超限期间即使码正确也不消费、不绑定。
//   - revoke(openId) 删除绑定并清理尝试记录；删不到绑定返回 false，重复调用幂等。
//
// 生效链路：Task 11 的 Host 总装创建 BindingCodes({store})，交给 FeishuInbound 消费
// `/bind`、交给 routes 生成绑定码/撤销绑定。换应用凭据时由 FeishuInbound 遍历绑定并
// 逐个 revoke。
import { randomInt } from 'node:crypto'

import { BindingRecordSchema } from './store.mjs'

/** 绑定码有效期：10 分钟。 */
export const BINDING_CODE_TTL_MS = 10 * 60 * 1000

/** 同一 open_id 在窗口内允许的失败次数。 */
export const BINDING_FAILURE_LIMIT = 5

/** 失败计数窗口：10 分钟；超限后整个窗口内拒绝。 */
export const BINDING_FAILURE_WINDOW_MS = 10 * 60 * 1000

/** 尝试表最多保留多少个 open_id（超出淘汰最旧记录）。 */
export const BINDING_MAX_TRACKED_OPEN_IDS = 1000

/** 绑定码字符集：去掉易混的 I/O/0/1。 */
export const BINDING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 绑定码长度。 */
export const BINDING_CODE_LENGTH = 8

/** 用户可见回执文案（测试与路由共用，避免各处各写一份）。 */
export const BINDING_MESSAGES = Object.freeze({
  success: '绑定成功，可以开始对话了',
  invalid: '绑定码无效或已使用，请在 DSH 飞书桥面板重新生成绑定码',
  expired: '绑定码已过期（有效期 10 分钟），请在面板重新生成',
  rateLimited: '尝试次数过多，请稍后再试',
  usage: '用法：/bind <绑定码>；绑定码请在 DSH 飞书桥面板生成',
})

/**
 * 生成一个空的 BindingRecord（尚未创建任何 DSH 会话）。
 * @param {number} [now=Date.now()] 当前时间（毫秒）
 * @returns {{sessionIds: string[], currentSessionId: string, docs: object, updatedAt: number}}
 */
export function makeBindingRecord(now = Date.now()) {
  return {
    sessionIds: [],
    currentSessionId: '',
    docs: {},
    updatedAt: now,
  }
}

/**
 * 把失败结果记录到有界尝试表。
 * @param {Map<string, {count: number, windowStart: number, blockedUntil: number}>} attempts
 * @param {string} openId
 * @param {number} now
 * @param {{failureLimit: number, failureWindowMs: number, maxTrackedOpenIds: number}} limits
 * @returns {void}
 */
function recordFailure(attempts, openId, now, limits) {
  let attempt = attempts.get(openId)
  if (attempt !== undefined && now - attempt.windowStart >= limits.failureWindowMs) {
    attempt = undefined
  }
  if (attempt === undefined) {
    attempt = { count: 0, windowStart: now, blockedUntil: 0 }
  }
  attempt.count += 1
  if (attempt.count >= limits.failureLimit) {
    attempt.blockedUntil = attempt.windowStart + limits.failureWindowMs
  }
  // 重新插入到 Map 尾部，让「最旧」= 最早写入/最近一次窗口起点最早的那条先被淘汰。
  attempts.delete(openId)
  attempts.set(openId, attempt)
  while (attempts.size > limits.maxTrackedOpenIds) {
    attempts.delete(attempts.keys().next().value)
  }
}

/**
 * 查询 open_id 当前是否处于限频中；窗口过期时顺手清理记录。
 * @param {Map<string, {count: number, windowStart: number, blockedUntil: number}>} attempts
 * @param {string} openId
 * @param {number} now
 * @param {{failureWindowMs: number}} limits
 * @returns {number} 剩余等待毫秒；0 表示未限频
 */
function blockedFor(attempts, openId, now, limits) {
  const attempt = attempts.get(openId)
  if (attempt === undefined) return 0
  if (attempt.blockedUntil > now) return attempt.blockedUntil - now
  if (now - attempt.windowStart >= limits.failureWindowMs) {
    attempts.delete(openId)
  }
  return 0
}

/**
 * 一次性绑定码管理器。
 *
 * 构造参数（都可注入，便于单测拨时钟/缩小限频窗口）：
 * - `store`：Task 3 的 Store；必须提供 updateBinding/deleteBinding（写绑定走 per-openId 写链）。
 * - `now`：时钟（毫秒）。
 * - `ttlMs` / `failureLimit` / `failureWindowMs` / `maxTrackedOpenIds`：见上方常量。
 */
export class BindingCodes {
  constructor({
    store,
    now = Date.now,
    ttlMs = BINDING_CODE_TTL_MS,
    failureLimit = BINDING_FAILURE_LIMIT,
    failureWindowMs = BINDING_FAILURE_WINDOW_MS,
    maxTrackedOpenIds = BINDING_MAX_TRACKED_OPEN_IDS,
  } = {}) {
    if (store === null || store === undefined) {
      throw new TypeError('BindingCodes: 必须提供 store')
    }
    if (typeof now !== 'function') throw new TypeError('BindingCodes: now 必须是函数')
    if (typeof store.updateBinding !== 'function') {
      throw new TypeError('BindingCodes: store.updateBinding 不可用')
    }
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new RangeError('BindingCodes: ttlMs 必须是正整数')
    }
    if (!Number.isInteger(failureLimit) || failureLimit <= 0) {
      throw new RangeError('BindingCodes: failureLimit 必须是正整数')
    }
    if (!Number.isInteger(failureWindowMs) || failureWindowMs <= 0) {
      throw new RangeError('BindingCodes: failureWindowMs 必须是正整数')
    }
    if (!Number.isInteger(maxTrackedOpenIds) || maxTrackedOpenIds <= 0) {
      throw new RangeError('BindingCodes: maxTrackedOpenIds 必须是正整数')
    }

    this._store = store
    this._now = now
    this._ttlMs = ttlMs
    this._limits = { failureLimit, failureWindowMs, maxTrackedOpenIds }
    /** @type {Map<string, number>} code -> 过期时间（毫秒） */
    this._codes = new Map()
    /** @type {Map<string, {count: number, windowStart: number, blockedUntil: number}>} */
    this._attempts = new Map()
  }

  /**
   * 生成绑定码（随机、唯一、默认 10 分钟有效）。
   * @returns {string} 绑定码；只在本次返回值里出现，不写日志
   */
  issue() {
    const now = this._now()
    this._sweep(now)
    for (;;) {
      let code = ''
      for (let i = 0; i < BINDING_CODE_LENGTH; i += 1) {
        code += BINDING_CODE_ALPHABET[randomInt(0, BINDING_CODE_ALPHABET.length)]
      }
      if (!this._codes.has(code)) {
        this._codes.set(code, now + this._ttlMs)
        return code
      }
    }
  }

  /**
   * 校验并消费绑定码；成功时写入该 open_id 的 BindingRecord。
   *
   * 返回：
   * - `{ok: true, message, binding}`：码有效，绑定已持久；
   * - `{ok: false, reason: 'invalid'|'expired'|'rate-limited', message, retryAfterMs?}`：
   *   码不存在/已用、已过期，或该 open_id 失败次数超限。失败都不会写绑定。
   *
   * @param {string} code 用户发来的绑定码
   * @param {string} openId 私聊发送者 open_id
   * @returns {Promise<object>}
   */
  async verify(code, openId) {
    if (typeof code !== 'string' || code.length === 0) {
      throw new TypeError('verify: code 必须是非空字符串')
    }
    if (typeof openId !== 'string' || openId.length === 0) {
      throw new TypeError('verify: openId 必须是非空字符串')
    }

    const now = this._now()
    const retryAfterMs = blockedFor(this._attempts, openId, now, this._limits)
    if (retryAfterMs > 0) {
      return {
        ok: false,
        reason: 'rate-limited',
        message: BINDING_MESSAGES.rateLimited,
        retryAfterMs,
      }
    }

    // 不在查码前 sweep：过期码要能回「已过期」而不是「无效」。
    const expiresAt = this._codes.get(code)
    if (expiresAt === undefined) {
      recordFailure(this._attempts, openId, now, this._limits)
      return { ok: false, reason: 'invalid', message: BINDING_MESSAGES.invalid }
    }
    if (now >= expiresAt) {
      this._codes.delete(code)
      recordFailure(this._attempts, openId, now, this._limits)
      return { ok: false, reason: 'expired', message: BINDING_MESSAGES.expired }
    }

    // 先消费码、再 await 写绑定：堵住「检查后/落盘前」的并发窗口，
    // 同一码不可能被两个 open_id 同时绑定成功。写失败时再把码退回。
    this._codes.delete(code)
    let record
    try {
      // 走 Store 的 per-openId 写链：保留并发的 sessionIds/docs 更新，不能拿旧快照覆盖。
      record = await this._store.updateBinding(openId, (current) => {
        const binding = current === null || current === undefined
          ? makeBindingRecord(now)
          : { ...current, updatedAt: now }
        // 再走一次 schema，保证写出去的形状与 Task 3 的持久化契约一致。
        return BindingRecordSchema.parse(binding)
      })
    } catch (error) {
      // 存储失败 = 未绑定成功：把码退回到原过期时间（若还没过期）。
      if (this._now() < expiresAt) this._codes.set(code, expiresAt)
      throw error
    }

    this._attempts.delete(openId)
    return { ok: true, message: BINDING_MESSAGES.success, binding: record }
  }

  /**
   * 撤销一个 open_id 的绑定并清空尝试记录。
   * @param {string} openId
   * @returns {Promise<boolean>} 删除前是否存在绑定
   */
  async revoke(openId) {
    if (typeof openId !== 'string' || openId.length === 0) {
      throw new TypeError('revoke: openId 必须是非空字符串')
    }
    this._attempts.delete(openId)
    if (typeof this._store.deleteBinding !== 'function') return false
    return this._store.deleteBinding(openId)
  }

  /**
   * 清空全部未消费的码与限频记录。换应用凭据时调用：旧应用生成的码必须立即失效。
   * @returns {void}
   */
  reset() {
    this._codes.clear()
    this._attempts.clear()
  }

  /**
   * 清理过期/已消费的码（已消费的码直接从 Map 删除；这里只处理过期）。
   * @param {number} now
   * @returns {void}
   */
  _sweep(now) {
    for (const [code, expiresAt] of this._codes) {
      if (now >= expiresAt) this._codes.delete(code)
    }
  }
}
