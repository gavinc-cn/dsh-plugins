// @gavinc-cn/dsh-feishu —— 扫码配置状态机（Device Flow → 保存凭据 → 显式补齐/发布）
//
// 目的：面板只通过本模块的 Status 观察扫码进度；流程成功后先把 App ID/Secret 写进
// Task 3 的 Store（credentials），再通知宿主 `onCredentials`，绝不把 Secret/device_code
// 放进任何公开状态。
//
// 设计约束：
//   - Device Flow 只复用 `lib/feishu/device.mjs` 的 `makeDeviceFlow`（不复制协议判定），
//     REST 只复用 `lib/feishu/rest.mjs`；二维码由随包 vendor 的 MIT 实现生成；
//   - 临时状态（二维码、URL、步骤、错误）只存内存；凭据只经 Store 的 credentials 出入口；
//   - `start()` 幂等：进行中的 waiting 直接返回现状；`force` 才取消旧流程重建；
//   - 每次流程有 generation，旧 worker 的成功/失败/域切换都被 generation 挡住，
//     不能覆盖新流程；后台 worker 的所有异常都收敛成 Status，不向外抛；
//   - `apply()` / `publish()` 只能显式调用；成功后不会自动补齐或发布；
//   - `dispose()` 只取消轮询，不删已保存凭据（凭据归 Store/宿主生命周期管理）。
//
// 生效链路：Task 11 Host 总装创建 `FeishuProvisioner`，routes 的 `/api/feishu/provision`
// 调 start/cancel/apply/publish，状态面板轮询 `status()`；插件卸载时 `dispose()`。
//
// 已知边界：
//   - publish 的版本号按远端 `app_versions` 的最大语义版本补丁位 +1（无版本回 1.0.0）；
//     发布后仍需租户管理员审批，本模块只负责提交；
//   - apply 失败保留 `state: success`（应用/凭据已建成）并把可操作错误放进 `error`，
//     不伪报整体失败，也不静默；
//   - 二维码 URL 来自 device.mjs 的 onQrCode（已带 addons），面板展示的就是这条原样 URL；
//     域切换时旧链接失效，这里清空 url/qr，避免误导扫码。
import { _provisionAddons, createCancelEvent, DEVICE_REQUIRED_CALLBACKS, DEVICE_REQUIRED_EVENTS, DEVICE_REQUIRED_SCOPES, makeDeviceFlow } from './feishu/device.mjs'
import { rest } from './feishu/rest.mjs'
import { redactError } from './utils.mjs'
import { toSvgDataUrl } from './vendor/qrcode/index.mjs'

/** 扫码流程状态存活上限（秒），与 Touchstone `PROVISION_TTL=600` 对齐。 */
export const PROVISION_TTL_S = 600

/** 应用配置/发布端点（官方 application/v7；能力开关在 ability 子路径）。 */
export const APP_ABILITY_PATH = (appId) => `/open-apis/application/v7/applications/${appId}/ability`
export const APP_CONFIG_PATH = (appId) => `/open-apis/application/v7/applications/${appId}/config`
export const APP_PUBLISH_PATH = (appId) => `/open-apis/application/v7/applications/${appId}/publish`
/** 版本列表端点：`lang` 是**必填**查询参数（缺省时飞书回 99992402 field validation failed；
 *  2026-10-31 真机核对：同一 app 仅把 `?lang=zh_cn` 补上，错误就从 99992402 变成正常的
 *  权限判定 —— 见 doc_ai/test_report/202610/20261030_0744_DSH飞书桥插件验证.md）。 */
export const APP_VERSIONS_PATH = (appId) => `/open-apis/application/v6/applications/${appId}/app_versions?lang=zh_cn`

/** 「应用缺 patch 权限」类错误码（与 Touchstone `_SLASH_PERM_CODES` 同集）。 */
export const PATCH_SCOPE_CODES = Object.freeze([99991640, 99991672, 99991679])

/** 缺 `application:application:patch` 时的可操作引导（错误文案不含秘密）。 */
export const PATCH_SCOPE_HINT = '应用缺少「application:application:patch」权限：请到开发者后台 → 权限管理添加该权限并创建版本发布；或把该权限对应用设为免审后再试'

/** 没有凭据时的统一文案。 */
export const NO_CREDENTIALS_ERROR = '应用凭据未配置（App ID / App Secret），请先保存凭据'

/** 发布时写给飞书的默认版本说明（中文，与既有实现一致）。 */
export const PUBLISH_REMARK = 'DSH 飞书桥配置自动化'
export const PUBLISH_CHANGELOG = '自动配置：机器人能力 / 权限 / 长连接事件订阅 / 卡片回调'

/** `sleep` 缺省实现（真时钟；测试注入假时钟） */
function defaultSleep(seconds) {
  return new Promise((resolve) => { setTimeout(resolve, Math.max(0, seconds) * 1000) })
}

/** 从版本列表里取最大语义版本补丁位 +1（无版本回 1.0.0；忽略非 x.y.z）。 */
export function nextVersion(items) {
  let best = null
  for (const item of items || []) {
    const raw = String((item && item.version) || '').trim()
    if (!/^\d+\.\d+\.\d+$/.test(raw)) continue
    const nums = raw.split('.').map((part) => Number(part))
    if (best === null || compareVersion(nums, best) > 0) best = nums
  }
  if (best === null) return '1.0.0'
  return `${best[0]}.${best[1]}.${best[2] + 1}`
}

/** 整数三元组比较（避免字符串序把 1.0.10 判成小于 1.0.3） */
function compareVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/** 判断 REST 错误是否属于「缺 patch 权限」 */
function needsPatchScope(error) {
  return PATCH_SCOPE_CODES.includes(error && error.code)
}

/** 把未知异常折成脱敏文本（不把 Secret 写进 Status） */
function errorText(error) {
  return redactError(error instanceof Error ? error.message : String(error))
}

/**
 * 扫码配置状态机。
 *
 * @param {object} options
 * @param {{loadCredentials: Function, saveCredentials: Function}} options.store Task 3 Store
 * @param {(value: {appId: string, appSecret: string}) => (void|Promise<void>)} [options.onCredentials]
 *        凭据持久化成功后通知宿主（启动 WS 等）；回调抛错不会回滚已保存凭据
 * @param {Function} [options.fetch] fetch 替身（测试用；缺省 globalThis.fetch）
 * @param {() => number} [options.now] 时钟替身（秒；缺省 Date.now()/1000）
 * @param {(seconds: number) => Promise<void>} [options.sleep] 睡眠替身（测试假时钟）
 * @param {object} [options.qrOptions] 传给 vendor SVG 渲染器的选项（width/margin/color）
 * @param {number} [options.ttlSeconds] waiting 状态存活上限（缺省 PROVISION_TTL_S）
 */
export class FeishuProvisioner {
  #store
  #onCredentials
  #fetch
  #now
  #sleep
  #qrOptions
  #ttlSeconds
  #domain
  #larkDomain

  #state = 'idle'
  #url = ''
  #qr = ''
  #appId = ''
  #error = ''
  #steps = []
  #startedAt = 0
  #expiresAt = 0
  #apply = null
  #publish = null

  #generation = 0
  #cancelEvent = null
  #ready = null
  #worker = null
  #disposed = false
  #startPromise = null
  #saveChain = Promise.resolve()

  constructor(options = {}) {
    if (options.store === undefined || options.store === null) {
      throw new TypeError('FeishuProvisioner: options.store 不可用')
    }
    this.#store = options.store
    this.#onCredentials = typeof options.onCredentials === 'function' ? options.onCredentials : null
    this.#fetch = typeof options.fetch === 'function'
      ? options.fetch
      : (...args) => globalThis.fetch(...args)
    this.#now = typeof options.now === 'function' ? options.now : () => Date.now() / 1000
    this.#sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep
    this.#qrOptions = options.qrOptions && typeof options.qrOptions === 'object'
      ? { ...options.qrOptions }
      : {}
    this.#ttlSeconds = Number.isFinite(options.ttlSeconds) && options.ttlSeconds > 0
      ? options.ttlSeconds
      : PROVISION_TTL_S
    // 域覆盖只给测试/私有化部署留缝；缺省仍由 device.mjs 决定飞书/Lark 主域。
    this.#domain = options.domain
    this.#larkDomain = options.larkDomain
  }

  /**
   * 发起扫码；进行中的流程幂等返回现状。已有凭据且未 force 时只返回提示，不发起流程。
   * @param {boolean} [force] 已配置/已在等待时是否强制换应用
   * @returns {Promise<object>} 当前 Status
   */
  start(force = false) {
    // 单飞：同一次 start 的在飞 Promise 直接复用，避免并发点击起两条 Device Flow。
    if (this.#startPromise !== null) return this.#startPromise
    const promise = this.#start(force)
    this.#startPromise = promise
    const clear = () => {
      if (this.#startPromise === promise) this.#startPromise = null
    }
    promise.then(clear, clear)
    return promise
  }

  /** start 的实际实现（由单飞包装进入；不要直接调用）。 */
  async #start(force = false) {
    if (this.#disposed) {
      return this.#withError(this.status(), '已释放，不能重新扫码')
    }
    const current = this.status()
    if (current.state === 'waiting' && !force) return current

    let saved
    try {
      saved = await this.#store.loadCredentials()
    } catch (error) {
      return this.#withError(this.status(), `读取应用凭据失败: ${errorText(error)}`)
    }
    if (saved !== undefined && saved !== null && !force) {
      return this.#withError(this.status(),
        `已配置应用 ${saved.appId}；如需换应用请确认后重试`)
    }

    // force/过期/无流程：先把旧 worker 作废，再建新 generation。
    if (this.#state === 'waiting') this.#abandonCurrent()
    const gen = this.#nextGeneration()
    const cancelEvent = createCancelEvent()
    this.#cancelEvent = cancelEvent
    this.#state = 'waiting'
    this.#url = ''
    this.#qr = ''
    this.#appId = ''
    this.#error = ''
    this.#steps = []
    this.#apply = null
    this.#publish = null
    const started = this.#now()
    this.#startedAt = Math.round(started * 1000)
    this.#expiresAt = Math.round((started + this.#ttlSeconds) * 1000)

    const ready = { gen, resolve: null }
    const promise = new Promise((resolve) => { ready.resolve = resolve })
    this.#ready = ready

    const flow = makeDeviceFlow({
      fetch: this.#fetch,
      now: this.#now,
      sleep: this.#sleep,
      addons: _provisionAddons(),
      cancelEvent,
      domain: this.#domain,
      larkDomain: this.#larkDomain,
      onQrCode: (info) => {
        if (gen !== this.#generation) return
        const url = info && typeof info.url === 'string' ? info.url : ''
        this.#url = url
        try {
          this.#qr = toSvgDataUrl(url, this.#qrOptions)
        } catch (error) {
          // QR 生成失败不改变 waiting：URL 仍可复制给用户，但如实记录原因。
          this.#qr = ''
          this.#error = `二维码生成失败: ${errorText(error)}`
        }
        this.#settleReady(gen)
      },
      onStatusChange: (info) => {
        if (gen !== this.#generation) return
        // 域切换后旧 URL 失效；device.mjs 不会重新 begin，因此清空而不是展示旧码。
        if (info && info.status === 'domain_switched') {
          this.#url = ''
          this.#qr = ''
        }
      },
    })

    // 后台跑完整流程；start() 只等到首个二维码（或首个终态），之后由面板轮询 status()。
    this.#worker = this.#runWorker(gen, flow)
    await promise
    return this.status()
  }

  /**
   * 取消进行中的扫码；只清临时状态，不动已保存凭据。
   * @returns {object} 当前 Status
   */
  cancel() {
    if (this.#state !== 'waiting') {
      return this.#withError(this.status(), '当前没有进行中的扫码流程')
    }
    const gen = this.#generation
    this.#cancelEvent?.set()
    this.#nextGeneration()
    this.#state = 'cancelled'
    this.#url = ''
    this.#qr = ''
    this.#error = ''
    this.#settleReady(gen)
    return this.status()
  }

  /**
   * 显式补齐应用配置（机器人能力 + 权限 + 长连接订阅 + 事件 + 回调）。
   * 失败时保留 `state: success`（应用/凭据已建成），把可操作错误放进 `error`。
   * @returns {Promise<object>} 当前 Status（含 apply 结果）
   */
  async apply() {
    const credentials = await this.#loadCredentials()
    if (credentials === undefined) return this.#recordCredentialError('apply')
    const blocked = this.#managementBlock(credentials, '补齐配置')
    if (blocked !== '') return this.#recordManageBlocked('apply', blocked)
    const steps = []
    try {
      await rest('PATCH', APP_ABILITY_PATH(credentials.appId), {
        jsonBody: { bot: { enable: true } },
        cfg: credentials,
        fetch: this.#fetch,
      })
      steps.push({
        key: 'ability',
        label: '开启机器人能力',
        ok: true,
        detail: '已开启',
      })
    } catch (error) {
      steps.push({
        key: 'ability',
        label: '开启机器人能力',
        ok: false,
        detail: errorText(error),
      })
      return this.#recordApplyFailure(error, steps)
    }

    // 一次 PATCH 写入权限/订阅方式/事件/回调，减少请求数与半生效窗口。
    const body = {
      scope: {
        add_scopes: DEVICE_REQUIRED_SCOPES.map(([scopeName, tokenType]) => ({
          scope_name: scopeName,
          token_type: tokenType,
        })),
      },
      event: {
        subscription_type: 'websocket',
        add_events: [...DEVICE_REQUIRED_EVENTS],
      },
      callback: {
        callback_type: 'websocket',
        add_callbacks: [...DEVICE_REQUIRED_CALLBACKS],
      },
    }
    try {
      await rest('PATCH', APP_CONFIG_PATH(credentials.appId), {
        jsonBody: body,
        cfg: credentials,
        fetch: this.#fetch,
      })
      steps.push({
        key: 'config',
        label: '权限 / 长连接订阅 / 事件 / 回调',
        ok: true,
        detail: '已写入（需发布新版本后生效）',
      })
    } catch (error) {
      steps.push({
        key: 'config',
        label: '权限 / 长连接订阅 / 事件 / 回调',
        ok: false,
        detail: errorText(error),
      })
      return this.#recordApplyFailure(error, steps)
    }

    this.#steps = steps.map((step) => ({ ...step }))
    this.#apply = { ok: true, needPatchScope: false, error: '', steps: this.#steps, at: this.#now() }
    this.#error = ''
    return this.status()
  }

  /**
   * 显式提交发布（版本号自动递增；发布后仍需租户管理员审批）。
   * @returns {Promise<object>} 当前 Status（含 publish 结果）
   */
  async publish() {
    const credentials = await this.#loadCredentials()
    if (credentials === undefined) return this.#recordCredentialError('publish')
    const blocked = this.#managementBlock(credentials, '提交发布')
    if (blocked !== '') return this.#recordManageBlocked('publish', blocked)

    let version = ''
    try {
      const listed = await rest('GET', APP_VERSIONS_PATH(credentials.appId), {
        cfg: credentials,
        fetch: this.#fetch,
      })
      const items = listed && listed.data && Array.isArray(listed.data.items)
        ? listed.data.items
        : []
      version = nextVersion(items)
      const published = await rest('POST', APP_PUBLISH_PATH(credentials.appId), {
        jsonBody: {
          version,
          remark: PUBLISH_REMARK,
          changelog: PUBLISH_CHANGELOG,
          pc_default_ability: 'bot',
          mobile_default_ability: 'bot',
        },
        cfg: credentials,
        fetch: this.#fetch,
      })
      const data = (published && published.data) || {}
      this.#publish = {
        ok: true,
        version: String(data.version || version),
        versionId: String(data.version_id || ''),
        error: '',
        at: this.#now(),
      }
      this.#error = ''
    } catch (error) {
      this.#publish = {
        ok: false,
        version,
        versionId: '',
        error: errorText(error),
        at: this.#now(),
      }
      this.#error = `发布失败: ${errorText(error)}`
    }
    return this.status()
  }

  /**
   * 只读现状；waiting 超过 TTL 时按 failed 呈现并停止旧 worker。
   * @returns {object} 公开 Status（绝不含 Secret/device_code）
   */
  status() {
    this.#expireWaiting()
    const nowS = this.#now()
    return {
      state: this.#state,
      url: this.#url,
      qr: this.#qr,
      appId: this.#appId,
      error: this.#error,
      steps: this.#steps.map((step) => ({ ...step })),
      startedAt: this.#startedAt,
      expiresAt: this.#expiresAt,
      ageS: this.#startedAt > 0 ? Math.max(0, Math.floor(nowS - this.#startedAt / 1000)) : 0,
      apply: cloneResult(this.#apply),
      publish: cloneResult(this.#publish),
    }
  }

  /** 取消轮询；不删除已保存凭据（dispose 只拥有内存态）。 */
  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#state === 'waiting') {
      const gen = this.#generation
      this.#cancelEvent?.set()
      this.#nextGeneration()
      this.#state = 'cancelled'
      this.#url = ''
      this.#qr = ''
      this.#error = ''
      this.#settleReady(gen)
    }
  }

  // ── 后台 worker ────────────────────────────────────────────────────────

  /**
   * 跑完 Device Flow 并收敛状态。所有异常都在这里吃掉；generation 不匹配的旧 worker
   * 直接退出，绝不写 Store/状态。
   * @param {number} gen 本次流程的 generation
   * @param {{run: Function}} flow makeDeviceFlow 返回值
   */
  async #runWorker(gen, flow) {
    try {
      const out = await flow.run()
      if (gen !== this.#generation) return
      const appId = out && typeof out.client_id === 'string' ? out.client_id : ''
      const appSecret = out && typeof out.client_secret === 'string' ? out.client_secret : ''
      if (appId === '' || appSecret === '') {
        this.#state = 'failed'
        this.#error = '扫码流程未返回应用凭据（可能超时或未确认），可重新发起'
        this.#url = ''
        this.#qr = ''
        return
      }

      // 先持久化（串行队列 + 队列内 generation 复检），再通知宿主；
      // 持久化失败或写入已被新流程取代时整个流程按失败/丢弃处理。
      const persisted = await this.#persistCredentials(gen, appId, appSecret)
      if (persisted !== true) return
      if (gen !== this.#generation) return

      this.#appId = appId
      this.#state = 'success'
      this.#url = ''
      this.#qr = ''
      this.#error = ''
      this.#settleReady(gen)

      if (this.#onCredentials !== null) {
        try {
          await this.#onCredentials({ appId, appSecret })
        } catch (error) {
          if (gen === this.#generation) {
            this.#error = `已保存应用凭据，但通知宿主失败: ${errorText(error)}`
          }
        }
      }
    } catch (error) {
      if (gen !== this.#generation) return
      if (this.#cancelEvent !== null && this.#cancelEvent.isSet()) {
        if (this.#state !== 'cancelled') {
          this.#state = 'cancelled'
          this.#url = ''
          this.#qr = ''
        }
        return
      }
      this.#state = 'failed'
      this.#appId = ''
      this.#url = ''
      this.#qr = ''
      this.#error = `扫码创建失败: ${errorText(error)}`
    } finally {
      this.#settleReady(gen)
    }
  }

  // ── 内部工具 ───────────────────────────────────────────────────────────

  /** 读取 Store 凭据；异常折成 undefined（调用方统一报「凭据未配置 + 原因」）。 */
  async #loadCredentials() {
    try {
      const value = await this.#store.loadCredentials()
      if (value === undefined || value === null) return undefined
      if (typeof value.appId !== 'string' || typeof value.appSecret !== 'string') return undefined
      return value
    } catch (error) {
      this.#error = `读取应用凭据失败: ${errorText(error)}`
      return undefined
    }
  }

  /**
   * apply/publish 没有可用凭据时的统一返回。
   * @param {'apply'|'publish'} kind 只填充对应操作的失败结果，不污染另一个结果
   */
  #recordCredentialError(kind) {
    const error = this.#error.startsWith('读取应用凭据失败') ? this.#error : NO_CREDENTIALS_ERROR
    if (kind === 'apply') {
      this.#apply = { ok: false, needPatchScope: false, error, steps: [], at: this.#now() }
    } else {
      this.#publish = { ok: false, version: '', versionId: '', error, at: this.#now() }
    }
    this.#error = error
    return this.status()
  }

  /**
   * apply/publish 的闸门：只有「当前成功流程的 appId」才允许操作应用配置。
   * 等待中的新扫码、取消后的旧流程、凭据被外部换掉都必须拒绝，避免误配置旧应用。
   * @param {{appId: string}} credentials Store 读到的当前凭据
   * @param {string} action 中文动作名（补齐配置 / 提交发布）
   * @returns {string} 空串 = 允许；否则是可操作的错误文案
   */
  #managementBlock(credentials, action) {
    if (this.#state === 'waiting') return `扫码流程进行中，不能${action}旧应用`
    if (this.#state !== 'success' || this.#appId === '') {
      return `当前没有已完成扫码的应用配置，不能${action}`
    }
    if (credentials.appId !== this.#appId) {
      return `应用凭据与当前扫码应用不一致，请重新扫码后再${action}`
    }
    return ''
  }

  /** 闸门拒绝时只记录对应操作的失败结果（不污染另一个结果）。 */
  #recordManageBlocked(kind, error) {
    if (kind === 'apply') {
      this.#apply = { ok: false, needPatchScope: false, error, steps: [], at: this.#now() }
    } else {
      this.#publish = { ok: false, version: '', versionId: '', error, at: this.#now() }
    }
    this.#error = error
    return this.status()
  }

  /**
   * 串行化凭据写入：所有流程的 saveCredentials 排在同一条 Promise 链上，队列内
   * 在真正调用 Store 前复检 generation；写入期间被取消/超时/force 重启的（stale）写入
   * 会被回滚为写入前的凭据，保证最终只留下最新有效流程的凭据。
   * @param {number} gen 发起写入的流程 generation
   * @param {string} appId
   * @param {string} appSecret
   * @returns {Promise<boolean>} true = 该流程的凭据已持久化且仍是最新
   */
  #persistCredentials(gen, appId, appSecret) {
    const write = async () => {
      if (gen !== this.#generation) return false
      let previous
      let knownPrevious = true
      try {
        previous = await this.#store.loadCredentials()
      } catch {
        // 读不到旧值就无法安全回滚；仍继续保存，stale 分支会跳过回滚。
        knownPrevious = false
      }
      if (gen !== this.#generation) return false
      await this.#store.saveCredentials({ appId, appSecret })
      if (gen !== this.#generation) {
        if (knownPrevious) await this.#restoreCredentials(previous)
        return false
      }
      return true
    }
    // 前一个写入失败也不能卡住后续流程：then 的两个分支都跑 write。
    const result = this.#saveChain.then(write, write)
    this.#saveChain = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * stale 写入的回滚：恢复写入前的凭据；原先没有凭据则清除。
   * 回滚失败不向上抛（不掩盖取消/超时状态），下一次有效保存会整体覆盖。
   * @param {{appId: string, appSecret: string} | undefined} previous
   */
  async #restoreCredentials(previous) {
    try {
      if (previous !== undefined && previous !== null
        && typeof previous.appId === 'string' && typeof previous.appSecret === 'string') {
        await this.#store.saveCredentials({ appId: previous.appId, appSecret: previous.appSecret })
      } else if (typeof this.#store.clearCredentials === 'function') {
        await this.#store.clearCredentials()
      }
    } catch {
      // 见注释：回滚是 best-effort，不影响已收敛的取消/失败状态。
    }
  }

  /** apply 失败：保留原 state（通常是 success），记录可操作错误与步骤。 */
  #recordApplyFailure(error, steps) {
    const needPatchScope = needsPatchScope(error)
    const detail = needPatchScope ? PATCH_SCOPE_HINT : errorText(error)
    this.#steps = steps.map((step) => ({ ...step }))
    this.#apply = { ok: false, needPatchScope, error: detail, steps: this.#steps, at: this.#now() }
    this.#error = `应用已创建，但配置补齐未完成：${detail}`
    return this.status()
  }

  /** waiting 超时：作废旧 worker 并按 failed 呈现（不接受迟到结果）。 */
  #expireWaiting() {
    if (this.#state !== 'waiting' || this.#startedAt === 0) return
    const elapsed = this.#now() - this.#startedAt / 1000
    if (elapsed <= this.#ttlSeconds) return
    const gen = this.#generation
    this.#cancelEvent?.set()
    this.#nextGeneration()
    this.#state = 'failed'
    this.#url = ''
    this.#qr = ''
    this.#error = '确认链接已超时（10 分钟有效），可重新发起'
    this.#settleReady(gen)
  }

  /** 作废当前流程（force/取消/超时共用）：置 cancel、推进 generation、解阻塞 start。 */
  #abandonCurrent() {
    const gen = this.#generation
    this.#cancelEvent?.set()
    this.#nextGeneration()
    this.#cancelEvent = null
    this.#settleReady(gen)
  }

  /** 推进 generation，返回新值（旧 worker 从此失效）。 */
  #nextGeneration() {
    this.#generation += 1
    return this.#generation
  }

  /** 只解除与 gen 匹配的 start 等待，避免旧 worker 提前放行新 start。 */
  #settleReady(gen) {
    const ready = this.#ready
    if (ready === null || ready.gen !== gen) return
    this.#ready = null
    ready.resolve()
  }

  /** 在 Status 副本上覆盖 error，不改变内部状态。 */
  #withError(status, error) {
    return { ...status, error }
  }
}

/** 克隆 apply/publish 结果（含 steps 数组），避免调用方改到内部状态。 */
function cloneResult(result) {
  if (result === null) return null
  const cloned = { ...result }
  if (Array.isArray(cloned.steps)) cloned.steps = cloned.steps.map((step) => ({ ...step }))
  return cloned
}
