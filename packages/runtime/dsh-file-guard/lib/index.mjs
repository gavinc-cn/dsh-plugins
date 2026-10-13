// @gavinc-cn/dsh-file-guard —— DSH 原生 Cordis 插件（每轮收尾检查文件是否被外部改动）
//
// 为什么做成插件而不是继续用 hook：
//   DSH 的 hook 子进程走 dsh-hook-protocol.runHook() → bash.execute()，请求里不带 sandboxPolicy，
//   回退到部署级默认沙箱（工作区可写、root=进程 cwd），实测只有 /tmp 可写：`file_guard.py
//   stop-hook` 读得到 ~/.orca/file-guard/ 下的 journal，却写不了 state.json 的去重标记与
//   reports/，异常被脚本 fail-open 吞掉 → 每轮要么不提示、要么反复提示同一批漂移。
//   插件跑在 harness 进程内，不受这层沙箱约束。
//
// 与 kimi hook 的触发点对应关系：
//   Stop         → agent/turn-stopping（有漂移时 agent.steer() 让模型简短告知用户）
//   SubagentStop → 同一个 agent/turn-stopping：子代理会话有自己的 session id 与状态目录，
//                  有漂移照常提示（与 kimi 配置里 SubagentStop 也调 stop-hook 一致），
//                  没有记录则静默——所以不做「子代理一律跳过」的特殊处理。
//
// 行为边界（与 Python 版一致，勿改）：
//   * 只报告，绝不自动改回；恢复必须显式执行 CLI `restore --yes`。
//   * 同一批漂移只提示一次（state.json 的 reported 去重，按「路径 + 当前 sha1」判重）。
//   * 任何异常都自己吞掉并记 error:* 日志，绝不影响回合收尾。
//
// 与 Python stop-hook 的**刻意偏差**（1 处，2026-10-08 复核后加）：
//   Python 的 stop-hook 在负载带 session_id 时只看 `<state_root>/<sanitize(session_id)>`，
//   而 CLI 默认的 note 写的是 `<state_root>/ws-<工作区目录名>` —— 两条路径对不上，
//   标准流程下 hook 永远查不到记录、静默空转。本插件默认 `resolve:'auto'`：
//   先认会话目录（有记录才认），否则按 CLI 的 workspace 口径找（见 resolveGuardDir）；
//   设 `resolve:'session'` 可完全回到 Python 语义。

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  collectDrift, DEFAULT_STATE_ROOT, filterReported, isFile, journalPath, resolveSession, sanitize,
  shortNotice, statePath, writeReport,
} from './core.mjs'

export const name = 'dsh-file-guard'

/** 日志默认位置（与其它 kimi hook 的日志放一起，便于对照排查）。 */
const DEFAULT_LOG = join(homedir(), '.kimi-code', 'hooks', 'logs', 'file_guard.dsh.log')
/** steer 消息的来源标记（会话日志里靠它判定"守卫提示过"）。 */
const SOURCE_KIND = 'dsh-file-guard'

/** 读取配置并填默认值；config 来自 profile patch 条目的 `config`。 */
function normalizeConfig(raw) {
  const c = raw ?? {}
  return {
    enabled: c.enabled !== false,
    dryRun: c.dryRun === true,
    // 与 kimi 侧 FILE_GUARD_ROOT 同源：两边指向同一份状态目录才能互读互写
    stateRoot: typeof c.stateRoot === 'string' && c.stateRoot.length > 0 ? c.stateRoot : DEFAULT_STATE_ROOT,
    notifyOnStop: c.notifyOnStop !== false,
    // 会话目录解析档位：'auto'（默认，能用）| 'session'（复刻 Python stop-hook）| 'workspace'
    resolve: c.resolve === 'session' || c.resolve === 'workspace' ? c.resolve : 'auto',
    logPath: typeof c.logPath === 'string' && c.logPath.length > 0 ? c.logPath : DEFAULT_LOG,
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

/** 会话 id 缩写，仅供日志阅读：去掉 session- / session_ 前缀后取前 8 位。 */
function shortId(sessionId) {
  return String(sessionId).replace(/^session[-_]/, '').slice(0, 8)
}

/**
 * 取会话 id：DSH 的 session.id 形如 session-<uuid>；header.id 是同一值的权威副本。
 * 两者都取不到时返回 null（放弃本次检查，静默）。
 */
function sessionIdOf(agent) {
  const id = agent?.session?.id ?? agent?.session?.header?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** 子代理会话判定（沿用 dsh-memory / dsh-autocommit 的 isChildSession）。 */
function isChildSession(agent) {
  const header = agent?.session?.header
  if (header === undefined) return false
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

/** 该目录里有没有守卫记录（state.json 或 journal.ndjson）——没有就别打扰。 */
function hasRecords(d) {
  return isFile(statePath(d)) || isFile(journalPath(d))
}

/**
 * 解析本轮要检查的状态目录，返回 { dir, via } 或 null（null = 静默）。
 *
 * 为什么要多一档：Python 的 `stop-hook` 在负载带 `session_id` 时**只**看
 * `<state_root>/<sanitize(session_id)>`，而 CLI 的默认 `note`（不带 `--session`）写的是
 * `<state_root>/ws-<工作区目录名>`（`default_session_id()`）——两条路径对不上，标准流程下
 * hook 永远查不到记录、静默空转（2026-10-08 复核：真实状态目录只有 ws-private，
 * 而 DSH 会话 id 是 session-<uuid>）。所以默认 'auto'：
 *   ① 会话目录里有记录 → 用它（与 Python 语义一致，支持 `note --session <id>`）；
 *   ② 否则按 CLI 的 workspace 口径（`resolve_session(None)`：state.json.workspace ==
 *      cwd 所在 git 仓库根、最近的优先）找；
 *   ③ 都没有 → 静默。
 * 想完全回到 Python `stop-hook` 语义（只有会话目录）就把 `resolve` 设成 'session'。
 */
function resolveGuardDir(config, sessionId, cwd) {
  const sessionDir = join(config.stateRoot, sanitize(sessionId))
  if (config.resolve === 'session') {
    return hasRecords(sessionDir) ? { dir: sessionDir, via: 'session' } : null
  }
  const fromWorkspace = () => {
    const d = resolveSession(null, { root: config.stateRoot, cwd })
    return d === null ? null : { dir: d, via: 'workspace' }
  }
  if (config.resolve === 'workspace') return fromWorkspace()
  return hasRecords(sessionDir) ? { dir: sessionDir, via: 'session' } : fromWorkspace()
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = (...parts) => logLine(config.logPath, ...parts)

  log('plugin-loaded', `enabled=${config.enabled}`, `dryRun=${config.dryRun}`,
    `stateRoot=${config.stateRoot}`, `notifyOnStop=${config.notifyOnStop}`,
    `resolve=${config.resolve}`)

  // Stop / SubagentStop 等价物：比对「本会话记下的期望状态」与磁盘。
  // 无漂移（或没有守卫记录）→ 静默；有漂移 → 去重后 steer 一条简短提示。
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const sessionId = sessionIdOf(agent)
    const who = sessionId === null ? 'session=?' : `session=${shortId(sessionId)}`
    try {
      if (!config.enabled) {
        log('stop:clean', 'n=0', 'reason=disabled', who)
        return
      }
      if (sessionId === null) {
        log('stop:clean', 'n=0', 'reason=no-session-id', who)
        return
      }
      // 会话/工作区目录解析（见 resolveGuardDir 的说明）；两档都没记录就静默
      const cwd = typeof agent?.session?.header?.cwd === 'string' && agent.session.header.cwd.length > 0
        ? agent.session.header.cwd
        : process.cwd()
      const picked = resolveGuardDir(config, sessionId, cwd)
      if (picked === null) {
        log('stop:clean', 'n=0', 'reason=no-journal', `resolve=${config.resolve}`, who)
        return
      }
      const d = picked.dir
      const items = collectDrift(d, null, cwd)
      if (config.dryRun) {
        // 只观察：不算去重、不写 state.json、不写 reports/、不 steer
        log('dry-run', `n=${items.length}`, who, `via=${picked.via}`, `dir=${d}`)
        return
      }
      // 关键动作：同批漂移只提示一次（写 state.json 的 reported 去重表）
      const fresh = filterReported(d, items)
      if (fresh.length === 0) {
        log('stop:clean', `n=${items.length}`, `reported=${items.length}`, who,
          `via=${picked.via}`, `dir=${d}`)
        return
      }
      log('stop:drift', `n=${fresh.length}`, who, `subagent=${isChildSession(agent)}`,
        `via=${picked.via}`, `dir=${d}`)
      // 证据落盘（reports/ 下按时间命名，与 Python write_report 同一目录、同一格式）
      const reportPath = writeReport(d, fresh)
      if (!config.notifyOnStop) return
      // 提示里标明是本插件（[dsh-file-guard]），详情直接指向本次落盘的报告
      const text = shortNotice(fresh, d, { tag: '[dsh-file-guard]', detail: reportPath })
      await agent.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: SOURCE_KIND },
      }))
    } catch (error) {
      // 守卫自身异常绝不影响会话收尾
      log('error:turn-stopping', String(error), who)
      ctx.logger?.warn?.(`dsh-file-guard: 收尾检查失败: ${String(error)}`)
    }
  })
}
