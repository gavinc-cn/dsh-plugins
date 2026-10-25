// dsh-write-guard 的脚本引用识别与读取模块（spec §5.9）。
//
// 职责：当 shell 命令因「引用了脚本文件」而无法静态判定时，把命令实际会执行的脚本内容读出来，
// 交给上层（decide → judge）判断文件效果：
//   * `detectScriptRefs`：**纯词法**识别命令里的脚本引用（解释器 + 脚本参数、直接执行路径、
//     `source`/`.`、shell 解释器的输入重定向），段间维护 `cd` 后的有效 cwd；不读写磁盘；
//   * `inspectScripts`：在词法结果上做受限读取——只读 project/whitelist/temp 内的普通文件
//     （realpath 归一化后校验，软链逃逸不读）、单文件 ≤ `maxBytes`、总量有预算、二进制拒绝；
//     读取成功返回 `{path, interpreter, sha256, bytes, content}`，失败逐条记 `skipped`。
//
// 设计约束：
//   * **不新增信任来源**：本模块只提供「内容」，判定仍由 decide/judge 做；读不到/读不全时保持
//     原有的保守路径（unanalyzable → judge → ask）；
//   * **不执行脚本**：只 readFileSync；脚本内容在 judge 侧同样按不可信数据处理；
//   * **只读放行面内的脚本**：项目/白名单/临时区之外的脚本一律不自动读入（不把外部文件内容
//     送进模型上下文），按 `outside-roots` 跳过；
//   * 纯词法与磁盘读取分开导出，词法层可单测且不碰磁盘；
//   * TOCTOU：读到执行之间脚本仍可能被改（命令级闸门的固有残留，文档化在 README 已知限制）。
//
// spec 对应：§5.9 脚本内容判定；配合 §4.3-③ unanalyzable 分支与 §5.4 AI 判定输入。

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { tokenizeShell } from '@gavinc-cn/dsh-path-rules/analyze'
import { normalizePath, underRoot } from '@gavinc-cn/dsh-path-rules/rules'
import { baseNameOf, commandWordIndex } from './shellwords.mjs'

/** 单条命令最多读取的脚本数；超出的引用记 `too-many` 跳过。 */
export const MAX_SCRIPTS = 3

/** 多个脚本内容的总字节预算；超出后剩余引用记 `budget-exceeded` 跳过。 */
export const MAX_SCRIPT_TOTAL_BYTES = MAX_SCRIPTS * 16384

/** 识别递归深度上限（与 decide.mjs 的建链扫描同口径，防病态嵌套）。 */
const MAX_RISK_NESTING = 3

/** wrapper 命令：命令词是它们时，真正执行的是后面的命令词。 */
const WRAPPER_COMMANDS = new Set(['exec', 'command', 'builtin', 'nohup', 'time', 'sudo', 'doas'])

/** 带「时长 + 命令」的 wrapper：`timeout 10 bash x.sh`。 */
const TIMEOUT_COMMANDS = new Set(['timeout', 'gtimeout'])

/** shell 解释器（`-c` 是内联代码，本层跳过并把内层文本递归交给脚本识别）。 */
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'])

/** pwsh 解释器（`-Command`/`-c` 内联，`-File` 后是脚本）。 */
const PWSH_INTERPRETERS = new Set(['pwsh', 'powershell'])

/** 其它脚本解释器：`-e`/`-c` 等内联开关按各自规则跳过，首个非选项词视为脚本。 */
const SCRIPT_INTERPRETERS = new Set(['node', 'nodejs', 'perl', 'ruby', 'php', 'deno', 'bun'])

/** shell 解释器里带取值的选项：值不是脚本路径（`bash -o pipefail x.sh`）。 */
const SHELL_VALUE_FLAGS = new Set(['-o', '+o', '--rcfile', '--init-file'])

/** python 解释器里带取值的选项（`-W error`、`-X dev`）。 */
const PYTHON_VALUE_FLAGS = new Set(['-W', '-X', '-Q'])

/** node 解释器里带取值的选项：值不是脚本路径。 */
const NODE_VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--conditions',
  '-C',
])

/** node 只做语法检查/求值的开关：不执行脚本文件，本层不读。 */
const NODE_NO_SCRIPT_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c', '--check'])

/** deno/bun 的子命令：`deno run x.ts` 的 `run` 不是脚本。 */
const DENO_SUBCOMMANDS = new Set(['run', 'test', 'bench', 'task', 'compile', 'bundle'])
const DENO_NO_SCRIPT_SUBCOMMANDS = new Set(['eval', 'repl', 'check', 'fmt', 'lint', 'init'])

/** 直接执行路径的写法：含分隔符，或以 `.` 开头（`./x.sh`、`../x.sh`、`/tmp/x.sh`）。 */
const PATH_LIKE_RE = /[\\/]/

/**
 * 把一个解释器命令词归一成「解释器种类」。
 *
 * @param {string} command - 已小写化的命令词 basename（如 `bash` / `python3.11`）。
 * @returns {'shell'|'pwsh'|'script'|null} 解释器种类；不是解释器返回 null。
 */
function interpreterKind(command) {
  if (SHELL_INTERPRETERS.has(command)) return 'shell'
  if (PWSH_INTERPRETERS.has(command)) return 'pwsh'
  if (SCRIPT_INTERPRETERS.has(command)) return 'script'
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(command)) return 'script'
  if (/^deno(?:\d+)?$/.test(command)) return 'script'
  return null
}

/**
 * 跳过 wrapper（`exec`/`nohup`/`time`/`timeout` 等）找到真正执行的命令词下标。
 *
 * 只做保守的「跳过 wrapper 自身的选项」；遇到不认识的结构就停在原地，让上层按
 * 「找不到脚本引用」处理（保守方向：不读、交 unanalyzable）。
 *
 * @param {string[]} words - 段内普通词。
 * @param {number} index - `commandWordIndex` 给出的命令词下标。
 * @returns {number} 真正命令词下标；越界返回 -1。
 */
function realCommandIndex(words, index) {
  let current = index
  for (let hops = 0; hops < 4; hops += 1) {
    if (current < 0 || current >= words.length) return -1
    const command = baseNameOf(words[current]).toLowerCase()
    if (TIMEOUT_COMMANDS.has(command)) {
      current += 1
      while (current < words.length && words[current].startsWith('-')) current += 1
      current += 1 // 时长
      while (current < words.length && words[current].startsWith('-')) current += 1
      continue
    }
    if (WRAPPER_COMMANDS.has(command)) {
      current += 1
      while (current < words.length && words[current].startsWith('-')) current += 1
      continue
    }
    return current
  }
  return current < words.length ? current : -1
}

/**
 * 从解释器参数里取脚本参数（不同解释器的选项规则不同）。
 *
 * @param {string[]} words - 段内普通词。
 * @param {number} start - 解释器命令词之后的下标。
 * @param {'shell'|'pwsh'|'script'} kind - 解释器种类。
 * @param {string} command - 解释器命令词（小写 basename，用来区分 python/node/deno/bun）。
 * @returns {{scripts?:string[], inline?:string, none?:true}|null} 脚本参数列表 / 内联文本 / 无脚本。
 */
function scriptArgsOf(words, start, kind, command) {
  if (kind === 'shell') return shellScriptArg(words, start)
  if (kind === 'pwsh') return pwshScriptArg(words, start)
  if (command === 'node' || command === 'nodejs') return nodeScriptArgs(words, start)
  if (/^python/.test(command)) return pythonScriptArg(words, start)
  if (command === 'deno' || /^deno\d+$/.test(command) || command === 'bun') {
    return denoScriptArgs(words, start)
  }
  // perl/ruby/php：`-e` 是内联代码（perl/ruby），`-r` 是 php 的 require；其余选项跳过。
  const inlineFlags = new Set(['-e', '--eval', '-r', '--require'])
  let index = start
  while (index < words.length) {
    const word = words[index]
    if (word === '--') {
      index += 1
      break
    }
    if (inlineFlags.has(word)) return { inline: '' }
    if (word.startsWith('-')) {
      index += 1
      continue
    }
    break
  }
  return index < words.length ? { scripts: [words[index]] } : null
}

/** shell 解释器：`--` 之后或首个非选项词是脚本；`-c` 是内联代码。 */
function shellScriptArg(words, start) {
  let index = start
  while (index < words.length) {
    const word = words[index]
    if (word === '--') {
      index += 1
      break
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) return { inline: words.slice(index + 1).join(' ') }
    if (SHELL_VALUE_FLAGS.has(word)) {
      index += 2
      continue
    }
    if (!word.startsWith('-')) break
    index += 1
  }
  return index < words.length ? { scripts: [words[index]] } : null
}

/** pwsh：`-Command`/`-c` 内联；`-File` 后是脚本；首个非选项词是脚本。 */
function pwshScriptArg(words, start) {
  let index = start
  while (index < words.length) {
    const word = words[index].toLowerCase()
    if (words[index] === '--') {
      index += 1
      break
    }
    if (word === '-command' || word === '--command' || word === '-c') {
      return { inline: words.slice(index + 1).join(' ') }
    }
    if (word === '-file' || word === '--file' || word === '-f') {
      index += 1
      break
    }
    if (!word.startsWith('-')) break
    index += 1
  }
  return index < words.length ? { scripts: [words[index]] } : null
}

/** node：`-e/-p/-c` 不执行文件；`--test` 后面的路径都算脚本；其余首个非选项词是脚本。 */
function nodeScriptArgs(words, start) {
  let index = start
  const scripts = []
  let testMode = false
  while (index < words.length) {
    const word = words[index]
    if (word === '--') {
      index += 1
      break
    }
    if (NODE_NO_SCRIPT_FLAGS.has(word)) return { none: true }
    if (word === '--test') {
      testMode = true
      index += 1
      continue
    }
    if (NODE_VALUE_FLAGS.has(word)) {
      index += 2
      continue
    }
    if (word.startsWith('-')) {
      index += 1
      continue
    }
    scripts.push(word)
    if (!testMode) break
    index += 1
  }
  return scripts.length > 0 ? { scripts } : null
}

/** python：`-c` 内联、`-m` 模块、`-` stdin；其余首个非选项词是脚本。 */
function pythonScriptArg(words, start) {
  let index = start
  while (index < words.length) {
    const word = words[index]
    if (word === '--') {
      index += 1
      break
    }
    if (word === '-c' || word === '--command' || word === '-m') return { none: true }
    if (word === '-') return { none: true }
    if (PYTHON_VALUE_FLAGS.has(word)) {
      index += 2
      continue
    }
    if (word.startsWith('-')) {
      index += 1
      continue
    }
    break
  }
  return index < words.length ? { scripts: [words[index]] } : null
}

/** deno/bun：子命令 `run`/`test` 后是脚本；`eval`/`check`/`fmt` 等不执行文件。 */
function denoScriptArgs(words, start) {
  let index = start
  while (index < words.length && words[index].startsWith('-')) index += 1
  if (index >= words.length) return null
  const sub = words[index].toLowerCase()
  if (DENO_NO_SCRIPT_SUBCOMMANDS.has(sub)) return { none: true }
  if (DENO_SUBCOMMANDS.has(sub)) {
    index += 1
    while (index < words.length && words[index].startsWith('-')) index += 1
  }
  return index < words.length ? { scripts: [words[index]] } : null
}

/**
 * 把脚本参数解析成「绝对路径」；无法静态解析时记进 skipped（不猜）。
 *
 * @param {string} raw - 脚本参数（原样）。
 * @param {string|null} base - 当前有效 cwd；null 表示 `cd` 目标不可解析。
 * @param {string[]} skipped - 跳过原因收集数组。
 * @returns {string|null} 绝对路径；无法解析返回 null。
 */
function resolveScriptArg(raw, base, skipped) {
  const token = String(raw ?? '')
  if (token.length === 0 || token === '-') {
    skipped.push({ reason: 'stdin', detail: token })
    return null
  }
  if (token.startsWith('~')) {
    skipped.push({ reason: 'tilde-path', detail: token })
    return null
  }
  if (token.includes('$')) {
    skipped.push({ reason: 'expansion', detail: token })
    return null
  }
  if (isAbsolute(token)) return token
  if (base === null) {
    skipped.push({ reason: 'cwd-unknown', detail: token })
    return null
  }
  return resolve(base, token)
}

/**
 * 读取并归一化 `cd` 的目标；无法静态解析时返回 null（后续相对脚本路径按 cwd-unknown 跳过）。
 *
 * @param {string} token - `cd` 的参数（原样）。
 * @param {string|null} base - 当前有效 cwd。
 * @returns {string|null} 新的绝对 cwd；解析不了返回 null。
 */
function resolveCdTarget(token, base) {
  const text = String(token ?? '')
  if (text.length === 0 || text === '-' || text.startsWith('~') || text.includes('$')) return null
  if (isAbsolute(text)) return resolve(text)
  if (base === null) return null
  return resolve(base, text)
}

/**
 * 纯词法识别一条 shell 命令里引用的脚本（不读写磁盘）。
 *
 * 识别范围：
 *   * 解释器 + 脚本参数：`bash x.sh` / `node x.mjs` / `python3 x.py` / `pwsh -File x.ps1`…；
 *   * 直接执行路径：`./x.sh`、`/tmp/x.sh`（解释器记为 `direct`，读取时再按 shebang 解析）；
 *   * `source` / `.`（记为 `source`）与 shell 解释器的输入重定向（`bash < x.sh`）；
 *   * wrapper 后的真实命令（`env` / `exec` / `nohup` / `time` / `timeout`）；
 *   * 段间 `cd` 后的有效 cwd；内层命令（`bash -c "…"`、`$(…)`/反引号）递归识别（≤3 层）。
 *
 * @param {string} command - 原始命令文本。
 * @param {{cwd?:string, shell?:string}} [options] - cwd 为解析基准；shell 目前不改变词法规则。
 * @returns {{refs:{path:string, interpreter:string}[], skipped:{reason:string, detail:string}[]}}
 *   `refs` 按命令顺序去重；`skipped` 记录无法静态解析的成分（原因 + 原始片段）。
 */
export function detectScriptRefs(command, { cwd, shell } = {}) {
  const baseCwd = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : process.cwd()
  const refs = []
  const skipped = []
  const seen = new Set()

  /**
   * 递归扫描一段命令文本。
   *
   * @param {string} text - 命令文本（顶层或内层）。
   * @param {string|null} base - 当前有效 cwd。
   * @param {number} depth - 递归层数。
   */
  function walk(text, base, depth) {
    if (typeof text !== 'string' || text.trim().length === 0) return
    if (depth > MAX_RISK_NESTING) {
      skipped.push({ reason: 'nested-too-deep', detail: String(text).slice(0, 80) })
      return
    }
    let tokenized
    try {
      tokenized = tokenizeShell(text)
    } catch {
      skipped.push({ reason: 'tokenize-error', detail: String(text).slice(0, 80) })
      return
    }
    if (tokenized?.error) {
      // 词法层已认为命令不可解析：不猜脚本路径（保守方向），交给 unanalyzable 原路径。
      skipped.push({ reason: 'tokenize-error', detail: String(text).slice(0, 80) })
      return
    }
    let currentBase = base
    for (const segment of Array.isArray(tokenized?.segments) ? tokenized.segments : []) {
      const words = Array.isArray(segment?.words) ? segment.words : []
      const index = commandWordIndex(words)

      // 内层命令（命令替换/反引号）先扫描：它们会真实执行。shell 变量展开后的内层文本
      // 仍按同一 base 解析相对路径。
      for (const substitution of Array.isArray(segment?.substitutions) ? segment.substitutions : []) {
        walk(substitution, currentBase, depth + 1)
      }

      if (index === -1) continue

      const rawCommand = words[index]
      const commandName = baseNameOf(rawCommand).toLowerCase()

      // `cd`：维护段间有效 cwd；目标不可解析时后续相对路径一律 cwd-unknown。
      if (commandName === 'cd' || commandName === 'set-location' || commandName === 'sl') {
        const arg = words.slice(index + 1).find((word) => !word.startsWith('-'))
        currentBase = arg === undefined ? null : resolveCdTarget(arg, currentBase)
        continue
      }

      // `source` / `.`：被引用的脚本会真实执行。
      if (commandName === 'source' || commandName === '.') {
        const arg = words.slice(index + 1).find((word) => !word.startsWith('-'))
        if (arg !== undefined) {
          const path = resolveScriptArg(arg, currentBase, skipped)
          if (path !== null && !seen.has(path)) {
            seen.add(path)
            refs.push({ path, interpreter: 'source' })
          }
        }
        continue
      }

      const realIndex = realCommandIndex(words, index)
      if (realIndex === -1) continue
      const realCommand = baseNameOf(words[realIndex]).toLowerCase()
      const kind = interpreterKind(realCommand)

      if (kind === null) {
        // 直接执行路径（`./x.sh`、`/tmp/x.sh`；命令词里没有分隔符则是 PATH 命令，不猜）。
        // 用 wrapper 之后的真实命令词（`timeout 10 ./x.sh` 的 `./x.sh`）。
        const realRaw = words[realIndex]
        if (PATH_LIKE_RE.test(realRaw) || realRaw.startsWith('.')) {
          const path = resolveScriptArg(realRaw, currentBase, skipped)
          if (path !== null && !seen.has(path)) {
            seen.add(path)
            refs.push({ path, interpreter: 'direct' })
          }
        }
        continue
      }

      const parsed = scriptArgsOf(words, realIndex + 1, kind, realCommand)
      if (parsed === null) {
        // shell 解释器从 stdin 读：`bash < x.sh` 的输入重定向就是脚本。
        if (kind === 'shell' && Array.isArray(segment?.inputs) && segment.inputs.length > 0) {
          const path = resolveScriptArg(segment.inputs[0], currentBase, skipped)
          if (path !== null && !seen.has(path)) {
            seen.add(path)
            refs.push({ path, interpreter: realCommand })
          }
        }
        continue
      }
      if (parsed.inline !== undefined) {
        // `bash -c "…"` / `pwsh -Command "…"`：把内层文本递归交给脚本识别。
        if (parsed.inline.trim().length > 0) walk(parsed.inline, currentBase, depth + 1)
        continue
      }
      if (parsed.none) continue
      for (const raw of parsed.scripts ?? []) {
        const path = resolveScriptArg(raw, currentBase, skipped)
        if (path !== null && !seen.has(path)) {
          seen.add(path)
          refs.push({ path, interpreter: realCommand })
        }
      }
    }
  }

  walk(String(command ?? ''), baseCwd, 0)
  return { refs, skipped }
}

/**
 * 从 shebang 解析解释器名；`#!/usr/bin/env node` 取 env 后的命令名。
 *
 * @param {string} content - 脚本全文。
 * @returns {string} 解释器名（小写 basename）；无 shebang 返回 `direct`。
 */
function interpreterFromShebang(content) {
  const firstLine = String(content ?? '').split('\n', 1)[0] ?? ''
  const match = /^#!\s*(.+)$/.exec(firstLine)
  if (!match) return 'direct'
  const tokens = match[1].trim().split(/\s+/).map((token) => baseNameOf(token)).filter(Boolean)
  if (tokens.length === 0) return 'direct'
  if (tokens[0] === 'env') {
    const rest = tokens.slice(1).filter((token) => !token.startsWith('-'))
    return rest[0] ?? 'env'
  }
  return tokens[0]
}

/**
 * 目标是否落在任一允许根（project/whitelist/temp）下。
 *
 * @param {string} path - 已归一化的绝对路径。
 * @param {{project?:string, whitelist?:string[], temp?:string[]}} roots - 已归一化的根集合。
 * @returns {boolean} 命中任一放行根返回 true。
 */
function underAnyRoot(path, roots) {
  if (typeof path !== 'string' || path.length === 0) return false
  const candidates = [
    typeof roots?.project === 'string' ? roots.project : '',
    ...(Array.isArray(roots?.whitelist) ? roots.whitelist : []),
    ...(Array.isArray(roots?.temp) ? roots.temp : []),
  ]
  return candidates.some((root) => typeof root === 'string' && root.length > 0 && underRoot(path, root))
}

/**
 * 读取命令引用的脚本内容（受限）。
 *
 * 读取策略（保守方向）：只读 project/whitelist/temp 内的**普通文件**；realpath 归一化后校验
 * 归属（项目内软链指向外部 → `outside-roots` 不读）；单文件超过 `maxBytes` → `too-large`；
 * 累计超过 {@link MAX_SCRIPT_TOTAL_BYTES} 或数量超过 `maxCount` → 跳过剩余；含 NUL 视为二进制。
 * 任何读取失败都只记 `skipped`，**绝不抛错**（调用方据此维持原有保守判定）。
 *
 * @param {string} command - 原始命令文本。
 * @param {{cwd?:string, shell?:string, roots?:object, maxBytes?:number, maxCount?:number}} [options]
 *   cwd 为解析基准；roots 为已归一化的 {project, whitelist, temp}；maxBytes/maxCount 有缺省值。
 * @returns {{scripts:{path:string, interpreter:string, sha256:string, bytes:number, content:string}[],
 *   skipped:{reason:string, detail:string}[]}} 脚本内容按命令顺序；skipped 汇总词法与读取跳过原因。
 */
export function inspectScripts(
  command,
  { cwd, shell, roots, maxBytes = 16384, maxCount = MAX_SCRIPTS } = {},
) {
  const detected = detectScriptRefs(command, { cwd, shell })
  const scripts = []
  const skipped = [...detected.skipped]
  const seen = new Set()
  const effectiveMaxBytes =
    typeof maxBytes === 'number' && Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 16384
  const effectiveMaxCount =
    typeof maxCount === 'number' && Number.isInteger(maxCount) && maxCount > 0
      ? maxCount
      : MAX_SCRIPTS
  let totalBytes = 0

  for (const ref of detected.refs) {
    if (scripts.length >= effectiveMaxCount) {
      skipped.push({ reason: 'too-many', detail: ref.path })
      continue
    }
    const normalized = normalizePath(ref.path, cwd)
    if (typeof normalized !== 'string' || normalized.length === 0) {
      skipped.push({ reason: 'missing', detail: ref.path })
      continue
    }
    if (seen.has(normalized)) continue
    if (!underAnyRoot(normalized, roots)) {
      skipped.push({ reason: 'outside-roots', detail: normalized })
      continue
    }

    let stat
    try {
      stat = statSync(normalized)
    } catch {
      skipped.push({ reason: 'missing', detail: normalized })
      continue
    }
    if (!stat.isFile()) {
      skipped.push({ reason: 'not-a-file', detail: normalized })
      continue
    }
    if (stat.size > effectiveMaxBytes) {
      skipped.push({ reason: 'too-large', detail: normalized })
      continue
    }
    if (totalBytes + stat.size > MAX_SCRIPT_TOTAL_BYTES) {
      skipped.push({ reason: 'budget-exceeded', detail: normalized })
      continue
    }

    let content
    try {
      content = readFileSync(normalized, 'utf8')
    } catch {
      skipped.push({ reason: 'read-failed', detail: normalized })
      continue
    }
    if (content.includes('\u0000')) {
      skipped.push({ reason: 'binary', detail: normalized })
      continue
    }

    const bytes = Buffer.byteLength(content)
    if (bytes > effectiveMaxBytes) {
      skipped.push({ reason: 'too-large', detail: normalized })
      continue
    }
    seen.add(normalized)
    totalBytes += bytes
    scripts.push({
      path: normalized,
      interpreter: ref.interpreter === 'direct' ? interpreterFromShebang(content) : ref.interpreter,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      bytes,
      content,
    })
  }

  return { scripts, skipped }
}
