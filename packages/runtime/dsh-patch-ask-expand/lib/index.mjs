// dsh-patch-ask-expand: 让 Web GUI 里「提问 / 回答」这一行默认展开。
//
// 要解决的问题：ask_user_question 渲染出来的那一行（标题「提问」，概要「N/M 已回答」）默认
// 是收起的，提问原文和用户当时的回答藏在 IN/OUT 卡片里，要点两次才看得到；而提问与回答
// 恰恰是会话里最该一眼看到的内容。
//
// 做法：@deepseek-ai/dsh-client-ui-tool 是 npm 上的成品包（本机没有对应源码，仓库 checkout
// 也不含该包），所以只能在它实际被 dsh web 服务的 lib/client.js 上打一个幂等的文本补丁：
// 把「提问」行算 open 的那一行改成 `expandable && (expanded || askDefaultOpen && !askDismissed)`
// —— 带问答记录的行默认展开，用户第一次点击后展开态完全交还组件自身。
// 必须同时改两个组件：QuestionToolRow（有可回看记录时走它）与通用 ToolRow（没有记录时走它，
// 本机实测的常见分支），判定条件分别是 askQuestion / askQuestionBody 非空，因此不会波及其它工具行。
// 详细说明与踩坑记录见 lib/patch.mjs 的头部注释。
//
// 生效链路：dsh web 的 webserver 自己 stat-poll 它服务的 client bundle，文件内容一变就重算
// rev 并广播，客户端重新拉取 → 无需重启、无需编译。本插件因此**不负责**广播，只负责把文件
// 改对；同一份内容只写一次，不会触发无谓的热重载。
//
// 已知边界（不是本插件能解决的，换取值前请先看 docs/plan 里的记录）：
//   1. 补丁文件属于全局安装的成品包，npm 重装/升级会覆盖 —— 默认在每次 dsh web 启动时重打，
//      reapply: true 可再开定时兜底（默认关闭）。
//   2. 提问行所在的过程分组、以及已完成轮次的整轮折叠，是 dsh 自己的展示策略
//      （transcriptView 模式表：compact/standard/detailed 都会 foldCompletedTurns）。
//      本插件只让"行内的问答"默认可见，不改变"分组/整轮"是否收起。
//
// 移除方式：从 profile patch 删掉 insert 条目，再把 lib/client.js.orig 覆盖回 lib/client.js
// （或直接 `pnpm i` / 重装该包），然后刷新页面。

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyPatch, isPatched, restoreOriginal } from './patch.mjs'

export const name = 'dsh-patch-ask-expand'
/** 纯文件补丁，不依赖任何服务注入。 */
export const inject = []

/** profile 的 @deepseek-ai/* 是指向全局安装的符号链接，用逻辑路径书写，读取时自然解析到真实文件。 */
const DEFAULT_BUNDLE = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-ui-tool', 'lib', 'client.js')
/** 与 kimi hook 日志同族目录，便于统一查看。 */
const DEFAULT_LOG = join(homedir(), '.kimi-code', 'hooks', 'logs', 'patch_ask_expand.log')

/**
 * 归一化 profile patch 传进来的 config。
 * @param {unknown} raw - 插件 config（可能为 undefined）。
 * @returns 补全默认值后的配置。
 */
function normalizeConfig(raw) {
  const c = raw ?? {}
  return {
    disable: c.disable === true,
    bundlePath: typeof c.bundlePath === 'string' && c.bundlePath.length > 0 ? c.bundlePath : DEFAULT_BUNDLE,
    logPath: typeof c.logPath === 'string' && c.logPath.length > 0 ? c.logPath : DEFAULT_LOG,
    reapply: c.reapply === true,
    reapplyMs: Number.isInteger(c.reapplyMs) && c.reapplyMs >= 1000 ? c.reapplyMs : 5000,
  }
}

/**
 * 追加一行日志（同时尝试走 ctx.logger，失败不影响补丁本身）。
 * @param {object} ctx - Cordis 上下文。
 * @param {string} line - 日志正文。
 * @param {string} logPath - 日志文件路径。
 */
function log(ctx, line, logPath) {
  const stamp = new Date().toISOString()
  const text = `[${stamp}] ${line}\n`
  try {
    ctx?.logger?.info?.(text.trimEnd())
  } catch {
    // ctx.logger 形态不保证，落盘那份才是权威记录。
  }
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(logPath, text, { flag: 'a' })
  } catch {
    // 日志写不进去不能影响补丁生效。
  }
}

/**
 * 原子写入：先写同目录临时文件再 rename，避免 HMR 读到半截内容。
 * @param {string} path - 目标文件。
 * @param {string} code - 新内容。
 */
function writeAtomic(path, code) {
  const tmp = `${path}.patch-tmp`
  writeFileSync(tmp, code, { mode: statSync(path).mode & 0o777 })
  renameSync(tmp, path)
}

/**
 * 对一份 bundle 执行"需要就打补丁"，必要时落盘。
 * @param {object} ctx - Cordis 上下文。
 * @param {{bundlePath: string, logPath: string}} config - 归一化配置。
 * @returns {boolean} 本次是否改写了文件。
 */
function patchOnce(ctx, config) {
  const { bundlePath, logPath } = config
  if (!existsSync(bundlePath)) {
    log(ctx, `跳过：找不到补丁目标 ${bundlePath}（dsh 包布局变了，请更新 bundlePath）`, logPath)
    return false
  }
  const source = readFileSync(bundlePath, 'utf8')
  if (isPatched(source)) return false
  const { code, changed, reason, applied } = applyPatch(source)
  if (!changed) {
    log(ctx, `跳过：${reason}（未改动文件）。dsh-client-ui-tool 可能已升级，请核对 ToolRow/QuestionToolRow 的 expandable/open 写法后更新锚点。`, logPath)
    return false
  }
  if (reason.startsWith('anchor-')) {
    log(ctx, `警告：锚点没对上（${reason}），只完成了旧版残留清理，请核对 ToolRow/QuestionToolRow 的 expandable/open 写法后更新补丁规则。`, logPath)
  }
  // 备份语义：.orig 必须恒为「官方原件」，否则"回滚"会退成上一版补丁。
  // 只有这一次读到的 source 本身就是官方原文（reason === 'patched'）时才敢直接复制；
  // 若是补丁版本迁移（migrated-legacy）等情形，就逆向规则表还原官方内容，
  // 还原不出来则保留既有备份，绝不拿补丁态去覆盖。
  const backup = `${bundlePath}.orig`
  let backupText = null
  if (reason === 'patched') backupText = source
  else if (!existsSync(backup)) backupText = restoreOriginal(source)
  try {
    if (backupText !== null) writeFileSync(backup, backupText)
    writeAtomic(bundlePath, code)
  } catch (error) {
    log(ctx, `失败：写入 ${bundlePath} 出错 —— ${error?.message ?? error}`, logPath)
    return false
  }
  const delta = Buffer.byteLength(code) - Buffer.byteLength(source)
  log(ctx, `已打补丁：${bundlePath}（${delta >= 0 ? '+' : ''}${delta} 字节，规则 ${applied.join(',') || reason}，补丁前内容备份为 ${backup}${backupText === null ? '（保留原有备份）' : ''}）。dsh web 的 HMR 会自动重算 rev 并让浏览器重新拉取。`, logPath)
  return true
}

/**
 * 插件入口：启动时打一次，可选定时兜底（应对成品包被重装覆盖）。
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} raw - profile patch 里的 config。
 */
export function apply(ctx, raw) {
  const config = normalizeConfig(raw)
  if (config.disable) {
    log(ctx, '已按 config.disable 跳过补丁。', config.logPath)
    return
  }
  patchOnce(ctx, config)
  if (!config.reapply) return
  // 兜底轮询：只在内容真的变了才写文件，因此不会自己把自己反复热重载。
  const timer = setInterval(() => {
    try {
      patchOnce(ctx, config)
    } catch (error) {
      log(ctx, `兜底轮询异常：${error?.message ?? error}`, config.logPath)
    }
  }, config.reapplyMs)
  ctx?.effect?.(() => () => clearInterval(timer))
}

/** 测试与排障用：暴露给外部直接调用。 */
export const __internals = { normalizeConfig, patchOnce, writeAtomic }
