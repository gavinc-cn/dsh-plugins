/**
 * DeepSeek 余额与今日消费 — 浏览器半。
 * 只读取宿主 owner-only route 的脱敏状态；不解析事件、不读取凭据、不直接访问 DeepSeek。
 * 视觉沿用 composer dock 的安静账本风格：等宽数字、细分隔、无额外装饰，点击刷新。
 */

window.__ModuleLoader__.load({
  id: '@gavinc-cn/dsh-deepseek-account',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const NS = 'deepseek-account'
    const POLL_MS = 60_000
    const PATHS = {
      status: '/api/deepseek-account/status',
      refresh: '/api/deepseek-account/refresh',
    }

    const zh = {
      'loading': '余额 … · 今日 …',
      'balance.label': '余额',
      'today.label': '今日',
      'unconfigured': '未配置',
      'balance.source': '余额来自 DeepSeek 官方 GET /user/balance，包含赠金与充值余额。',
      'balance.detail': '{total}；充值 {toppedUp}，赠金 {granted}。',
      'balance.unconfigured': '未读取到 DEEPSEEK_API_KEY。可在 DSH Models 页配置官方 API Key；账号授权不等于 API Key。',
      'usage.source': '{day}（北京时间）的消费是按本机 DSH 全部会话的模型 token 用量估算；不含 Search/Fetch、其他工具、外部调用和折扣。',
      'usage.detail': '已计价 {calls} 次，覆盖 {sessions} 个会话；未计价 {unpriced} 次。',
      'usage.partial': '{count} 个会话读取失败，今日费用可能不完整；点击刷新可重试。',
      'usage.error': '会话历史暂不可读，今日费用暂缺。',
      'updated': '状态更新于 {time}。',
      'refresh': '点击重新查询余额并重试失败会话。',
      'requestFailed': '状态请求失败；保留上一次成功结果。',
    }
    const en = {
      'loading': 'Balance … · Today …',
      'balance.label': 'Balance',
      'today.label': 'Today',
      'unconfigured': 'not configured',
      'balance.source': 'Balance comes from DeepSeek GET /user/balance and includes granted and topped-up funds.',
      'balance.detail': '{total}; topped up {toppedUp}, granted {granted}.',
      'balance.unconfigured': 'DEEPSEEK_API_KEY is unavailable. Configure the official API key on the DSH Models page; account authorization is not an API key.',
      'usage.source': '{day} (Beijing time) is estimated from model-token usage across all local DSH sessions. Search/Fetch, other tools, external calls, and discounts are excluded.',
      'usage.detail': '{calls} priced calls across {sessions} sessions; {unpriced} unpriced calls.',
      'usage.partial': '{count} session(s) could not be read, so today may be incomplete. Click to retry.',
      'usage.error': 'Session history is unavailable, so today’s cost is unavailable.',
      'updated': 'Status updated at {time}.',
      'refresh': 'Click to query the balance again and retry failed sessions.',
      'requestFailed': 'Status request failed; keeping the last successful result.',
    }

    const BUTTON_STYLE = {
      boxSizing: 'border-box',
      borderRadius: 'var(--dsw-radius-sm)',
      maxWidth: '100%',
      color: 'var(--dsw-alias-label-tertiary)',
      font: 'inherit',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      fontVariantNumeric: 'tabular-nums',
      lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
      whiteSpace: 'nowrap',
      background: 'transparent',
      border: 'none',
      alignItems: 'center',
      gap: '6px',
      padding: '1px 8px',
      display: 'inline-flex',
      cursor: 'pointer',
    }

    /** 纳元整数转人民币显示；小于 10 元保留四位，避免小额消费显示成 0.00。 */
    function formatCny(nanoYuan) {
      const safe = Number.isSafeInteger(nanoYuan) ? nanoYuan : 0
      const yuan = safe / 1_000_000_000
      return '¥' + (yuan < 10 ? yuan.toFixed(4) : yuan.toFixed(2))
    }

    /** 官方金额保持字符串；优先展示 CNY，否则展示第一种货币。 */
    function balanceEntry(balance) {
      const entries = Array.isArray(balance?.balances) ? balance.balances : []
      return entries.find((entry) => entry.currency === 'CNY') ?? entries[0] ?? null
    }

    function formatBalance(entry) {
      if (entry === null || typeof entry.total !== 'string') return '—'
      if (entry.currency === 'CNY') return '¥' + entry.total
      if (entry.currency === 'USD') return 'US$' + entry.total
      return entry.currency + ' ' + entry.total
    }

    function formatClock(timeMs) {
      if (!Number.isSafeInteger(timeMs)) return '—'
      const date = new Date(timeMs)
      const pad = (value) => String(value).padStart(2, '0')
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    /** 生成胶囊可见文案，余额和今日消费分别降级，互不清空。 */
    function labelOf(snapshot, t) {
      if (snapshot === null || snapshot === undefined) return t('loading')
      const entry = balanceEntry(snapshot.balance)
      const balance = entry !== null
        ? formatBalance(entry)
        : snapshot.balance?.status === 'unconfigured' ? t('unconfigured') : '—'
      const usage = snapshot.usage
      const today = usage?.status === 'loading'
        ? '…'
        : usage?.status === 'error'
          ? '—'
          : formatCny(usage?.nanoYuan) + (usage?.unpricedCalls > 0 ? '+' : '')
      return t('balance.label') + ' ' + balance + ' · ' + t('today.label') + ' ' + today
    }

    /** 生成完整口径、拆分明细、失败原因与更新时间。 */
    function titleOf(snapshot, t, requestError) {
      if (snapshot === null || snapshot === undefined) return t('loading')
      const lines = [t('balance.source')]
      const entry = balanceEntry(snapshot.balance)
      if (entry !== null) {
        lines.push(t('balance.detail', {
          total: formatBalance(entry), toppedUp: entry.toppedUp, granted: entry.granted,
        }))
      }
      if (snapshot.balance?.status === 'unconfigured') lines.push(t('balance.unconfigured'))
      if (typeof snapshot.balance?.error === 'string') lines.push(snapshot.balance.error)
      const usage = snapshot.usage ?? {}
      lines.push(t('usage.source', { day: usage.day ?? '—' }))
      lines.push(t('usage.detail', {
        calls: usage.pricedCalls ?? 0,
        sessions: usage.sessionCount ?? 0,
        unpriced: usage.unpricedCalls ?? 0,
      }))
      if (usage.status === 'partial') lines.push(t('usage.partial', { count: usage.failedSessions ?? 0 }))
      if (usage.status === 'error') lines.push(t('usage.error'))
      if (requestError !== null) lines.push(t('requestFailed'))
      lines.push(t('updated', { time: formatClock(snapshot.balance?.updatedAt ?? usage.updatedAt) }))
      lines.push(t('refresh'))
      return lines.join('\n')
    }

    /** same-origin JSON 请求；错误只保留固定短文案，不反射服务端正文。 */
    async function requestAccount(force) {
      const response = await globalThis.fetch(force ? PATHS.refresh : PATHS.status, {
        method: force ? 'POST' : 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (response?.ok !== true) throw new Error('account status unavailable')
      const payload = await response.json()
      if (payload?.ok !== true || typeof payload.balance !== 'object' || typeof payload.usage !== 'object') {
        throw new Error('account status malformed')
      }
      return payload
    }

    function AccountPill({ t }) {
      const [snapshot, setSnapshot] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const [requestError, setRequestError] = React.useState(null)
      const [requestState, setRequestState] = React.useState({ version: 0, force: false })

      React.useEffect(() => {
        let active = true
        setRefreshing(true)
        requestAccount(requestState.force).then((next) => {
          if (!active) return
          setSnapshot(next)
          setRequestError(null)
        }).catch((error) => {
          if (active) setRequestError(error)
        }).finally(() => {
          if (active) setRefreshing(false)
        })
        return () => { active = false }
      }, [requestState.version])

      React.useEffect(() => {
        const timer = setInterval(() => {
          setRequestState((current) => ({ version: current.version + 1, force: false }))
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [])

      const label = labelOf(snapshot, t)
      return h('button', {
        type: 'button',
        style: { ...BUTTON_STYLE, opacity: refreshing ? 0.65 : 1 },
        'data-composer-stat': 'deepseek-account',
        'data-refreshing': refreshing ? 'true' : 'false',
        disabled: refreshing,
        'aria-label': label,
        title: titleOf(snapshot, t, requestError),
        onClick: () => setRequestState((current) => ({ version: current.version + 1, force: true })),
      }, h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, label))
    }

    /** 注册词典与一个 composer.dock 条目，排在现有会话费用之后。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-account: dictionaries')
      ctx.slots.inject('conversation.composer.dock', function* () {
        yield ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'deepseek-account',
          order: 4,
          locale: NS,
        }, AccountPill)
      })
    }

    exports.apply = apply
    exports.inject = ['locale', 'slots']
    exports.AccountPill = AccountPill
    exports.labelOf = labelOf
    exports.titleOf = titleOf
    exports.formatCny = formatCny
    return module.exports
  },
})
