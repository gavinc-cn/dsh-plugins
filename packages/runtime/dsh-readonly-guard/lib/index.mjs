// dsh-readonly-guard: 把 kimi-code 的 readonly_guard.py hook 移植为 DSH 原生 Cordis 插件。
//
// 与 kimi hook 的触发点对应关系（kimi 事件 → DSH 扩展点）：
//   PreToolUse(matcher=bash) → tools/pre-execute（waterfall，返回 PreToolDecision）
//
// 三处关键差异（详见 README.md「与 kimi 语义的差异」）：
//   1. kimi 侧只有「exit 2 = deny + 让模型带审批标记重试」这一种出口；DSH 有真审批瀑布，
//      所以非只读命令默认返回 {kind:'ask'}（真弹窗），把「问用户」这件事交还给 harness。
//      需要严格复刻 kimi 行为时把配置 askMode 设为 'deny'。
//   2. kimi 侧 sanity check 的提示走 stderr（模型看不到）；插件里改记 `allow:marker:non-readonly`
//      日志行，正文与 Python 原文一致。
//   3. dryRun 下不写 pending 记录（插件跑在 harness 进程内，dry-run 应当零副作用）。
//
// 设计约束：
//   - 监听器必须自己 try/catch 吞异常（插件跑在 harness 进程内，抛出去会打断当前工具调用）。
//     内部异常一律 fail-open：放行，并记 `error:<阶段>`。
//   - 分类/白名单/审批记录的逻辑全在 lib/classify.mjs，本文件只做「读配置 + 读 exec + 决策 + 日志」。

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  APPROVAL_MARKER,
  APPROVAL_MARKER_RE,
  DEFAULT_PENDING_PATH,
  DEFAULT_WHITELIST_PATH,
  isReadOnlyCommand,
  isWhitelisted,
  pyStrip,
  recordApproval,
} from './classify.mjs'

export const name = 'dsh-readonly-guard'

/** 与 kimi hook 日志同族目录，文件名单独一份便于区分两边。 */
const DEFAULT_LOG = join(homedir(), '.kimi-code', 'hooks', 'logs', 'readonly_guard.dsh.log')

/** 本插件只处理 bash 工具（DSH 侧工具名就是小写 `bash`）。 */
const BASH_TOOL = 'bash'

/** 日志里单条命令的最大长度；超出部分截断并标注省略了多少字符。 */
const LOG_COMMAND_MAX = 1000

/**
 * 归一化 profile patch 传进来的 config。
 * @param {unknown} raw - 插件 config（可能为 undefined）。
 * @returns 补全默认值后的配置。
 */
function normalizeConfig(raw) {
  const c = raw ?? {}
  return {
    enabled: c.enabled !== false,
    dryRun: c.dryRun === true,
    askMode: c.askMode === 'deny' ? 'deny' : 'ask',
    whitelistPath: nonEmptyString(c.whitelistPath) ?? DEFAULT_WHITELIST_PATH,
    pendingPath: nonEmptyString(c.pendingPath) ?? DEFAULT_PENDING_PATH,
    logPath: nonEmptyString(c.logPath) ?? DEFAULT_LOG,
  }
}

/** 非空字符串则原样返回，否则 undefined。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 追加一行审计日志；日志不可写时静默（不因日志失败影响主流程）。 */
function logLine(logPath, ...parts) {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    const stamp = new Date().toISOString().slice(0, 19)
    appendFileSync(logPath, `${stamp} | ${parts.map((p) => String(p)).join(' | ')}\n`, 'utf8')
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 命令压成一行并截断，保证「一个事件一行日志」。 */
function forLog(command) {
  const text = command.replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  if (text.length <= LOG_COMMAND_MAX) return text
  return `${text.slice(0, LOG_COMMAND_MAX)}…(+${text.length - LOG_COMMAND_MAX}字符)`
}

/** 取会话 id（对应 kimi payload 的 session_id；取不到给空串）。 */
function sessionIdOf(exec) {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' ? id : ''
}

/**
 * deny 文案：与 Python 阻断时写 stderr 的三行逐字一致（askMode='deny' 时使用）。
 * @param {string} command 原始命令。
 */
export function denyReason(command) {
  return '[READONLY_GUARD] 命令被分类为可能修改系统，已阻断。\n'
    + `原始命令：${command}\n`
    + '请使用 AskUserQuestion 向用户确认。若用户同意执行，'
    + `请在重新执行时把审批标记 '${APPROVAL_MARKER}' 单独放在一行，`
    + '再将实际命令放在下一行。\n'
    + '经批准放行的命令会被记录，本轮对话结束后相似的只读命令'
    + '将自动加入白名单，无需再次批准。'
}

/**
 * ask 文案：沿用 Python 的 `[READONLY_GUARD] ...` 说明，但语气改成「请用户确认」——
 * DSH 的 ask 会真的弹审批，用户同意后命令直接执行，不必再贴标记。
 * @param {string} command 原始命令。
 */
export function askReason(command) {
  return '[READONLY_GUARD] 命令被分类为可能修改系统，需要用户确认后才能执行。\n'
    + `原始命令：${command}\n`
    + '请等待用户在审批弹窗中确认；用户同意后该命令即会执行，无需再手动添加审批标记。\n'
    + '若用户拒绝，也可走 kimi 兼容路径：把审批标记 '
    + `'${APPROVAL_MARKER}' 单独放在一行、实际命令放在下一行重试。`
}

/** ask 弹窗上展示的文案（交给 GUI 本地化；reason 是审计用的原文）。 */
function askDisplayReason(command) {
  return {
    en: `[READONLY_GUARD] This command may modify the system: ${forLog(command)}\n`
      + 'Approve to run it once. Reject to keep it blocked.',
    zh: `[READONLY_GUARD] 该命令可能修改系统：${forLog(command)}\n`
      + '批准即可执行一次；拒绝则继续保持阻断。',
  }
}

/**
 * 注册插件。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [rawConfig] - profile patch 条目上的 config。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = (...parts) => logLine(config.logPath, ...parts)

  log('plugin-loaded',
    `askMode=${config.askMode}`, `dryRun=${config.dryRun}`, `enabled=${config.enabled}`,
    `whitelist=${config.whitelistPath}`)

  // PreToolUse/Bash 等价物：只读放行，可能写系统的交给审批或直接阻断。
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (!config.enabled) return next()
      if (exec?.name !== BASH_TOOL) return next()

      const args = exec?.arguments
      const command = args !== null && typeof args === 'object' ? args.command : undefined
      // 与 Python 的 `if not command: return 0` 对齐：空命令直接放行。
      if (typeof command !== 'string' || command.length === 0) return next()

      const sid = sessionIdOf(exec)

      // ① 审批标记：去掉标记 → 记录 → 放行。标记必须出现在命令串最开头（Python 用 re.match）。
      if (APPROVAL_MARKER_RE.exec(command) !== null) {
        const stripped = pyStrip(command.replace(APPROVAL_MARKER_RE, ''))
        if (config.dryRun) {
          log('dry-run', sid, 'would-allow:marker', forLog(stripped))
          return next()
        }
        recordApproval(stripped, sid, config.pendingPath)
        log('allow:marker', sid, forLog(stripped))
        // 去掉标记后再做一次 sanity check：非只读则留痕（Python 侧写 stderr，这里写日志）。
        if (!isReadOnlyCommand(stripped)) {
          log('allow:marker:non-readonly', sid, `[READONLY_GUARD] 命令已通过用户审批，放行执行：${forLog(stripped)}`)
        }
        return next()
      }

      // ② 明确只读：放行。
      if (isReadOnlyCommand(command)) {
        log('allow:readonly', sid, forLog(command))
        return next()
      }

      // ③ 白名单命中（曾在别处批准过、或学习出的相似只读模式）：放行。
      //    放在分类之后，让普通只读命令免去白名单文件 I/O。
      if (isWhitelisted(command, { whitelistPath: config.whitelistPath })) {
        log('allow:whitelist', sid, forLog(command))
        return next()
      }

      // ④ 非只读且未在白名单。
      if (config.dryRun) {
        log('dry-run', sid, `would-${config.askMode}`, forLog(command))
        return next()
      }
      if (config.askMode === 'deny') {
        log('deny', sid, forLog(command))
        return { kind: 'deny', reason: denyReason(command) }
      }
      log('ask', sid, forLog(command))
      return { kind: 'ask', reason: askReason(command), displayReason: askDisplayReason(command) }
    } catch (error) {
      // fail-open：插件内部异常绝不阻断工具调用。
      log('error:pre-execute', String(error))
      return next()
    }
  })
}
