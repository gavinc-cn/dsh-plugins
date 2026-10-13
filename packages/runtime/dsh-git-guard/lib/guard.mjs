// dsh-git-guard 决策核心：~/.kimi-code/hooks/git_commit_guard.py 的忠实移植。
//
// 本模块只做「判定」：读 git 状态、解析命令行，**不写仓库、不改任何文件**。
// evaluate() 返回 null 表示放行，返回字符串表示拒绝原因（字符串逐字对齐 Python 版，
// 因为它会原样回传给模型当提示）。
//
// 移植口径（与 Python 一一对应）：
//   shlex.split          → shlexSplit()            （含引号/反斜杠/空引号语义）
//   os.path.realpath     → pyRealpath()            （非严格模式：不存在的路径按祖先解析）
//   os.path.expanduser   → expandUser()
//   str.splitlines()     → pySplitLines()          （\r、\v、\f、\x85、U+2028 也算换行，且无尾空行）
//   str.strip()          → pyStrip()               （Python 的 Unicode 空白集合）
//   re / re.fullmatch    → JS 正则（Python 的 `.` 只排除 \n，故写成 [^\n]）
//   subprocess.run       → gitOut()（execFile；起不来/超时抛异常，与 Python 一致，
//                          由调用方的 try/catch 走「保守拒绝」分支）
//
// 快路径：命令里没有受控 git 子命令时，本模块不 spawn 任何 git 子进程（与 Python 版一致），
// 因为 DSH 的每一次 bash 工具调用都会经过这里。

import { execFile } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

// ── 顶层常量 ────────────────────────────────────────────────────────────────

/** 无会话时的回退前缀。 */
export const FALLBACK_PREFIX = '--AGENT-- '

/** 默认 git 子进程超时（毫秒）：对应 Python 版 _git_out 的 4s，DSH 侧放宽为 20s。 */
export const DEFAULT_GIT_TIMEOUT_MS = 20_000

/** 远端探测超时倍率：Python 版 _REMOTE_TIMEOUT(6s) / _git_out(4s) = 1.5。 */
export const REMOTE_TIMEOUT_RATIO = 1.5

/** 有会话时的前缀：--<短id>-- ，短 id 为会话 id 去 session_ 前缀后的前 6 位（字母大写）。 */
const SUBJECT_PREFIX_RE = /^--[A-Z0-9]{6}-- /

/** squash/amend 归属判定：subject 以上述两种前缀之一开头即为 agent 提交。 */
const AGENT_SUBJECT_RE = /^--(?:AGENT|[A-Z0-9]{6})-- /

/** shlex 分词后作为独立 token 出现、标志一个新命令段开始的 shell 操作符。 */
const SEGMENT_SPLITTERS = new Set(['&&', '||', ';', '|', '&'])

/**
 * 可以出现在 git 前面的前缀：sudo、环境变量赋值、子 shell 左括号。
 *
 * 2026-10-12 修：原写法 `[A-Za-z_][A-Za-z0-9_]*=` 配 `(?=\n?$)` 要求 token 在 `=` 后立即结束，
 * 于是只认「空值赋值」`FOO=`，而最常见的 `FOO=1` 反而不被跳过 ⇒ 整段认不出 git 调用而放行。
 * 现按 Python 同款语义写成 `=.*`（Python 的 `.` = 这里的 `[^\n]`，`$` 语义两边一致）。
 */
const LEADING_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\n]*|\()$/u

/** git 全局选项中需要单独取值的（其后的参数不能误当成子命令）。 */
const GIT_GLOBAL_VALUE_OPTS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix',
])

/** 会把操作重定向到其他仓库的 git 全局选项（出现即无法在本目录校验归属）。 */
const REPO_REDIRECT_OPTS = new Set(['-C', '--git-dir', '--work-tree'])

/**
 * 组合短选项正则：单破折号开头，'m'/'F' 前只能是不带值的标志字母（如 -am）。
 * Python 的 `.` 不匹配 \n（但匹配 \r），故 `(.*)` 写作 `([^\n]*)`。
 */
const SHORT_M_RE = /^-([a-rt-z]*)m([^\n]*)$/
const SHORT_F_RE = /^-([a-rt-z]*)F([^\n]*)$/

/** Python str 的空白字符集合（用于 \s 与 strip）。 */
const PY_WS_CLASS = '\\t\\n\\x0b\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_WS_RE = new RegExp(`[${PY_WS_CLASS}]`, 'g')
const PY_STRIP_RE = new RegExp(`^[${PY_WS_CLASS}]+|[${PY_WS_CLASS}]+$`, 'g')

/** Python str.splitlines 的行分隔符。 */
const PY_LINE_BREAK_RE = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g

/** $(cat <<'EOF' ...) 形式的 heredoc 引导。 */
const HEREDOC_RE = new RegExp(`<<-?[${PY_WS_CLASS}]*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?`)

/** Python str.strip()（Unicode 空白集合，不用 JS 的 trim——JS 会多剥 U+FEFF）。 */
function pyStrip(value) {
  return String(value).replace(PY_STRIP_RE, '')
}

/** Python str.splitlines()：末尾换行不产生空元素，\r/\v/\f/\x85 等也算换行。 */
function pySplitLines(value) {
  const str = String(value)
  const out = []
  let last = 0
  PY_LINE_BREAK_RE.lastIndex = 0
  let m = PY_LINE_BREAK_RE.exec(str)
  while (m !== null) {
    out.push(str.slice(last, m.index))
    last = m.index + m[0].length
    m = PY_LINE_BREAK_RE.exec(str)
  }
  if (last < str.length) out.push(str.slice(last))
  return out
}

// ── shlex.split 移植（CPython 3.12 shlex，posix=True / comments=False / whitespace_split=True）──

const SHLEX_WHITESPACE = ' \t\r\n'
const SHLEX_QUOTES = '\'"'
const SHLEX_ESCAPED_QUOTES = '"'

/**
 * 把命令行按 shell 语法分词，等价 Python 的 shlex.split(command)。
 * 引号不闭合抛 Error('No closing quotation')、转义符后到 EOF 抛
 * Error('No escaped character')（文案与 CPython 一致，便于差分对比）。
 */
export function shlexSplit(command) {
  const chars = Array.from(String(command))
  const tokens = []
  let index = 0 // 读指针（按码点前进，与 Python 的 read(1) 一致）
  let state = ' '
  let token = ''

  /**
   * 读一个 token（CPython shlex.read_token 的直译）。
   * @returns {string|null} null 表示 EOF（self.eof）；空串是合法 token（如 ''）
   */
  function readToken() {
    let quoted = false
    let escapedstate = ' '
    let result = ''
    for (;;) {
      const atEof = index >= chars.length
      const nextchar = atEof ? '' : chars[index]
      if (!atEof) index += 1
      if (state === null) { // past end of file
        result = ''
        break
      }
      if (state === ' ') {
        if (nextchar === '') { state = null; result = token; break }
        if (SHLEX_WHITESPACE.includes(nextchar)) {
          if (token || (quoted)) { result = token; break } // 吐出当前 token
          continue
        }
        if (nextchar === '\\') { escapedstate = 'a'; state = '\\'; continue }
        if (SHLEX_QUOTES.includes(nextchar)) { state = nextchar; continue }
        token = nextchar // whitespace_split：非空白字符一律当词字符
        state = 'a'
        continue
      }
      if (SHLEX_QUOTES.includes(state)) {
        quoted = true
        if (nextchar === '') throw new Error('No closing quotation')
        if (nextchar === state) { state = 'a'; continue }
        if (nextchar === '\\' && SHLEX_ESCAPED_QUOTES.includes(state)) {
          escapedstate = state
          state = '\\'
          continue
        }
        token += nextchar
        continue
      }
      if (state === '\\') {
        if (nextchar === '') throw new Error('No escaped character')
        // posix 下引号内只有引号本身与转义符可被转义
        if (SHLEX_QUOTES.includes(escapedstate) && nextchar !== '\\' && nextchar !== escapedstate) {
          token += '\\'
        }
        token += nextchar
        state = escapedstate
        continue
      }
      // state === 'a'（词中）
      if (nextchar === '') { state = null; result = token; break }
      if (SHLEX_WHITESPACE.includes(nextchar)) {
        state = ' '
        if (token || (quoted)) { result = token; break }
        continue
      }
      if (SHLEX_QUOTES.includes(nextchar)) { state = nextchar; continue }
      if (nextchar === '\\') { escapedstate = 'a'; state = '\\'; continue }
      token += nextchar
    }
    // 与 CPython 的收尾一致：result = self.token; self.token = ''
    token = ''
    if (result === '' && !quoted) return null // posix and not quoted and result == ''
    return result
  }

  for (;;) {
    const raw = readToken()
    if (raw === null) break
    tokens.push(raw)
  }
  return tokens
}

// ── 路径 helper（os.path 对应物）─────────────────────────────────────────────

/** os.path.expanduser：只处理 ~ 与 ~/（~user 原样返回，与 Python 找不到用户时一致）。 */
function expandUser(path) {
  const p = String(path)
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/**
 * os.path.realpath(strict=False)：解析符号链接；路径不存在时按「最深的已存在祖先」
 * 解析后再把剩余部分接回去（Python 的 realpath 也是这个口径）。
 */
function pyRealpath(path) {
  const abs = resolve(String(path))
  let cur = abs
  const tail = []
  for (;;) {
    try {
      const real = realpathSync(cur)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch {
      // 该层不存在：向上找已存在的祖先
    }
    const parent = dirname(cur)
    if (parent === cur) return abs
    tail.unshift(basename(cur))
    cur = parent
  }
}

/** os.path.join(os.getcwd(), p) 的等价物：相对路径按 cwd 展开。 */
function absFrom(cwd, path) {
  return isAbsolute(path) ? path : join(cwd, path)
}

// ── git 子进程 ──────────────────────────────────────────────────────────────

/**
 * 在 cwd 执行 git 并返回 {code, out}；与 Python 的 subprocess.run 对齐：
 *   - 正常结束（含非 0 退出码）→ {code: <退出码>, out}
 *   - git 起不来（ENOENT）/ cwd 不存在 / 超时 → 抛异常（Python 侧是 FileNotFoundError /
 *     TimeoutExpired），由调用方的 try/catch 转成「保守拒绝」，不改变判定方向。
 */
function gitOut(cwd, args, timeoutMs) {
  return new Promise((ok, fail) => {
    execFile('git', args, {
      cwd: cwd || process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 8 << 20,
      encoding: 'utf8',
    }, (err, stdout) => {
      if (err === null) {
        ok({ code: 0, out: String(stdout ?? '') })
        return
      }
      if (typeof err.code === 'number') {
        ok({ code: err.code, out: String(stdout ?? '') })
        return
      }
      fail(err)
    })
  })
}

// ── 命令分段与 git 调用识别 ─────────────────────────────────────────────────

/**
 * 把 shlex 分词结果按 shell 操作符切成命令段。
 *
 * 除标准操作符（&&/||/;/|/&）外，还要处理 shlex 把 `;` 粘在词尾的形态
 * （`git tag -a x -m msg; echo ok` → 词 `msg;`），否则同一段里会混入下一条命令
 * 的参数，导致误判（假拦截）。
 */
function segments(tokens) {
  const out = []
  let seg = []
  for (const tok of tokens) {
    if (SEGMENT_SPLITTERS.has(tok)) {
      out.push(seg)
      seg = []
      continue
    }
    if (tok.endsWith(';')) { // 词尾分号：`a;` 结束前段，`;` 独立成段
      const content = tok.slice(0, -1)
      if (content) seg.push(content)
      out.push(seg)
      seg = []
      continue
    }
    seg.push(tok)
  }
  out.push(seg)
  return out
}

/** 命令替换 / 子 shell 引导符：`$(git …)`、`` `git …` ``、`(git …` 会与 git 粘成同一个 token。 */
const GIT_TOKEN_LEAD_RE = /^[$(（{`]+/

/**
 * 这个 token 是不是「在调用 git」：`git`、`/usr/bin/git`、`$(git` 都算。
 * 2026-10-12 新增：绝对路径与命令替换此前被当成普通参数，整段因此不被识别而放行。
 */
function isGitToken(tok) {
  const stripped = String(tok).replace(GIT_TOKEN_LEAD_RE, '')
  const base = stripped.split(/[\\/]/).pop()
  return base === 'git'
}

/**
 * 从 git token 之后解析子命令（跳过需要取值的全局选项）。
 * 返回 {subcmd, redirected}：subcmd 为第一个位置参数（无则 null）。
 */
function parseSubcmd(seg, start) {
  let i = start
  let redirected = false
  while (i < seg.length) {
    const tok = seg[i]
    if (GIT_GLOBAL_VALUE_OPTS.has(tok)) {
      if (REPO_REDIRECT_OPTS.has(tok)) redirected = true
      i += 2 // 全局选项连同其值一起跳过
    } else if (tok.startsWith('--git-dir=') || tok.startsWith('--work-tree=')) {
      redirected = true
      i += 1
    } else if (tok.startsWith('-')) {
      i += 1 // 无值全局选项
    } else {
      return { subcmd: tok, redirected } // 第一个位置参数即子命令
    }
  }
  return { subcmd: null, redirected }
}

/**
 * 识别 `git ... <subcommand>` 调用（跳过 sudo/env/括号前缀与全局选项）。
 * 返回 {subcmd, redirected}：subcmd 为第一个位置参数（无则 null）；
 * redirected=true 表示带 -C/--git-dir/--work-tree，操作目标非当前目录。
 */
function gitCall(seg) {
  let i = 0
  while (i < seg.length && (LEADING_RE.test(seg[i]) || seg[i] === 'sudo')) i += 1
  if (i >= seg.length || !isGitToken(seg[i])) return { subcmd: null, redirected: false }
  return parseSubcmd(seg, i + 1)
}

/**
 * 「git 调用不在段首」的 fail-closed 兜底（2026-10-12 新增）。
 *
 * `time git …` / `nice git …` / `env git …` / `command git …` / `xargs git …` /
 * `/usr/bin/git …` / `$(git …)` 等写法会让 gitCall() 认不出整段，改动前等于**静默放行**。
 * 现在改为：只要段内出现「被专属校验的 git 子命令」，就拒绝并要求改写成段首直呼 git。
 * 代价（已知且刻意接受）：`echo git commit` 这类把 git 当普通参数的写法也会被拦，
 * 加引号（`echo "git commit"`）即可放行。
 */
function wrappedGitCall(seg) {
  for (let i = 0; i < seg.length; i += 1) {
    if (!isGitToken(seg[i])) continue
    const { subcmd } = parseSubcmd(seg, i + 1)
    if (subcmd !== null && LOGGED_SUBCMDS.has(subcmd)) {
      return { subcmd, prefix: seg.slice(0, i) }
    }
  }
  return null
}

/** 非段首 git 调用的拒绝原因（会原样回传给模型）。 */
function reasonWrappedGit({ subcmd, prefix }) {
  const shown = prefix.length > 0 ? prefix.join(' ') : '(命令替换/子 shell)'
  return `git ${subcmd} 不在命令段首（前面是 "${shown}"），守卫无法校验其归属；`
    + '请去掉前缀直接以 git 开头（time/nice/env/command/xargs/绝对路径/$( ) 等写法都不被支持）。'
    + '若 git 只是普通参数（如 echo git commit），请加引号或改写。'
}

// ── commit message 提取 ─────────────────────────────────────────────────────

/** 提取 text 中第一个 heredoc 的正文；找不到返回 ''。 */
function heredocBody(text) {
  const m = HEREDOC_RE.exec(String(text))
  if (m === null) return ''
  const rest = String(text).slice(m.index + m[0].length)
  const nl = rest.indexOf('\n')
  if (nl === -1) return ''
  const body = []
  for (const line of rest.slice(nl + 1).split('\n')) {
    if (pyStrip(line) === m[1]) break // 结束标记行
    body.push(line)
  }
  return body.join('\n')
}

/** 把 -m 的取值解析成真正的 message 文本；无法解析返回 ''（严格模式下拦截）。 */
function resolveMessage(raw) {
  const text = pyStrip(raw)
  if (text.includes('$(') || text.includes('`')) {
    // 命令替换目前只支持 $(cat <<EOF ...) 形式
    return heredocBody(text)
  }
  return text
}

/** 读取 -F 指定的 message 文件内容；读不到返回 ''。 */
function readMessageFile(path) {
  try {
    return readFileSync(expandUser(pyStrip(path)), 'utf8')
  } catch {
    return ''
  }
}

/**
 * 扫描一个 git commit 命令段，收集 message。
 * 返回 {messages, isAmend, hasNoEdit}：messages 依次为各 -m/-F 的取值
 * （第一个即 subject 来源），空数组表示命令没有携带 message。
 */
function extract(seg) {
  const messages = []
  let isAmend = false
  let hasNoEdit = false
  let i = seg.indexOf('commit') + 1
  while (i < seg.length) {
    const tok = seg[i]
    const nxt = i + 1 < seg.length ? seg[i + 1] : null
    if (tok === '--') break // 之后全是 pathspec，不再是选项
    if (tok === '--amend') {
      isAmend = true
    } else if (tok === '--no-edit') {
      hasNoEdit = true
    } else if (tok === '-m' || tok === '--message' || tok === '-F' || tok === '--file') {
      if (nxt === null) { // 选项悬空，无法取值
        messages.push('')
      } else if (tok === '-m' || tok === '--message') {
        messages.push(resolveMessage(nxt))
      } else {
        messages.push(readMessageFile(nxt))
      }
      i += 1
    } else if (tok.startsWith('--message=')) {
      messages.push(resolveMessage(tok.slice('--message='.length)))
    } else if (tok.startsWith('--file=')) {
      messages.push(readMessageFile(tok.slice('--file='.length)))
    } else {
      const m = SHORT_M_RE.exec(tok)
      if (m !== null) {
        if (m[2]) { // 连写取值，如 -mFix
          messages.push(resolveMessage(m[2]))
        } else if (nxt !== null) {
          messages.push(resolveMessage(nxt))
          i += 1
        } else {
          messages.push('')
        }
      } else {
        const f = SHORT_F_RE.exec(tok)
        if (f !== null) {
          if (f[2]) { // 连写取值，如 -Fmsg.txt
            messages.push(readMessageFile(f[2]))
          } else if (nxt !== null) {
            messages.push(readMessageFile(nxt))
            i += 1
          } else {
            messages.push('')
          }
        }
      }
    }
    i += 1
  }
  return { messages, isAmend, hasNoEdit }
}

/** 提取不到 message 时的固定原因（严格模式）。 */
function reasonNoMessage() {
  return '检测到 git commit，但无法从命令中提取 commit message。'
    + '请使用 git commit -m "--XXXXXX-- <摘要>"（XXXXXX 为 6 位会话短 id，'
    + `无会话时首行以 "${FALLBACK_PREFIX}" 开头），`
    + '多行 message 可用 -m "$(cat <<\'EOF\' ...)" 形式；'
    + '若要保留原提交信息请使用 --amend --no-edit。'
}

// ── git reset --soft squash 归属校验 ─────────────────────────────────────────

const RESET_MODES = new Set(['--soft', '--mixed', '--hard', '--merge', '--keep'])

/** 解析 git reset 参数段。返回 {mode, ref, error}；mode 缺省为 --mixed。 */
function resetModeAndRef(seg) {
  let mode = null
  const refs = []
  let i = seg.indexOf('reset') + 1
  while (i < seg.length) {
    const tok = seg[i]
    if (tok === '--') { // 之后全是 pathspec
      if (i + 1 < seg.length) return { mode: null, ref: null, error: '带路径的 reset（撤销暂存）不属于 squash，禁止' }
      break
    }
    if (RESET_MODES.has(tok)) {
      if (mode !== null && mode !== tok) return { mode: null, ref: null, error: 'git reset 指定了多个模式，无法解析' }
      mode = tok
    } else if (tok.startsWith('-')) {
      // -q/--quiet 等无值选项忽略
    } else {
      refs.push(tok)
    }
    i += 1
  }
  if (refs.length > 1) return { mode: null, ref: null, error: 'git reset 参数过多，无法解析目标' }
  return { mode: mode ?? '--mixed', ref: refs.length > 0 ? refs[0] : 'HEAD', error: null }
}

/**
 * squash 归属校验：<ref>..HEAD 全部提交须为 agent 前缀且暂存区干净。
 * 返回 null 放行；返回字符串为拦截原因。任何无法核实的情况一律保守拦截。
 */
async function checkResetOwnership(ref, cwd, timeoutMs) {
  try {
    if ((await gitOut(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], timeoutMs)).code !== 0) {
      return `无法解析 reset 目标 "${ref}"（非有效提交），拒绝`
    }
    if ((await gitOut(cwd, ['merge-base', '--is-ancestor', ref, 'HEAD'], timeoutMs)).code !== 0) {
      return `"${ref}" 不是 HEAD 的祖先，不属于 squash 场景，拒绝`
    }
    if ((await gitOut(cwd, ['diff', '--cached', '--quiet'], timeoutMs)).code !== 0) {
      return '暂存区存在未提交内容，reset 后会被卷入合并提交；请先处理暂存区'
    }
    const log = await gitOut(cwd, ['log', '--format=%s', `${ref}..HEAD`], timeoutMs)
    if (log.code !== 0) return '无法读取提交历史，保守拒绝'
    for (const subject of pySplitLines(log.out)) {
      if (!AGENT_SUBJECT_RE.test(subject)) {
        return `squash 范围内存在非 agent 前缀提交（用户提交不可动）："${subject}"。`
          + '前缀是归属判定的唯一标准；请缩小范围或请用户手动执行'
      }
    }
    const total = await gitOut(cwd, ['rev-list', '--count', `${ref}..HEAD`], timeoutMs)
    const unpushed = await gitOut(cwd, ['rev-list', '--count', `${ref}..HEAD`, '--not', '--remotes'], timeoutMs)
    if (total.code === 0 && unpushed.code === 0
      && pyStrip(total.out) !== pyStrip(unpushed.out)) {
      return 'squash 范围内存在已推送提交（远程跟踪分支可达），改写已发布历史请用户手动执行'
    }
  } catch (exc) {
    return `squash 归属校验失败（${exc}），保守拒绝；如需执行请用户手动运行`
  }
  return null
}

/**
 * amend 归属校验（2026-09-26 v8）：HEAD 须为 agent 前缀提交且未推送。
 * --no-edit 与带新 message 两种形式都要过此检查；无法核实一律保守拦截。
 */
async function checkAmendOwnership(cwd, timeoutMs) {
  try {
    const log = await gitOut(cwd, ['log', '-1', '--format=%s', 'HEAD'], timeoutMs)
    if (log.code !== 0 || pyStrip(log.out) === '') {
      return '无法核实 HEAD 提交，保守拒绝 amend；如需执行请用户手动运行'
    }
    const subject = pySplitLines(pyStrip(log.out))[0]
    if (!AGENT_SUBJECT_RE.test(subject)) {
      return `HEAD 是非 agent 前缀提交（用户提交不可动）："${subject}"；`
        + 'amend 仅限自己的 agent 前缀提交'
    }
    const pushed = await gitOut(cwd, ['branch', '-r', '--contains', 'HEAD'], timeoutMs)
    if (pushed.code !== 0) return '无法核实 HEAD 是否已推送，保守拒绝 amend'
    if (pyStrip(pushed.out) !== '') {
      return 'HEAD 已被远程跟踪分支包含（已推送），amend 会改写已发布历史；请用户手动执行'
    }
  } catch (exc) {
    return `amend 归属校验失败（${exc}），保守拒绝；如需执行请用户手动运行`
  }
  return null
}

/** 判断命令段中 cd 的目标是否有任一落在 cwd 之外。 */
function cdOutside(targets, cwd) {
  const base = pyRealpath(cwd)
  for (let t of targets) {
    t = expandUser(t)
    const p = pyRealpath(absFrom(cwd, t))
    if (p !== base) return true
  }
  return false
}

/** 校验一个 git reset 命令段；返回 null 放行，否则拦截原因。 */
async function evaluateReset(seg, redirected, cdTargets, cwd, timeoutMs) {
  if (redirected) {
    return 'git -C/--git-dir/--work-tree 重定向仓库时无法校验 squash 归属；'
      + '请进入目标仓库目录后执行'
  }
  if (cdTargets.length > 0 && cdOutside(cdTargets, cwd)) {
    return '命令先 cd 到其他目录再 git reset，无法校验 squash 归属；'
      + '请进入目标仓库目录后执行'
  }
  const { mode, ref, error } = resetModeAndRef(seg)
  if (error) return error
  if (mode !== '--soft') {
    return `仅允许 git reset --soft <ref>（squash 栈顶连续 agent 提交），当前为 ${mode} 模式；`
      + '其余 reset 形式一律禁止，请用户手动执行'
  }
  return checkResetOwnership(ref, cwd, timeoutMs)
}

// ── git branch / worktree / checkout 归属校验（2026-09-19 v6）─────────────────

/**
 * agent 分支命名：agent/<6位会话短id>（大写字母数字，与提交前缀同源）；
 * 无会话短 id 时的回退命名 agent/AGENT-<14位时间戳>（2026-09-26 v8 起支持）。
 * 注：Python 的 \d 是 Unicode 十进制数字，这里用 \p{Nd} 对齐。
 */
const AGENT_BRANCH_RE = /^agent\/(?:[A-Z0-9]{6}|AGENT-\p{Nd}{14})$/u

const BRANCH_DELETE_FLAGS = new Set(['-d', '-D', '--delete'])
/** branch 的写类选项（rename/copy/force/upstream/description）一律不放开。 */
const BRANCH_BLOCKED_FLAGS = new Set([
  '-f', '--force', '-m', '-M', '--move', '-c', '-C', '--copy',
  '-u', '--unset-upstream', '--edit-description',
])
/** 出现即为只读列表形式：其后的位置参数是匹配 pattern/过滤值，不是分支名。 */
const BRANCH_READ_FLAGS = new Set([
  '-l', '--list', '--show-current',
  '--contains', '--no-contains', '--merged', '--no-merged', '--points-at',
  '--sort', '--format', '--abbrev', '--color', '--column',
])
const BRANCH_READ_LONG_FLAGS = [...BRANCH_READ_FLAGS].filter((f) => f.startsWith('--'))

const WORKTREE_ADD_VALUE_FLAGS = ['--reason', '--expire'] // 带值选项（值跳过）
const WORKTREE_ADD_BOOL_FLAGS = new Set(['-q', '--quiet', '--track', '-t', '--no-track', '--lock'])

/** 分支/worktree 写操作的目标仓库校验；可校验返回 null。 */
function redirectOrCdReason(redirected, cdTargets, cwd, what) {
  if (redirected) {
    return `git -C/--git-dir/--work-tree 重定向仓库时无法校验${what}归属；`
      + '请进入目标仓库目录后执行'
  }
  if (cdTargets.length > 0 && cdOutside(cdTargets, cwd)) {
    return `命令先 cd 到其他目录再执行${what}，无法校验归属；`
      + '请进入目标仓库目录后执行'
  }
  return null
}

/** 校验 git branch 段：仅放行 agent/<6位短id> 分支的新建/删除与只读列表。 */
function evaluateBranch(seg, redirected, cdTargets, cwd) {
  const tokens = seg.slice(seg.indexOf('branch') + 1)
  // 第一遍：写类禁用选项优先拦截
  for (const tok of tokens) {
    if (BRANCH_BLOCKED_FLAGS.has(tok) || tok.startsWith('--set-upstream-to')) {
      return `git branch 的 ${tok} 选项不在开放范围`
        + '（仅允许 agent/<6位会话短id> 分支的新建/删除）'
    }
  }
  // 第二遍：显式只读列表形式（--list/--show-current/--contains 等），
  // 其位置参数是匹配 pattern/过滤值而非分支名，直接放行
  for (const tok of tokens) {
    if (BRANCH_READ_FLAGS.has(tok)
      || BRANCH_READ_LONG_FLAGS.some((f) => tok.startsWith(`${f}=`))) {
      return null
    }
  }
  let del = false
  const names = []
  for (const tok of tokens) {
    if (BRANCH_DELETE_FLAGS.has(tok)) {
      del = true
    } else if (tok.startsWith('-')) {
      // 其余只读样式选项（-a -r -v 等）
    } else {
      names.push(tok)
    }
  }
  if (!del && names.length === 0) return null // 无位置参数的列表形式
  const reason = redirectOrCdReason(redirected, cdTargets, cwd, '分支操作')
  if (reason) return reason
  if (del) {
    const bad = names.filter((n) => !AGENT_BRANCH_RE.test(n))
    if (bad.length > 0) {
      return '仅允许删除 agent/<6位会话短id> 或 agent/AGENT-<14位时间戳> '
        + `形式的分支（如 agent/EE2BB7），"${bad[0]}" 不符合；用户分支绝不动`
    }
    return null
  }
  // 新建：第一个位置参数是分支名（须 agent 形），第二个是起点（任意 ref）
  if (names.length > 2) return 'git branch 新建至多接受 <名称> [<起点>] 两个参数'
  if (!AGENT_BRANCH_RE.test(names[0])) {
    return '仅允许新建 agent/<6位会话短id> 或 agent/AGENT-<14位时间戳> '
      + `形式的分支（如 agent/EE2BB7），"${names[0]}" 不符合；用户分支绝不动`
  }
  return null
}

/** cwd 所在 git 仓库根；非仓库/异常返回 null。 */
async function repoToplevel(cwd, timeoutMs) {
  try {
    const p = await gitOut(cwd, ['rev-parse', '--show-toplevel'], timeoutMs)
    return p.code === 0 ? pyStrip(p.out) : null
  } catch {
    return null
  }
}

/**
 * 查 worktree 路径检出的分支名（refs/heads/ 之后部分）。
 * 返回分支名；路径不在 worktree 列表中返回 null；detached（无 branch 行）返回 ''。
 */
async function worktreeBranchOf(path, cwd, timeoutMs) {
  try {
    const p = await gitOut(cwd, ['worktree', 'list', '--porcelain'], timeoutMs)
    if (p.code !== 0) return null
    const target = pyRealpath(absFrom(cwd, path))
    let curPath = null
    let curBranch = ''
    let found = null
    for (const line of [...pySplitLines(p.out), '']) {
      if (line.startsWith('worktree ')) {
        curPath = line.slice('worktree '.length)
        curBranch = ''
      } else if (line.startsWith('branch refs/heads/')) {
        curBranch = line.slice('branch refs/heads/'.length)
      } else if (line === '' && curPath !== null) {
        if (pyRealpath(curPath) === target) {
          found = curBranch // '' 表示 detached
          break
        }
        curPath = null
      }
    }
    return found
  } catch {
    return null
  }
}

/** 校验 git worktree add：必须显式 -b agent/<短id> 或检出 agent 分支。 */
async function evaluateWorktreeAdd(tokens, cwd, timeoutMs) {
  let newBranch = null
  const pos = []
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok === '-b') {
      if (i + 1 >= tokens.length) return 'git worktree add -b 缺少分支名'
      newBranch = tokens[i + 1]
      i += 2
    } else if (tok.startsWith('-b') && tok.length > 2) {
      newBranch = tok.slice(2) // -bname 连写
      i += 1
    } else if (WORKTREE_ADD_VALUE_FLAGS.includes(tok)) {
      i += 2
    } else if (WORKTREE_ADD_VALUE_FLAGS.some((f) => tok.startsWith(`${f}=`))) {
      i += 1
    } else if (WORKTREE_ADD_BOOL_FLAGS.has(tok)) {
      i += 1
    } else if (tok.startsWith('-')) {
      return `git worktree add 的选项 ${tok} 不在开放范围`
        + '（--force/-B/--detach/--orphan 等一律禁止）'
    } else {
      pos.push(tok)
      i += 1
    }
  }
  if (pos.length === 0 || pos.length > 2) return 'git worktree add 参数应为 <路径> [<分支/起点>]'
  // 目标路径不得位于仓库内部（嵌套 worktree 会污染主仓库状态）
  const top = await repoToplevel(cwd, timeoutMs)
  if (top) {
    const rp = pyRealpath(absFrom(cwd, pos[0]))
    const rt = pyRealpath(top)
    if (rp === rt || rp.startsWith(rt + '/')) return 'worktree 目标路径不得位于仓库内部'
  }
  if (newBranch !== null) {
    if (!AGENT_BRANCH_RE.test(newBranch)) {
      return 'worktree 新分支名必须是 agent/<6位会话短id> 或 '
        + `agent/AGENT-<14位时间戳>，"${newBranch}" 不符合；用户分支绝不动`
    }
  } else if (pos.length === 2) {
    if (!AGENT_BRANCH_RE.test(pos[1])) {
      return 'worktree add 仅允许检出 agent 命名分支（agent/<6位短id> 或 '
        + `agent/AGENT-<14位时间戳>），"${pos[1]}" 不符合`
    }
  } else {
    return 'git worktree add 必须显式给出 -b agent/<6位短id> 或 agent 分支名'
  }
  return null
}

/** 校验 git worktree remove：目标 worktree 检出的必须是 agent 分支，禁 --force。 */
async function evaluateWorktreeRemove(tokens, cwd, timeoutMs) {
  const pos = []
  for (const tok of tokens) {
    if (tok === '-n' || tok === '--dry-run' || tok === '-q' || tok === '--quiet') continue
    if (tok === '-f' || tok === '--force') {
      return 'git worktree remove 不允许 --force（会丢弃 worktree 内未提交改动）'
    }
    if (tok.startsWith('-')) return `git worktree remove 的选项 ${tok} 不在开放范围`
    pos.push(tok)
  }
  if (pos.length !== 1) return 'git worktree remove 需要且仅需要一个 worktree 路径'
  const branch = await worktreeBranchOf(pos[0], cwd, timeoutMs)
  if (branch === null) return `无法在 git worktree list 中核实 "${pos[0]}"，保守拒绝`
  if (!AGENT_BRANCH_RE.test(branch)) {
    const shown = branch || '(detached 或无分支)'
    return `worktree "${pos[0]}" 检出的分支是 ${shown}，`
      + '仅允许移除检出 agent/<6位短id>（或 agent/AGENT-<14位时间戳>）'
      + '分支的 worktree'
  }
  return null
}

/** 校验 git worktree 段：仅放行 list 与 agent 分支相关的 add/remove。 */
async function evaluateWorktree(seg, redirected, cdTargets, cwd, timeoutMs) {
  const i = seg.indexOf('worktree') + 1
  if (i >= seg.length) return null // 裸 git worktree 等价 list（只读）
  const sub = seg[i]
  if (sub === 'list') return null
  if (sub !== 'add' && sub !== 'remove') {
    return `git worktree ${sub} 不在开放范围（仅 list/add/remove）`
  }
  const reason = redirectOrCdReason(redirected, cdTargets, cwd, 'worktree 操作')
  if (reason) return reason
  if (sub === 'add') return evaluateWorktreeAdd(seg.slice(i + 1), cwd, timeoutMs)
  return evaluateWorktreeRemove(seg.slice(i + 1), cwd, timeoutMs)
}

/** 当前检出的分支名；异常返回 null。 */
async function currentBranch(cwd, timeoutMs) {
  try {
    const p = await gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs)
    return p.code === 0 ? pyStrip(p.out) : null
  } catch {
    return null
  }
}

/**
 * 校验 git merge 段（2026-09-25 v7，2026-09-26 v8 扩展）。
 *
 * 仅放行三种受控形态，源分支都必须是 agent 命名（用户创建的分支绝不动）：
 *   1. `--ff-only agent/<短id>` —— 快进合并进 master（当前分支须 master、ff 可行）；
 *   2. `--squash agent/<短id>` —— squash 回流（当前分支须 master 或 agent 分支、
 *      暂存区干净、HEAD..源分支 范围内全部提交带 agent 前缀）；
 *   3. 裸 `--abort` —— 合并冲突回退（仅 2 会进入冲突态，需保留逃生门）。
 */
async function evaluateMerge(seg, redirected, cdTargets, cwd, timeoutMs) {
  const tokens = seg.slice(seg.indexOf('merge') + 1)
  let mode = null // "--ff-only" / "--squash" / "--abort"
  const pos = []
  for (const tok of tokens) {
    if (tok === '--ff-only' || tok === '--squash' || tok === '--abort') {
      if (mode !== null && mode !== tok) return 'git merge 指定了多个互斥模式，无法解析'
      mode = tok
    } else if (tok === '-q' || tok === '--quiet') {
      continue
    } else if (tok.startsWith('-')) {
      return `git merge 的选项 ${tok} 不在开放范围（仅允许 --ff-only 快进、`
        + '--squash 回流 agent 分支、--abort 冲突回退；--no-ff/-m 等'
        + '一律禁止，请用户手动执行）'
    } else {
      pos.push(tok)
    }
  }
  if (mode === null) {
    return 'git merge 仅允许 --ff-only / --squash / --abort 三种形态；'
      + '缺省合并等其余形态请用户手动执行'
  }
  if (mode === '--abort') {
    if (pos.length > 0) return 'git merge --abort 不接受其他参数'
    return null // 冲突回退：git 自身校验合并态，无仓库副作用需此处把关
  }
  if (pos.length !== 1) return 'git merge 需要且仅需要一个源分支参数'
  if (!AGENT_BRANCH_RE.test(pos[0])) {
    return '仅允许合并 agent 命名的分支（agent/<6位会话短id> 或 '
      + `agent/AGENT-<14位时间戳>），"${pos[0]}" 不符合；用户分支绝不动`
  }
  const reason = redirectOrCdReason(redirected, cdTargets, cwd, 'merge 操作')
  if (reason) return reason
  if (mode === '--ff-only') return checkMergeFf(pos[0], cwd, timeoutMs)
  return checkMergeSquash(pos[0], cwd, timeoutMs)
}

/** ff-only 校验：当前分支须 master，且 HEAD 是源分支的后代（可快进）。 */
async function checkMergeFf(src, cwd, timeoutMs) {
  const cur = await currentBranch(cwd, timeoutMs)
  if (cur === null) return '无法核实当前分支，保守拒绝'
  if (cur !== 'master') {
    return `仅允许把 agent 分支快进合并进 master（当前分支为 ${cur}）；`
      + '请在 master 上执行，或交由用户手动合并'
  }
  try {
    if ((await gitOut(cwd, ['merge-base', '--is-ancestor', 'HEAD', src], timeoutMs)).code !== 0) {
      return 'master 与该 agent 分支已分叉（非快进场景），保守拒绝；'
        + '请改用 --squash 回流，或交由用户手动合并'
    }
  } catch (exc) {
    return `ff 可行性校验失败（${exc}），保守拒绝；如需执行请用户手动运行`
  }
  return null
}

/**
 * squash 回流校验：当前分支须 master/agent 形、暂存区干净、范围全 agent 前缀。
 * squash 合并把源分支改动整体放进暂存区，随后的回流提交走「提交流程」出
 * agent 前缀 message；若范围混入用户提交，其改动会被卷入 agent 提交，故拦。
 */
async function checkMergeSquash(src, cwd, timeoutMs) {
  const cur = await currentBranch(cwd, timeoutMs)
  if (cur === null) return '无法核实当前分支，保守拒绝'
  if (cur !== 'master' && !AGENT_BRANCH_RE.test(cur)) {
    return `squash 回流的改动将落在当前分支（${cur}），仅允许在 master 或 `
      + 'agent 分支上执行；用户分支绝不动'
  }
  try {
    if ((await gitOut(cwd, ['rev-parse', '--verify', '--branch', src], timeoutMs)).code !== 0) {
      return `无法解析源分支 "${src}"，保守拒绝`
    }
    if ((await gitOut(cwd, ['diff', '--cached', '--quiet'], timeoutMs)).code !== 0) {
      return '暂存区存在未提交内容，squash 合并后会被卷入回流提交；'
        + '请先处理暂存区'
    }
    const log = await gitOut(cwd, ['log', '--format=%s', `HEAD..${src}`], timeoutMs)
    if (log.code !== 0) return '无法读取源分支提交历史，保守拒绝'
    for (const subject of pySplitLines(log.out)) {
      if (!AGENT_SUBJECT_RE.test(subject)) {
        return '合并范围内存在非 agent 前缀提交（用户提交不可动）：'
          + `"${subject}"。前缀是归属判定的唯一标准；请用户手动执行`
      }
    }
  } catch (exc) {
    return `squash 回流校验失败（${exc}），保守拒绝；如需执行请用户手动运行`
  }
  return null
}

// ── git config 写形式与未知子命令别名拦截（2026-09-26 v8）─────────────────────

/** git config 的写形式选项：设置值/建别名可让命令绕过本 hook，一律拦截。 */
const CONFIG_WRITE_FLAGS = new Set([
  '--add', '--unset', '--unset-all', '--replace-all',
  '--rename-section', '--remove-section', '-e', '--edit',
])

// ── git tag 归属校验（2026-10-07 v9）─────────────────────────────────────────

/**
 * 只读列表选项：出现即等价 git tag -l（其后位置参数是匹配 pattern，不是 tag 名）。
 * 注：--column 属终端排版选项，不放进只读集合（未开放的选项一律拦）。
 */
const TAG_READ_FLAGS = new Set([
  '-l', '--list', '-n', '--contains', '--no-contains', '--merged',
  '--no-merged', '--points-at', '--sort', '--format',
])
/** 删除选项（v9 归属：agent 只能删本会话新建且从未 push 的 tag）。 */
const TAG_DELETE_FLAGS = new Set(['-d', '--delete'])
/** 强制/覆盖选项：一切形式都拦——移动既有 tag 会改写归属（agent 只新建，绝不改写）。 */
const TAG_FORCE_FLAGS = new Set(['-f', '--force'])
/** 带值选项：值续在下一个 token，解析时要跳过。 */
const TAG_VALUE_FLAGS = new Set([
  '-m', '--message', '-F', '--file', '-u', '--local-user', '--cleanup',
  '--create-reflog', '--trailer',
])
/** 不在开放范围的选项：签名（GPG 交互）/清理/校验/列名——一律拦，交用户。 */
const TAG_BLOCKED_FLAGS = new Set([
  '-s', '--sign', '-u', '--local-user', '--cleanup',
  '--column', '-v', '--verify', '--create-reflog',
  '--trailer', '--edit', '-e',
])
/** tag 名合法性（git check-ref-format 口径的子集）：空白与控制字符、git 保留字符。 */
const TAG_BAD_CHARS_RE = /[\x00-\x20\x7f~^:?*[\\]/
/** 短选项簇里允许出现的单字符选项（其余单破折号选项一律拦）。 */
const TAG_SHORT_FLAGS = new Set(['-a', '-m', '-d', '-l', '-f'])
/** 只读列表行数形式：-n / -n5。 */
const TAG_N_RE = /^-n\p{Nd}*$/u

/** tag 名是否合法（git check-ref-format 口径）；合法返回 null，否则返回原因。 */
function tagShapeError(name) {
  if (!name) return 'tag 名为空'
  if (name.startsWith('-')) return "tag 名不能以 '-' 开头（会被当成选项）"
  if (TAG_BAD_CHARS_RE.test(name)) return 'tag 名含空白、控制字符或 git 保留字符（~ ^ : ? * [ \\）'
  if (name.endsWith('.') || name.startsWith('.')) return "tag 名不能以 '.' 开头或结尾"
  if (name.endsWith('.lock')) return "tag 名不能以 '.lock' 结尾"
  for (const bad of ['..', '//', '@{', '.@']) {
    if (name.includes(bad)) return `tag 名不能包含 ${bad}`
  }
  return null
}

/** 远端名：优先 origin，否则第一个远端；无远端（或读不到）返回 null。 */
async function findRemote(cwd, timeoutMs) {
  try {
    const p = await gitOut(cwd, ['remote'], timeoutMs)
    if (p.code !== 0) return null
    const remotes = p.out.split(/\s+/).filter((s) => s !== '')
    if (remotes.length === 0) return null
    return remotes.includes('origin') ? 'origin' : remotes[0]
  } catch {
    return null
  }
}

/**
 * 远端是否已有同名 tag 的**精确**判定。
 * 返回 true=远端已存在 / false=确认不存在 / null=无法核实（无远端、查询失败或超时）。
 * 按 `refs/tags/<name>` 精确 pattern 查询（不用 `--tags` 全量取回）。
 */
async function tagOnRemote(name, cwd, remoteTimeoutMs, localTimeoutMs) {
  const remote = await findRemote(cwd, localTimeoutMs)
  if (remote === null) return null
  const pattern = `refs/tags/${name}`
  try {
    const p = await gitOut(cwd, ['ls-remote', '--tags', remote, pattern, `${pattern}^{}`], remoteTimeoutMs)
    if (p.code !== 0) return null
    return pyStrip(p.out) !== ''
  } catch {
    return null
  }
}

/**
 * 本地是否存在同名远端跟踪 tag 引用（refs/remotes/&lt;remote&gt;/&lt;name&gt;）。
 * `git push` 不写远端跟踪引用、`git fetch` 默认也不取 tag，所以它只覆盖
 * 「历史会话曾 push 且当时留下过引用」这一窄场景；查到即保守拦下新建。
 */
async function tagInTrackingRefs(name, cwd, timeoutMs) {
  try {
    const p = await gitOut(cwd, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${name}`], timeoutMs)
    return p.code === 0 && pyStrip(p.out) !== ''
  } catch {
    return false
  }
}

/** 待标记的对象（tag 的目标 ref/提交）校验：解析成提交才放行。 */
async function tagCheckName(field, cwd, timeoutMs) {
  let p
  try {
    p = await gitOut(cwd, ['rev-parse', '--verify', `${field}^{commit}`], timeoutMs)
  } catch (exc) {
    return `无法解析 tag 目标 "${field}"（${exc}），保守拒绝`
  }
  return p.code === 0 ? null : `无法解析 tag 目标 "${field}"（不是有效提交），拒绝`
}

/** 覆盖/移动既有 tag 的固定拦截原因（-f/--force 一切形态）。 */
function tagForceReason() {
  return 'git tag 不允许覆盖/移动既有 tag（-f/--force）：移动既有的 tag 会改写归属，'
    + '未 push 的 tag 请先 git tag -d 再重打，已 push 的交用户手动执行'
}

/**
 * 单破折号 token 的短选项簇展开：返回 {flags, value}。
 *
 * 按 git 的短选项语义：带值选项（-m/-F/-u）之后的余下字符即它的取值（如 -amX
 * → ['-a','-m'] + 'X'）；值取空（如 -am）时取值来自下一个 token，由调用方补。
 * flags 为空数组表示不是短选项簇。
 */
function tagValueShort(tok) {
  const chars = Array.from(tok)
  if (chars.length < 2 || !tok.startsWith('-') || tok.startsWith('--')) {
    return { flags: [], value: null }
  }
  const flags = []
  let value = null
  for (let idx = 1; idx < chars.length; idx += 1) {
    const ch = chars[idx]
    const flag = `-${ch}`
    flags.push(flag)
    if (ch === 'm' || ch === 'F' || ch === 'u') { // 带值选项：其后的字符就是它的取值
      value = chars.slice(idx + 1).join('')
      break
    }
  }
  return { flags, value }
}

/**
 * 校验 git tag 段（2026-10-07 v9）：只读列表随时可用，写操作只放开「新建」。
 *
 * 放开的写形态 = 在本地新建一个**全新** tag（annotated `-a`/`-m` 为规范形态，
 * 轻量 tag 也放行），tag 名不限（命令形状约束）；
 * 一律拦截：覆盖/移动、删除既有 tag、-s 签名与未开放选项、多位置参数、
 * 无法核实仓库的 -C/跨目录调用，以及远端已有同名 tag（已发布）的情况。
 */
async function evaluateTag(seg, redirected, cdTargets, cwd, timeoutMs, remoteTimeoutMs) {
  const tokens = seg.slice(seg.indexOf('tag') + 1)
  let listMode = false // 只读列表
  let del = false // 删除
  let newTag = false // 显式新建语义（-a/-m，或位置参数）
  const pos = [] // 位置参数：tag 名 + 可选目标
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    i += 1
    if (tok === '--') {
      pos.push(...tokens.slice(i))
      break
    }
    if (!tok.startsWith('-') || tok === '-') {
      pos.push(tok) // 位置参数：tag 名或目标
      continue
    }
    // ① 长选项
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=')
      const opt = eq === -1 ? tok : tok.slice(0, eq)
      let val = eq === -1 ? '' : tok.slice(eq + 1)
      if (opt === '--message') {
        if (!val) {
          if (i >= tokens.length) return 'git tag 的 --message 缺少取值'
          val = tokens[i]
          i += 1
        }
        newTag = true
        continue
      }
      if (TAG_READ_FLAGS.has(opt)) {
        listMode = true
        continue
      }
      if (TAG_FORCE_FLAGS.has(opt)) return tagForceReason()
      if (TAG_BLOCKED_FLAGS.has(opt)) {
        return `git tag 的 ${opt} 不在开放范围`
          + '（签名/校验/清理等形态一律交用户）'
      }
      if (TAG_DELETE_FLAGS.has(opt)) {
        del = true
        continue
      }
      if (TAG_VALUE_FLAGS.has(opt)) {
        if (!val) {
          if (i >= tokens.length) return `git tag 的 ${opt} 缺少取值`
          i += 1
        }
        return `git tag 的 ${opt} 不在开放范围`
          + '（message 请用 -m/--message；其余形态交用户）'
      }
      return `git tag 的 ${opt} 不在开放范围`
    }
    // ② 单破折号：-n5（列表行数）先放行；其余按短选项簇逐个判定
    if (TAG_N_RE.test(tok)) {
      listMode = true
      continue
    }
    const { flags: cluster, value: clusterVal } = tagValueShort(tok)
    if (cluster.length > 0) {
      // 覆盖优先：-f 即使与 -a/-d 同簇（-af/-df）也给「覆盖/移动」这条明确原因
      if (cluster.some((flag) => TAG_FORCE_FLAGS.has(flag))) return tagForceReason()
      for (const flag of cluster) {
        if (!TAG_SHORT_FLAGS.has(flag)) return `git tag 的选项 ${flag}（来自 ${tok}）不在开放范围`
        // 与 Python 版一致：-F/-u 不在 _TAG_SHORT_FLAGS，上面那条已先把它们拦下，
        // 这里保留同一结构，避免将来改动走偏
        if (flag === '-F' || flag === '-u') {
          return `git tag 的 ${flag} 不在开放范围`
            + '（message 请用 -m/--message；签名等形态交用户）'
        }
        if (flag === '-m') { // 簇内带值选项：取值可能续在下一个 token
          if (!clusterVal) {
            if (i >= tokens.length) return `git tag 的 ${tok} 缺少 -m 取值`
            i += 1
          }
          newTag = true
        } else if (flag === '-a') {
          newTag = true
        } else if (flag === '-d') {
          del = true
        } else if (flag === '-l') {
          listMode = true
        }
      }
      continue
    }
    if (TAG_FORCE_FLAGS.has(tok)) return tagForceReason()
    if (TAG_BLOCKED_FLAGS.has(tok)) return `git tag 的 ${tok} 不在开放范围（签名/校验等形态交用户）`
    if (TAG_READ_FLAGS.has(tok) || TAG_N_RE.test(tok)) {
      listMode = true
      continue
    }
    if (TAG_DELETE_FLAGS.has(tok)) {
      del = true
      continue
    }
    if (tok === '-a' || tok === '--annotate') {
      newTag = true
      continue
    }
    if (tok === '-m' || tok === '--message') {
      if (i >= tokens.length) return `git tag 的 ${tok} 缺少取值`
      i += 1
      newTag = true
      continue
    }
    if (TAG_VALUE_FLAGS.has(tok)) {
      return `git tag 的 ${tok} 不在开放范围`
        + '（message 请用 -m/--message；其余形态交用户）'
    }
    return `git tag 的选项 ${tok} 不在开放范围`
  }
  if (listMode) {
    if (del) return 'git tag 的 -l 与 -d 不能同时使用'
    return null // 只读列表：位置参数只是匹配 pattern
  }
  if (!del && !newTag && pos.length === 0) return null // 裸 git tag = 列表（只读）
  const name = pos.length > 0 ? pos[0] : null
  if (name === null) return 'git tag 缺少 tag 名'
  const shape = tagShapeError(name)
  if (shape) return `不适用的 tag 名 "${name}"：${shape}`
  const maxPos = del ? 1 : 2 // 删除只接受 tag 名；新建可跟一个目标
  if (pos.length > maxPos) {
    return del
      ? 'git tag -d 只接受 tag 名，不接受目标参数'
      : 'git tag 至多接受 <名称> [<目标>] 两个位置参数'
  }
  const reason = redirectOrCdReason(redirected, cdTargets, cwd, 'tag 操作')
  if (reason) return reason
  let exists
  try {
    exists = (await gitOut(cwd, ['rev-parse', '--verify', `refs/tags/${name}`], timeoutMs)).code === 0
  } catch (exc) {
    return `tag 存在性校验失败（${exc}），保守拒绝；如需执行请用户手动运行`
  }
  const remoteState = await tagOnRemote(name, cwd, remoteTimeoutMs, timeoutMs)
  if (!remoteState && await tagInTrackingRefs(name, cwd, timeoutMs)) {
    return `本地远端跟踪引用里已有同名 tag "${name}"（可能已发布）：`
      + '重打会让下游与 CI 缓存对不上；如需处理请用户手动执行'
  }
  if (remoteState) {
    return `远端已有同名 tag "${name}"（已发布的标签绝不动）：`
      + '重打/删除都会动到已发布的标签；如需处理请用户手动执行'
  }
  if (del) {
    if (exists) {
      return `本地既有 tag "${name}" 不是本会话新建的：agent 只能删除自己刚建、`
        + '从未 push 的 tag；删除既有 tag 请用户手动执行'
    }
    if (remoteState === null && await findRemote(cwd, timeoutMs) !== null) {
      return `无法确认远端 tag "${name}" 是否存在（查询失败），保守拒绝删除；`
        + '如需执行请用户手动运行'
    }
    return `本地没有 tag "${name}"：无可删除的对象；如要删除远端或其他会话创建的 `
      + 'tag，请用户手动执行'
  }
  if (exists) {
    return `本地已存在同名 tag "${name}"：agent 只新建、不改写/不删除既有 tag；`
      + '要移动或删除请用户手动执行'
  }
  return acceptTagTarget(pos, cwd, timeoutMs)
}

/** 新建 tag 的目标对象校验：缺省 HEAD；给了就解析成提交，解析不了保守拦。 */
function acceptTagTarget(pos, cwd, timeoutMs) {
  if (pos.length < 2) return null // 缺省 HEAD
  return tagCheckName(pos[1], cwd, timeoutMs)
}

// ── 未知子命令别名检查 ──────────────────────────────────────────────────────

/**
 * git 内建子命令表：别名无法遮蔽内建命令，只有不在表内的名字才可能是别名。
 */
const KNOWN_SUBCMDS = new Set([
  // 只读白名单
  'status', 'diff', 'log', 'show', 'tag', 'remote', 'blame', 'ls-files',
  'rev-parse', 'shortlog', 'reflog', 'describe', 'cat-file', 'grep',
  'stash', 'ls-remote', 'config', 'help', 'version', 'whatchanged',
  'range-diff', 'count-objects', 'symbolic-ref', 'merge-base', 'rev-list',
  'verify-commit', 'verify-tag', 'diff-tree', 'ls-tree', 'name-rev',
  // 受控写操作（各自有专属校验）
  'add', 'commit', 'reset', 'branch', 'worktree', 'merge', 'checkout', 'switch',
  // 其余内建命令（别名遮蔽不了，是否放开由 skill 纪律/权限层决定）
  'init', 'clone', 'push', 'pull', 'fetch', 'rebase', 'revert', 'cherry-pick',
  'restore', 'clean', 'rm', 'mv', 'bisect', 'gc', 'prune', 'fsck', 'notes',
  'apply', 'am', 'format-patch', 'cherry', 'archive', 'bundle', 'update-ref',
  'commit-tree', 'write-tree', 'read-tree', 'submodule', 'replace',
  'filter-branch', 'difftool', 'mergetool',
])

/**
 * 有专属校验逻辑、进日志的受控子命令（其余内建只读命令不进日志，避免刷屏）。
 * 2026-10-12 起同时用作 wrappedGitCall() 的 fail-closed 名单：段首之外出现这些子命令即拒绝。
 */
const LOGGED_SUBCMDS = new Set([
  'commit', 'reset', 'branch', 'worktree', 'merge', 'checkout', 'switch', 'config', 'tag',
])

/**
 * 校验 git config 段（2026-09-26 v8）：仅放行读形式，写形式一律拦截。
 * 读形式：--get/--get-all/--get-regexp/--list/省略选项的单 key 查询；
 * 写形式：设置值（≥2 个位置参数）与 --add/--unset/--edit 等写选项——别名配置
 * （alias.<name>）能让未知子命令携带任意命令绕过本 hook，必须堵住。
 */
function evaluateConfig(seg) {
  const tokens = seg.slice(seg.indexOf('config') + 1)
  const pos = []
  for (const tok of tokens) {
    if (CONFIG_WRITE_FLAGS.has(tok)) {
      return `git config 的写操作（${tok}）不放开（含别名配置——别名可绕过`
        + '本 hook 的命令校验）；如需配置请用户手动执行'
    }
    if (tok.startsWith('-')) continue // --get/--list/--global/--local 等读形式或作用域选项
    pos.push(tok)
  }
  if (pos.length > 1) {
    return 'git config 设置值属于写操作，不放开（含别名配置——别名可绕过'
      + '本 hook 的命令校验）；如需配置请用户手动执行'
  }
  return null
}

/**
 * 未知子命令别名检查（2026-09-26 v8）：配置了 alias.<name> 即拦截。
 * git 别名只能遮蔽非内建名字，因此只对 KNOWN_SUBCMDS 之外的子命令触发；
 * 查不到别名时放行（git 会自然报「不是 git 命令」），查询异常保守拦截。
 */
async function checkNoAlias(name, cwd, timeoutMs) {
  let p
  try {
    p = await gitOut(cwd, ['config', '--get', `alias.${name}`], timeoutMs)
  } catch (exc) {
    return `git 别名校验失败（${exc}），保守拒绝`
  }
  if (p.code === 0 && pyStrip(p.out) !== '') {
    return `"${name}" 是 git 别名（指向 "${pyStrip(p.out)}"），别名可携带`
      + '任意命令绕过本 hook 的校验，禁止经别名执行 git 操作；请用完整子命令'
  }
  return null
}

// ── 顶层入口 ────────────────────────────────────────────────────────────────

/**
 * 校验命令行中所有受控 git 操作的归属。
 *
 * @param {string} command 完整的 bash 命令行
 * @param {string} [cwd]   目标仓库目录（缺省用进程 cwd）
 * @param {{gitTimeoutMs?: number, trace?: {handled: string[]}}} [options]
 *        gitTimeoutMs：单个 git 子进程超时（默认 20s，远端探测按 1.5 倍）；
 *        trace.handled：出参，记录本次真正走校验的受控子命令（供日志用）。
 * @returns {Promise<string|null>} null 表示放行；字符串为拦截原因（回传给模型）
 */
export async function evaluate(command, cwd, options = {}) {
  const timeoutMs = Number.isInteger(options.gitTimeoutMs) && options.gitTimeoutMs > 0
    ? options.gitTimeoutMs
    : DEFAULT_GIT_TIMEOUT_MS
  const remoteTimeoutMs = Math.round(timeoutMs * REMOTE_TIMEOUT_RATIO)
  const trace = options.trace
  let tokens
  try {
    tokens = shlexSplit(command ?? '')
  } catch (exc) {
    return `命令引号无法解析（${exc.message}），无法校验 commit message；`
      + '请改用规范写法：git commit -m "--XXXXXX-- <摘要>"'
  }
  const baseCwd = cwd || process.cwd()
  const cdTargets = [] // reset 段之前出现的 cd 目标（跨目录 reset 无法校验归属）
  for (const seg of segments(tokens)) {
    if (seg.length > 0 && seg[0] === 'cd') {
      cdTargets.push(seg.length > 1 ? seg[seg.length - 1] : '~')
      continue
    }
    const { subcmd, redirected } = gitCall(seg)
    if (subcmd === null) {
      // 段首认不出 git 调用时，再兜一次：段内出现被校验的 git 子命令即 fail-closed（2026-10-12）
      const wrapped = wrappedGitCall(seg)
      if (wrapped !== null) return reasonWrappedGit(wrapped)
      continue
    }
    if (trace !== undefined && (LOGGED_SUBCMDS.has(subcmd) || !KNOWN_SUBCMDS.has(subcmd))) {
      trace.handled.push(`git ${subcmd}`)
    }
    if (subcmd === 'commit') {
      const { messages, isAmend, hasNoEdit } = extract(seg)
      if (messages.length === 0) {
        if (isAmend && hasNoEdit) {
          // --amend --no-edit 保留原 message，但仍须核实 HEAD 归属与未推送
          const reason = await checkAmendOwnership(baseCwd, timeoutMs)
          if (reason) return reason
          continue
        }
        return reasonNoMessage()
      }
      const first = pyStrip(messages[0])
      if (!first) return reasonNoMessage()
      const subject = pySplitLines(first)[0]
      if (!(SUBJECT_PREFIX_RE.test(subject) || subject.startsWith(FALLBACK_PREFIX))) {
        return 'commit message 首行必须以 "--<6位会话短id>-- "（如 "--D7DC1D-- "）'
          + `或 "${FALLBACK_PREFIX}" 开头，`
          + `当前首行为 "${subject}"。`
          + '请改为 git commit -m "--XXXXXX-- <摘要>"。'
      }
      if (isAmend) {
        // amend 会改写已有提交：message 形状合规后，还要过 HEAD 归属与未推送检查
        const reason = await checkAmendOwnership(baseCwd, timeoutMs)
        if (reason) return reason
      }
    } else if (subcmd === 'reset') {
      const reason = await evaluateReset(seg, redirected, cdTargets, baseCwd, timeoutMs)
      if (reason) return reason
    } else if (subcmd === 'branch') {
      const reason = evaluateBranch(seg, redirected, cdTargets, baseCwd)
      if (reason) return reason
    } else if (subcmd === 'worktree') {
      const reason = await evaluateWorktree(seg, redirected, cdTargets, baseCwd, timeoutMs)
      if (reason) return reason
    } else if (subcmd === 'merge') {
      const reason = await evaluateMerge(seg, redirected, cdTargets, baseCwd, timeoutMs)
      if (reason) return reason
    } else if (subcmd === 'checkout' || subcmd === 'switch') {
      return `git ${subcmd} 不放开（会切换当前仓库状态）；`
        + '要隔离工作区请用 git worktree add <路径> -b agent/<6位短id>'
    } else if (subcmd === 'config') {
      const reason = evaluateConfig(seg)
      if (reason) return reason
    } else if (subcmd === 'tag') {
      const reason = await evaluateTag(seg, redirected, cdTargets, baseCwd, timeoutMs, remoteTimeoutMs)
      if (reason) return reason
    } else if (!KNOWN_SUBCMDS.has(subcmd)) {
      // 内建命令别名遮蔽不了；表外名字若配置了别名则可绕过校验，拦
      const reason = await checkNoAlias(subcmd, baseCwd, timeoutMs)
      if (reason) return reason
    }
  }
  return null
}
