// dsh-git-guard: 把 kimi-code 的 git_commit_guard hook 移植为 DSH 原生 Cordis 插件。
//
// 与 kimi hook 的触发点对应关系（kimi 事件 → DSH 扩展点）：
//   PreToolUse / Bash → tools/pre-execute（waterfall；返回 {kind:'deny', reason}，
//                       reason 会作为错误文本回给模型）
//   退出码 2 + stderr → deny 的 reason（文本与 Python 版逐字一致）
//   退出码 0          → next()（放行，不覆盖下游决定）
//
// 判定逻辑全部在 ./guard.mjs（evaluate + 全部 helper），本文件只负责：
//   ① 工具名过滤（只处理 bash）与配置归一化；
//   ② cwd 解析：exec.arguments.workdir → 会话 cwd → 进程 cwd；
//   ③ 决策落地（deny / dry-run 放行）与审计日志；
//   ④ 任何异常一律 fail-open（插件跑在 harness 进程内，抛出去会打断工具调用）。
//
// 与 Python 版的差异（刻意的）：
//   - 不再读 ~/.kimi-code/sessions/*/state.json 推会话 cwd：DSH 的
//     exec.agent.session.header.cwd 就是权威值，进程内直接拿得到；
//   - git 子进程超时可配（gitTimeoutMs，默认 20s；远端 ls-remote 按其 1.5 倍），
//     替代 Python 版写死的 4s/6s；
//   - 本插件不受 hook 子进程沙箱限制（这正是本次迁移的原因）。

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { evaluate } from './guard.mjs'

export const name = 'dsh-git-guard'

/** 默认审计日志（与 kimi 侧 hook 同目录，文件名单列一份便于区分）。 */
const DEFAULT_LOG = join(homedir(), '.kimi-code', 'hooks', 'logs', 'git_guard.dsh.log')

/** deny 日志里规则摘要的最大长度（只用于日志，不影响回给模型的 reason）。 */
const SUMMARY_MAX = 80

/** 读取配置并填默认值；config 来自 profile patch 的条目。 */
export function normalizeConfig(raw) {
  const c = raw ?? {}
  return {
    enabled: c.enabled !== false,
    dryRun: c.dryRun === true,
    logPath: typeof c.logPath === 'string' && c.logPath.length > 0 ? c.logPath : DEFAULT_LOG,
    gitTimeoutMs: Number.isInteger(c.gitTimeoutMs) && c.gitTimeoutMs > 0 ? c.gitTimeoutMs : 20_000,
  }
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

/** 只处理 DSH 的 bash 工具（大小写不敏感）；其他工具原样交给下游。 */
function isBashTool(toolName) {
  return String(toolName ?? '').toLowerCase() === 'bash'
}

/**
 * 定位 git 操作的目标目录：exec.arguments.workdir（DSH 的 bash 工具参数名）
 * → 会话工作目录 exec.agent.session.header.cwd → 进程 cwd。
 * 与 Python 的 _resolve_repo_cwd 顺序一致，只是省掉了会话 state.json 那一跳。
 */
function resolveCwd(exec) {
  const args = exec?.arguments ?? {}
  const toolCwd = String(args.cwd ?? args.workdir ?? '').trim()
  if (toolCwd.length > 0) return toolCwd
  const sessionCwd = exec?.agent?.session?.header?.cwd
  if (typeof sessionCwd === 'string' && sessionCwd.trim().length > 0) return sessionCwd.trim()
  return process.cwd()
}

/** 规则摘要：取 reason 首行并截断（日志用；模型拿到的是完整 reason）。 */
function summarize(reason) {
  const first = String(reason).split('\n')[0]
  return first.length > SUMMARY_MAX ? `${first.slice(0, SUMMARY_MAX)}…` : first
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = (...parts) => logLine(config.logPath, ...parts)

  log('plugin-loaded', `enabled=${config.enabled}`, `dryRun=${config.dryRun}`,
    `gitTimeoutMs=${config.gitTimeoutMs}`)

  // PreToolUse/Bash 的等价物：在 bash 工具真正执行前过一遍归属校验。
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (!isBashTool(exec?.name)) return next()
      if (!config.enabled) return next()
      const command = String(exec.arguments?.command ?? '')
      if (command.length === 0) return next()
      const cwd = resolveCwd(exec)
      const trace = { handled: [] }
      const reason = await evaluate(command, cwd, { gitTimeoutMs: config.gitTimeoutMs, trace })
      if (reason === null) {
        // 只记「受控子命令」的放行，避免每条 bash 调用都写一行日志
        if (trace.handled.length > 0) log('allow', trace.handled.join(', '), cwd)
        return next()
      }
      if (config.dryRun) {
        log('dry-run', reason, cwd)
        return next()
      }
      log('deny', summarize(reason), cwd)
      return { kind: 'deny', reason }
    } catch (error) {
      // fail-open：判定脚本自身出问题时不阻塞模型（与 Python hook 的异常语义一致）
      log('error:pre-execute', String(error))
      return next()
    }
  })
}
