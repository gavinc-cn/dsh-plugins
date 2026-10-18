// dsh-path-rules：DSH 原生「路径规则」权限模式的逐调用闸门。
//
// 本文件只做接线与判定编排，规则细节都在三个纯函数单元里：
//   rules.mjs    路径语义（归一化 / 黑名单优先的分类 / 多目标合成）
//   classify.mjs 工具 → 读写意图
//   analyze.mjs  bash / pwsh 词法分析 → 读写目标
//
// 判定链（spec §4.2）：
//   ① enabled=false / 服务缺失 / 无 agent ⇒ pass（透传，不介入）
//   ② 模式未激活（预设身份不是 activationPreset，且父链上也找不到）⇒ pass
//   ③ 工具分派：pass ⇒ pass；read/write ⇒ 逐目标判定；shell ⇒ 先静态分析
//   ④ 合成：多目标最严者胜（任一 ask 则 ask）
//   ⑤ unanalyzable ⇒ 按 unanalyzable 策略：deny（默认，带改写指引）或 ask
//   ⑥ 审批通道检查：子代理 / 会话 approval 为 never ⇒ 就地把 ask 改写成 deny
//   （⑦ 与下游合成、⑧ failMode 兜底在 apply() 里做，见 Task 8）

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { analyzeCommand } from './analyze.mjs'
import {
  MAX_AUTO_ENTRIES,
  expandHome,
  filterAutoWhitelistDirs,
  loadAutoWhitelist,
  saveAutoWhitelist,
  sensitiveRoots,
  writableDirsOf,
} from './auto-whitelist.mjs'
import { classifyTool } from './classify.mjs'
import { combine, classifyPath, decideTarget, normalizePath, normalizeRoots, underRoot } from './rules.mjs'

export const name = 'dsh-path-rules'

/** 默认审计日志（与既有守卫同目录）。 */
const DEFAULT_LOG = join(homedir(), '.kimi-code', 'hooks', 'logs', 'path_rules.dsh.log')

/** 父链上溯的最大层数（防环 + 防病态深链）。 */
const MAX_PARENT_HOPS = 8

/** 允许的 unanalyzable 策略。 */
const UNANALYZABLE_POLICIES = new Set(['deny', 'ask'])

/** 允许的 failMode。 */
const FAIL_MODES = new Set(['closed', 'open'])

/** 校验一串"必须是绝对路径"的配置项。 */
function absolutePathList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`dsh-path-rules: ${field} must be an array of absolute paths`)
  for (const item of value) {
    if (typeof item !== 'string' || !isAbsolute(item)) {
      throw new Error(`dsh-path-rules: ${field} entries must be absolute paths, got ${JSON.stringify(item)}`)
    }
  }
  return value
}

/**
 * 归一化插件配置（只做校验与默认值，不做 realpath —— realpath 由 apply() 在加载时做一次）。
 *
 * @param raw - profile 覆盖行给的 config（可为空）。
 * @returns 完整的 Config；非法配置直接抛错（拒绝加载，不改变现状行为）。
 */
export function normalizeConfig(raw) {
  const c = raw ?? {}
  if (c.unanalyzable !== undefined && !UNANALYZABLE_POLICIES.has(c.unanalyzable)) {
    throw new Error(`dsh-path-rules: unanalyzable must be "deny" or "ask", got ${JSON.stringify(c.unanalyzable)}`)
  }
  if (c.failMode !== undefined && !FAIL_MODES.has(c.failMode)) {
    throw new Error(`dsh-path-rules: failMode must be "closed" or "open", got ${JSON.stringify(c.failMode)}`)
  }
  if (c.autoWhitelistFile !== undefined && (typeof c.autoWhitelistFile !== 'string' || c.autoWhitelistFile.trim().length === 0)) {
    throw new Error('dsh-path-rules: autoWhitelistFile must be a non-empty string')
  }
  const activationPreset = c.activationPreset === undefined ? 'path-rules' : c.activationPreset
  if (typeof activationPreset !== 'string' || activationPreset.trim().length === 0) {
    throw new Error('dsh-path-rules: activationPreset must be a non-empty string')
  }
  return {
    enabled: c.enabled !== false,
    activationPreset: activationPreset.trim(),
    whitelist: absolutePathList(c.whitelist, 'whitelist'),
    blacklist: absolutePathList(c.blacklist, 'blacklist'),
    allowTempRoots: c.allowTempRoots !== false,
    unanalyzable: c.unanalyzable ?? 'deny',
    failMode: c.failMode ?? 'closed',
    dryRun: c.dryRun === true,
    modelFallback: c.modelFallback === true,
    autoWhitelist: c.autoWhitelist === true,
    autoWhitelistFile: typeof c.autoWhitelistFile === 'string' ? c.autoWhitelistFile.trim() : '',
    logPath: typeof c.logPath === 'string' && c.logPath.trim().length > 0 ? c.logPath.trim() : DEFAULT_LOG,
  }
}

/** 取调用所属会话。 */
function sessionOf(exec) {
  return exec?.agent?.session
}

/** 子代理会话判定（框架只把它们标在 header 上）。 */
function isSubagentSession(session) {
  const header = session?.header ?? {}
  return header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

/** 该会话是否有审批通道：子代理恒无（框架把它们的 approval 钉成 never）。 */
function hasNoApprovalChannel(session, services) {
  if (isSubagentSession(session)) return true
  return services.approvalOverrideOf?.(session) === 'never'
}

/**
 * 模式是否激活：本会话的预设身份命中 activationPreset；
 * 否则若是子代理，沿 header.parentSession 上溯（≤ MAX_PARENT_HOPS 层、带环检测）。
 */
function isActive(session, config, services) {
  if (services.presetOf(session) === config.activationPreset) return true
  if (!isSubagentSession(session)) return false
  const visited = new Set([session])
  let current = session
  for (let hops = 0; hops < MAX_PARENT_HOPS; hops += 1) {
    const parentId = current?.header?.parentSession
    if (typeof parentId !== 'string' || parentId.length === 0) return false
    const parent = services.getSession?.(parentId)
    if (parent === undefined || parent === null || visited.has(parent)) return false
    visited.add(parent)
    if (services.presetOf(parent) === config.activationPreset) return true
    current = parent
  }
  return false
}

/** 组装判定用的根集合（project 取沙箱口径的 workspaceRoot）。 */
function buildRoots(session, config, services) {
  const project = services.workspaceRootOf(session)
  const normalizedProject = typeof project === 'string' && project.length > 0 ? normalizePath(project, project) : null
  const temp = config.allowTempRoots
    ? [...new Set([normalizePath('/tmp', normalizedProject ?? '/'), normalizePath(tmpdir(), normalizedProject ?? '/')])]
    : []
  return {
    project: normalizedProject,
    whitelist: config.whitelist,
    blacklist: config.blacklist,
    temp: temp.filter((path) => path.length > 0),
  }
}

/** 沙箱升权请求的 reason 前缀（框架固定格式）。 */
const SANDBOX_ESCALATION_PREFIX = 'escalate sandbox to '

/**
 * 目标是否落在沙箱可写根内（会话工作区 / 临时区）。
 * 这是"谁负责审批"的分界线（spec §4.4）：根内的黑名单写只有插件能拦；根外的写由沙箱升权审批。
 */
function insideWritableRoots(target, roots) {
  if (typeof roots.project === 'string' && roots.project.length > 0 && underRoot(target, roots.project)) return true
  return roots.temp.some((root) => underRoot(target, root))
}

/**
 * 单目标的分层判定：`allow` / `ask` / `delegate`（委派给沙箱升权审批）。
 *  - 黑名单读 ⇒ ask（沙箱从不拦读，这是唯一防线）；
 *  - 黑名单写 ⇒ 沙箱可写根内 ask，根外 delegate（沙箱会拦并弹审批）；
 *  - 项目外读 ⇒ allow；项目外写 ⇒ delegate；
 *  - 白名单/项目内/临时区 ⇒ allow。
 */
function decideLayered(target, effect, roots) {
  const kind = classifyPath(target, roots)
  if (kind === 'blacklist') {
    if (effect === 'write' && !insideWritableRoots(target, roots)) return { kind: 'delegate' }
    return { kind: 'ask', code: 'BLACKLIST', reason: `目标命中黑名单：${target}` }
  }
  if (kind === 'outside') return effect === 'write' ? { kind: 'delegate' } : { kind: 'allow' }
  return { kind: 'allow' }
}

/** 从会话日志按 callId 找该次工具调用的目标（用于升权请求的白名单自动放行）。 */
function escalationTargetOf(session, callId) {
  const events = session?.events
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event || event.type !== 'tool/call' || event.data?.callId !== callId) continue
    let args
    try {
      args = JSON.parse(event.data.arguments)
    } catch {
      return undefined
    }
    if (args === null || typeof args !== 'object') return undefined
    for (const key of ['file_path', 'path']) {
      if (typeof args[key] === 'string' && args[key].length > 0) return { kind: 'file', value: args[key] }
    }
    const toolName = String(event.data.name ?? '')
    if ((toolName === 'bash' || toolName === 'pwsh') && typeof args.command === 'string') {
      return { kind: 'command', value: args.command }
    }
    return undefined
  }
  return undefined
}

/** 从一次工具调用的参数里提取升权目标（与 escalationTargetOf 的提取规则一致）。 */
function escalationTargetFromArgs(args) {
  if (args === null || typeof args !== 'object') return undefined
  for (const key of ['file_path', 'path']) {
    if (typeof args[key] === 'string' && args[key].length > 0) return { kind: 'file', value: args[key] }
  }
  if (typeof args.command === 'string') return { kind: 'command', value: args.command }
  return undefined
}

/**
 * 命令类升权请求是否允许自动放行（2026-10-18 严格化）。
 *
 * 旧口径只看"命令文本里是否出现白名单路径"，`cp /white/f.txt /elsewhere/f.txt` 也会被静默批准
 * （自动白名单让白名单动态变化后风险更大）。这里改为按静态分析出的**写目标**判定：
 *
 * @returns true      = 全部写目标都在白名单/项目内/临时区，且至少一个命中白名单 ⇒ 可自动放行；
 *          false     = 存在黑名单或项目外写目标 ⇒ 必须交给用户；
 *          undefined = 判不出（参数缺失/不可解析/没有写目标）⇒ 退回旧的子串口径兜底。
 */
function commandEscalationIsWhitelisted(config, session, services, toolName, args) {
  if (args === undefined) return undefined
  const cwd = sessionCwdOf(session, services)
  const derived = writableDirsOf(toolName, args, cwd)
  if (derived.pairs.length === 0) return undefined
  const roots = buildRoots(session, config, services)
  let sawWhitelist = false
  for (const pair of derived.pairs) {
    const kind = classifyPath(pair.target, roots)
    if (kind === 'blacklist' || kind === 'outside') return false
    if (kind === 'whitelist') sawWhitelist = true
  }
  return sawWhitelist ? true : undefined
}

/**
 * 升权请求的目标是否命中白名单（文件按 realpath 后前缀；命令优先按静态写目标严格判定，
 * 判不出时再用粗粒度子串兜底）。
 */
function escalationIsWhitelisted(target, config, session, commandCheck) {
  if (config.whitelist.length === 0) return false
  if (target.kind === 'file') {
    const resolved = normalizePath(target.value, session?.header?.cwd ?? process.cwd())
    return config.whitelist.some((root) => underRoot(resolved, root))
  }
  const strict = typeof commandCheck === 'function' ? commandCheck() : undefined
  if (strict !== undefined) return strict
  return config.whitelist.some((root) => target.value.includes(root))
}

/** 统一的透传结果。 */
function pass() {
  return { kind: 'pass' }
}

/** 会话工作目录：header.cwd 优先，其次沙箱工作区根，最后进程 cwd。 */
function sessionCwdOf(session, services) {
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim().length > 0) return cwd.trim()
  const workspaceRoot = services.workspaceRootOf(session)
  if (typeof workspaceRoot === 'string' && workspaceRoot.length > 0) return workspaceRoot
  return process.cwd()
}

/**
 * 判定一次工具调用（纯判定：不写日志、不触 IO、不改状态）。
 *
 * @param exec - tools/pre-execute 的 exec（用 name / arguments / agent.session）。
 * @param config - normalizeConfig 的结果（白/黑名单应已 realpath 过）。
 * @param services - `{ presetOf, workspaceRootOf, approvalOverrideOf, getSession }` 适配层。
 * @returns Decision：`{ kind: 'pass'|'allow'|'ask'|'deny', code?, reason?, displayReason? }`。
 */
export function decideCall(exec, config, services) {
  const svc = services ?? {}
  if (!config.enabled) return pass()
  const session = sessionOf(exec)
  if (session === undefined || session === null) return pass()
  if (typeof svc.presetOf !== 'function' || typeof svc.workspaceRootOf !== 'function') return pass()
  if (!isActive(session, config, svc)) return pass()

  const sessionCwd = sessionCwdOf(session, svc)
  const effect = classifyTool(exec.name, exec.arguments)
  if (effect.kind === 'pass') return pass()
  const roots = buildRoots(session, config, svc)

  let decisions = []
  let unanalyzable = null
  if (effect.kind === 'read' || effect.kind === 'write') {
    const targets = effect.targets.length > 0 ? effect.targets : [sessionCwd]
    decisions = targets.map((target) => decideLayered(normalizePath(target, sessionCwd), effect.kind, roots))
  } else {
    const cwd = effect.workdir.length > 0 ? effect.workdir : sessionCwd
    const analysis = analyzeCommand(effect.command, { shell: effect.shell, cwd })
    unanalyzable = analysis.unanalyzable
    if (unanalyzable === null) {
      decisions = [
        ...analysis.reads.map((target) => decideLayered(normalizePath(target, cwd), 'read', roots)),
        ...analysis.writes.map((target) => decideLayered(normalizePath(target, cwd), 'write', roots)),
      ]
    }
  }

  let decision
  if (unanalyzable !== null) {
    const guidance = '；请改写成可静态判定的形式（显式绝对路径、限定的写目标，或拆分命令）'
    decision = config.unanalyzable === 'ask'
      ? { kind: 'ask', code: 'UNANALYZABLE', reason: `无法静态判定该命令的读写目标（${unanalyzable.reason}）${guidance}` }
      : { kind: 'deny', code: 'UNANALYZABLE', reason: `无法静态判定该命令的读写目标（${unanalyzable.reason}），已拒绝${guidance}` }
  } else {
    // 任一 ask 优先（需要用户批准）；否则只要有一个目标要"交沙箱审批"就整体透传（沙箱会拦、会弹框）；
    // 全部 allow 才由我们直接放行。
    const firstAsk = decisions.find((item) => item.kind === 'ask')
    if (firstAsk !== undefined) {
      decision = { kind: 'ask', code: firstAsk.code, reason: firstAsk.reason }
    } else if (decisions.some((item) => item.kind === 'delegate')) {
      return pass()
    } else {
      return { kind: 'allow' }
    }
  }

  if (decision.kind === 'ask' && hasNoApprovalChannel(session, svc)) {
    return {
      kind: 'deny',
      code: 'NO_APPROVAL_CHANNEL',
      reason: `${decision.reason ?? '该操作需要审批'}；但当前会话没有审批通道（子代理的 approval 被框架钉成 never），请到主会话执行，或改写成项目内/白名单内的目标`,
    }
  }
  return {
    kind: decision.kind,
    code: decision.code,
    reason: decision.reason,
    displayReason: `路径规则：${decision.reason ?? '需要审批'}`,
  }
}

// ─────────────────────────── Cordis 接线 ───────────────────────────

/** 追加一行审计日志；日志不可写时静默（不影响主流程）。 */
function logLine(logPath, event, summary, detail) {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    const stamp = new Date().toISOString().slice(0, 19)
    appendFileSync(logPath, `${stamp} | ${event} | ${String(summary ?? '')} | ${String(detail ?? '')}\n`, 'utf8')
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/**
 * 解析 DSH home：优先用宿主提供的 `dshHomePath` 服务（尊重 `DSH_HOME`），
 * 缺失时按 `$DSH_HOME` → `~/.dsh` 回退。用于定位自动白名单状态文件与保护路径。
 */
function resolveDshHome(ctx) {
  const homePath = ctx.get?.('dshHomePath')
  if (typeof homePath === 'function') {
    try {
      const home = homePath()
      if (typeof home === 'string' && home.length > 0) return home
    } catch {
      /* 服务不可用时走环境变量回退 */
    }
  }
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/**
 * 自动白名单状态文件路径：配置优先（支持 `~`），否则放在 `<dsh home>/path-rules/auto-whitelist.json`。
 * 按平台分区写在文件内部（见 auto-whitelist.mjs），所以容器与宿主同步同一份文件也不会串味。
 */
function resolveAutoWhitelistFile(config, ctx) {
  if (config.autoWhitelistFile.length > 0) {
    return normalizePath(expandHome(config.autoWhitelistFile, homedir()), process.cwd())
  }
  return normalizePath(join(resolveDshHome(ctx), 'path-rules', 'auto-whitelist.json'), process.cwd())
}

/** 给模型看的规则说明；**只有本会话真的受该模式管辖时才注入**（否则模型会误判自己的权限档）。 */
function renderRules(config, session, services, extras = {}) {
  if (session === undefined || session === null) return ''
  if (typeof services.presetOf !== 'function') return ''
  try {
    if (!isActive(session, config, services)) return ''
  } catch {
    return ''
  }
  const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
  const declaredWhitelist = Array.isArray(extras.declaredWhitelist) ? extras.declaredWhitelist : config.whitelist
  const autoEntries = Array.isArray(extras.autoEntries) ? extras.autoEntries : []
  const lines = [
    '[path-rules] 当前权限模式：路径规则。',
    `会话工作区（可自由读写）：${cwd.length > 0 ? cwd : '(未知)'}`,
    '工作区外：读取允许；写入需要用户审批（会弹工具审批框）。',
  ]
  if (declaredWhitelist.length > 0) lines.push(`白名单（可自由读写）：${declaredWhitelist.join(', ')}`)
  if (autoEntries.length > 0) {
    lines.push(`自动白名单（用户批准后自动学习，升权请求会被自动放行、不弹框）：${autoEntries.map((entry) => entry.path).join(', ')}`)
  }
  if (config.blacklist.length > 0) lines.push(`黑名单（读写都需要审批）：${config.blacklist.join(', ')}`)
  lines.push('bash/pwsh：只读命令直接放行；写命令请写成可静态判定的形式（显式路径），判不出的命令会被拒绝。')
  lines.push('工作区外写入若先被沙箱拒绝：用 sandbox_permissions（能覆盖该目标的最窄更宽模式）+ justification 重试同一调用，用户审批后即可写入；白名单与自动白名单内的目标会自动放行。')
  return lines.join('\n')
}

/** 日志里的调用摘要（arguments 不可读时不抛）。 */
function describeCall(exec) {
  const toolName = String(exec?.name ?? '?')
  try {
    const args = exec?.arguments
    const text = typeof args === 'object' && args !== null ? JSON.stringify(args) : String(args ?? '')
    return `${toolName} ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`
  } catch {
    return `${toolName} (arguments 不可读)`
  }
}

/** 按"更严者胜"合成下游结论与我方判定（spec §4.2 ⑦ / D7）。 */
function compose(downstream, decision, config, log, exec) {
  const kind = downstream?.kind ?? 'allow'
  if (kind === 'deny' || kind === 'cancel') {
    log('pass', `downstream:${kind}`, describeCall(exec))
    return downstream
  }
  if (config.dryRun) {
    log('dry-run', `${decision.kind}${decision.code === undefined ? '' : `:${decision.code}`}`, describeCall(exec))
    return downstream
  }
  if (decision.kind === 'ask') {
    log('ask', `${decision.code ?? ''} ${decision.reason ?? ''}`.trim(), describeCall(exec))
    return { kind: 'ask', reason: decision.reason, displayReason: decision.displayReason }
  }
  if (decision.kind === 'deny') {
    log('deny', `${decision.code ?? ''} ${decision.reason ?? ''}`.trim(), describeCall(exec))
    return { kind: 'deny', reason: decision.reason }
  }
  if (decision.kind === 'allow') {
    log('allow', 'path-rules', describeCall(exec))
    return downstream
  }
  return downstream
}

/**
 * 插件入口：注册 pre-execute 钩子与规则说明注入。
 *
 * 所需服务一律用 ctx.get 取，缺失时按"未激活"退化 —— 不因缺服务让插件加载失败，
 * 也不改变现状行为（spec §4.2 ①、§5.4）。
 */
export function apply(ctx, rawConfig) {
  const base = normalizeConfig(rawConfig)
  const declaredWhitelist = normalizeRoots(base.whitelist, process.cwd())
  const config = {
    ...base,
    whitelist: [...declaredWhitelist],
    blacklist: normalizeRoots(base.blacklist, process.cwd()),
  }
  const log = (event, summary, detail) => logLine(config.logPath, event, summary, detail)
  log('plugin-loaded', `enabled=${config.enabled} autoWhitelist=${config.autoWhitelist}`, `activationPreset=${config.activationPreset} dryRun=${config.dryRun}`)
  if (config.modelFallback) {
    log('error', 'warn:model-fallback-ignored', 'modelFallback 本期不改变判定行为（模型裁决路径需另立 spec）')
  }

  // 自动白名单的状态文件与保护路径（只在开关打开时才读盘；关闭时零 IO、零行为变化）。
  const autoWhitelistFile = resolveAutoWhitelistFile(config, ctx)
  const dshHome = resolveDshHome(ctx)
  const protectedPaths = [...new Set([autoWhitelistFile, config.logPath, dshHome])]
  /** 当前进程内的自动白名单条目（与 config.whitelist 同步追加；持久化只写本平台分区）。 */
  const autoEntries = []
  if (config.autoWhitelist) {
    const loaded = loadAutoWhitelist(autoWhitelistFile, process.platform)
    if (loaded.error !== undefined) log('error', 'auto-whitelist-load', loaded.error)
    for (const entry of loaded.entries) {
      const normalized = normalizePath(entry.path, process.cwd())
      if (normalized.length === 0 || autoEntries.some((item) => item.path === normalized)) continue
      autoEntries.push({ ...entry, path: normalized })
      if (!config.whitelist.includes(normalized)) config.whitelist.push(normalized)
    }
    if (autoEntries.length > 0) log('auto-whitelist', `loaded=${autoEntries.length}`, autoWhitelistFile)
  }

  const services = {
    presetOf: (session) => ctx.get('permissionPresets')?.current?.(session),
    workspaceRootOf: (session) => ctx.get('sandboxPolicy')?.resolve?.({ session })?.workspaceRoot,
    approvalOverrideOf: (session) => ctx.get('approval')?.overrideOf?.(session),
    getSession: (id) => ctx.get('sessions')?.get?.(id),
  }

  // 按 callId 记住最近一次工具调用的参数：真实运行态里审批请求附带的对象不暴露 session.events，
  // 无法按 callId 回查会话日志（探针实测 hasEvents=false），所以白名单升权自动放行要依赖这份记忆。
  const recentCallArgs = new Map()
  const REMEMBERED_CALLS_MAX = 200
  const rememberCall = (exec) => {
    try {
      if (typeof exec?.callId !== 'string') return
      recentCallArgs.set(exec.callId, exec.arguments)
      if (recentCallArgs.size > REMEMBERED_CALLS_MAX) {
        recentCallArgs.delete(recentCallArgs.keys().next().value)
      }
    } catch {
      /* 参数不可读时不记（不影响判定） */
    }
  }

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'path-rules',
      order: 111,
      text: (context) => renderRules(config, context?.agent?.session, services, { declaredWhitelist, autoEntries }),
    })
  })

  /**
   * 把一次"用户批准的沙箱升权调用"学进自动白名单。
   *
   * 只在 path-rules 档激活的会话里学（其它档不改变任何状态）；任何异常都吞掉并记日志 ——
   * 它只是顺手降低重复弹框，绝不能影响审批结果本身。
   */
  const learnFromApproval = (request) => {
    const session = request.agent?.session
    if (session === undefined || session === null) return
    if (!isActive(session, config, services)) return
    const args = recentCallArgs.get(request.callId)
    if (args === undefined) {
      log('auto-whitelist-skip', 'no-remembered-args', request.callId)
      return
    }
    const cwd = sessionCwdOf(session, services)
    const derived = writableDirsOf(request.toolName, args, cwd)
    if (derived.pairs.length === 0) {
      log('auto-whitelist-skip', derived.reason ?? 'no-write-target', request.callId)
      return
    }
    const roots = buildRoots(session, config, services)
    const { accepted, skipped } = filterAutoWhitelistDirs(derived.pairs, {
      roots,
      protectedPaths,
      sensitiveRoots: sensitiveRoots(),
    })
    for (const item of skipped) log('auto-whitelist-skip', `${item.reason} ${item.dir}`, describeCall({ name: request.toolName, arguments: args }))
    if (accepted.length === 0) return

    const added = []
    for (const dir of accepted) {
      if (autoEntries.some((entry) => entry.path === dir)) continue
      autoEntries.push({
        path: dir,
        platform: process.platform,
        addedAt: new Date().toISOString(),
        tool: String(request.toolName ?? ''),
        callId: request.callId,
      })
      if (!config.whitelist.includes(dir)) config.whitelist.push(dir)
      added.push(dir)
    }
    // 上限按"最旧淘汰"：自动白名单只是便利，不能无限膨胀。
    while (autoEntries.length > MAX_AUTO_ENTRIES) {
      const dropped = autoEntries.shift()
      const index = config.whitelist.indexOf(dropped.path)
      if (index >= 0) config.whitelist.splice(index, 1)
    }
    if (added.length === 0) return
    const saved = saveAutoWhitelist(autoWhitelistFile, process.platform, autoEntries)
    if (!saved.ok) log('error', 'auto-whitelist-save', saved.error)
    log('auto-whitelist', `added=${added.length}`, added.join(', '))
  }

  // 白名单目标的沙箱升权请求自动放行（承接已退役的 sandbox-path-allowlist 能力）：
  // 只作答 "escalate sandbox to " 开头的请求，且目标必须命中白名单；其余一律交给下游弹框。
  // autoWhitelist 打开时再包一层：等用户的结论，只有 allowed-once（用户点了同意）才学习。
  ctx.on('approval/request', (request, next) => {
    if (typeof request?.callId !== 'string') return next()
    if (typeof request.reason !== 'string' || !request.reason.startsWith(SANDBOX_ESCALATION_PREFIX)) return next()

    let target
    try {
      const remembered = recentCallArgs.get(request.callId)
      const session = request.agent?.session
      // remembered 优先：真实运行态里审批请求附带的 session 不暴露 events，无法按 callId 回查
      // 会话日志（实测 hasEvents=false），只有 pre-execute 时记下的参数可靠。
      target = escalationTargetFromArgs(remembered) ?? escalationTargetOf(session, request.callId)
      const commandCheck = () => commandEscalationIsWhitelisted(config, session, services, request.toolName, remembered)
      if (target !== undefined && escalationIsWhitelisted(target, config, session, commandCheck)) {
        // remembered 只进审计日志，便于区分"走记忆命中"与"走会话日志兜底命中"
        log('allow', 'whitelist-escalation', `${request.callId} remembered=${remembered !== undefined} ${target.value}`)
        return 'allowed-once'
      }
    } catch (error) {
      log('error', 'approval-error', String(error))
      return next()
    }
    if (target === undefined || !config.autoWhitelist || !config.enabled || config.dryRun) return next()
    return Promise.resolve(next()).then((outcome) => {
      if (outcome === 'allowed-once') {
        try {
          learnFromApproval(request)
        } catch (error) {
          log('error', 'auto-whitelist-error', String(error))
        }
      }
      return outcome
    })
  }, { prepend: true })

  ctx.on('tools/pre-execute', async (exec, next) => {
    rememberCall(exec)
    // 先取下游结论：既满足 waterfall"调用 next 才不否决整条链"的语义，又能做"更严者胜"合成
    let downstream
    try {
      downstream = await next()
    } catch (error) {
      // 下游监听器自身抛错：记录后原样抛给框架，不在这里替它做决定
      log('error', 'downstream-error', String(error))
      throw error
    }
    let decision
    try {
      decision = decideCall(exec, config, services)
    } catch (error) {
      log('error', 'gate-error', `${String(error)} | ${describeCall(exec)}`)
      if (config.failMode === 'closed') {
        return {
          kind: 'deny',
          reason: `路径规则闸门内部错误（fail-closed）：${String(error)}；可切换权限档或停用本插件后重试`,
        }
      }
      return downstream
    }
    return compose(downstream, decision, config, log, exec)
  })
}
