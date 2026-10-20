// dsh-write-guard 插件接线（apply）：把「完全权限（拦截）」档的判定链挂进 DSH 的
// tools/pre-execute、approval/request 与 systemPrompt 三个接缝。
//
// 职责与接线顺序（spec §4.2/§4.4/§4.5/§5.5/§5.6）：
//   ① 加载期：normalizeConfig → normalizeRoots(whitelist) → 读自动白名单并入内存白名单
//      → 记 plugin-loaded；同时算出状态文件与保护路径（DSH home / 状态文件 / 日志）；
//   ② tools/pre-execute：先 await next() 取下游结论（不否决整条链）；非激活 / 无会话 /
//      无工作区 → 透传；否则 decideCall（shell 判不出时注入 judge 回调）→ 无审批通道时把
//      ask **变换**成 deny（含 failMode 错误路径）→ 统一 compose 合成（下游 deny/cancel
//      永不弱化、dryRun 只记日志、failMode 兜底）→ 按「最终合成结论」维护 pendingLearn；
//   ③ approval/request（prepend）：只处理 reason 以 `[write-guard] ` 开头的本插件请求；
//      await next() 拿到 allowed-once 才触发 learn()，rejected/cancelled 不学习；
//   ④ systemPrompt：注册 order=112 的上下文条目，仅激活会话注入规则说明；
//   ⑤ 所有宿主服务一律 `ctx.get(...)` 懒取：服务缺失 = 未激活（退化成完全权限现状）。
//
// 边界：
//   - 判定细节在 decide.mjs / judge.mjs / whitelist.mjs，本文件只做接线与状态编排；
//   - 子代理没有审批通道（框架把 approval 钉成 never），越界写一律 deny（spec D8）；
//   - 任何插件内部异常都按 failMode（ask 默认 / deny / open）兜底并记 gate-error，
//     绝不把异常抛给宿主框架；下游监听器自身的异常只记日志后原样重抛；
//   - 自动学习只在插件激活且非 dryRun 时发生，持久化失败（saved:false）时**不**更新内存，
//     避免"磁盘没记住、内存却放行"。

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { sensitiveRoots } from '@gavinc-cn/dsh-path-rules/auto-whitelist'
import { normalizePath, normalizeRoots } from '@gavinc-cn/dsh-path-rules/rules'

import { normalizeConfig } from './config.mjs'
import { decideCall, tempRoots } from './decide.mjs'
import { JudgeCache, buildJudgeInput, judgeCacheKey, judgeCommand } from './judge.mjs'
import {
  deriveLearnDirs,
  filterLearnDirs,
  loadAutoWhitelistPaths,
  persistAutoWhitelist,
  resolveAutoWhitelistFile,
  resolveDshHome,
} from './whitelist.mjs'

/** 插件显示名（与 package.json / bundle 行 id 一致）。 */
export const name = 'dsh-write-guard'

/** 本插件审批理由的固定标记：只有以此开头的 approval/request 才归我们处理（spec §5.5）。 */
export const REASON_PREFIX = '[write-guard] '

/** 子代理父链上溯的最大层数（防环 + 防病态深链，spec §4.2）。 */
const MAX_PARENT_HOPS = 8

/** pendingLearn 的容量上限，超出按 FIFO 淘汰最旧（spec §5.5）。 */
const MAX_PENDING_LEARN = 200

/** 无审批通道时的固定拒绝理由（spec D8；子代理与 approval=never 共用）。 */
const NO_APPROVAL_CHANNEL_REASON = `${REASON_PREFIX}当前会话没有审批通道（子代理 / approval=never），越界写入被拒绝；请回主会话执行，或在主会话中处理。`

/**
 * 把任意抛出的值渲染成短文本（日志/审批文案用），避免把整个对象打出来。
 *
 * @param error - 任意抛出的值。
 * @returns {string} 非空文本。
 */
function errorText(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) {
    return error.message
  }
  if (typeof error === 'string' && error.length > 0) return error
  try {
    return String(error)
  } catch {
    return '未知错误'
  }
}

/**
 * 生成一次工具调用的日志摘要（命令截断到 120 字符，避免日志膨胀，spec §5.7）。
 *
 * `exec.arguments` 可能是抛错 getter 或不可序列化对象，本函数保证不抛。
 *
 * @param exec - tools/pre-execute 的 exec（只读 name/arguments）。
 * @returns {string} 形如 `write {"file_path":"/x"}`。
 */
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

/**
 * 把日志字段压成单行：模型/命令可控的换行不能伪造出新的审计行（review finding 6）。
 *
 * @param value - 任意字段值（null/undefined 渲染成空串）。
 * @returns {string} 不含 `\n` / `\r\n` 的文本。
 */
function logField(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ')
}

/**
 * 追加一行审计日志：`<ISO> | <event> | <summary> | <detail>\n`。
 *
 * 日志目录不存在时递归创建；任何写失败都静默吞掉——日志不能影响判定/审批主流程。
 * 所有字段先经 `logField` 单行化，防止模型理由/命令文本里的换行注入伪造日志行。
 *
 * @param logPath - 日志文件路径（可为相对路径）。
 * @param event - 事件名（plugin-loaded/allow/ask/...）。
 * @param summary - 一行摘要。
 * @param detail - 细节（命令、路径、错误等）。
 */
function appendLog(logPath, event, summary, detail) {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    const line = `${new Date().toISOString()} | ${logField(event)} | ${logField(summary)} | ${logField(detail)}\n`
    appendFileSync(logPath, line, 'utf8')
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/**
 * 子代理会话判定（框架只把身份标在 header 上，spec §2.4）。
 *
 * @param session - 会话对象。
 * @returns {boolean}
 */
function isSubagentSession(session) {
  const header = session?.header ?? {}
  return (
    header.origin === 'subagent' ||
    (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
  )
}

/**
 * 本插件是否在该会话生效（spec §4.2）：
 *   ① `enabled === false` 一律不生效；
 *   ② 本会话预设身份命中 `activationPreset` ⇒ 生效；
 *   ③ 子代理不继承该身份，沿 `header.parentSession` 上溯（≤8 层、带环检测）命中任一祖先 ⇒ 生效；
 *   ④ 其余一律不生效（透传，插件完全不介入）。
 *
 * @param session - 会话对象（可为 null）。
 * @param config - normalizeConfig 的结果（只读 enabled/activationPreset）。
 * @param services - `{presetOf, getSession}` 适配层（可缺省）。
 * @returns {boolean}
 */
export function isActive(session, config, services) {
  if (config?.enabled === false) return false
  if (session === undefined || session === null) return false
  const svc = services ?? {}
  if (typeof svc.presetOf === 'function' && svc.presetOf(session) === config?.activationPreset) {
    return true
  }
  if (!isSubagentSession(session)) return false

  // 环检测：visited 里既有会话对象本身，也包含已上溯过的祖先（对象引用去重）。
  const visited = new Set([session])
  let current = session
  for (let hops = 0; hops < MAX_PARENT_HOPS; hops += 1) {
    const parentId = current?.header?.parentSession
    if (typeof parentId !== 'string' || parentId.length === 0) return false
    const parent = typeof svc.getSession === 'function' ? svc.getSession(parentId) : undefined
    if (parent === undefined || parent === null || visited.has(parent)) return false
    visited.add(parent)
    if (typeof svc.presetOf === 'function' && svc.presetOf(parent) === config?.activationPreset) {
      return true
    }
    current = parent
  }
  return false
}

/**
 * 该会话是否**没有**审批通道（spec D8）：
 *   - 子代理：框架把 approval 钉成 never，ask 会被静默拒绝；
 *   - 主会话：approval 覆盖值为 `never` 时同理。
 *
 * @param session - 会话对象。
 * @param services - `{approvalOverrideOf}` 适配层（可缺省）。
 * @returns {boolean}
 */
export function hasNoApprovalChannel(session, services) {
  if (isSubagentSession(session)) return true
  try {
    return services?.approvalOverrideOf?.(session) === 'never'
  } catch {
    // 服务异常时按「有通道」处理：真正的 ask 会由框架兜底，不至于错误放行。
    return false
  }
}

/**
 * 按「更严者胜」合成下游结论与我方判定（spec §4.4 / D9）：
 *   ① 下游 deny/cancel 原样返回（永不弱化），记 downstream；
 *   ② dryRun：只记 dry-run，返回下游；
 *   ③ 我方 ask/deny 返回我方结论（ask 保留 displayReason 供审批卡本地化）；
 *   ④ 其余（pass/allow）记 allow 并返回下游。
 *
 * @param downstream - `await next()` 的下游结论。
 * @param decision - decideCall 的判定结果（pass/allow/ask/deny）。
 * @param config - 插件配置（只读 dryRun）。
 * @param log - 日志函数 `(event, summary, detail) => void`。
 * @param exec - 当前工具调用（日志摘要用）。
 * @returns 下游结论或我方 ask/deny。
 */
export function compose(downstream, decision, config, log, exec) {
  const downstreamKind = downstream?.kind ?? 'allow'
  const detail = describeCall(exec)
  if (downstreamKind === 'deny' || downstreamKind === 'cancel') {
    log('downstream', `downstream:${downstreamKind}`, detail)
    return downstream
  }
  if (config?.dryRun === true) {
    const code = decision?.code === undefined ? '' : `:${decision.code}`
    log('dry-run', `${decision?.kind ?? 'pass'}${code}`, detail)
    return downstream
  }
  if (decision?.kind === 'ask') {
    log('ask', `${decision.code ?? ''} ${decision.reason ?? ''}`.trim(), detail)
    return { kind: 'ask', reason: decision.reason, displayReason: decision.displayReason }
  }
  if (decision?.kind === 'deny') {
    log('deny', `${decision.code ?? ''} ${decision.reason ?? ''}`.trim(), detail)
    return { kind: 'deny', reason: decision.reason }
  }
  log('allow', decision?.code ?? 'write-guard', detail)
  return downstream
}

/**
 * 转义注入 systemPrompt 的动态文本，避免被宿主当成模板插值。
 *
 * `dsh-system-prompt` 会把 `{{name}}` 替换成宿主变量；白名单/项目根来自用户批准后自动学习的
 * 路径（目录名里完全可以包含 `{{cwd}}` 这类字样），若不转义，模型上下文会被"学习到的路径"
 * 改写（review minor 5）。这里把半角花括号替换成全角，保留可读性且不触发插值。
 *
 * @param text - 任意动态文本（路径/字符串）。
 * @returns 花括号已替换的文本。
 */
function escapePromptText(text) {
  return String(text ?? '')
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
}

/**
 * 渲染注入模型上下文的规则说明；**只有激活会话**才返回文本。
 *
 * 非激活会话（其它权限档）必须拿到空串，否则模型会误判自己的权限档（spec §4.5）。
 *
 * @param config - 插件配置（白名单已含自动条目）。
 * @param session - 当前会话（可为 null）。
 * @param services - `{presetOf, workspaceRootOf, getSession}`。
 * @returns {string} 规则说明；非激活/无会话/服务异常返回 ''。
 */
function renderRules(config, session, services) {
  if (session === undefined || session === null) return ''
  try {
    if (!isActive(session, config, services)) return ''
    const workspaceRoot = services?.workspaceRootOf?.(session)
    const cwd = normalizePath(workspaceRoot ?? session?.header?.cwd ?? '', process.cwd())
    const whitelist = Array.isArray(config.whitelist) ? config.whitelist : []
    const lines = [
      '[write-guard] 当前权限模式：完全权限（拦截）。',
      `项目根（可自由读写）：${cwd.length > 0 ? escapePromptText(cwd) : '(未知)'}`,
      `白名单（可自由读写）：${whitelist.length > 0 ? whitelist.map(escapePromptText).join(', ') : '(未配置)'}`,
      '读取任何文件都允许，不会弹框。',
      '项目根/白名单之外的写入会弹框询问用户；用户批准后目标目录会自动加入白名单，下次同目录写入不再询问。',
      'bash/pwsh 中无法静态判定的复杂命令会先由 AI 判定；AI 判定可能越界或无法判断时也会询问用户。',
    ]
    return lines.join('\n')
  } catch {
    return ''
  }
}

/**
 * 构造 failMode 兜底判定（decideCall / 接线内部异常时使用）。
 *
 * `ask` 的文案与 spec §5.6 一致（带 `[write-guard] ` 标记、`（failMode=ask）` 后缀）；
 * `deny` 同理；`open` 由调用方直接返回下游结论。
 *
 * @param mode - 'ask' | 'deny'。
 * @param error - 原始异常（只取 message）。
 * @returns ask/deny 判定对象。
 */
function gateErrorDecision(mode, error) {
  const message = errorText(error)
  if (mode === 'deny') {
    return {
      kind: 'deny',
      code: 'GATE_ERROR',
      reason: `${REASON_PREFIX}写入守卫内部错误：${message}（failMode=deny）`,
    }
  }
  return {
    kind: 'ask',
    code: 'GATE_ERROR',
    reason: `${REASON_PREFIX}写入守卫内部错误：${message}（failMode=ask）`,
    displayReason: {
      zh: '写入守卫内部错误，需要你确认。',
      en: 'The write guard failed internally and needs your confirmation.',
    },
    targets: [],
  }
}

/**
 * 插件入口：归一化配置 → 加载自动白名单 → 注册 pre-execute / approval / systemPrompt。
 *
 * 宿主服务一律 `ctx.get(...)` 懒取（服务可能晚于插件注册）；缺失时按「未激活」退化，
 * 不因缺服务让插件加载失败，也不改变现状行为（spec §4.2 ①）。
 *
 * @param ctx - 插件上下文（需 on / inject / get）。
 * @param rawConfig - profile 覆盖行给的 config（可为空）。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  // 白名单在加载期做一次 realpath（配置只保证绝对路径）；此后新增条目已由学习链归一化。
  config.whitelist = normalizeRoots(config.whitelist, process.cwd())
  // 记录「配置声明的」白名单（不含随后并入的自动条目）：学习成功后要用磁盘上的最终条目
  // 重建 config.whitelist，才能把被 MAX_AUTO_ENTRIES 淘汰的旧目录同步移出内存（review finding 3）。
  const declaredWhitelist = [...config.whitelist]

  const log = (event, summary, detail) => appendLog(config.logPath, event, summary, detail)
  log(
    'plugin-loaded',
    `enabled=${config.enabled} autoWhitelist=${config.autoWhitelist}`,
    `activationPreset=${config.activationPreset} dryRun=${config.dryRun}`,
  )

  // 宿主服务适配层：全部懒取，避免在加载期因服务未就绪而失败。
  const services = {
    presetOf: (session) => ctx.get('permissionPresets')?.current?.(session),
    workspaceRootOf: (session) => ctx.get('sandboxPolicy')?.resolve?.({ session })?.workspaceRoot,
    approvalOverrideOf: (session) => ctx.get('approval')?.overrideOf?.(session),
    getSession: (id) => ctx.get('sessions')?.get?.(id),
    llm: () => ctx.get('llm'),
    dshHome: () => ctx.get('dshHomePath')?.(),
  }

  // ── 自动白名单状态（加载期只读；学习在 approval 监听器里发生） ──
  let autoEntries = []
  let whitelistVersion = 0
  const autoWhitelistFile = resolveAutoWhitelistFile(config, ctx)
  let dshHome
  try {
    dshHome = services.dshHome()
  } catch {
    dshHome = undefined
  }
  dshHome = dshHome ?? resolveDshHome(ctx)
  // 保护路径统一归一化：DSH home / 状态文件 / 日志文件（含祖先/后代关系，T5-review 要求）。
  const protectedPaths = [
    ...new Set(
      [autoWhitelistFile, normalizePath(config.logPath, process.cwd()), normalizePath(dshHome, process.cwd())]
        .filter((path) => typeof path === 'string' && path.length > 0),
    ),
  ]

  if (config.autoWhitelist) {
    const loaded = loadAutoWhitelistPaths(autoWhitelistFile, process.platform)
    if (typeof loaded.error === 'string' && loaded.error.length > 0) {
      log('error', 'auto-whitelist-load', loaded.error)
    }
    autoEntries = loaded.entries
    for (const entry of autoEntries) {
      const path = typeof entry?.path === 'string' ? entry.path : ''
      if (path.length > 0 && !config.whitelist.includes(path)) config.whitelist.push(path)
    }
    if (autoEntries.length > 0) log('auto-whitelist', `loaded=${autoEntries.length}`, autoWhitelistFile)
  }

  const judgeCache = new JudgeCache(config.judgeCacheSize)

  // 按 callId 记住本次 ask 的越界目标：审批结论回来时据此学习（spec §5.5）。
  const pendingLearn = new Map()

  /**
   * 无审批通道改写（spec D8）：把 ask **变换**成 deny，而不是提前 return。
   *
   * 只有最终经 `compose` 合成的结论才算数——这样下游 deny/cancel 永远优先、dryRun 仍然
   * 放行（review finding 1）。failMode=ask 的错误路径同样走这里（gateErrorDecision 也返回 ask）。
   *
   * @param decision - decideCall / gateErrorDecision 的判定（可为空）。
   * @param session - 当前会话（可为 null）。
   * @returns 改写后的判定（非 ask 或仍有审批通道时原样返回）。
   */
  function rewriteNoApprovalChannel(decision, session) {
    if (decision?.kind !== 'ask') return decision
    if (session === undefined || session === null) return decision
    if (!hasNoApprovalChannel(session, services)) return decision
    return { kind: 'deny', code: 'NO_APPROVAL_CHANNEL', reason: NO_APPROVAL_CHANNEL_REASON }
  }

  /**
   * 按「最终合成结论」维护 pendingLearn（review finding 4）：
   *   仅在最终结论是 ask、原始判定也是 ask、且 targets 非空时登记；
   *   其余情况（无目标 ask / dryRun / 下游 deny/cancel / 无审批通道改判 deny / gate error）
   *   一律删除同 callId 的旧条目，避免过期目标被下一次审批误学习。
   *
   * @param exec - 当前工具调用（只读 callId）。
   * @param decision - 合成前的判定（targets 来源）。
   * @param final - `compose` 的最终结论。
   */
  function syncPendingLearn(exec, decision, final) {
    const callId = exec?.callId
    if (typeof callId !== 'string') return
    const targets = Array.isArray(decision?.targets) ? decision.targets : []
    if (final?.kind === 'ask' && decision?.kind === 'ask' && targets.length > 0) {
      pendingLearn.set(callId, { targets: [...targets], code: decision.code })
      while (pendingLearn.size > MAX_PENDING_LEARN) {
        pendingLearn.delete(pendingLearn.keys().next().value)
      }
      return
    }
    pendingLearn.delete(callId)
  }

  /**
   * 调一次 AI 判定（judge.mjs），记录 judge-safe/judge-ask/judge-error 日志。
   *
   * judgeCommand 自身保证不抛；这里的 try/catch 只是防未来实现变化，任何异常都降级成
   * `unknown`（decideCall 会据此转 ask），绝不让异常冒到 pre-execute 外层。
   */
  async function runJudge({ command, shell, workdir, analysis }, exec, cwd, roots) {
    const input = buildJudgeInput({
      platform: process.platform,
      shell,
      projectRoot: cwd,
      whitelist: roots.whitelist,
      // review minor 2：临时区也算放行面；只有 allowTempRoots 为真时才告诉 judge。
      tempRoots: config.allowTempRoots ? roots.temp : [],
      workdir,
      command,
      analysis,
    })
    // 缓存按插件实例共享，判定输入含 project_root（本会话 cwd），因此项目根必须入键，
    // 否则不同项目根的会话在命令+workdir 相同时会误命中彼此结论（review finding 2）。
    const cacheKey = judgeCacheKey({ projectRoot: cwd, shell, workdir, whitelistVersion, command })
    let result
    try {
      result = await judgeCommand({
        ctx: { llm: services.llm() },
        exec,
        input,
        cache: judgeCache,
        cacheKey,
        timeoutMs: config.judgeTimeoutMs,
      })
    } catch (error) {
      log('judge-error', 'judge-exception', `${errorText(error)} | ${describeCall(exec)}`)
      return { decision: 'unknown', outsidePaths: [], reason: `AI 判定失败：${errorText(error)}` }
    }
    log(
      result.decision === 'safe' ? 'judge-safe' : 'judge-ask',
      result.cached === true ? 'cached' : 'live',
      `${result.reason ?? ''} | ${describeCall(exec)}`,
    )
    return result
  }

  /**
   * 用户批准（allowed-once）后把本次越界目标学进自动白名单（spec §5.5）。
   *
   * 顺序：开关闸门 → 会话存在（否则 skipped no-session）→ 激活判定 → 取 pending 目标 →
   * 推导候选目录 → 过滤（敏感根/保护路径；`allowTempRoots` 为假时临时区不算直通面，故不会
   * 被判 no-need）→ 持久化；**只有 saved=true 才更新内存**（autoEntries / config.whitelist /
   * whitelistVersion），避免磁盘没记住却放行。
   */
  function learn(request) {
    if (!config.enabled || !config.autoWhitelist || config.dryRun) {
      const why = !config.enabled ? 'disabled' : !config.autoWhitelist ? 'auto-whitelist-off' : 'dry-run'
      log('auto-whitelist-skip', why, request?.callId)
      return
    }
    const session = request?.agent?.session
    // 没有会话就无法判断是否激活、也无法确定学习基准；按「不可学习」处理（review finding 5）。
    if (session === undefined || session === null) {
      log('auto-whitelist-skip', 'no-session', request?.callId)
      return
    }
    if (!isActive(session, config, services)) {
      log('auto-whitelist-skip', 'inactive', request?.callId)
      return
    }
    const entry = pendingLearn.get(request?.callId)
    if (entry === undefined || !Array.isArray(entry.targets) || entry.targets.length === 0) {
      log('auto-whitelist-skip', 'no-learnable-target', request?.callId)
      return
    }

    const workspaceRoot = services.workspaceRootOf(session)
    const cwd = normalizePath(workspaceRoot ?? session?.header?.cwd ?? '', process.cwd())
    const pairs = deriveLearnDirs(entry.targets, cwd)
    // review minor 1：`allowTempRoots: false` 时临时区不是直通面，获批的 /tmp 写必须能学习
    // （否则批准完下一次仍弹框）；反过来为 true 时仍按 temp 判 no-need。
    const roots = {
      project: cwd,
      whitelist: [...config.whitelist],
      temp: config.allowTempRoots ? tempRoots() : [],
    }
    const { accepted, skipped } = filterLearnDirs(pairs, {
      roots,
      protectedPaths,
      sensitiveRoots: sensitiveRoots(),
    })
    for (const item of skipped) log('auto-whitelist-skip', item.reason, item.path)
    if (accepted.length === 0) return

    const paths = accepted.map((item) => item.path)
    const result = persistAutoWhitelist({
      file: autoWhitelistFile,
      platform: process.platform,
      entries: autoEntries,
      addedPaths: paths,
      meta: { source: 'approval', callId: request?.callId },
    })
    if (result.saved !== true) {
      // 落盘失败：内存态保持原样，宁可下次继续弹框，也不能出现"磁盘没记住却放行"。
      log('error', 'auto-whitelist-save', result.error ?? '保存自动白名单失败')
      return
    }

    autoEntries.splice(0, autoEntries.length, ...result.entries)
    // 用磁盘上的最终条目重建内存白名单（declared + auto）：`persistAutoWhitelist` 因
    // MAX_AUTO_ENTRIES 淘汰掉的旧目录必须同时从内存移除，否则会出现「磁盘已忘、内存仍放行」。
    const autoPaths = autoEntries
      .map((item) => (typeof item?.path === 'string' ? item.path : ''))
      .filter((path) => path.length > 0)
    config.whitelist = [...new Set([...declaredWhitelist, ...autoPaths])]
    whitelistVersion += 1
    log('auto-whitelist', `added=${paths.length}`, paths.join(', '))
  }

  // ── ① 规则说明注入（仅激活会话；order=112 紧跟 path-rules 的 111） ──
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'write-guard',
      order: 112,
      text: (context) => renderRules(config, context?.agent?.session, services),
    })
  })

  // ── ② 审批结果监听：只处理本插件发起的审批，用户点允许才学习 ──
  ctx.on(
    'approval/request',
    (request, next) => {
      if (typeof request?.reason !== 'string' || !request.reason.startsWith(REASON_PREFIX)) {
        return next()
      }
      let outcomePromise
      try {
        outcomePromise = Promise.resolve(next())
      } catch (error) {
        // 下游审批链自身抛错：记日志后原样抛回（不替它做决定）。
        log('error', 'approval-error', errorText(error))
        pendingLearn.delete(request.callId)
        throw error
      }
      return outcomePromise.then(
        (outcome) => {
          if (outcome === 'allowed-once') {
            try {
              learn(request)
            } catch (error) {
              // 学习失败绝不能影响审批结果本身。
              log('error', 'auto-whitelist-error', errorText(error))
            }
          }
          pendingLearn.delete(request.callId)
          return outcome
        },
        (error) => {
          pendingLearn.delete(request.callId)
          log('error', 'approval-error', errorText(error))
          throw error
        },
      )
    },
    { prepend: true },
  )

  // ── ③ 逐调用写入闸门 ──
  ctx.on('tools/pre-execute', async (exec, next) => {
    // 先取下游结论：waterfall 语义要求调用 next() 才不否决整条链，同时用于"更严者胜"合成。
    let downstream
    try {
      downstream = await next()
    } catch (error) {
      // 下游监听器自身抛错：记录后原样抛给框架，不在这里替它做决定。
      log('error', 'downstream-error', errorText(error))
      throw error
    }

    try {
      const session = exec?.agent?.session
      // 非激活 / 无会话：完全不介入（零日志、零状态、零弹框）。
      if (session === undefined || session === null) return downstream
      if (!isActive(session, config, services)) return downstream

      // 项目根 = 沙箱口径的 workspaceRoot（缺省回退 header.cwd）；归一化后必须非空。
      const workspaceRoot = services.workspaceRootOf(session)
      const cwd = normalizePath(workspaceRoot ?? session?.header?.cwd ?? '', process.cwd())
      if (cwd.length === 0) return downstream

      const roots = { project: cwd, whitelist: [...config.whitelist], temp: tempRoots() }
      const judge = config.judge
        ? (parts) => runJudge(parts, exec, cwd, roots)
        : null

      let decision
      try {
        decision = await decideCall(exec, { config, cwd, roots, judge })
      } catch (error) {
        log('gate-error', errorText(error), describeCall(exec))
        if (config.failMode === 'open') {
          // fail-open 直接交还下游；顺手清掉同 callId 的过期待学习目标。
          syncPendingLearn(exec, undefined, downstream)
          return downstream
        }
        decision = gateErrorDecision(config.failMode, error)
      }

      // 无审批通道（子代理 / approval=never）只做「判定变换」，再由 compose 统一合成：
      // 下游 deny/cancel 与 dryRun 的优先级因此不会被提前 return 破坏（review finding 1）。
      const final = compose(
        downstream,
        rewriteNoApprovalChannel(decision, session),
        config,
        log,
        exec,
      )
      // pendingLearn 以「最终合成结论」为准：dryRun / 下游否决 / 无目标 / 改判 deny 都不登记
      // 且清掉旧条目（review finding 4）。
      syncPendingLearn(exec, decision, final)
      return final
    } catch (error) {
      // 最后一道保险：接线内部（激活判定/根集合/合成等）任何异常都转成 failMode 兜底，
      // 绝不让异常冒到宿主框架（下游异常已在上面单独重抛）。
      log('gate-error', `unexpected:${errorText(error)}`, describeCall(exec))
      const session = exec?.agent?.session
      if (config.failMode === 'open') {
        syncPendingLearn(exec, undefined, downstream)
        return downstream
      }
      // failMode=ask 的错误判定同样要经过无审批通道改写 + compose（review finding 1）。
      const decision = gateErrorDecision(config.failMode, error)
      const final = compose(downstream, rewriteNoApprovalChannel(decision, session), config, log, exec)
      syncPendingLearn(exec, decision, final)
      return final
    }
  })
}
