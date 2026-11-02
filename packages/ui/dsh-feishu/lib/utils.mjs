// @gavinc-cn/dsh-feishu —— 共享纯函数
//
// 目的：把「错误脱敏 / 文本分片 / 文件名净化 / 穷尽分支检查」这些与宿主无关、
// 又会被入站、出站、附件、日志多层复用的口径固定在纯函数里，避免各处各写一套。
// 设计约束：
//   - 不 import 任何 DSH/飞书模块，可被单测与浏览器侧以外的地方直接复用；
//   - 输入输出都是普通字符串/数组，失败时抛原生 TypeError/RangeError/Error；
//   - 秘密只做「值替换」，保留键名与 URL 主机/路径，便于排障。
// 已知边界：正则脱敏是兜底，不是安全边界；真正敏感的值不应进入日志。

/** 会被整体抹掉值的敏感键（大小写不敏感，兼容下划线写法）。 */
const SECRET_PAIR = /((?:["']?(?:app_?secret|access_?token|client_?secret|tenant_access_token|user_access_token)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;}]+)/gi

/** URL 里的 userinfo（`https://user:pass@host/...`）。 */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^/\s?#@]+)@/gi

/** Authorization: Bearer 令牌。 */
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi

/**
 * 把任意错误/值转成可打印字符串；对象优先 JSON 序列化，循环引用时退回 String()。
 * @param {unknown} value
 * @returns {string}
 */
function stringifyError(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (value !== null && typeof value === 'object') {
    try {
      const json = JSON.stringify(value)
      if (typeof json === 'string') return json
    } catch {
      // 循环引用/含 BigInt 的对象：退回 String()，由下面的兜底保证一定返回字符串。
    }
  }
  try {
    return String(value)
  } catch {
    return '[unserializable error]'
  }
}

/**
 * 生成适合写日志/回传面板的错误文本：保留上下文，抹掉 appSecret、accessToken、
 * URL 的 userinfo 与 Authorization Bearer 值。幂等（重复脱敏不会再改变结果）。
 * @param {unknown} error
 * @returns {string}
 */
export function redactError(error) {
  return stringifyError(error)
    .replace(URL_CREDENTIALS, '$1[REDACTED]@')
    .replace(SECRET_PAIR, (_match, prefix, value) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : ''
      return `${prefix}${quote}[REDACTED]${quote}`
    })
    .replace(BEARER_TOKEN, '$1[REDACTED]')
}

/**
 * 按 UTF-16 码元上限切分文本，绝不切开代理对（emoji 等增补平面字符保持完整）。
 * 空串返回空数组；单个码点若自身超过上限（极端 max=1 + emoji）会独占一片。
 * @param {string} text
 * @param {number} [max=3000] 每个分片的最大 UTF-16 码元数
 * @returns {string[]}
 */
export function chunkText(text, max = 3000) {
  if (typeof text !== 'string') throw new TypeError('chunkText: text 必须是字符串')
  if (!Number.isInteger(max) || max <= 0) throw new RangeError('chunkText: max 必须是正整数')
  if (text.length === 0) return []

  const chunks = []
  let current = ''
  for (const codePoint of text) {
    if (current.length + codePoint.length > max) {
      // current 为空说明单个码点（如 max=1 时的 emoji）已超上限：
      // 不能把空串推入结果，让该码点独占一片即可。
      if (current.length > 0) chunks.push(current)
      current = ''
    }
    current += codePoint
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * 从任意路径字符串中取出可安全落盘的基础文件名：
 * 兼容 `/` 与 `\`、去掉目录段与 `.`/`..`、剔除控制字符、结果为空时回退 `file`。
 * @param {string} name
 * @returns {string}
 */
export function safeBaseName(name) {
  if (typeof name !== 'string') throw new TypeError('safeBaseName: name 必须是字符串')

  const segments = name.replace(/\\/g, '/').split('/')
  let base = segments.at(-1) ?? ''
  // 末尾是空段（"a/"）或穿越段（"a/.."）时，退回最后一个正常目录段。
  if (base === '' || base === '.' || base === '..') {
    base = segments.filter((segment) => segment !== '' && segment !== '.' && segment !== '..').at(-1) ?? ''
  }
  base = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (base === '' || base === '.' || base === '..') return 'file'
  return base
}

/**
 * 穷尽分支检查：联合类型的所有成员都处理完后调用；运行时走到这里说明漏了分支。
 * @param {never} value
 * @returns {never}
 */
export function assertNever(value) {
  let detail
  try {
    detail = JSON.stringify(value)
  } catch {
    detail = undefined
  }
  if (typeof detail !== 'string') {
    try {
      detail = String(value)
    } catch {
      detail = '[unserializable value]'
    }
  }
  throw new Error(`Unhandled variant: ${detail}`)
}
