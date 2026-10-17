// dsh-path-rules 的路径语义层（纯函数，无插件依赖）。
//
// 设计要点（spec §5.1）：
//   * normalizePath 只对「存在的最深前缀」做 realpath，剩余段原样拼回：
//     既不放过"项目内软链指向项目外"的逃逸，也不要求目标本身已存在
//     （write 创建新文件时目标通常还不存在）。
//   * underRoot 是词法前缀判断：target 等于 root，或以 `root + sep` 开头；
//     同名前缀的兄弟目录（/proj/abc vs /proj/ab）不算在其下。

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** realpath 一个路径；不存在/无权限时返回 undefined（不抛）。 */
function tryRealpath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

/**
 * 把任意路径写法归一化成可用于判定比较的绝对路径。
 *
 * 目标存在 ⇒ 直接 realpath；目标不存在 ⇒ 向上找到最深已存在祖先做 realpath，
 * 再把中间的路径段原样拼回（这样符号链接目录下的新文件也能按真实位置判定）。
 *
 * @param raw - 原始路径（可为相对路径）；空/空白返回空串。
 * @param cwd - 相对路径的解析基准（会话工作目录）。
 * @returns 归一化后的绝对路径。
 */
export function normalizePath(raw, cwd) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return ''
  const absolute = isAbsolute(text) ? text : resolve(cwd ?? process.cwd(), text)
  const real = tryRealpath(absolute)
  if (real !== undefined) return real
  const tail = []
  let current = absolute
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return absolute
    tail.unshift(basename(current))
    const parentReal = tryRealpath(parent)
    if (parentReal !== undefined) return join(parentReal, ...tail)
    current = parent
  }
}

/**
 * 判断 target 是否位于 root 之下（含相等）。
 *
 * @param target - 已归一化的目标路径。
 * @param root - 已归一化的根路径。
 * @returns 同名前缀的兄弟目录返回 false。
 */
export function underRoot(target, root) {
  if (typeof target !== 'string' || typeof root !== 'string') return false
  if (target.length === 0 || root.length === 0) return false
  if (target === root) return true
  const boundary = root.endsWith(sep) ? root : root + sep
  return target.startsWith(boundary)
}

/**
 * 把配置里的一串路径归一化成根列表：逐项 normalizePath、丢弃空白项、去重保序。
 *
 * @param paths - 配置里的绝对路径数组（可为空/非数组）。
 * @param cwd - 相对路径的解析基准（正常配置要求绝对路径，此参数只作兜底）。
 * @returns 归一化后的根列表。
 */
export function normalizeRoots(paths, cwd) {
  const list = Array.isArray(paths) ? paths : []
  const roots = []
  for (const item of list) {
    const normalized = normalizePath(item, cwd)
    if (normalized.length > 0 && !roots.includes(normalized)) roots.push(normalized)
  }
  return roots
}

/** 目标是否命中根列表中的任一根（词法前缀，含相等）。 */
function matchesAnyRoot(target, list) {
  return Array.isArray(list) && list.some((root) => underRoot(target, root))
}

/**
 * 判定目标落在哪一类，顺序固定：黑名单 → 白名单 → 项目内 → 临时区 → 项目外。
 * 「先命中者胜」是 spec §4.2 的硬约定：黑名单压过一切（含项目内与白名单）。
 *
 * @param target - 已归一化的目标路径。
 * @param roots - { project, whitelist, blacklist, temp }。
 * @returns 'blacklist' | 'whitelist' | 'project' | 'temp' | 'outside'。
 */
export function classifyPath(target, roots) {
  const r = roots ?? {}
  if (matchesAnyRoot(target, r.blacklist)) return 'blacklist'
  if (matchesAnyRoot(target, r.whitelist)) return 'whitelist'
  if (typeof r.project === 'string' && r.project.length > 0 && underRoot(target, r.project)) return 'project'
  if (matchesAnyRoot(target, r.temp)) return 'temp'
  return 'outside'
}

/**
 * 单目标决策：黑名单 ⇒ ask；项目外且写 ⇒ ask；其余 ⇒ allow。
 *
 * @param target - 已归一化的目标路径。
 * @param effect - 'read' | 'write'。
 * @param roots - 同 classifyPath。
 * @returns { kind: 'allow'|'ask', code?: ReasonCode, reason?: string }。
 */
export function decideTarget(target, effect, roots) {
  const kind = classifyPath(target, roots)
  if (kind === 'blacklist') {
    return { kind: 'ask', code: 'BLACKLIST', reason: `目标命中黑名单：${target}` }
  }
  if (kind === 'outside' && effect === 'write') {
    return { kind: 'ask', code: 'PROJECT_OUTSIDE_WRITE', reason: `项目外写入：${target}` }
  }
  return { kind: 'allow' }
}

/**
 * 多目标合成：最严者胜（任一 ask 则整体 ask）。
 *
 * @param decisions - decideTarget 的结果列表。
 * @returns { kind: 'allow'|'ask', codes: ReasonCode[] }（codes 去重保序，仅收 ask 的）。
 */
export function combine(decisions) {
  const list = Array.isArray(decisions) ? decisions : []
  const codes = []
  let ask = false
  for (const decision of list) {
    if (decision?.kind !== 'ask') continue
    ask = true
    if (decision.code !== undefined && !codes.includes(decision.code)) codes.push(decision.code)
  }
  return ask ? { kind: 'ask', codes } : { kind: 'allow', codes: [] }
}
