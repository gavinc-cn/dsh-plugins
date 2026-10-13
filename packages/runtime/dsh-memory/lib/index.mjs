// @gavinc-cn/dsh-memory —— DSH 原生跨会话记忆插件（注入索引 + 限流提示回顾）
//
// 为什么做成插件而不是继续用 hook：
//   DSH 的 hook 子进程走 dsh-hook-protocol.runHook() → bash.execute()，请求里不带 sandboxPolicy，
//   `@deepseek-ai/dsh-bash-sandbox` 回退到部署级默认沙箱（工作区可写、root=进程 cwd），实测
//   只有 /tmp 可写：写 `~/.agents/memory/.injected` 直接 PermissionError，被脚本 fail-open 吞掉
//   → 既不注入也不留哨兵，且无任何报错（2026-10-08 探针实测）。插件跑在 harness 进程内，
//   不受这层沙箱约束。
//
// 两个扩展点与 kimi 侧 hook 一一对应：
//   UserPromptSubmit（memory_inject.py） → agent/pre-step：把 <memory> 块追加成一条用户消息
//   Stop（memory_review.py）            → agent/turn-stopping：agent.steer 一步让模型回顾
//
// 记忆根：~/.agents/memory（2026-10-08 由 ~/.kimi-code/memory 迁来；与 kimi code、DSH desktop
// 共用同一份，`.agents/**` 在 mutagen 白名单内，容器 ⇄ Windows 双向同步）。

import { execFileSync } from 'node:child_process'
import {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-memory'

/** 记忆根与日志的默认位置（与 kimi 侧同源；日志留在 hooks/logs 里跟其它 hook 一起看）。 */
const DEFAULT_MEMORY_ROOT = join(homedir(), '.agents', 'memory')
const DEFAULT_LOG = join(homedir(), '.kimi-code', 'hooks', 'logs', 'memory.dsh.log')

const MAX_LINES = 200
const MAX_BYTES = 25 * 1024
const SENTINEL_TTL_MS = 7 * 24 * 3600 * 1000
const GIT_TIMEOUT_MS = 2000
/** 注入与 steer 消息的来源标记（会话日志里靠它判定"记忆注入过"）。 */
const SOURCE_KIND = 'kimi-memory'

/**
 * 收尾回顾提示（一行，前缀标明执行者插件）。
 * 与 memory_review.py 的 REVIEW_PROMPT 同义，只有前缀不同（各自标明是谁写的话）。
 */
const REVIEW_PROMPT = '[dsh-memory] 会话收尾回顾：有值得跨会话保留的信息'
  + '（命令/调试经验/架构决策/用户偏好）就调用 memory skill 写入（先读索引）；'
  + '没有就直接结束，不要输出额外内容。'

/** 读取配置并填默认值；config 来自 profile patch 条目的 `config`。 */
function normalizeConfig(raw) {
  const c = raw ?? {}
  return {
    enabled: c.enabled !== false,
    dryRun: c.dryRun === true,
    memoryRoot: typeof c.memoryRoot === 'string' && c.memoryRoot.length > 0 ? c.memoryRoot : DEFAULT_MEMORY_ROOT,
    reviewInterval: Number.isInteger(c.reviewInterval) && c.reviewInterval > 0 ? c.reviewInterval : 4,
    maxInjections: Number.isInteger(c.maxInjections) && c.maxInjections > 0 ? c.maxInjections : 8,
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

/** 过滤 session_id 中的非文件名字符（与 memory_inject.py:_sanitize 同规则）。 */
function sanitize(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, '_')
}

/** 会话 id 缩写，仅供日志阅读：去掉 session- / session_ 前缀后取前 8 位。 */
function shortId(sessionId) {
  return String(sessionId).replace(/^session[-_]/, '').slice(0, 8)
}

/** 保留前 maxLines 行且总字节数 ≤ maxBytes；按行截断，不拆多字节字符（同 Python 版口径）。 */
function truncateIndex(text, maxLines = MAX_LINES, maxBytes = MAX_BYTES) {
  const out = []
  let used = 0
  for (const line of text.split('\n').slice(0, maxLines)) {
    const size = Buffer.byteLength(line, 'utf8') + 1 // +1 为换行符
    if (used + size > maxBytes) break
    out.push(line)
    used += size
  }
  return out.join('\n')
}

/** 读取并截断索引文件；不存在、不可读或内容为空时返回 null。 */
function readIndex(path) {
  try {
    const text = truncateIndex(readFileSync(path, 'utf8'))
    return text.trim().length > 0 ? text : null
  } catch {
    return null
  }
}

/** git 根绝对路径的 '/'→'_' 编码；非 git 仓库退回 cwd（同 memory_inject.py:project_key）。 */
function projectKey(cwd) {
  let root = String(cwd ?? '')
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out.length > 0) root = out
  } catch {
    /* 非 git 仓库 / 超时 → 用 cwd */
  }
  return root.replaceAll('/', '_')
}

/** 拼装 <memory> 注入块；两级索引都缺失时返回 undefined。 */
function buildInjection(memoryRoot, cwd) {
  const globalIndex = readIndex(join(memoryRoot, 'global', 'MEMORY.md'))
  const key = projectKey(cwd)
  const projectIndex = readIndex(join(memoryRoot, 'projects', key, 'MEMORY.md'))
  if (globalIndex === null && projectIndex === null) return undefined
  const parts = ['<memory>']
  if (globalIndex !== null) parts.push(`## 全局记忆索引\n\n${globalIndex}`)
  if (projectIndex !== null) parts.push(`## 项目记忆索引（${key}）\n\n${projectIndex}`)
  parts.push('</memory>')
  return parts.join('\n\n')
}

/** 删除目录内 mtime 超过 7 天的文件（目录不存在或不可读时静默）。 */
function cleanupSentinels(dir, now = Date.now()) {
  try {
    for (const entry of readdirSync(dir)) {
      try {
        if (now - statSync(join(dir, entry)).mtimeMs > SENTINEL_TTL_MS) unlinkSync(join(dir, entry))
      } catch {
        /* 单个文件处理失败不影响其它文件 */
      }
    }
  } catch {
    /* 目录不存在等 → 忽略 */
  }
}

/** 建目录；失败时记 error 日志并返回 false（调用方自行决定降级策略）。 */
function ensureDir(dir, log, sessionId) {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch (error) {
    log('error:sentinel', shortId(sessionId), String(error))
    return false
  }
}

/**
 * 原子创建注入哨兵；返回 true 表示"本会话已注入过"。
 * 哨兵写失败不阻断注入（退化为每次注入一遍），但要留下 error 日志。
 */
function alreadyInjected(memoryRoot, sessionId, log) {
  const dir = join(memoryRoot, '.injected')
  if (!ensureDir(dir, log, sessionId)) return false
  try {
    closeSync(openSync(join(dir, sanitize(sessionId)), 'wx'))
    return false
  } catch (error) {
    if (error?.code === 'EEXIST') return true
    log('error:sentinel', shortId(sessionId), String(error))
    return false
  }
}

/**
 * 回顾限流：先累计本次 Stop 次数，再判定是否注入。
 * 与 memory_review.py:maybe_inject 同口径 —— 第 1、1+interval… 次注入，
 * 累计达到 maxInjections*interval 次 Stop 后停止。
 * 状态写不了时返回 { inject: false }（宁可漏一次回顾，也不能因失去限流而反复 steer）。
 * @returns {{inject: boolean, stop: number}}
 */
function maybeReview(memoryRoot, sessionId, config, log) {
  const dir = join(memoryRoot, '.reviewed')
  if (!ensureDir(dir, log, sessionId)) return { inject: false, stop: 0 }
  const path = join(dir, sanitize(sessionId))
  let count = 0
  try {
    const parsed = Number.parseInt(readFileSync(path, 'utf8'), 10)
    if (Number.isInteger(parsed) && parsed > 0) count = parsed
  } catch {
    count = 0
  }
  try {
    writeFileSync(path, String(count + 1), 'utf8')
  } catch (error) {
    log('error:sentinel', shortId(sessionId), String(error))
    return { inject: false, stop: count + 1 }
  }
  if (count >= config.maxInjections * config.reviewInterval) return { inject: false, stop: count + 1 }
  return { inject: count % config.reviewInterval === 0, stop: count + 1 }
}

/**
 * 子代理会话判定（沿用 dsh-autocommit 的 isChildSession）：
 * 子代理不注入、不回顾、不写哨兵——避免哨兵污染与无谓 token。
 */
function isChildSession(agent) {
  const header = agent?.session?.header
  if (header === undefined) return false
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const memoryRoot = config.memoryRoot
  const log = (...parts) => logLine(config.logPath, ...parts)

  log('plugin-loaded', `enabled=${config.enabled}`, `dryRun=${config.dryRun}`, `memoryRoot=${memoryRoot}`)

  // ① UserPromptSubmit 等价物：本会话首次提交 prompt 时，把两级记忆索引追加成一条用户消息。
  //    姿势与 DSH 自带 claude-code 桥接一致（先跑下游 next()，再决定是否追加消息）。
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const downstream = await next()
    try {
      const sessionId = agent?.session?.header?.id
      if (sessionId === undefined) return downstream
      if (!config.enabled) { log('skip:disabled', 'pre-step', shortId(sessionId)); return downstream }
      if (isChildSession(agent)) { log('skip:subagent', 'pre-step', shortId(sessionId)); return downstream }
      if (messages.length === 0) { log('skip:no-messages', shortId(sessionId)); return downstream }
      if (downstream?.kind !== 'enter') return downstream
      if (config.dryRun) { log('dry-run', 'inject', shortId(sessionId)); return downstream }
      cleanupSentinels(join(memoryRoot, '.injected'))
      if (alreadyInjected(memoryRoot, sessionId, log)) {
        log('skip:already-injected', shortId(sessionId))
        return downstream
      }
      const block = buildInjection(memoryRoot, agent?.session?.header?.cwd)
      if (block === undefined) { log('skip:empty-index', shortId(sessionId)); return downstream }
      log('inject', shortId(sessionId), `bytes=${Buffer.byteLength(block, 'utf8')}`)
      return {
        ...downstream,
        messages: [...downstream.messages, createUserMessage({
          content: [{ type: 'text', text: block }],
          source: { kind: SOURCE_KIND },
        })],
      }
    } catch (error) {
      log('error:pre-step', String(error))
      ctx.logger?.warn?.(`dsh-memory: pre-step 注入失败: ${String(error)}`)
      return downstream
    }
  })

  // ② Stop 等价物：按限流 steer 一步，让模型回顾本次会话并写记忆。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      const sessionId = agent?.session?.header?.id
      if (sessionId === undefined) return
      if (!config.enabled) { log('skip:disabled', 'stop', shortId(sessionId)); return }
      if (isChildSession(agent)) { log('skip:subagent', 'stop', shortId(sessionId)); return }
      if (config.dryRun) { log('dry-run', 'review', shortId(sessionId)); return }
      cleanupSentinels(join(memoryRoot, '.reviewed'))
      const { inject, stop } = maybeReview(memoryRoot, sessionId, config, log)
      if (!inject) { log('skip:rate-limited', shortId(sessionId), `stop=${stop}`); return }
      log('review', shortId(sessionId), `stop=${stop}`)
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: REVIEW_PROMPT }],
        source: { kind: SOURCE_KIND },
      }))
    } catch (error) {
      log('error:turn-stopping', String(error))
      ctx.logger?.warn?.(`dsh-memory: 回顾提示失败: ${String(error)}`)
    }
  })
}
