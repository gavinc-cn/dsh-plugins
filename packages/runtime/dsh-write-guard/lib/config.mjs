// dsh-write-guard 的配置归一化（纯函数）。
//
// 职责：把宿主传入的原始 config（YAML 映射，字段可能缺失、类型任意）校验并补全默认值，
// 返回插件内部统一使用的 Config 形状。
//
// 边界：
//   - 只做「校验 + 默认值 + `~` 展开」，**不做 realpath、不检查路径是否存在**——
//     路径解析属于判定阶段（rules/decide）按需做的事，放到加载期会让配置受磁盘状态影响；
//   - 路径类字段（`autoWhitelistFile`/`logPath`）的「空」（缺失 / `null` / `''` / 纯空白）
//     一律回落到默认值，对应 spec §5.8 的「空 = 默认路径」；
//   - 不读写文件、不访问网络，方便单测；
//   - 非法配置一律抛 Error，message 以 `dsh-write-guard: ` 开头并点名字段，
//     让宿主在加载期直接拒绝（fail fast），而不是带着坏值静默运行。

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { expandHome } from '@gavinc-cn/dsh-path-rules/auto-whitelist'

/** 激活本插件的权限预设名（对应 profile 里 permission.presets 的键）。 */
export const DEFAULT_ACTIVATION_PRESET = 'write-guard'

/** 缺省审计日志路径：与既有 kimi-code hook 日志同目录。 */
export const DEFAULT_LOG_PATH = join(homedir(), '.kimi-code', 'hooks', 'logs', 'write_guard.dsh.log')

/** failMode 允许的取值（插件内部异常时的兜底策略）。 */
const FAIL_MODES = ['ask', 'deny', 'open']

/**
 * 构造统一形状的配置错误：前缀固定，消息里点名字段，便于宿主/用户定位。
 *
 * @param field - 出错的配置字段名（可带数组下标，如 `whitelist[0]`）。
 * @param reason - 该字段为什么非法。
 * @returns {Error}
 */
function configError(field, reason) {
  return new Error(`dsh-write-guard: 配置项 ${field} ${reason}`)
}

/**
 * 把任意值渲染成短小可读的描述，仅用于错误信息，避免把整个对象打出来。
 *
 * @param value - 任意原始值。
 * @returns {string} 形如 `"nope"` / `null` / `数组` / `number 0`。
 */
function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  if (typeof value === 'object') return '对象'
  return String(value)
}

/**
 * 读取布尔字段：`undefined` 取默认值，其余必须是真正的 boolean。
 *
 * 不接受 `'true'`/`1`/`0` 之类的“可 truthy”写法——配置文件里写错类型时应显式报错，
 * 而不是让用户以为开关生效了。
 *
 * @param source - 原始 config 对象。
 * @param field - 字段名。
 * @param fallback - 缺省值。
 * @returns {boolean}
 */
function readBoolean(source, field, fallback) {
  const value = source[field]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw configError(field, `必须是布尔值，收到 ${describeValue(value)}`)
  }
  return value
}

/**
 * 读取「常规字符串」字段：`undefined` 取默认值，否则必须是字符串；
 * 返回值去掉首尾空白，trim 后为空则视为非法（如 `activationPreset`）。
 *
 * @param source - 原始 config 对象。
 * @param field - 字段名。
 * @param fallback - 缺省值。
 * @returns {string} 去空白后的非空字符串。
 */
function readTrimmedString(source, field, fallback) {
  const value = source[field]
  if (value === undefined) return fallback
  if (typeof value !== 'string') {
    throw configError(field, `必须是字符串，收到 ${describeValue(value)}`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw configError(field, `必须是非空字符串（纯空白视为空），收到 ${describeValue(value)}`)
  }
  return trimmed
}

/**
 * 读取「可选路径字符串」字段（spec §5.8：空 = 用默认值）。
 *
 * 缺失、`null`、空串、纯空白都表示「未配置」，直接返回 fallback；
 * 其余值必须是字符串，先 trim 再展开 `~` 前缀（展开顺序见 readWhitelist）。
 *
 * @param source - 原始 config 对象。
 * @param field - 字段名。
 * @param fallback - 缺省值（`''` 或 `DEFAULT_LOG_PATH`）。
 * @returns {string} 展开后的路径，或 fallback。
 */
function readPathString(source, field, fallback) {
  const value = source[field]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') {
    throw configError(field, `必须是字符串，收到 ${describeValue(value)}`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return fallback
  return expandHome(trimmed)
}

/**
 * 读取 whitelist：必须是数组，逐项先 `expandHome` 再要求绝对路径；返回展开后的新数组。
 *
 * 展开顺序很重要：`~/x` 只有展开后才可能变成绝对路径，因此先展开再判 `isAbsolute`。
 * 不修改原数组、也不做 realpath（判定阶段再归一化）。
 *
 * @param source - 原始 config 对象。
 * @returns {string[]} 展开后的绝对路径列表（保持原顺序）。
 */
function readWhitelist(source) {
  const value = source.whitelist
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw configError('whitelist', `必须是字符串数组，收到 ${describeValue(value)}`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw configError(`whitelist[${index}]`, `必须是字符串，收到 ${describeValue(entry)}`)
    }
    const expanded = expandHome(entry)
    if (!isAbsolute(expanded)) {
      throw configError(
        `whitelist[${index}]`,
        `必须是绝对路径（~ 展开后仍非绝对），收到 ${JSON.stringify(entry)}`,
      )
    }
    return expanded
  })
}

/**
 * 读取 failMode：只接受 `ask`/`deny`/`open`（大小写敏感），缺省 `ask`。
 *
 * @param source - 原始 config 对象。
 * @returns {'ask'|'deny'|'open'}
 */
function readFailMode(source) {
  const value = source.failMode
  if (value === undefined) return 'ask'
  if (typeof value !== 'string' || !FAIL_MODES.includes(value)) {
    throw configError(
      'failMode',
      `必须是 ask|deny|open 之一，收到 ${describeValue(value)}`,
    )
  }
  return value
}

/**
 * 读取 judgeTimeoutMs：有限正数（毫秒），不要求整数（允许 0.5 这类亚毫秒精度）。
 *
 * @param source - 原始 config 对象。
 * @returns {number}
 */
function readJudgeTimeoutMs(source) {
  const value = source.judgeTimeoutMs
  if (value === undefined) return 20000
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw configError('judgeTimeoutMs', `必须是有限正数（毫秒），收到 ${describeValue(value)}`)
  }
  return value
}

/**
 * 读取 judgeCacheSize：非负整数（0 = 不缓存）。
 *
 * @param source - 原始 config 对象。
 * @returns {number}
 */
function readJudgeCacheSize(source) {
  const value = source.judgeCacheSize
  if (value === undefined) return 200
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw configError('judgeCacheSize', `必须是非负整数，收到 ${describeValue(value)}`)
  }
  return value
}

/**
 * 归一化插件配置：校验 + 补默认值，返回完整 Config。
 *
 * 字段与缺省值（spec §5.8）：
 *   enabled=true、activationPreset='write-guard'、whitelist=[]、allowTempRoots=true、
 *   judge=true、judgeTimeoutMs=20000、judgeCacheSize=200、autoWhitelist=true、
 *   autoWhitelistFile=''、failMode='ask'、dryRun=false、logPath=DEFAULT_LOG_PATH。
 *
 * 空值语义（spec §5.8）：`autoWhitelistFile`/`logPath` 缺失、`null`、`''`、纯空白
 * 都回落到默认值；`activationPreset` 先 trim，trim 后为空则抛错；`failMode` 按
 * `ask|deny|open` 精确匹配（不 trim、大小写敏感）；`whitelist` 每项展开 `~` 后必须是绝对路径。
 *
 * @param raw - 宿主传入的原始 config（可为 undefined / null）。
 * @returns {{enabled:boolean, activationPreset:string, whitelist:string[], allowTempRoots:boolean,
 *   judge:boolean, judgeTimeoutMs:number, judgeCacheSize:number, autoWhitelist:boolean,
 *   autoWhitelistFile:string, failMode:'ask'|'deny'|'open', dryRun:boolean, logPath:string}}
 * @throws {Error} 任一字段非法时抛错（前缀 `dsh-write-guard: `，消息点名字段）。
 */
export function normalizeConfig(raw = {}) {
  const source = raw ?? {}
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw configError('config', `必须是对象，收到 ${describeValue(source)}`)
  }
  return {
    enabled: readBoolean(source, 'enabled', true),
    activationPreset: readTrimmedString(source, 'activationPreset', DEFAULT_ACTIVATION_PRESET),
    whitelist: readWhitelist(source),
    allowTempRoots: readBoolean(source, 'allowTempRoots', true),
    judge: readBoolean(source, 'judge', true),
    judgeTimeoutMs: readJudgeTimeoutMs(source),
    judgeCacheSize: readJudgeCacheSize(source),
    autoWhitelist: readBoolean(source, 'autoWhitelist', true),
    autoWhitelistFile: readPathString(source, 'autoWhitelistFile', ''),
    failMode: readFailMode(source),
    dryRun: readBoolean(source, 'dryRun', false),
    logPath: readPathString(source, 'logPath', DEFAULT_LOG_PATH),
  }
}
