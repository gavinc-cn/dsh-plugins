// dsh-patch-unsent-session: 让侧栏继续显示「写过草稿但还没发送」的新会话。
//
// 要解决的问题：官方 @deepseek-ai/dsh-client-ui-workspace 只显示**当前选中**的 blank Session，
// 用户在新会话里写了草稿、切到别的会话后，这一行就从侧栏消失（草稿本身还留在 localStorage）。
// 本插件在 dsh 启动时对它的 client bundle 打一个幂等文本补丁：
//   * sessionVisible()：blank 会话只要有非空草稿就保留在侧栏；
//   * displayTitle()：这类行的标题显示草稿首行，便于区分多个未发送会话。
//
// 与 dsh-patch-ask-expand 相同的原因：@deepseek-ai/* 是 npm 上的成品包，本机没有对应源码，
// 只能在 webserver 实际服务的 lib/client.js 上改文本。
//
// 生效链路：dsh web 的 webserver 会 stat-poll 它服务的 client bundle，文件内容一变就重算 rev
// 并广播，客户端重新拉取 → 无需重启、无需编译。本插件因此**不负责**广播，只负责把文件改对；
// 同一份内容只写一次，不会触发无谓的热重载。
//
// 已知边界：
//   1. 补丁文件属于全局安装的成品包，npm 重装/升级会覆盖 —— 默认在每次 dsh web 启动时重打，
//      reapply: true 可再开定时兜底（默认关闭）。
//   2. 纯附件草稿（没有文字/引用）本来就不进 localStorage，侧栏不会为它保留行。
//
// 移除方式：从 profile patch 删掉 insert 条目，再把 lib/client.js.orig 覆盖回 lib/client.js
// （或重装 dsh-client-ui-workspace），然后刷新页面。

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyPatch, BUNDLE_RELATIVE_PATH, isPatched, restoreOriginal } from './patch.mjs'

export const name = 'dsh-patch-unsent-session'
/** 纯文件补丁，不依赖任何服务注入。 */
export const inject = []

/** profile 的 @deepseek-ai/* 是指向全局安装的符号链接，用逻辑路径书写，读取时自然解析到真实文件。 */
const DEFAULT_BUNDLE = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', BUNDLE_RELATIVE_PATH)
/** 与 kimi hook 日志同族目录，便于统一查看。 */
const DEFAULT_LOG = join(homedir(), '.kimi-code', 'hooks', 'logs', 'patch_unsent_session.log')

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
    log(ctx, `跳过：${reason}（未改动文件）。dsh-client-ui-workspace 可能已升级，请核对 sessionVisible/displayTitle 写法后更新锚点。`, logPath)
    return false
  }
  // 备份语义：.orig 必须恒为「官方原件」，否则"回滚"会退成上一版补丁。
  // 只有这一次读到的 source 本身就是官方原文（reason === 'patched'）时才敢直接复制；
  // 若是补丁版本迁移等情形，就逆向规则表还原官方内容，还原不出来则保留既有备份。
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
