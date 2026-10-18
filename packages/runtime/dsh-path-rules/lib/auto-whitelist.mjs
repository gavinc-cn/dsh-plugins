// dsh-path-rules 的自动白名单（2026-10-18 新增）。
//
// 目的：用户批准过一次「沙箱升权写入」后，把该次写入目标折叠成的**目录**记进白名单，
// 之后同一目录的升权请求由插件自动答 allowed-once、不再反复弹框。
//
// 三层职责（全部可独立测试，index.mjs 只做接线）：
//   ① writableDirsOf      ：从一次工具调用（工具名 + 参数）推导写入目标 → 父目录；
//   ② filterAutoWhitelistDirs：安全护栏（黑名单/项目内/临时区/已覆盖/保护路径/敏感根）；
//   ③ loadAutoWhitelist / saveAutoWhitelist：按平台分区的 JSON 状态文件读写（原子写）。
//
// 重要边界：本模块只负责「学什么、记到哪」，**不改变**判定链本身的优先级
// （黑名单仍压过白名单；自动条目只是追加进 config.whitelist）。

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { analyzeCommand } from './analyze.mjs'
import { classifyTool } from './classify.mjs'
import { classifyPath, normalizePath, underRoot } from './rules.mjs'

/** 自动白名单条数上限（每个平台），超出淘汰最旧。 */
export const MAX_AUTO_ENTRIES = 200

/** 状态文件格式版本。 */
const STATE_VERSION = 1

/** POSIX 系统目录：既不允许自身也不允许它们的祖先目录被自动加入（更深目录可以）。 */
const POSIX_SENSITIVE_ROOTS = ['/', '/etc', '/usr', '/bin', '/sbin', '/boot', '/var', '/lib', '/lib64', '/opt', '/proc', '/sys', '/dev']

/** 展开 `~` / `~/` / `~\` 前缀；其它写法原样返回。 */
export function expandHome(path, home = homedir()) {
  if (typeof path !== 'string') return path
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/**
 * 目标路径 → 该自管目录：目标本身是已存在的目录就取它自己，否则取父目录。
 * （批准后写入目标往往还没创建，所以只能靠"是否已是目录"这一条证据；新目录取父目录是保守估计。）
 */
function directoryOf(target) {
  try {
    if (statSync(target).isDirectory()) return target
  } catch {
    /* 不存在/不可读 ⇒ 按"待创建的文件"处理 */
  }
  return dirname(target)
}

/** 把若干原始写目标归一化并折叠成 {target, dir} 对（去重、丢弃空路径）。 */
function toPairs(rawTargets, cwd) {
  const pairs = []
  const seen = new Set()
  for (const raw of Array.isArray(rawTargets) ? rawTargets : []) {
    const target = normalizePath(raw, cwd)
    if (target.length === 0) continue
    const dir = directoryOf(target)
    if (dir.length === 0) continue
    const key = `${target}\n${dir}`
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push({ target, dir })
  }
  return pairs
}

/**
 * 从一次工具调用推导"用户批准后要学的目录"。
 *
 * 只认写目标：read 不触发升权；shell 用静态分析结果，判不出就**不猜**（返回空）。
 * 工具/参数不可读时不抛（审批监听器里必须容忍任何异常）。
 *
 * @param toolName - 工具名（审批请求里的 request.toolName）。
 * @param args - 该次调用的参数（pre-execute 按 callId 记忆下来的那份）。
 * @param cwd - 相对路径解析基准（会话 cwd）。
 * @returns { pairs: Array<{target: string, dir: string}>, reason?: string }
 */
export function writableDirsOf(toolName, args, cwd) {
  let effect
  try {
    effect = classifyTool(toolName, args)
  } catch {
    return { pairs: [], reason: 'unreadable-args' }
  }
  if (effect.kind === 'write') return { pairs: toPairs(effect.targets, cwd) }
  if (effect.kind !== 'shell') return { pairs: [], reason: 'not-a-write' }
  const base = effect.workdir.length > 0 ? effect.workdir : cwd
  const analysis = analyzeCommand(effect.command, { shell: effect.shell, cwd: base })
  if (analysis.unanalyzable !== null) return { pairs: [], reason: 'unanalyzable' }
  return { pairs: toPairs(analysis.writes, base) }
}

/** 目录是否与受保护路径相关（自身、祖先或后代都算）——状态/日志文件与 DSH home 用它。 */
function isProtected(dir, protectedPaths) {
  return protectedPaths.some((path) => underRoot(path, dir) || underRoot(dir, path))
}

/** 目录是否等于某个敏感根、或是敏感根的祖先（更深层目录允许）。 */
function isSensitive(dir, sensitiveRoots) {
  return sensitiveRoots.some((root) => underRoot(root, dir))
}

/**
 * 过滤候选目录：只保留"值得且可以自动加入白名单"的那些。
 *
 * 跳过原因（写进审计日志用）：
 *   blacklist         目标或目录命中黑名单（黑名单优先级最高，加了也无效）
 *   no-need           目标在项目内 / 临时区（本来就直通，无需白名单）
 *   already-whitelisted 目录已被现有白名单覆盖
 *   protected         与插件状态/日志文件或 DSH home 相关（防"自动白名单自己改写自己"）
 *   sensitive         目录是系统根/用户 home 自身或其祖先（防止一次批准放大成整个系统/home）
 *
 * @param pairs - writableDirsOf 的输出。
 * @param options - { roots, protectedPaths, sensitiveRoots }。
 * @returns { accepted: string[], skipped: Array<{dir, target, reason}> }
 */
export function filterAutoWhitelistDirs(pairs, options = {}) {
  const roots = options.roots ?? {}
  const whitelist = Array.isArray(roots.whitelist) ? roots.whitelist : []
  const protectedPaths = (Array.isArray(options.protectedPaths) ? options.protectedPaths : [])
    .filter((path) => typeof path === 'string' && path.length > 0)
  const sensitive = (Array.isArray(options.sensitiveRoots) ? options.sensitiveRoots : [])
    .filter((path) => typeof path === 'string' && path.length > 0)
  const accepted = []
  const skipped = []
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const target = pair?.target
    const dir = pair?.dir
    if (typeof target !== 'string' || typeof dir !== 'string' || target.length === 0 || dir.length === 0) continue
    const classification = classifyPath(target, roots)
    if (classification === 'blacklist') {
      skipped.push({ dir, target, reason: 'blacklist' })
      continue
    }
    if (classification === 'project' || classification === 'temp') {
      skipped.push({ dir, target, reason: 'no-need' })
      continue
    }
    if (classifyPath(dir, roots) === 'blacklist') {
      skipped.push({ dir, target, reason: 'blacklist' })
      continue
    }
    if (whitelist.some((root) => underRoot(dir, root))) {
      skipped.push({ dir, target, reason: 'already-whitelisted' })
      continue
    }
    if (isProtected(dir, protectedPaths)) {
      skipped.push({ dir, target, reason: 'protected' })
      continue
    }
    if (isSensitive(dir, sensitive)) {
      skipped.push({ dir, target, reason: 'sensitive' })
      continue
    }
    if (!accepted.includes(dir)) accepted.push(dir)
  }
  return { accepted, skipped }
}

/** 读状态文件里的全部原始条目（其它平台的要原样保留；文件坏了就当没有）。 */
function readRawEntries(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(data?.entries) ? data.entries : []
  } catch {
    return []
  }
}

/**
 * 读取当前平台的自动白名单条目。
 *
 * 容错是硬要求：状态文件由用户手改/跨平台同步产生，坏了只记 error 日志、不能影响插件加载。
 *
 * @param file - 状态文件绝对路径。
 * @param platform - 当前平台（默认 process.platform）。
 * @returns { entries: Array<object>, error?: string }
 */
export function loadAutoWhitelist(file, platform = process.platform) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [], error: undefined }
    return { entries: [], error: `读取失败：${String(error)}` }
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    return { entries: [], error: `JSON 解析失败：${String(error)}` }
  }
  const entries = []
  const seen = new Set()
  for (const item of Array.isArray(data?.entries) ? data.entries : []) {
    if (item === null || typeof item !== 'object') continue
    const itemPlatform = item.platform === undefined ? platform : item.platform
    if (itemPlatform !== platform) continue
    const path = typeof item.path === 'string' ? item.path.trim() : ''
    // 相对路径（含跨平台同步过来的另一平台写法）一律忽略，且不写回原文件。
    if (path.length === 0 || !isAbsolute(path) || seen.has(path)) continue
    seen.add(path)
    entries.push({ ...item, path, platform })
  }
  return { entries, error: undefined }
}

/**
 * 原子写当前平台的自动白名单（保留其它平台条目，防容器/宿主双写互删）。
 *
 * @param file - 状态文件绝对路径。
 * @param platform - 当前平台。
 * @param entries - 当前平台的完整条目列表（调用方已按上限裁剪）。
 * @returns { ok: true } | { ok: false, error: string }
 */
export function saveAutoWhitelist(file, platform, entries) {
  const current = Array.isArray(entries) ? entries : []
  const others = readRawEntries(file).filter((item) => item?.platform !== undefined && item.platform !== platform)
  const payload = { version: STATE_VERSION, entries: [...others, ...current] }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/** Windows 敏感根：优先取环境变量（盘符可能不是 C:）。 */
function windowsSensitiveRoots() {
  const roots = []
  for (const key of ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim().length > 0) roots.push(value.trim())
  }
  roots.push('C:\\')
  return roots
}

/**
 * 敏感根列表：这些目录自身与其祖先不会被自动加入白名单，更深层目录可以。
 * 用途是防止"批准了一个文件"被放大成"整个系统目录/home"的长期信任。
 *
 * @param options - { platform, home }（测试可注入）。
 * @returns 归一化后的绝对路径列表。
 */
export function sensitiveRoots(options = {}) {
  const platform = options.platform ?? process.platform
  const home = typeof options.home === 'string' && options.home.length > 0 ? options.home : homedir()
  const raw = platform === 'win32' ? [...windowsSensitiveRoots(), home] : [...POSIX_SENSITIVE_ROOTS, home]
  const roots = []
  for (const path of raw) {
    const normalized = normalizePath(path, home)
    if (normalized.length > 0 && !roots.includes(normalized)) roots.push(normalized)
  }
  return roots
}
