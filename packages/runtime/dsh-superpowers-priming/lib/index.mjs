// @gavinc-cn/dsh-superpowers-priming —— DSH 原生 Cordis 插件
// （给「重开的会话」补上 superpowers 开场说明，且保证每个会话最多一份）
//
// 要解决的问题
// ------------
// superpowers 的 SessionStart 走 CC 桥接（profile 的 dsh-hooks.json），matcher 是
// `startup|clear|compact`，而 DSH 的 agent 只有两种创建来源：
//   startup —— 新建会话（桥接注入，正常）
//   resume  —— 会话在持久化日志里存在、但当前没有活 agent，于是被复活
//              （最常见触发＝dsh web 重启后再打开旧会话）
// resume 不在 matcher 里，所以重开的会话拿不到开场注入。可是「该不该补」不能只看
// 「是不是 resume」：
//   * 会话建好后**用过** → 历史里已经有那条注入消息，模型重放历史时看得到 ⇒ 再注入就是重复；
//   * 会话建好后**从没用过**就被重开（点了新建任务、隔天才来提问）→ agent.inject 只落在内存
//     inbox 里，被 dispose 时连同 inbox 一起消失，日志里一个字节都没有 ⇒ 缺这段开场说明。
// 判据因此是「本会话历史里到底有没有它」，这就是本插件做的事：
//   在 agent/created(source=resume) 时读一次会话日志（ctx.sessionQuery.readSession，
//   非 deprecated 的异步读），扫有没有 priming 消息（source.kind 是桥接的 hooks-claude-code
//   或本插件的 superpowers-priming）；有就跳过，没有才补注入。
//
// 与桥接的分工（默认配置）
// ----------------------
//   startup → 仍然由桥接执行上游 superpowers/hooks/session-start（本插件默认不插手，
//             避免与桥接在同一次 startup 上各注入一份）；
//   resume  → 桥接的 matcher 不匹配，只有本插件兜底。
// 若哪天把桥接那条 SessionStart 摘掉，可把 config 的 sources 设成 ['startup','resume']，
// 由本插件独占这条注入（此时历史判重同样生效）。
//
// 行为边界
//   * 只补注入，不改上游 superpowers 仓库任何文件；技能正文在注入时读盘，上游更新即生效。
//   * 读不到会话日志（没有 sessionQuery / 读失败）时**不注入**并记日志——宁可漏一次，
//     也不要因为读失败在每次重开时反复注入、把上下文撑起来。
//   * 只处理 delegationDepth/ origin 为主会话的会话，子代理不补（子代理生命周期短，注入是噪音）。
//   * 任何异常都自己吞掉并记 error:* 日志，绝不影响会话创建。

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-superpowers-priming'

/** 上游 superpowers 开场说明的默认位置。
 *  解析优先级：插件配置 `skillPath` > env `SUPERPOWERS_SKILL_PATH` > 家目录下的 superpowers 检出。
 *  包内**不放任何机器专有路径**：本机/宿主的检出位置写在 profile patch 的 config 里（见
 *  ~/.dsh/profiles/<profile>/cordis.patch.yml）。文件不存在时只记日志并跳过注入，不影响会话。 */
const ENV_SKILL_PATH = process.env.SUPERPOWERS_SKILL_PATH
const DEFAULT_SKILL_PATH = typeof ENV_SKILL_PATH === 'string' && ENV_SKILL_PATH.length > 0
  ? ENV_SKILL_PATH
  : join(homedir(), 'superpowers', 'skills', 'using-superpowers', 'SKILL.md')
/** 日志默认位置（与其它 kimi hook / DSH 插件的日志放一起，便于对照排查）。 */
const DEFAULT_LOG = join(homedir(), '.kimi-code', 'hooks', 'logs', 'superpowers_priming.dsh.log')
/** 本插件注入消息的 source.kind（会话日志里靠它判「补过没有」）。 */
const PRIME_SOURCE = 'superpowers-priming'
/** 桥接注入消息的 source.kind —— 老会话的开场说明就是这个来源，判重时必须一起认。 */
const BRIDGE_SOURCE = 'hooks-claude-code'
/** 视作「已经有开场说明」的来源集合。 */
const PRIMED_SOURCES = new Set([PRIME_SOURCE, BRIDGE_SOURCE])

/** 读取配置并填默认值；config 来自 profile patch 条目的 `config`。 */
function normalizeConfig(raw) {
  const c = raw ?? {}
  const sources = Array.isArray(c.sources)
    ? c.sources.filter((s) => s === 'startup' || s === 'resume')
    : ['resume']
  return {
    enabled: c.enabled !== false,
    dryRun: c.dryRun === true,
    // 默认只兜底 resume：startup 交给桥接，避免两边各注入一份
    sources: sources.length > 0 ? sources : ['resume'],
    skillPath: typeof c.skillPath === 'string' && c.skillPath.length > 0 ? c.skillPath : DEFAULT_SKILL_PATH,
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
  const s = String(sessionId)
  const cut = s.startsWith('session-') || s.startsWith('session_') ? s.slice(8) : s
  return cut.slice(0, 8)
}

/**
 * 判断某个 agent 的会话是否为子代理会话。
 * 与 dsh-memory / dsh-autocommit 同一套判定：SessionHeader 的 origin / delegationDepth。
 */
function isChildSession(agent) {
  const header = agent?.session?.header
  if (header === undefined) return false
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

/**
 * 会话日志里有没有「开场说明」。
 * 只看 user/message：注入都是以用户侧消息落盘的（桥接与本插件都是）。
 */
export function hasPriming(events) {
  if (!Array.isArray(events)) return false
  return events.some((event) => event?.type === 'user/message'
    && PRIMED_SOURCES.has(event?.data?.source?.kind))
}

/**
 * 拼装补注入的正文。
 * 首行标明执行者与本条为何出现（用户 2026-10-10 的约定：会话里的说明文字要能看出是谁写的）；
 * 之后整段照抄上游 hooks/session-start 的 <EXTREMELY_IMPORTANT> 包装，保持 priming 语义一致。
 */
export function buildPriming(skillText) {
  return [
    '[dsh-superpowers-priming] 本会话是重开（resume），历史里没有 superpowers 开场说明，补注入一次。',
    '',
    '<EXTREMELY_IMPORTANT>',
    'You have superpowers.',
    '',
    "**Below is the full content of your 'superpowers:using-superpowers' skill - your introduction to using skills. For all other skills, use the 'Skill' tool:**",
    '',
    skillText,
    '</EXTREMELY_IMPORTANT>',
  ].join('\n')
}

/**
 * 取会话历史读取服务（web/base profile 由 dsh-session-query-sqlite 提供）。
 * 用 ctx.get 取而不是声明 inject：服务缺失时应静默降级，而不是让整条插件行加载失败。
 */
function sessionQueryOf(ctx) {
  const viaGet = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined
  const query = viaGet ?? ctx?.sessionQuery
  return query !== undefined && typeof query.readSession === 'function' ? query : undefined
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = (...parts) => logLine(config.logPath, ...parts)
  log('plugin-loaded', `enabled=${config.enabled}`, `dryRun=${config.dryRun}`,
    `sources=${config.sources.join(',')}`, `skill=${config.skillPath}`)
  if (!config.enabled) return

  ctx.on('agent/created', async ({ agent, source }) => {
    const sessionId = agent?.session?.header?.id
    const who = sessionId === undefined ? 'session=?' : `session=${shortId(sessionId)}`
    try {
      // 只处理配置里声明的来源（默认 resume；startup 归桥接）
      if (!config.sources.includes(source)) return
      if (isChildSession(agent)) { log('skip:subagent', source, who); return }
      if (sessionId === undefined) { log('skip:no-session-id', source); return }
      const query = sessionQueryOf(ctx)
      if (query === undefined) { log('skip:no-session-query', source, who); return }
      let snapshot
      try {
        snapshot = await query.readSession(sessionId)
      } catch (error) {
        // 读失败宁可漏一次，也不要在每次重开时反复注入
        log('skip:read-failed', source, who, String(error))
        return
      }
      const events = snapshot?.events ?? []
      if (hasPriming(events)) {
        log('skip:already-primed', source, who, `events=${events.length}`)
        return
      }
      if (config.dryRun) { log('dry-run', source, who, `events=${events.length}`); return }
      const skillText = readFileSync(config.skillPath, 'utf8')
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: buildPriming(skillText) }],
        source: { kind: PRIME_SOURCE },
      }))
      log('inject', source, who, `events=${events.length}`, `bytes=${Buffer.byteLength(skillText, 'utf8')}`)
    } catch (error) {
      log('error:agent-created', String(error), who)
      ctx.logger?.warn?.(`dsh-superpowers-priming: 补注入失败: ${String(error)}`)
    }
  })
}
