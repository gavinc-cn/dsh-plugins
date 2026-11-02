/**
 * dsh-feishu —— 浏览器侧飞书连接面板
 *
 * 目的：在 DSH Web GUI 里提供飞书桥的唯一管理面：扫码配置应用、补齐配置/发布、
 * 生成一次性绑定码、查看脱敏绑定、重连长连接、修改非秘密配置，以及显式重试失败项。
 *
 * 设计约束：
 *   - 只经宿主 `slots` 扩展点介入：`sidebar.footer.action`（低调入口）与 `shell.overlay`
 *     （整框覆盖层）。不改写宿主其它 DOM，不注入 <style>，不依赖 React 之外的包；
 *   - 只轮询 `GET /api/feishu/status`，且仅在面板打开、且扫码处于 waiting 或刚做过
 *     连接动作（重连/扫码/发布后短暂收敛）时轮询；关闭/卸载立刻 clearInterval；
 *   - 所有响应先投影成白名单视图模型（normalizeStatus）再渲染：即使服务器误带
 *     appSecret/accessToken/device_code/正文，也绝不会进入 DOM。错误文本再按
 *     `key=value` / Bearer 模式二次脱敏；
 *   - 二维码只接受 data:image/*（随包 vendor 生成，不外链第三方二维码服务）；
 *     验证链接只接受 http(s)；其它一律降级为纯文本或忽略；
 *   - publish 必须二次确认；apply/cancel/start/revoke/retry 全部是显式点击；
 *     无任何自动动作（挂载/轮询都不会触发写接口）；
 *   - 面板打开时把焦点移到对话框，Escape 关闭并把焦点还给侧栏入口。
 *
 * 已知边界：
 *   - status 里的绑定 open_id 是打码值，服务器无法据此定位真实绑定；撤销失败时面板
 *     如实提示「未生效」并给出飞书内 `/unbind` 的替代路径（不伪报成功）；
 *   - 面板不缓存状态到 localStorage；绑定码只存在当前面板内存，关闭即清空。
 *
 * 生效链路：UI bundle 行 → 浏览器 client 模块 → slots 注册（侧栏入口 + 覆盖层）。
 * 移除方式：在 Plugins 面板关闭本行，或从 UI bundle 删除对应 insert/dependency。
 */
window.__ModuleLoader__.load({
  id: '@gavinc-cn/dsh-feishu',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /* ── 常量 ───────────────────────────────────────────────────────────── */

    /** 状态轮询间隔（毫秒）：扫码 waiting 与连接收敛期使用。 */
    const POLL_INTERVAL_MS = 3000

    /** 一次连接动作后最多跟随多少个轮询周期（≈60s），避免永久轮询。 */
    const PROBE_TICKS = 20

    /** 失败上限（与 Host status 的 20 条一致）。 */
    const MAX_FAILURES = 20

    /** 非秘密配置的边界（与 routes/index 的校验同口径）。 */
    const MAX_CWD_CHARS = 4096
    const MAX_FILE_MAX_BYTES = 1024 * 1024 * 1024

    const API = Object.freeze({
      status: '/api/feishu/status',
      provision: '/api/feishu/provision',
      bindCode: '/api/feishu/bind-code',
      revokeBinding: '/api/feishu/bindings/revoke',
      reconnect: '/api/feishu/reconnect',
      config: '/api/feishu/config',
      outboxRetry: '/api/feishu/outbox/retry',
    })

    /** opaque bindingKey 的形状（与 Host 的 BINDING_KEY_PATTERN 同口径）。 */
    const BINDING_KEY_RE = /^[0-9a-f]{16}$/

    const CONNECTIONS = Object.freeze(['connected', 'disconnected', 'provision-needed'])
    const PROVISION_STATES = Object.freeze(['idle', 'waiting', 'success', 'failed', 'cancelled'])
    const CONNECTION_LABEL = Object.freeze({
      connected: '已连接',
      disconnected: '未连接',
      'provision-needed': '待配置',
    })
    const CONNECTION_DETAIL = Object.freeze({
      connected: '飞书长连接运行中，绑定用户可在私聊里直接对话。',
      disconnected: '已保存应用凭据，但长连接未建立。可尝试重新连接。',
      'provision-needed': '还没有飞书应用凭据。先扫码创建或配置一个应用。',
    })

    /* ── 设计令牌（DSH alias token + 仓库既有回退色，禁止硬编码主题）──────── */

    const T = Object.freeze({
      font: "var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif)",
      mono: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
      text: 'var(--dsw-alias-label-primary, #f2f3f5)',
      text2: 'var(--dsw-alias-label-secondary, #cfd3d6)',
      text3: 'var(--dsw-alias-label-tertiary, #adb2b8)',
      border: 'var(--dsw-alias-border-l2, rgba(255,255,255,.12))',
      borderStrong: 'var(--dsw-alias-border-l3, rgba(255,255,255,.18))',
      bgBase: 'var(--dsw-alias-bg-base, #151517)',
      bgL1: 'var(--dsw-alias-bg-layer-1, #232324)',
      bgL2: 'var(--dsw-alias-bg-layer-2, #2c2c2d)',
      mask: 'var(--dsw-alias-bg-mask-2, rgba(0,0,0,.45))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))',
      business: 'var(--dsw-alias-state-business-primary, #679efe)',
      businessTert: 'var(--dsw-alias-state-business-tertiary, rgba(103,158,254,.2))',
      success: 'var(--dsw-alias-state-success-primary, #22c55e)',
      successTert: 'var(--dsw-alias-state-success-tertiary, rgba(34,197,94,.2))',
      warn: 'var(--dsw-alias-state-warn-primary, #f5a20b)',
      warnTert: 'var(--dsw-alias-state-warn-tertiary, rgba(245,162,11,.2))',
      error: 'var(--dsw-alias-state-error-primary, #f25a5a)',
      errorTert: 'var(--dsw-alias-state-error-secondary, rgba(242,90,90,.16))',
    })

    /* ── 纯函数 ─────────────────────────────────────────────────────────── */

    /** 普通对象（排除 null/数组）。 */
    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /** 有界数字。 */
    function boundedNumber(value, max = Number.MAX_SAFE_INTEGER) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
      return Math.min(value, max)
    }

    const SECRET_TEXT_RE = /((?:app[_-]?secret|client[_-]?secret|access[_-]?token|tenant[_-]?access[_-]?token|refresh[_-]?token|authorization|password|passwd)\s*[=:：]\s*)[^\s,;，。]+/gi
    const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
    const URL_USERINFO_RE = /\b(https?:\/\/)[^/@\s]+@/gi

    /**
     * 二次脱敏：即使 Host 已经 redact 过，也不把 key=value 形式的秘密带回 DOM。
     * @param {unknown} value
     * @returns {string}
     */
    function redactSecrets(value) {
      return String(value ?? '')
        .replace(SECRET_TEXT_RE, '$1***')
        .replace(BEARER_RE, 'Bearer ***')
        .replace(URL_USERINFO_RE, '$1***@')
    }

    /** 安全文本：字符串化、脱敏并截断。 */
    function safeText(value, max) {
      if (typeof value !== 'string' || value === '') return ''
      return redactSecrets(value).slice(0, max)
    }

    /** 只接受 http(s) URL，其它（javascript:、data:、相对路径）一律拒绝。 */
    function safeHttpUrl(value) {
      return typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value) ? value : ''
    }

    /** 只接受 data:image/*；外链二维码一律拒绝（面板不依赖第三方二维码服务）。 */
    function safeDataImage(value) {
      return typeof value === 'string' && /^data:image\/(?:svg\+xml|png|jpeg|webp|gif)[;,]/i.test(value) ? value : ''
    }

    /** 归一化扫码附加步骤。 */
    function normalizeSteps(raw) {
      if (!Array.isArray(raw)) return []
      return raw.slice(0, MAX_FAILURES).map((step) => ({
        label: safeText(step?.label, 200),
        ok: step?.ok === true,
        detail: safeText(step?.detail, 300),
      }))
    }

    /**
     * 绑定 open_id 的展示值：服务器已打码就原样用；万一服务器回归成完整值，
     * 客户端再打一次码，保证完整 open_id 不进入 DOM（撤销仍用原值）。
     * @param {string} value
     * @returns {string}
     */
    function maskOpenId(value) {
      const text = safeText(value, 128)
      if (text === '') return ''
      if (text.includes('*')) return text
      if (text.length <= 8) return `${text.slice(0, 2)}***`
      return `${text.slice(0, 4)}***${text.slice(-4)}`
    }

    /** 归一化 apply/publish 的结果块（不含任何凭据）。 */
    function normalizeActionResult(raw) {
      if (!isPlainObject(raw)) return null
      return {
        ok: raw.ok === true,
        error: safeText(raw.error, 300),
        version: safeText(raw.version, 64),
      }
    }

    /**
     * 白名单投影 provision 状态：只保留渲染需要的字段，外链二维码/非 http 链接被丢弃。
     * @param {unknown} raw
     * @returns {object|null}
     */
    function normalizeProvision(raw) {
      if (!isPlainObject(raw)) return null
      return {
        state: PROVISION_STATES.includes(raw.state) ? raw.state : 'idle',
        url: safeHttpUrl(raw.url),
        qr: safeDataImage(raw.qr),
        appId: safeText(raw.appId, 128),
        error: safeText(raw.error, 600),
        steps: normalizeSteps(raw.steps),
        expiresAt: boundedNumber(raw.expiresAt),
        apply: normalizeActionResult(raw.apply),
        publish: normalizeActionResult(raw.publish),
      }
    }

    /**
     * 白名单投影 status：未知字段（包括任何 secret 命名字段）一律丢弃。
     * @param {unknown} raw
     * @returns {object}
     */
    function normalizeStatus(raw) {
      const source = isPlainObject(raw) ? raw : {}
      const provision = normalizeProvision(source.provision)
      const inbound = isPlainObject(source.inbound) ? source.inbound : {}
      const config = isPlainObject(source.config) ? source.config : {}
      const failures = isPlainObject(source.failures) ? source.failures : {}

      const bindings = Array.isArray(source.bindings)
        ? source.bindings.slice(0, 50).map((item) => ({
          openId: safeText(item?.openId, 128),
          displayOpenId: maskOpenId(item?.openId),
          // 撤销只认这个稳定句柄；形状不符（旧 Host/脏数据）时按空处理，不猜 open_id。
          bindingKey: typeof item?.bindingKey === 'string' && BINDING_KEY_RE.test(item.bindingKey)
            ? item.bindingKey
            : '',
          sessionCount: boundedNumber(item?.sessionCount, 1000),
          hasCurrent: item?.hasCurrent === true,
          docs: boundedNumber(item?.docs, 1000),
          updatedAt: boundedNumber(item?.updatedAt),
        })).filter((item) => item.openId !== '')
        : []

      const inbox = Array.isArray(failures.inbox)
        ? failures.inbox.slice(0, MAX_FAILURES).map((item) => ({
          id: safeText(item?.id, 256),
          attempts: boundedNumber(item?.attempts, 1000),
          error: safeText(item?.error, 300),
          receivedAt: boundedNumber(item?.receivedAt),
        })).filter((item) => item.id !== '')
        : []

      const outbox = Array.isArray(failures.outbox)
        ? failures.outbox.slice(0, MAX_FAILURES).map((item) => ({
          requestId: safeText(item?.requestId, 256),
          openId: safeText(item?.openId, 128),
          kind: safeText(item?.kind, 32),
          attempts: boundedNumber(item?.attempts, 1000),
          textChars: boundedNumber(item?.textChars, 10 * 1024 * 1024),
          hasDocument: item?.hasDocument === true,
          error: safeText(item?.error, 300),
          createdAt: boundedNumber(item?.createdAt),
        })).filter((item) => item.requestId !== '')
        : []

      return {
        connection: CONNECTIONS.includes(source.connection) ? source.connection : 'disconnected',
        credentialsConfigured: source.credentialsConfigured === true,
        inbound: {
          running: inbound.running === true,
          queued: boundedNumber(inbound.queued, 10000),
          pending: boundedNumber(inbound.pending, 10000),
          processing: boundedNumber(inbound.processing, 10000),
          done: boundedNumber(inbound.done, 1000000),
          failed: boundedNumber(inbound.failed, 1000000),
          lastError: safeText(inbound.lastError, 300),
        },
        bindings,
        failures: { inbox, outbox },
        config: {
          defaultCwd: safeText(config.defaultCwd, MAX_CWD_CHARS),
          fileMaxBytes: boundedNumber(config.fileMaxBytes, MAX_FILE_MAX_BYTES),
        },
        provision,
        lastError: safeText(source.lastError, 300),
      }
    }

    /** 面板错误类型：只携带可展示文案。 */
    class PanelError extends Error {
      /**
       * @param {string} message 可直接展示的脱敏文案
       * @param {{code?: string, status?: number}} [options] 结构化错误码（如 binding_not_found）
       */
      constructor(message, options = {}) {
        super(message)
        this.name = 'PanelError'
        this.code = typeof options.code === 'string' ? options.code : ''
        this.status = Number.isInteger(options.status) ? options.status : 0
      }
    }

    /** 任意异常 → 可展示、已脱敏的短文案。 */
    function messageOf(error) {
      const raw = error instanceof Error ? error.message : String(error ?? '')
      return redactSecrets(raw).slice(0, 300) || '操作失败，请稍后重试'
    }

    /** 统一请求：same-origin、JSON、非 2xx/畸形响应都转成 PanelError。 */
    async function request(path, options = {}) {
      const init = {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      let response
      try {
        response = await globalThis.fetch(path, init)
      } catch {
        throw new PanelError('无法连接 DSH 宿主，请确认页面连接后重试')
      }
      if (response === null || typeof response !== 'object' || typeof response.json !== 'function') {
        throw new PanelError('状态响应格式异常')
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new PanelError('响应不是合法 JSON')
      }
      if (!isPlainObject(payload)) throw new PanelError('响应格式异常')
      if (response.ok === false) {
        const fallback = `请求失败（HTTP ${Number(response.status) || 0}）`
        const code = typeof payload.error === 'string' ? payload.error : ''
        const message = code !== '' ? safeText(code, 300) : fallback
        throw new PanelError(message, { code, status: Number(response.status) || 0 })
      }
      if (response.ok !== true || payload.ok !== true) {
        const code = typeof payload.error === 'string' ? payload.error : ''
        const message = code !== '' ? safeText(code, 300) : '请求被拒绝'
        throw new PanelError(message, { code, status: Number(response.status) || 0 })
      }
      return payload
    }

    /** 7 条 owner-only API 的薄封装。 */
    const api = Object.freeze({
      async status() {
        const payload = await request(API.status)
        // 2xx 但缺少 status 不是“空状态”，而是接口异常：必须显式报错。
        if (!isPlainObject(payload.status)) throw new PanelError('状态响应缺少 status 字段')
        return normalizeStatus(payload.status)
      },
      provision(action, options = {}) {
        const body = { action }
        if (options.force === true) body.force = true
        return request(API.provision, { method: 'POST', body })
      },
      bindCode() {
        return request(API.bindCode, { method: 'POST', body: {} })
      },
      revoke(bindingKey) {
        // 只传 opaque bindingKey；打码 open_id 仅用于展示，不进入请求体。
        return request(API.revokeBinding, { method: 'POST', body: { bindingKey } })
      },
      reconnect() {
        return request(API.reconnect, { method: 'POST', body: {} })
      },
      config(patch) {
        return request(API.config, { method: 'POST', body: patch })
      },
      retry(requestId) {
        return request(API.outboxRetry, { method: 'POST', body: { requestId } })
      },
    })

    /* ── 跨槽位状态：侧栏入口与覆盖层面板共享「是否打开 / 最近连接态」────── */

    const store = (() => {
      let open = false
      let connection = ''
      let trigger = null
      // 一次性绑定码是敏感态：放在共享 store 里，任何关闭路径都能同步清空，
      // 不依赖“effect 在 commit 之后才跑”的时序（否则重开首帧可能闪现旧码）。
      let bindCode = null
      let copied = false
      const listeners = new Set()

      const snapshot = () => ({ open, connection, bindCode, copied })

      function emit() {
        const next = snapshot()
        for (const listener of [...listeners]) {
          try {
            listener(next)
          } catch {
            // 订阅者异常不得影响其它订阅者或面板开关。
          }
        }
      }

      /** 清空一次性码与“已复制”提示；关闭路径据此同步生效。 */
      function clearTransient() {
        bindCode = null
        copied = false
      }

      return {
        snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        setOpen(next) {
          const value = next === true
          if (open === value) return
          open = value
          // 关闭（Escape/✕/遮罩/侧栏入口）时立刻丢弃一次性码，重开首帧即干净。
          if (!value) clearTransient()
          emit()
        },
        setConnection(next) {
          const value = typeof next === 'string' ? next : ''
          if (connection === value) return
          connection = value
          emit()
        },
        setBindCode(next) {
          if (next === null) {
            clearTransient()
          } else {
            bindCode = { code: next.code, expiresAt: next.expiresAt }
            copied = false
          }
          emit()
        },
        setCopied(next) {
          const value = next === true
          if (copied === value) return
          copied = value
          emit()
        },
        setTrigger(node) {
          trigger = node
        },
        focusTrigger() {
          try {
            if (trigger !== null && typeof trigger.focus === 'function') trigger.focus()
          } catch {
            // 焦点恢复失败不应影响关闭流程。
          }
        },
      }
    })()

    /** 订阅跨槽位状态；返回不可变快照。 */
    function usePanelSnapshot() {
      const [snapshot, setSnapshot] = React.useState(() => store.snapshot())
      React.useEffect(() => {
        const unsubscribe = store.subscribe(setSnapshot)
        setSnapshot(store.snapshot())
        return unsubscribe
      }, [])
      return snapshot
    }

    /** 当前视口是否窄屏（< 560px 用右侧抽屉，否则居中对话框）。 */
    function readNarrow() {
      if (typeof window === 'undefined') return false
      const width = Number(window.innerWidth)
      return Number.isFinite(width) && width > 0 && width < 560
    }

    /* ── 样式（全部内联；不注入 <style>，不改写宿主其它区域）──────────────── */

    function footerStyle(wide) {
      return {
        display: 'flex',
        alignItems: 'center',
        justifyContent: wide ? 'flex-start' : 'center',
        gap: 6,
        width: '100%',
        boxSizing: 'border-box',
        padding: wide ? '6px 12px' : '6px 0',
        margin: '2px 0',
        borderRadius: 8,
        cursor: 'pointer',
        border: 'none',
        background: 'transparent',
        color: T.text,
        fontFamily: T.font,
        fontSize: wide ? 13 : 12,
        lineHeight: '20px',
        textAlign: wide ? 'left' : 'center',
        opacity: 0.86,
      }
    }

    function dotStyle(connection) {
      const color = connection === 'connected' ? T.success : (connection === 'disconnected' ? T.warn : T.text3)
      return {
        width: 6,
        height: 6,
        flex: 'none',
        borderRadius: 999,
        background: color,
        boxShadow: connection === 'connected' ? `0 0 0 3px ${T.successTert}` : 'none',
      }
    }

    const overlayStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 40,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
    }

    const backdropStyle = {
      position: 'absolute',
      inset: 0,
      background: T.mask,
      pointerEvents: 'auto',
    }

    function panelStyle(narrow) {
      return {
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width: narrow ? '100%' : 'min(560px, calc(100vw - 48px))',
        height: narrow ? '100%' : 'auto',
        maxHeight: narrow ? '100%' : 'min(720px, calc(100vh - 64px))',
        background: T.bgL1,
        color: T.text,
        fontFamily: T.font,
        fontSize: 13,
        lineHeight: 1.55,
        border: narrow ? 'none' : `1px solid ${T.borderStrong}`,
        borderRadius: narrow ? 0 : 14,
        boxShadow: '0 24px 64px rgba(0, 0, 0, .38)',
        overflow: 'hidden',
        outline: 'none',
        pointerEvents: 'auto',
      }
    }

    const headerStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '14px 18px 12px',
      borderBottom: `1px solid ${T.border}`,
      flex: 'none',
    }

    const titleStyle = {
      margin: 0,
      fontSize: 15,
      fontWeight: 600,
      lineHeight: '22px',
      color: T.text,
    }

    const eyebrowStyle = {
      fontSize: 11,
      lineHeight: '16px',
      letterSpacing: '.09em',
      fontWeight: 600,
      color: T.text3,
    }

    const bodyStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      padding: '14px 18px 18px',
      overflowY: 'auto',
      flex: '1 1 auto',
      minHeight: 0,
    }

    const sectionStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: '12px 14px',
      background: T.bgL2,
      border: `1px solid ${T.border}`,
      borderRadius: 10,
    }

    const headingStyle = {
      margin: 0,
      fontSize: 13,
      fontWeight: 600,
      color: T.text,
    }

    const hintStyle = {
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: T.text3,
    }

    const monoStyle = {
      fontFamily: T.mono,
      fontSize: 12,
      lineHeight: '18px',
      color: T.text2,
      wordBreak: 'break-all',
    }

    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap',
    }

    function badgeStyle(connection) {
      const palette = connection === 'connected'
        ? { color: T.success, background: T.successTert }
        : (connection === 'disconnected'
          ? { color: T.warn, background: T.warnTert }
          : { color: T.text3, background: T.hover })
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        lineHeight: '16px',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...palette,
      }
    }

    const errorBannerStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '10px 12px',
      borderRadius: 8,
      border: `1px solid ${T.errorTert}`,
      background: T.errorTert,
      color: T.error,
      fontSize: 12,
      lineHeight: '18px',
    }

    const noticeBannerStyle = {
      padding: '8px 12px',
      borderRadius: 8,
      border: `1px solid ${T.businessTert}`,
      background: T.businessTert,
      color: T.text2,
      fontSize: 12,
      lineHeight: '18px',
    }

    const ticketStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: 14,
      background: T.bgBase,
      border: `1px dashed ${T.borderStrong}`,
      borderRadius: 10,
    }

    const tearLineStyle = {
      height: 0,
      borderTop: `1px dashed ${T.border}`,
      margin: '2px 0',
    }

    const qrStyle = {
      width: 156,
      height: 156,
      flex: 'none',
      borderRadius: 8,
      background: '#fff',
      objectFit: 'contain',
    }

    const ticketBodyStyle = {
      display: 'flex',
      gap: 14,
      alignItems: 'flex-start',
      flexWrap: 'wrap',
    }

    const stepStyle = {
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: T.text2,
    }

    const linkStyle = {
      color: T.business,
      fontFamily: T.mono,
      fontSize: 12,
      lineHeight: '18px',
      wordBreak: 'break-all',
      textDecoration: 'underline',
    }

    const codeStyle = {
      fontFamily: T.mono,
      fontSize: 16,
      letterSpacing: '.14em',
      fontWeight: 600,
      color: T.text,
      padding: '6px 10px',
      borderRadius: 8,
      background: T.bgBase,
      border: `1px solid ${T.border}`,
      display: 'inline-block',
    }

    function buttonStyle(kind) {
      const base = {
        fontFamily: T.font,
        fontSize: 12,
        lineHeight: '18px',
        padding: '5px 12px',
        borderRadius: 8,
        cursor: 'pointer',
        border: `1px solid ${T.border}`,
        background: 'transparent',
        color: T.text,
        whiteSpace: 'nowrap',
      }
      if (kind === 'primary') {
        return { ...base, background: T.business, border: `1px solid ${T.business}`, color: '#fff', fontWeight: 600 }
      }
      if (kind === 'danger') return { ...base, color: T.error }
      if (kind === 'quiet') return { ...base, border: '1px solid transparent', color: T.text2 }
      return base
    }

    const inputStyle = {
      boxSizing: 'border-box',
      width: '100%',
      padding: '5px 8px',
      borderRadius: 6,
      border: `1px solid ${T.border}`,
      background: T.bgBase,
      color: T.text,
      fontFamily: T.mono,
      fontSize: 12,
      lineHeight: '18px',
    }

    const fieldLabelStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      fontSize: 12,
      lineHeight: '18px',
      color: T.text2,
    }

    const listStyle = {
      margin: 0,
      padding: 0,
      listStyle: 'none',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }

    const listItemStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '8px 10px',
      borderRadius: 8,
      background: T.bgBase,
      border: `1px solid ${T.border}`,
    }

    const failureErrorStyle = {
      ...monoStyle,
      color: T.error,
    }

    const footerNoteStyle = {
      margin: 0,
      fontSize: 11,
      lineHeight: '16px',
      color: T.text3,
    }

    /* ── 纯渲染片段 ─────────────────────────────────────────────────────── */

    /** 小标题 + 卡片的统一骨架。 */
    function section(title, children, key) {
      return h('section', { key, style: sectionStyle, 'data-feishu-section': title },
        h('h3', { style: headingStyle }, title),
        children)
    }

    /** 扫码步骤的静态引导（真实 3 步，顺序有意义）。 */
    function scanSteps() {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        h('p', { style: stepStyle }, '1 · 用飞书扫描二维码'),
        h('p', { style: stepStyle }, '2 · 在飞书里确认创建应用'),
        h('p', { style: stepStyle }, '3 · 回到这里继续补齐配置'))
    }

    /** 二维码票据：面板唯一的高光元素（一次性配对凭证）。 */
    function renderTicket(provision, handlers) {
      return h('div', { style: ticketStyle, 'data-feishu-ticket': '' },
        h('div', { style: ticketBodyStyle },
          provision.qr !== ''
            ? h('img', {
              src: provision.qr,
              alt: '飞书扫码配置二维码',
              width: 156,
              height: 156,
              style: qrStyle,
              'data-feishu-qr': '',
            })
            : h('p', { style: hintStyle }, '二维码不可用，请使用下方的验证链接在飞书中打开。'),
          scanSteps()),
        h('div', { style: tearLineStyle, 'aria-hidden': 'true' }),
        provision.url !== ''
          ? h('a', {
            href: provision.url,
            target: '_blank',
            rel: 'noreferrer noopener',
            style: linkStyle,
            'data-feishu-verify-link': '',
          }, provision.url)
          : h('p', { style: hintStyle }, '等待飞书返回验证链接…'),
        h('p', { style: hintStyle }, '链接原样来自飞书，也可复制到飞书里打开。'),
        h('div', { style: rowStyle },
          h('button', {
            type: 'button',
            style: buttonStyle('ghost'),
            'data-feishu-action': 'cancel',
            onClick: handlers.cancel,
          }, '取消扫码')))
    }

    /** 扫码结果 / 配置步骤列表。 */
    function renderProvisionSteps(provision) {
      if (provision.appId === '' && provision.steps.length === 0) return null
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        provision.appId !== ''
          ? h('p', { style: monoStyle, 'data-feishu-app-id': '' }, `应用 ${provision.appId}`)
          : null,
        provision.steps.length > 0
          ? h('ul', { style: listStyle },
            provision.steps.map((step, index) => h('li', { key: `step-${index}`, style: listItemStyle },
              h('span', { style: { ...stepStyle, color: step.ok ? T.success : T.error } },
                `${step.ok ? '✓' : '✕'} ${step.label}`),
              step.detail !== '' ? h('span', { style: hintStyle }, step.detail) : null)))
          : null)
    }

    /** apply/publish 的结果行（只在有结果时出现）。 */
    function renderActionResult(label, result) {
      if (result === null) return null
      if (result.error !== '') {
        return h('p', { style: failureErrorStyle }, `${label}失败：${result.error}`)
      }
      if (result.ok !== true) return null
      return h('p', { style: { ...stepStyle, color: T.success } },
        label === '发布' && result.version !== '' ? `已发布版本 ${result.version}` : `${label}已完成`)
    }

    /** 连接卡片：徽标、计数、最近错误与重连。 */
    function renderConnection(status, handlers) {
      const inbound = status.inbound
      const counts = `入站 ${inbound.done} 完成 · ${inbound.failed} 失败 · ${inbound.pending + inbound.processing} 待处理`
      const lines = [
        h('p', { key: 'detail', style: hintStyle }, CONNECTION_DETAIL[status.connection]),
        h('p', { key: 'counts', style: monoStyle, 'data-feishu-inbound-counts': '' }, counts),
      ]
      if (status.lastError !== '') {
        lines.push(h('p', { key: 'last-error', style: failureErrorStyle, 'data-feishu-last-error': '' }, status.lastError))
      }
      if (inbound.lastError !== '') {
        lines.push(h('p', { key: 'inbound-error', style: failureErrorStyle }, `最近入站错误：${inbound.lastError}`))
      }
      if (status.credentialsConfigured) {
        lines.push(h('div', { key: 'actions', style: rowStyle },
          h('button', {
            type: 'button',
            style: buttonStyle('ghost'),
            'data-feishu-action': 'reconnect',
            disabled: handlers.busy === 'reconnect',
            onClick: handlers.reconnect,
          }, handlers.busy === 'reconnect' ? '正在重连…' : '重新连接')))
      }
      return lines
    }

    /** 绑定卡片：绑定码 + 打码绑定列表。 */
    function renderBinding(status, state, handlers) {
      const nodes = []
      if (state.bindCode !== null) {
        nodes.push(h('div', { key: 'code', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: rowStyle },
            h('code', { style: codeStyle, 'data-feishu-bind-code': '' }, state.bindCode.code),
            h('button', {
              type: 'button',
              style: buttonStyle('ghost'),
              'data-feishu-action': 'copy-code',
              onClick: handlers.copyCode,
            }, state.copied ? '已复制' : '复制')),
          h('p', { style: hintStyle },
            `在飞书里私聊机器人，发送 /bind ${state.bindCode.code}（10 分钟内有效，仅可使用一次）。`)))
      }
      nodes.push(h('div', { key: 'issue', style: rowStyle },
        h('button', {
          type: 'button',
          style: buttonStyle('primary'),
          'data-feishu-action': 'bind-code',
          disabled: handlers.busy === 'bind-code',
          onClick: handlers.bindCode,
        }, state.bindCode === null ? '生成绑定码' : '生成新码')))

      if (status.bindings.length === 0) {
        nodes.push(h('p', { key: 'empty', style: hintStyle },
          '还没有绑定用户。生成绑定码后，在飞书私聊里发送 /bind <码> 即可完成绑定。'))
      } else {
        nodes.push(h('ul', { key: 'list', style: listStyle },
          status.bindings.map((binding) => h('li', {
            key: `binding-${binding.openId}`,
            style: listItemStyle,
            'data-feishu-binding': binding.displayOpenId,
          },
          h('div', { style: rowStyle },
            h('code', { style: monoStyle }, binding.displayOpenId),
            h('span', { style: hintStyle }, `${binding.sessionCount} 个会话${binding.hasCurrent ? ' · 有当前会话' : ''}`),
            // 撤销只认 opaque bindingKey；打码 open_id 只是展示值，不进入请求体。
            binding.bindingKey !== ''
              ? h('button', {
                type: 'button',
                style: { ...buttonStyle('danger'), marginLeft: 'auto' },
                'data-feishu-action': 'revoke',
                onClick: () => handlers.revoke(binding.bindingKey),
              }, '撤销')
              : h('span', { style: { ...hintStyle, marginLeft: 'auto' } }, '此版本不支持面板撤销')),
          h('span', { style: hintStyle }, '撤销只移除授权，不删除 DSH 会话历史。')))))
        nodes.push(h('p', { key: 'unbind-hint', style: hintStyle },
          '也可以让用户在飞书里发送 /unbind 撤销自己的绑定。'))
      }
      return nodes
    }

    /** 非秘密配置表单。 */
    function renderConfig(status, state, handlers) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('label', { style: fieldLabelStyle },
          '默认工作目录（绝对路径；留空则交给会话创建时决定）',
          h('input', {
            type: 'text',
            value: state.form.defaultCwd,
            placeholder: '/home/user/project',
            spellCheck: false,
            style: inputStyle,
            'data-feishu-field': 'defaultCwd',
            'aria-label': '默认工作目录',
            onChange: (event) => handlers.changeField('defaultCwd', event),
          })),
        h('label', { style: fieldLabelStyle },
          '单文件上限（字节，1..1073741824；默认 52428800 = 50 MiB）',
          h('input', {
            type: 'text',
            inputMode: 'numeric',
            value: state.form.fileMaxBytes,
            placeholder: '52428800',
            spellCheck: false,
            style: inputStyle,
            'data-feishu-field': 'fileMaxBytes',
            'aria-label': '单文件上限（字节）',
            onChange: (event) => handlers.changeField('fileMaxBytes', event),
          })),
        state.formError !== ''
          ? h('p', { style: failureErrorStyle, role: 'alert', 'data-feishu-form-error': '' }, state.formError)
          : null,
        h('div', { style: rowStyle },
          h('button', {
            type: 'button',
            style: buttonStyle('primary'),
            'data-feishu-action': 'save-config',
            disabled: handlers.busy === 'config',
            onClick: handlers.saveConfig,
          }, handlers.busy === 'config' ? '正在保存…' : '保存配置'),
          h('span', { style: hintStyle }, `当前已保存：${status.config.fileMaxBytes > 0 ? `${status.config.fileMaxBytes} 字节` : '未设置'}`)))
    }

    /** 失败项：只显示摘要，重试必须显式点击。 */
    function renderFailures(status, handlers) {
      const nodes = []
      if (status.failures.inbox.length === 0 && status.failures.outbox.length === 0) {
        return [h('p', { key: 'empty', style: hintStyle }, '暂无失败记录。入站与投递失败会出现在这里，等待你显式重试。')]
      }
      if (status.failures.inbox.length > 0) {
        nodes.push(h('ul', { key: 'inbox', style: listStyle, 'data-feishu-failure': 'inbox' },
          status.failures.inbox.map((item) => h('li', { key: `inbox-${item.id}`, style: listItemStyle },
            h('div', { style: rowStyle },
              h('span', { style: monoStyle }, item.id),
              h('span', { style: hintStyle }, `${item.attempts} 次尝试`),
              h('button', {
                type: 'button',
                style: { ...buttonStyle('ghost'), marginLeft: 'auto' },
                'data-feishu-action': 'retry-inbox',
                onClick: () => handlers.retry(item.id.startsWith('feishu:') ? item.id : `feishu:${item.id}`),
              }, '重试入站')),
            item.error !== '' ? h('span', { style: failureErrorStyle }, item.error) : null))))
      }
      if (status.failures.outbox.length > 0) {
        nodes.push(h('ul', { key: 'outbox', style: listStyle, 'data-feishu-failure': 'outbox' },
          status.failures.outbox.map((item) => h('li', { key: `outbox-${item.requestId}`, style: listItemStyle },
            h('div', { style: rowStyle },
              h('span', { style: monoStyle }, item.requestId),
              h('span', { style: hintStyle }, `${item.kind || 'reply'} · ${item.attempts} 次尝试 · ${item.textChars} 字符`),
              h('button', {
                type: 'button',
                style: { ...buttonStyle('ghost'), marginLeft: 'auto' },
                'data-feishu-action': 'retry-outbox',
                onClick: () => handlers.retry(item.requestId),
              }, '重试投递')),
            item.error !== '' ? h('span', { style: failureErrorStyle }, item.error) : null))))
      }
      return nodes
    }

    /* ── 侧栏入口 ───────────────────────────────────────────────────────── */

    /** 低调的侧栏底部动作：一个状态点 + 「飞书」，打开唯一的管理面板。 */
    function FeishuFooter(props) {
      const snapshot = usePanelSnapshot()
      const wide = props?.wide === true
      const connection = snapshot.connection
      return h('button', {
        type: 'button',
        style: footerStyle(wide),
        'data-feishu-footer': '',
        'aria-label': '飞书连接面板',
        'aria-expanded': snapshot.open ? 'true' : 'false',
        'aria-controls': 'dsh-feishu-panel',
        title: snapshot.open ? '收起飞书连接面板' : '打开飞书连接面板',
        ref: (node) => store.setTrigger(node),
        onClick: () => store.setOpen(!snapshot.open),
      },
      h('span', { style: dotStyle(connection), 'data-feishu-dot': connection, 'aria-hidden': 'true' }),
      wide ? h('span', null, '飞书') : null)
    }

    /* ── 覆盖层面板 ─────────────────────────────────────────────────────── */

    /** 唯一的连接面板：扫码、绑定、配置与失败重试都收在这一张卡里。 */
    function FeishuPanel() {
      const snapshot = usePanelSnapshot()
      const open = snapshot.open
      // 一次性绑定码归共享 store 管：关闭时同步清空，重开首帧不会闪现旧码。
      const bindCode = snapshot.bindCode
      const copied = snapshot.copied

      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [confirm, setConfirm] = React.useState('')
      const [form, setForm] = React.useState({ defaultCwd: '', fileMaxBytes: '' })
      const [formError, setFormError] = React.useState('')
      const [probe, setProbe] = React.useState(false)
      const [narrow, setNarrow] = React.useState(readNarrow)

      const alive = React.useRef(false)
      const dialogRef = React.useRef(null)
      const formReady = React.useRef(false)
      const probeTicks = React.useRef(0)
      // 生命周期代际：每次打开/关闭都 +1。异步响应必须证明自己仍属于同一代，
      // 才允许写面板状态或共享 store——关闭后才返回的响应一律丢弃。
      const epoch = React.useRef(0)

      /** 在动作开始时拍下代际令牌。 */
      function actionToken() {
        return { epoch: epoch.current }
      }

      /** 令牌仍然有效（组件未卸载、面板仍打开、且没关闭/重开过）。 */
      function stillCurrent(token) {
        // 必须读实时 store.open：close 是同步的，而 epoch 在被动 effect 里才递增，
        // 两者之间的窗口里迟到的响应仍可能通过纯代际比较（M1 残余竞态）。
        return alive.current && store.snapshot().open === true && token.epoch === epoch.current
      }

      /** 拉取并投影 status；失败只进面板错误条，不写控制台。 */
      async function loadStatus() {
        const token = actionToken()
        let connected = false
        try {
          const next = await api.status()
          if (!stillCurrent(token)) return
          connected = next.connection === 'connected'
          setStatus(next)
          store.setConnection(next.connection)
          setError('')
          if (!formReady.current) {
            formReady.current = true
            setForm({
              defaultCwd: next.config.defaultCwd,
              fileMaxBytes: next.config.fileMaxBytes > 0 ? String(next.config.fileMaxBytes) : '',
            })
          }
        } catch (caught) {
          if (!stillCurrent(token)) return
          setError(messageOf(caught))
        } finally {
          // 探针必须在失败时也递减：否则网络一直 5xx 会永久轮询。
          if (stillCurrent(token) && probeTicks.current > 0) {
            probeTicks.current -= 1
            if (connected || probeTicks.current <= 0) {
              probeTicks.current = 0
              setProbe(false)
            }
          }
        }
      }

      /** 让轮询短暂跟随一次连接动作（最多 PROBE_TICKS 个周期）。 */
      function beginProbe() {
        probeTicks.current = PROBE_TICKS
        if (alive.current) setProbe(true)
      }

      /** 统一动作壳：busy 标记、错误收敛、异常不逃逸；task 收到本次代际令牌。 */
      async function runAction(name, task) {
        const token = actionToken()
        setBusy(name)
        setError('')
        setNotice('')
        try {
          await task(token)
        } catch (caught) {
          if (stillCurrent(token)) setError(messageOf(caught))
        } finally {
          if (stillCurrent(token)) setBusy('')
        }
      }

      /** 把 provision 接口返回的 status 合回面板状态（full status 或仅 provision）。 */
      async function applyProvisionPayload(payload, token) {
        if (!stillCurrent(token)) return
        const raw = payload.status
        if (isPlainObject(raw) && typeof raw.connection === 'string') {
          const next = normalizeStatus(raw)
          if (!stillCurrent(token)) return
          setStatus(next)
          store.setConnection(next.connection)
          return
        }
        if (isPlainObject(raw) && typeof raw.state === 'string') {
          const provision = normalizeProvision(raw)
          if (!stillCurrent(token)) return
          setStatus((current) => (current === null ? current : { ...current, provision }))
          return
        }
        await loadStatus()
      }

      function runProvision(action, options = {}) {
        void runAction(action, async (token) => {
          const payload = await api.provision(action, options)
          if (!stillCurrent(token)) return
          await applyProvisionPayload(payload, token)
          if (!stillCurrent(token)) return
          if (action === 'publish') setNotice('已提交发布请求，结果以飞书返回为准。')
          if (action === 'apply') setNotice('已提交补齐配置请求。')
          // 取消只是停下扫码流程，不需要等待连接收敛，绝不启动探针轮询。
          if (action !== 'cancel') beginProbe()
        })
      }

      function reconnect() {
        void runAction('reconnect', async (token) => {
          const payload = await api.reconnect()
          if (!stillCurrent(token)) return
          await applyProvisionPayload(payload, token)
          if (!stillCurrent(token)) return
          setNotice('已请求重新连接。')
          beginProbe()
        })
      }

      function requestBindCode() {
        void runAction('bind-code', async (token) => {
          const payload = await api.bindCode()
          // 关闭后才返回的绑定码绝不能再写回共享 store。
          if (!stillCurrent(token)) return
          const code = typeof payload.code === 'string' ? payload.code : ''
          if (code === '') throw new PanelError('服务器没有返回绑定码')
          store.setBindCode({
            code: safeText(code, 64),
            expiresAt: boundedNumber(payload.expiresAt),
          })
        })
      }

      function copyBindCode() {
        const code = bindCode === null ? '' : bindCode.code
        if (code === '') return
        const token = actionToken()
        void (async () => {
          try {
            await globalThis.navigator.clipboard.writeText(code)
            if (stillCurrent(token)) store.setCopied(true)
          } catch {
            if (stillCurrent(token)) setError('复制失败，请手动选择绑定码。')
          }
        })()
      }

      function revokeBinding(bindingKey) {
        void runAction('revoke', async (token) => {
          try {
            const payload = await api.revoke(bindingKey)
            if (!stillCurrent(token)) return
            await loadStatus()
            if (!stillCurrent(token)) return
            if (payload.revoked === true) {
              setNotice('已撤销该绑定（DSH 会话历史保留）。')
            } else {
              setError('撤销未生效：服务器没有确认删除这条绑定。请在飞书里发送 /unbind 撤销，或刷新后重试。')
            }
          } catch (caught) {
            if (!stillCurrent(token)) return
            const code = caught instanceof PanelError ? caught.code : ''
            if (code === 'binding_not_found') {
              // 先刷新列表（这条绑定可能已被别处撤销），再给结论，避免旧列表误导。
              await loadStatus()
              if (stillCurrent(token)) setError('撤销未生效：这条绑定已不存在（可能已在飞书里用 /unbind 撤销）。')
              return
            }
            if (code === 'binding_key_ambiguous') {
              setError('撤销未生效：bindingKey 命中多条绑定（罕见的前缀碰撞），无法安全判断目标。请让用户在飞书里用 /unbind 逐个撤销。')
              return
            }
            throw caught
          }
        })
      }

      function retryFailure(requestId) {
        void runAction('retry', async (token) => {
          const payload = await api.retry(requestId)
          if (!stillCurrent(token)) return
          const state = typeof payload.state === 'string' ? safeText(payload.state, 32) : ''
          await loadStatus()
          if (!stillCurrent(token)) return
          setNotice(payload.retried === true
            ? `已重新排队（${state || 'pending'}）。`
            : '这条记录状态已变化，未重试。')
        })
      }

      /** 客户端先校验非秘密配置；校验不过不打扰后端。 */
      function saveConfig() {
        setFormError('')
        const defaultCwd = String(form.defaultCwd ?? '').trim()
        const bytesText = String(form.fileMaxBytes ?? '').trim()
        if (defaultCwd.length > MAX_CWD_CHARS) {
          setFormError(`默认工作目录过长（最多 ${MAX_CWD_CHARS} 字符）`)
          return
        }
        if (defaultCwd.includes('\0')) {
          setFormError('默认工作目录含非法字符')
          return
        }
        if (defaultCwd !== '' && !(defaultCwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(defaultCwd))) {
          setFormError('默认工作目录必须是绝对路径（以 / 或盘符开头）')
          return
        }
        if (!/^[0-9]+$/.test(bytesText)) {
          setFormError('文件上限必须是以字节为单位的正整数')
          return
        }
        const fileMaxBytes = Number(bytesText)
        if (!Number.isSafeInteger(fileMaxBytes) || fileMaxBytes <= 0 || fileMaxBytes > MAX_FILE_MAX_BYTES) {
          setFormError(`文件上限必须在 1..${MAX_FILE_MAX_BYTES} 字节之间`)
          return
        }
        void runAction('config', async (token) => {
          const payload = await api.config({ defaultCwd, fileMaxBytes })
          if (!stillCurrent(token)) return
          const saved = isPlainObject(payload.config) ? payload.config : {}
          setForm({
            defaultCwd: typeof saved.defaultCwd === 'string' ? safeText(saved.defaultCwd, MAX_CWD_CHARS) : defaultCwd,
            fileMaxBytes: String(boundedNumber(saved.fileMaxBytes, MAX_FILE_MAX_BYTES) || fileMaxBytes),
          })
          setNotice('配置已保存。')
          await loadStatus()
        })
      }

      function changeField(name, event) {
        const value = event?.target?.value
        if (typeof value !== 'string') return
        setFormError('')
        setForm((current) => ({ ...current, [name]: value }))
      }

      // 生命周期：alive 标记（异步回调在卸载后不得再 setState）。
      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      // 每次打开/关闭都推进代际：关闭后到达的异步响应自动失效（见 stillCurrent）。
      React.useEffect(() => {
        epoch.current += 1
      }, [open])

      // 每次打开都重置一次性状态并拉取最新 status（关闭时不发请求）。
      React.useEffect(() => {
        if (!open) return undefined
        setError('')
        setNotice('')
        setBusy('')
        setConfirm('')
        setFormError('')
        setProbe(false)
        probeTicks.current = 0
        formReady.current = false
        void loadStatus()
        return undefined
      }, [open])

      // 焦点移入对话框；关闭时还给侧栏入口。
      React.useEffect(() => {
        if (!open) return undefined
        try {
          if (dialogRef.current !== null && typeof dialogRef.current.focus === 'function') {
            dialogRef.current.focus()
          }
        } catch {
          // 焦点不可用不影响面板功能。
        }
        return () => {
          store.focusTrigger()
        }
      }, [open])

      // Escape 关闭（只在打开期间监听，关闭/卸载即移除）。
      React.useEffect(() => {
        if (!open) return undefined
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          if (event?.key !== 'Escape') return
          if (typeof event.preventDefault === 'function') event.preventDefault()
          store.setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          // 宿主/测试环境可能在清理前拆掉 document；移除监听必须容错。
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('keydown', onKeyDown)
          }
        }
      }, [open])

      // 视口变化时在对话框/抽屉之间切换。
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onResize = () => setNarrow(readNarrow())
        window.addEventListener('resize', onResize)
        return () => {
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('resize', onResize)
          }
        }
      }, [])

      // 轮询：仅当打开、已有 status，且扫码 waiting 或刚做过连接动作时。
      const waiting = status !== null && status.provision !== null && status.provision.state === 'waiting'
      const shouldPoll = open && status !== null && (waiting || probe)
      React.useEffect(() => {
        if (!shouldPoll) return undefined
        let active = true
        const timer = setInterval(() => {
          if (!active) return
          void loadStatus()
        }, POLL_INTERVAL_MS)
        return () => {
          active = false
          clearInterval(timer)
        }
      }, [open, shouldPoll])

      if (!open) return null

      const connection = status === null ? '' : status.connection
      const provision = status === null ? null : status.provision
      const configured = status !== null && status.credentialsConfigured === true
      const handlers = {
        busy,
        confirm,
        configured,
        // 无凭据：直接 start；已有凭据：先二次确认，再带 force 替换应用。
        start: () => {
          if (configured) setConfirm('force-start')
          else runProvision('start')
        },
        forceStart: () => {
          setConfirm('')
          runProvision('start', { force: true })
        },
        dismissForceStart: () => setConfirm(''),
        cancel: () => runProvision('cancel'),
        apply: () => runProvision('apply'),
        askPublish: () => setConfirm('publish'),
        dismissConfirm: () => setConfirm(''),
        confirmPublish: () => {
          setConfirm('')
          runProvision('publish')
        },
        reconnect,
        bindCode: requestBindCode,
        copyCode: copyBindCode,
        revoke: revokeBinding,
        retry: retryFailure,
        saveConfig,
        changeField,
      }

      const banners = []
      if (error !== '') banners.push(h('div', { key: 'error', role: 'alert', 'data-feishu-error': '', style: errorBannerStyle }, error))
      if (notice !== '') banners.push(h('div', { key: 'notice', role: 'status', style: noticeBannerStyle }, notice))

      const safeStatus = status === null ? normalizeStatus(null) : status
      const body = [section('连接', renderConnection(safeStatus, handlers), 'connection')]

      body.push(section('应用配置', renderProvision(provision, handlers), 'provision'))
      body.push(section('绑定', renderBinding(safeStatus, { bindCode, copied }, handlers), 'binding'))
      body.push(section('非秘密配置', renderConfig(safeStatus, { form, formError }, handlers), 'config'))
      body.push(section('失败记录', renderFailures(safeStatus, handlers), 'failures'))
      body.push(h('p', { key: 'privacy', style: footerNoteStyle },
        '面板只显示脱敏状态：App Secret 与消息正文不会进入浏览器。发布、撤销与重试都不会自动执行。'))

      return h('div', { style: overlayStyle, 'data-feishu-overlay': '' },
        h('div', { style: backdropStyle, 'data-feishu-backdrop': '', 'aria-hidden': 'true', onClick: () => store.setOpen(false) }),
        h('div', {
          role: 'dialog',
          id: 'dsh-feishu-panel',
          'aria-modal': 'true',
          'aria-label': '飞书连接面板',
          'aria-labelledby': 'dsh-feishu-panel-title',
          tabIndex: -1,
          ref: dialogRef,
          'data-feishu-panel': '',
          'data-layout': narrow ? 'drawer' : 'dialog',
          style: panelStyle(narrow),
        },
        h('div', { style: headerStyle },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 } },
            h('span', { style: eyebrowStyle }, 'DSH × 飞书'),
            h('h2', { id: 'dsh-feishu-panel-title', style: titleStyle }, '飞书连接')),
          h('span', { style: badgeStyle(connection), 'data-feishu-connection': connection },
            h('span', { style: dotStyle(connection), 'aria-hidden': 'true' }),
            CONNECTION_LABEL[connection] ?? '读取中'),
          h('button', {
            type: 'button',
            style: buttonStyle('quiet'),
            'data-feishu-action': 'refresh',
            'aria-label': '刷新飞书状态',
            disabled: busy !== '',
            onClick: () => { void loadStatus() },
          }, '刷新'),
          h('button', {
            type: 'button',
            style: buttonStyle('quiet'),
            'data-feishu-action': 'close',
            'aria-label': '关闭飞书面板',
            onClick: () => store.setOpen(false),
          }, '✕')),
        h('div', { style: bodyStyle },
          banners,
          status === null
            ? h('p', { style: hintStyle, 'data-feishu-loading': '' }, '正在读取飞书状态…')
            : body)))
    }

    /** 「应用配置」卡片：按 provision.state 渲染不同动作，publish 必须二次确认。 */
    /**
     * 扫码入口 + 二次确认。无凭据时直接开始；已有凭据时必须显式确认“更换应用”
     * 才发 `{action:'start', force:true}`（否则 Host 会因应用已配置而拒绝）。
     */
    function renderStartControl(provisionState, handlers) {
      const configured = handlers.configured === true
      const label = configured
        ? '更换飞书应用…'
        : (provisionState === 'failed' || provisionState === 'cancelled' ? '重新扫码配置' : '开始扫码配置')
      const nodes = [h('button', {
        type: 'button',
        key: 'start',
        style: buttonStyle('primary'),
        'data-feishu-action': 'start',
        disabled: handlers.busy === 'start',
        onClick: () => handlers.start(),
      }, label)]
      if (handlers.confirm === 'force-start') {
        nodes.push(h('div', {
          key: 'force-confirm',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '8px 10px',
            borderRadius: 8,
            border: `1px solid ${T.warnTert}`,
            background: T.warnTert,
          },
        },
        h('p', { style: { ...hintStyle, color: T.text2 } },
          '更换应用会用新凭据替换当前飞书应用，现有绑定可能需要重新绑定。确认更换？'),
        h('div', { style: rowStyle },
          h('button', {
            type: 'button',
            style: buttonStyle('primary'),
            'data-feishu-action': 'force-start-confirm',
            disabled: handlers.busy === 'start',
            onClick: () => handlers.forceStart(),
          }, '确认更换'),
          h('button', {
            type: 'button',
            style: buttonStyle('ghost'),
            'data-feishu-action': 'force-start-cancel',
            onClick: () => handlers.dismissForceStart(),
          }, '取消'))))
      }
      return nodes
    }

    function renderProvision(provision, handlers) {
      if (provision === null) {
        return [h('p', { key: 'hint', style: hintStyle }, '还没有配置飞书应用。扫码创建应用，或用已有应用凭据重新扫码。'),
          ...renderStartControl('idle', handlers)]
      }

      const nodes = []
      if (provision.error !== '') nodes.push(h('p', { key: 'error', style: failureErrorStyle }, provision.error))

      if (provision.state === 'waiting') {
        nodes.push(h('div', { key: 'ticket', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          renderTicket(provision, handlers)))
        return nodes
      }

      if (provision.state === 'success') {
        const steps = renderProvisionSteps(provision)
        if (steps !== null) nodes.push(h('div', { key: 'steps' }, steps))
        nodes.push(h('div', { key: 'results', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          renderActionResult('补齐', provision.apply),
          renderActionResult('发布', provision.publish)))
        nodes.push(h('div', { key: 'actions', style: rowStyle },
          h('button', {
            type: 'button',
            style: buttonStyle('primary'),
            'data-feishu-action': 'apply',
            disabled: handlers.busy === 'apply',
            onClick: () => handlers.apply(),
          }, handlers.busy === 'apply' ? '正在补齐…' : '补齐应用配置'),
          h('button', {
            type: 'button',
            style: buttonStyle('ghost'),
            'data-feishu-action': 'publish',
            disabled: handlers.busy === 'publish',
            onClick: () => handlers.askPublish(),
          }, '发布应用版本')))
        if (handlers.confirm === 'publish') {
          nodes.push(h('div', {
            key: 'confirm',
            style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 8, border: `1px solid ${T.warnTert}`, background: T.warnTert },
          },
          h('p', { style: { ...hintStyle, color: T.text2 } },
            '发布会在飞书创建并上线一个新版本，确认发布？这一步需要再次确认，不会自动执行。'),
          h('div', { style: rowStyle },
            h('button', {
              type: 'button',
              style: buttonStyle('primary'),
              'data-feishu-action': 'publish-confirm',
              disabled: handlers.busy === 'publish',
              onClick: () => handlers.confirmPublish(),
            }, handlers.busy === 'publish' ? '正在发布…' : '确认发布'),
            h('button', {
              type: 'button',
              style: buttonStyle('ghost'),
              'data-feishu-action': 'publish-cancel',
              onClick: () => handlers.dismissConfirm(),
            }, '取消'))))
        }
        return nodes
      }

      if (provision.state === 'failed') {
        const steps = renderProvisionSteps(provision)
        if (steps !== null) nodes.push(h('div', { key: 'steps' }, steps))
      }

      nodes.push(...renderStartControl(provision.state, handlers))
      return nodes
    }

    /* ── 插件挂载 ───────────────────────────────────────────────────────── */

    /**
     * 只经官方 slots 扩展点注册两个表面：
     *   - sidebar.footer.action：低调入口（宽栏显示「飞书」，窄栏只显示状态点）；
     *   - shell.overlay：整框覆盖层，关闭时返回 null（不保留任何宿主 DOM）。
     * @param {object} ctx Host 客户端上下文
     */
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'feishu-footer',
      }, FeishuFooter))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'feishu-panel',
      }, FeishuPanel))
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
