// dsh-readonly-guard 分类核心 —— `~/.kimi-code/hooks/readonly_guard.py` 的忠实 JS 移植。
//
// 本文件只做「分类 + 白名单 + 审批记录」三件事，不碰任何 DSH 扩展点，便于单独做差分测试：
// 同一批命令喂给 Python 的 `is_read_only_command()` / `is_whitelisted()` 与这里的
// `isReadOnlyCommand()` / `isWhitelisted()`，布尔结果必须逐条相同（见 test/differential.mjs）。
//
// 移植口径（与源文件一一对应，函数名 camelCase 化，常量名保持不变）：
//   strip_leading_env     → stripLeadingEnv
//   get_first_token       → getFirstToken
//   has_write_redirection → hasWriteRedirection
//   looks_read_only_python→ looksReadOnlyPython
//   split_shell_segments  → splitShellSegments
//   is_read_only_command  → isReadOnlyCommand
//   _is_read_only_segment → isReadOnlySegment（去掉下划线前缀，本文件内可自由调用）
//   load_whitelist        → loadWhitelist（多一个可注入的 whitelistPath 参数，默认与 Python 常量同值）
//   _matches_whitelist    → matchesWhitelist
//   is_whitelisted        → isWhitelisted（同样支持注入 whitelistPath）
//   record_approval       → recordApproval（支持注入 pendingPath）
//
// 覆盖范围与已知限制沿用 Python docstring，见本包 README.md 的「覆盖范围」一节。
//
// 依赖的 Python 标准库语义在此自行实现，理由与忠实度：
//   os.path.basename  → posixBasename（POSIX 语义，差分只在 Linux 上跑）
//   shlex.split(posix) → shlexSplit（按 CPython 3.12 shlex.read_token 逐状态移植）
//   fnmatch.fnmatchcase→ fnmatchCase（按 CPython 3.12 fnmatch.translate 逐分支移植）

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// 审批标记
// ---------------------------------------------------------------------------

/** 用户审批标记：必须独占一行（bash 把 '#' 当注释），下一行才是真正的命令。 */
export const APPROVAL_MARKER = '######USER_APPROVED######'

// 审批数据文件：白名单是历史学习结果（只读），pending 是本次审批的追加日志。
// 两个路径都与 kimi 侧共用同一份文件，格式必须双向兼容。
export const DEFAULT_WHITELIST_PATH = join(homedir(), '.kimi-code', 'readonly_whitelist.json')
export const DEFAULT_PENDING_PATH = join(homedir(), '.kimi-code', 'readonly_pending.jsonl')

// ---------------------------------------------------------------------------
// 只读 / 可写命令分类
// ---------------------------------------------------------------------------

/** 明确只读的命令（集合语义；源文件里 "lsof" 出现两次，Set 自动去重，此处照抄以方便逐行比对）。 */
export const READ_ONLY_COMMANDS = new Set([
  // 文件系统查看
  'ls', 'll', 'cat', 'tac', 'less', 'more', 'head', 'tail', 'file',
  'stat', 'du', 'df', 'find', 'locate', 'which', 'whereis', 'pwd',
  'readlink', 'realpath', 'dirname', 'basename', 'lsblk', 'lscpu',
  'lsmem', 'lsusb', 'lspci', 'lsof', 'blkid',
  // 文本检索
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'gawk',
  'nawk', 'cut', 'sort', 'uniq', 'wc', 'tr', 'column', 'strings',
  'xxd', 'hexdump', 'od', 'diff', 'cmp', 'comm', 'patch',
  // 进程查看
  'ps', 'pgrep', 'pstree', 'top', 'htop', 'vmstat', 'iostat', 'mpstat',
  'sar', 'free', 'uptime', 'who', 'w', 'last', 'lastb', 'id', 'groups',
  // 网络查看
  'ping', 'ping6', 'traceroute', 'tracepath', 'mtr', 'ss', 'netstat',
  'lsof', 'nslookup', 'dig', 'host', 'whois', 'curl', 'wget',
  // 归档 / 压缩（列目录时只读）
  'tar', 'unzip', 'zipinfo', 'zcat', 'zless', 'bzcat', 'bzless',
  'xzcat', 'lzcat',
  // 解释器（载荷另行检查）
  'python', 'python3', 'python2', 'py', 'bash', 'sh', 'zsh', 'fish',
  'ssh', 'scp', 'sftp',
  // 其它只读命令
  'date', 'cal', 'env', 'printenv', 'echo', 'printf', 'yes', 'true',
  'false', 'test', '[', '[[', 'seq', 'jot', 'expr', 'bc', 'dc',
  'nm', 'objdump', 'readelf', 'ldd', 'strace', 'time', 'timeout',
  // 只读输入的 shell 内建
  'read',
  // 版本管理 / 容器
  'git', 'hg', 'svn', 'docker', 'podman', 'kubectl',
])

/** 明确可写（或不可安全判定）的命令：一律不当作只读。 */
export const MUTATING_COMMANDS = new Set([
  'rm', 'rmdir', 'del', 'erase',
  'cp', 'copy', 'mv', 'move', 'rename', 'ren',
  'ln', 'link', 'symlink', 'mklink',
  'chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'chacl',
  'mkdir', 'mkfifo', 'mknod', 'mktemp',
  'touch', 'truncate', 'install',
  'dd',
  'fdisk', 'parted', 'mkfs', 'mount', 'umount', 'format',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'systemctl',
  'kill', 'killall', 'pkill', 'xargs',
  'pip', 'pip3', 'pip2', 'npm', 'yarn', 'pnpm', 'gem', 'bundle',
  'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'zypper', 'apk',
  'make', 'cmake', 'ninja', 'meson',
  'git', // 取决于子命令
  'docker', 'podman', 'kubectl', // 取决于子命令
  'crontab', 'at', 'batch',
  'passwd', 'useradd', 'usermod', 'userdel', 'groupadd', 'groupdel',
  'visudo', 'sudo', 'su', 'doas',
  'source', '.',
  'eval', 'exec',
])

/** 子命令粒度的只读白名单。 */
export const READ_ONLY_SUBCOMMANDS = {
  git: new Set([
    'status', 'log', 'show', 'diff', 'blame', 'grep', 'ls-files',
    'ls-tree', 'ls-remote', 'for-each-ref', 'branch', 'tag', 'remote',
    'config', 'help', 'version', 'rev-parse', 'rev-list', 'name-rev',
    'describe', 'merge-base', 'verify-tag', 'verify-commit',
    'cat-file', 'archive',
  ]),
  docker: new Set([
    'ps', 'images', 'inspect', 'logs', 'top', 'stats', 'version',
    'info', 'search', 'port', 'diff', 'history',
  ]),
  kubectl: new Set([
    'get', 'describe', 'logs', 'top', 'version', 'api-resources',
    'api-versions', 'explain',
  ]),
}

/** 子命令粒度的可写黑名单（与只读表一起决定 git/docker/kubectl 的判定）。 */
export const MUTATING_SUBCOMMANDS = {
  git: new Set([
    'add', 'rm', 'mv', 'commit', 'push', 'pull', 'fetch', 'merge',
    'rebase', 'cherry-pick', 'revert', 'reset', 'checkout', 'switch',
    'restore', 'stash', 'clean', 'init', 'clone', 'gc', 'prune',
  ]),
  docker: new Set([
    'run', 'exec', 'create', 'start', 'stop', 'restart', 'kill',
    'rm', 'rmi', 'build', 'pull', 'push', 'tag', 'commit', 'load',
    'save', 'import', 'export', 'update', 'pause', 'unpause',
  ]),
  kubectl: new Set([
    'create', 'apply', 'delete', 'patch', 'edit', 'replace', 'run',
    'expose', 'scale', 'rollout', 'set', 'label', 'annotate',
    'taint', 'cordon', 'uncordon', 'drain', 'auth',
  ]),
}

/** python -c 片段里的写操作特征（命中即认为非只读）。 */
const PYTHON_WRITE_PATTERNS = [
  /\bopen\s*\(\s*[^,\)]+\s*,\s*['"][waxr]/,
  /\bos\.(?:remove|unlink|rmdir|rename|replace|mkdir|makedirs)\s*\(/,
  /\bshutil\.(?:copy|move|rmtree|remove)/,
  /\bsubprocess\.(?:call|run|Popen|check_call|check_output)/,
  /\bos\.system\s*\(/,
  /\bexec\s*\(/,
  /\beval\s*\(/,
]

// Python 的 str 正则是 Unicode 语义：`\s` 含 U+001C-U+001F、U+0085 等，**不含** U+FEFF；
// JS 的 `\s` 恰好相反（不含前者、含 U+FEFF）。两者不一致会让 `\S+` / `[^'"\s]` 这类
// 字符类在含特殊空白的命令上给出不同结果，所以这里把 Python 的集合显式写出来复用
// （`python -c` / `bash -c` 的提取正则也一并改成这套字符类）。
// 集合 = Python 3 str.isspace() 为真的字符（与 re 的 `\s` 一致）。
const PY_SPACE = ' \\t\\n\\r\\f\\v\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
/** `\s` */
const WS = `[${PY_SPACE}]`
/** `\S` */
const NON_WS = `[^${PY_SPACE}]`
/** `[^'"\s]` */
const NON_WS_NO_QUOTE = `[^'"${PY_SPACE}]`

/** 行首环境变量赋值（含取值可带引号）。 */
const ENV_ASSIGN_PATTERN = new RegExp(
  `^(?:${WS}*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|${NON_WS_NO_QUOTE}${NON_WS}*)${WS}+)*${WS}*`)

/** 跳过环境变量赋值与前导 `-flag` 后取第一个 token。 */
const FIRST_TOKEN_PATTERN = new RegExp(
  `^(?:${WS}*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|${NON_WS_NO_QUOTE}${NON_WS}*)${WS}+)*`
  + `(?:${WS}*[-+]${NON_WS}+${WS}+)*${WS}*(${NON_WS}+)`)

/** has_write_redirection 的分词：按空白切分，但把成对引号整体保留。 */
const REDIRECTION_SPLIT_PATTERN = new RegExp(`(${WS}+|"[^"]*"|'[^']*')`)
/** 形如 2> / 2>> / 2<> 的数字重定向 token。 */
const NUMERIC_REDIRECTION_PATTERN = new RegExp(`^[0-9]+(>>?|<>?)${WS}*$`)
/** 回退分词：等价于 Python str.split()（按空白切、丢弃空串）。 */
const WHITESPACE_SPLIT_PATTERN = new RegExp(`${WS}+`)
/** Python str.strip()：两端各剥掉一串 PY_SPACE。JS 的 trim() 集合不同，不能直接用。 */
const STRIP_PATTERN = new RegExp(`^${WS}+|${WS}+$`, 'g')

/** Python str.strip() 的等价实现。 */
export function pyStrip(text) {
  return text.replace(STRIP_PATTERN, '')
}

/** 只匹配「命令串以标记开头」的情形（Python 用 re.match，等价于锚定在 0 位）。 */
export const APPROVAL_MARKER_RE = new RegExp(`^${APPROVAL_MARKER}${WS}*`)

/** 取出 `python -c '<代码>'` 的代码部分（Python 侧 re.DOTALL → JS s 标志）。 */
const PY_C_PATTERN = new RegExp(
  `\\bpython(?:3|2)?\\b(?:${WS}+${NON_WS}+)*${WS}+-c${WS}+(['"])(.+?)\\1`, 's')
/** 取出 `bash -c '<命令>'` / `sh -c` / `zsh -c` / `fish -c` 的命令部分。 */
const BASH_C_PATTERN = new RegExp(
  `\\b(?:bash|sh|zsh|fish)\\b(?:${WS}+${NON_WS}+)*${WS}+-c${WS}+(['"])(.+?)\\1`, 's')

// 命令替换：$(cmd) 在第 1 组，`cmd` 在第 2 组。$(...) 采用非贪婪匹配，嵌套替换会先分类最内层
// 命令；算术展开 $((...)) 由调用方跳过。单引号内的替换在 bash 里并不执行，但这里仍会检查，
// 属于「宁可拦错、不可漏放」的保守取向。
const CMD_SUBST_PATTERN = /\$\((.*?)\)|`([^`]*)`/gs

// ---------------------------------------------------------------------------
// 基础 helper
// ---------------------------------------------------------------------------

/** 去掉行首的环境变量赋值。 */
export function stripLeadingEnv(command) {
  return pyStrip(command.replace(ENV_ASSIGN_PATTERN, ''))
}

/** 取命令名（忽略环境变量赋值、前导短横线选项）；取不到返回 null。 */
export function getFirstToken(command) {
  const m = FIRST_TOKEN_PATTERN.exec(command)
  if (m === null) return null
  const token = m[1].replace(/[;|&<>]+$/, '')
  return token.length > 0 ? token : null
}

/** 输出重定向 token 全集（会创建/覆盖文件）。 */
const WRITE_REDIRECTION_TOKENS = new Set(['>', '>>', '<>', '>|', '&>', '>&', '&>>'])

/** 是否含「会创建或覆盖文件」的输出重定向。 */
export function hasWriteRedirection(command) {
  // Python 用 re.split(捕获组) 保留分隔符，JS 的 String.split 同样保留捕获组。
  const tokens = command.split(REDIRECTION_SPLIT_PATTERN)
  for (const raw of tokens) {
    const tok = pyStrip(raw)
    if (tok.length === 0) continue
    if (WRITE_REDIRECTION_TOKENS.has(tok)) return true
    if (NUMERIC_REDIRECTION_PATTERN.test(tok)) return true // 形如 2> / 2>> / 2<>
  }
  return false
}

/** 启发式判断 `python -c` 片段是否只读。 */
export function looksReadOnlyPython(code) {
  const text = pyStrip(code)
  if (text.length === 0) return true
  for (const pattern of PYTHON_WRITE_PATTERNS) {
    if (pattern.test(text)) return false
  }
  return true
}

/**
 * 按「未加引号的 `;` / `&&` / `||` / 换行」切分命令行。
 *
 * 引号（' 与 "）与反斜杠转义会关闭分隔符识别，直到配对结束，因此 `echo 'a;b'` 仍是单段。
 * 单个 `|` 与 `&` 留在段内：管道/后台列表按第一个命令分类，与守卫的原始行为一致。
 * 不解析 heredoc：其正文与结束符各成一段，通常会分类失败，从而保守地保持阻断。
 */
export function splitShellSegments(command) {
  const segments = []
  let buf = []
  let quote = null
  let i = 0
  const n = command.length
  while (i < n) {
    const ch = command[i]
    if (quote !== null) {
      buf.push(ch)
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      buf.push(ch)
      i += 1
      continue
    }
    if (ch === '\\') {
      // 转义字符：连同被转义的下一个字符一起保留。
      buf.push(ch)
      if (i + 1 < n) buf.push(command[i + 1])
      i += 2
      continue
    }
    if (ch === ';' || ch === '\n') {
      segments.push(buf.join(''))
      buf = []
      i += 1
      continue
    }
    if (command.startsWith('&&', i) || command.startsWith('||', i)) {
      segments.push(buf.join(''))
      buf = []
      i += 2
      continue
    }
    buf.push(ch)
    i += 1
  }
  segments.push(buf.join(''))
  return segments
}

// ---------------------------------------------------------------------------
// 白名单
// ---------------------------------------------------------------------------

/** 纯对象判定（对应 Python 的 isinstance(p, dict)）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取白名单条目；任何异常都返回 []（fail-open，与 Python 一致）。 */
export function loadWhitelist(whitelistPath = DEFAULT_WHITELIST_PATH) {
  try {
    const data = JSON.parse(readFileSync(whitelistPath, 'utf8'))
    const patterns = Array.isArray(data?.patterns) ? data.patterns : []
    // Python 的过滤条件是 isinstance(p, dict) and p.get("pattern")（真值语义）。
    // 这里收紧为「非空字符串」：白名单文件若被写坏（如 pattern 是数组），Python 会在
    // fnmatch 里抛 TypeError，JS 则直接忽略该条 —— 后者更安全，且不影响合法文件。
    return patterns.filter((p) => isPlainObject(p) && typeof p.pattern === 'string' && p.pattern.length > 0)
  } catch {
    return []
  }
}

/**
 * 单个 shell 段与单条白名单条目的匹配。
 *
 * `exact` 条目整段字符串相等；其余按 fnmatch 通配（例如 "mycli query *"，
 * 由已下线的 whitelist_learn.py 在 2026-10-01 之前生成）。
 */
export function matchesWhitelist(segment, entry) {
  if (entry.type === 'exact') return segment === entry.pattern
  return fnmatchCase(segment, entry.pattern)
}

/**
 * 命令的每一个 shell 段都命中白名单时返回 true。
 *
 * 逐段匹配是为了让 `approved_cmd; dangerous_cmd` 无法靠前缀命中蒙混过关。
 */
export function isWhitelisted(command, { whitelistPath = DEFAULT_WHITELIST_PATH } = {}) {
  const patterns = loadWhitelist(whitelistPath)
  if (patterns.length === 0) return false
  const segments = splitShellSegments(command)
    .map((s) => pyStrip(s))
    .filter((s) => s.length > 0)
  if (segments.length === 0) return false
  return segments.every((seg) => patterns.some((p) => matchesWhitelist(seg, p)))
}

/**
 * 把用户已批准的命令追加到 pending 日志。
 *
 * 单次 O_APPEND 写一短行是原子的，多会话并发不会写坏日志。异常一律吞掉：学习是尽力而为，
 * 绝不能因此阻断守卫本身。
 *
 * 记录必须与 Python `record_approval` 逐字段、逐字节一致（kimi 侧仍在读这份数据），因此：
 *   - 字段顺序固定为 cmd / session / ts；
 *   - 分隔符沿用 Python json.dumps 的默认 `", "` / `": "`（JS 的 JSON.stringify 不带空格）；
 *   - 不转义非 ASCII（对应 ensure_ascii=False）；
 *   - ts 为 Unix 秒（Python time.time()；JS 侧只有毫秒精度）。
 *
 * @param {string} command 去掉审批标记后的命令。
 * @param {string} sessionId 会话 id（对应 payload["session_id"]）。
 * @param {string} [pendingPath] 追加目标，测试可指向临时 fixture。
 */
export function recordApproval(command, sessionId, pendingPath = DEFAULT_PENDING_PATH) {
  try {
    const cmd = typeof command === 'string' ? command : ''
    const session = typeof sessionId === 'string' ? sessionId : ''
    const ts = Date.now() / 1000
    const line = `{"cmd": ${JSON.stringify(cmd)}, "session": ${JSON.stringify(session)}, "ts": ${JSON.stringify(ts)}}`
    mkdirSync(dirname(pendingPath), { recursive: true })
    appendFileSync(pendingPath, `${line}\n`, 'utf8')
  } catch {
    /* 尽力而为：学习失败不得阻断守卫 */
  }
}

// ---------------------------------------------------------------------------
// 主分类
// ---------------------------------------------------------------------------

/** 整条命令是否只读：先剥行首环境变量，再逐段判定。 */
export function isReadOnlyCommand(command) {
  const text = pyStrip(stripLeadingEnv(command))
  if (text.length === 0) return true
  for (const seg of splitShellSegments(text)) {
    if (!isReadOnlySegment(pyStrip(seg))) return false
  }
  return true
}

/** 会递归进入下一条命令的控制结构关键字（do/then/... 后面跟的是命令）。 */
const CONTROL_PREFIX_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '{', '!'])
/** 纯块结束标记（本身不执行命令）。 */
const BLOCK_END_KEYWORDS = new Set(['done', 'fi', 'esac', '}'])
/** shell 解释器命令名。 */
const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'fish'])
/** python 解释器命令名。 */
const PYTHON_COMMANDS = new Set(['python', 'python3', 'python2', 'py'])
/** ssh 中「后面还跟一个取值」的短选项。 */
const SSH_OPTIONS_WITH_VALUE = new Set(['-i', '-l', '-p', '-F', '-o', '-D', '-L', '-R', '-w'])

/** 判定单个 shell 段（段内不再含未加引号的 &&/||/;/换行）。 */
export function isReadOnlySegment(command) {
  if (command.length === 0) return true

  if (hasWriteRedirection(command)) return false

  // 命令替换（$(cmd) 与 `cmd`）本身会执行命令，必须逐个也判为只读；
  // 算术展开 $((...)) 不是命令，跳过。
  for (const m of command.matchAll(CMD_SUBST_PATTERN)) {
    let inner
    if (m[1] !== undefined) {
      if (command.slice(m.index + 2, m.index + 3) === '(') continue // $(( 算术展开
      inner = m[1]
    } else {
      inner = m[2]
    }
    if (!isReadOnlyCommand(inner)) return false
  }

  const first = getFirstToken(command)
  if (first === null) return true

  const base = posixBasename(first)
  // 注意：Python 这里用 command[len(first):]，即假定 token 落在第 0 位；存在行首赋值/选项时
  // 会切出错位字符串（源文件既有行为）。为保持逐条一致，这里照抄该语义，只把「按字符数切片」
  // 换成「按码点切片」以免星平面字符造成偏差。
  const rest = pyStrip([...command].slice([...first].length).join(''))

  // shell 控制结构。下列关键字本身不执行任何东西：
  // - do/then/else/elif/if/while/until、`{`、`!` 后面跟命令（或什么都不跟），递归分类；
  // - `for` 头部（for name in words...）也不执行命令 —— 其中的命令替换已在上面判过；
  // - done/fi/esac/`}` 是纯块标记。
  // `case`、子 shell `( ... )`、C 风格 `for (( ... ))` 不解析，其片段落到保守默认值，保持阻断。
  if (CONTROL_PREFIX_KEYWORDS.has(base)) return isReadOnlySegment(rest)
  if (base === 'for') return true
  if (BLOCK_END_KEYWORDS.has(base)) return rest.length === 0 || isReadOnlySegment(rest)

  if (SHELL_COMMANDS.has(base)) {
    const m = BASH_C_PATTERN.exec(command)
    if (m !== null) return isReadOnlyCommand(m[2])
    return false
  }

  if (PYTHON_COMMANDS.has(base)) {
    const m = PY_C_PATTERN.exec(command)
    if (m !== null) return looksReadOnlyPython(m[2])
    return false
  }

  if (base === 'ssh') {
    const tokens = shlexSplitOrFallback(rest)
    let i = 0
    while (i < tokens.length) {
      const t = tokens[i]
      if (t.startsWith('-')) {
        i += 1
        if (SSH_OPTIONS_WITH_VALUE.has(t) && i < tokens.length) i += 1
      } else {
        break
      }
    }
    if (i < tokens.length) {
      i += 1 // 跳过主机名
      const remoteCommand = tokens.slice(i).join(' ')
      return isReadOnlyCommand(remoteCommand)
    }
    return false
  }

  if (base === 'git' || base === 'docker' || base === 'podman' || base === 'kubectl') {
    const key = base === 'podman' ? 'docker' : base
    const tokens = shlexSplitOrFallback(rest)
    const subcommand = tokens.length > 0 ? tokens[0] : ''
    if (READ_ONLY_SUBCOMMANDS[key].has(subcommand)) return true
    if (MUTATING_SUBCOMMANDS[key].has(subcommand)) return false
    return false
  }

  if (base === 'kimi') {
    const tokens = shlexSplitOrFallback(rest)
    // 帮助 / 版本类查询是只读的：commander.js 打印帮助或版本文本后直接退出，不会进入任何
    // action handler，例如 kimi --help / kimi --version / kimi help [cmd] / kimi <子命令> --help。
    // 因此独立的 --help/-h token 永远安全；最坏情况也只是被当成一个无副作用的选项取值。
    if (tokens.length === 0) {
      // 裸 `kimi` 会启动交互式会话：非只读。
      return false
    }
    if (tokens[0] === '--help' || tokens[0] === '-h' || tokens[0] === '--version' || tokens[0] === '-V' || tokens[0] === 'help') {
      return true
    }
    if (tokens.slice(1).some((t) => t === '--help' || t === '-h')) return true
    // 只读子命令，按子命令粒度匹配。
    const sub = tokens[0]
    // `kimi doctor` 只校验配置文件。
    if (sub === 'doctor') return true
    // `kimi server ps` / `kimi server status` 只查看服务状态。
    if (sub === 'server' && tokens.length > 1 && (tokens[1] === 'ps' || tokens[1] === 'status')) return true
    // `kimi provider list` / `kimi provider catalog list` 只读本地配置或公开模型目录；
    // `provider add`、`provider remove`、`provider catalog add` 会改配置，保持阻断。
    if (sub === 'provider' && tokens.length > 1) {
      if (tokens[1] === 'list') return true
      if (tokens[1] === 'catalog' && tokens.length > 2 && tokens[2] === 'list') return true
    }
    // 其余（server install/kill/run、web、export、migrate、upgrade、provider add/remove...）保守阻断。
    return false
  }

  if (MUTATING_COMMANDS.has(base)) return false
  if (READ_ONLY_COMMANDS.has(base)) return true

  return false
}

// ---------------------------------------------------------------------------
// 标准库语义移植：os.path.basename / shlex.split / fnmatch.fnmatchcase
// ---------------------------------------------------------------------------

/** os.path.basename 的 POSIX 语义（'a/b/' → ''，'/' → ''）。 */
export function posixBasename(path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * shlex.split(s, posix=True) 的等价实现。
 *
 * 按 CPython 3.12 `shlex.read_token` 的状态机逐状态移植；本用途下构造参数固定为
 * punctuation_chars=''、commenters=''、whitespace_split=True、posix=True，
 * 因此标点状态（'c'）与 pushback 分支不可达，已略去；保留的判断顺序与源实现一致。
 *
 * 与 Python 一致地在两种情况下抛错（调用方据此回退到 str.split()）：
 *   - 引号未闭合 → "No closing quotation"
 *   - 转义符后到达串尾 → "No escaped character"
 */
export function shlexSplit(input) {
  const WHITESPACE = ' \t\r\n'
  const QUOTES = "'\""
  const ESCAPE = '\\'
  // posix 模式下 wordchars 额外包含这批拉丁字母；whitespace_split=true 时其实不参与判定，
  // 保留是为了让状态迁移与 CPython 完全同形。
  const WORDCHARS = 'abcdfeghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'
    + 'ßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ'

  const out = []
  let i = 0
  const n = input.length
  let state = ' ' // ' ' | 'a' | "'" | '"' | '\\'
  let token = ''
  let quoted = false
  let escapedstate = ' '
  for (;;) {
    const eof = i >= n
    const ch = eof ? '' : input[i]
    if (!eof) i += 1

    if (state === ' ') {
      if (eof) break
      if (WHITESPACE.includes(ch)) continue // token 在 ' ' 态必为空
      if (ch === ESCAPE) { escapedstate = 'a'; state = ESCAPE; continue }
      if (WORDCHARS.includes(ch)) { token = ch; state = 'a'; continue }
      if (QUOTES.includes(ch)) { state = ch; continue }
      token = ch; state = 'a'; continue // whitespace_split=true 且无标点字符集
    } else if (state === "'" || state === '"') {
      quoted = true
      if (eof) throw new Error('No closing quotation')
      if (ch === state) { state = 'a'; continue }
      if (ch === ESCAPE && state === '"') { escapedstate = state; state = ESCAPE; continue }
      token += ch
      continue
    } else if (state === ESCAPE) {
      if (eof) throw new Error('No escaped character')
      // 引号内的 `\x`：x 既不是引号本身也不是反斜杠时，反斜杠原样保留。
      if ((escapedstate === "'" || escapedstate === '"') && ch !== ESCAPE && ch !== escapedstate) token += ESCAPE
      token += ch
      state = escapedstate
      continue
    } else {
      // 'a'：词中
      if (eof) break
      if (WHITESPACE.includes(ch)) {
        out.push(token)
        token = ''
        quoted = false
        escapedstate = ' '
        state = ' '
        continue
      }
      if (QUOTES.includes(ch)) { state = ch; continue }
      if (ch === ESCAPE) { escapedstate = 'a'; state = ESCAPE; continue }
      token += ch
      continue
    }
  }
  // 到达串尾时若还有内容（或出现过引号，例如 shlex.split("''") === ['']）则产出最后一个 token。
  if (token.length > 0 || quoted) out.push(token)
  return out
}

/** shlex 失败时按 Python 的 `str.split()` 语义回退（按空白切、丢弃空串）。 */
function fallbackSplit(text) {
  return text.split(WHITESPACE_SPLIT_PATTERN).filter((s) => s.length > 0)
}

/** shlex 能解析就用它，抛错则回退 —— 对应 Python 的 try/except ValueError。 */
function shlexSplitOrFallback(text) {
  try {
    return shlexSplit(text)
  } catch {
    return fallbackSplit(text)
  }
}

/** Python re.escape 的字符集里，JS 正则（非 u 标志）同样需要转义的字符。 */
function escapeRegexChar(ch) {
  return /[.*+?^${}()|[\]\\/\-&~# ]/.test(ch) ? `\\${ch}` : ch
}

/**
 * fnmatch.fnmatchcase(name, pattern) 的等价实现。
 *
 * 直接按 CPython 3.12 `fnmatch.translate` 逐分支移植，再交给 JS RegExp；
 * 唯一差别是 `(?>.*?fixed)` 原子组写成 `(?:.*?fixed)`（JS 无原子组）——
 * 该组只影响回溯性能，不改变本场景（整体以 \Z 收尾的匹配判定）的真假结果。
 */
export function fnmatchCase(name, pattern) {
  return fnmatchTranslate(pattern).test(name)
}

const fnmatchCache = new Map()

/** 翻译结果带缓存（对应 Python 的 _compile_pattern lru_cache）。 */
function fnmatchTranslate(pattern) {
  const cached = fnmatchCache.get(pattern)
  if (cached !== undefined) return cached
  const compiled = new RegExp(fnmatchTranslateSource(pattern), 's')
  if (fnmatchCache.size > 32768) fnmatchCache.clear()
  fnmatchCache.set(pattern, compiled)
  return compiled
}

const STAR = Symbol('STAR')

/** 与 CPython fnmatch.translate 同构：返回不带锚点标志的正则源码（`s` 标志由调用方加）。 */
function fnmatchTranslateSource(pat) {
  const res = []
  let i = 0
  const n = pat.length
  while (i < n) {
    const c = pat[i]
    i += 1
    if (c === '*') {
      // 连续 `*` 合并成一个
      if (res.length === 0 || res[res.length - 1] !== STAR) res.push(STAR)
    } else if (c === '?') {
      res.push('.')
    } else if (c === '[') {
      let j = i
      if (j < n && pat[j] === '!') j += 1
      if (j < n && pat[j] === ']') j += 1
      while (j < n && pat[j] !== ']') j += 1
      if (j >= n) {
        res.push('\\[')
      } else {
        let stuff = pat.slice(i, j)
        if (!stuff.includes('-')) {
          stuff = stuff.replaceAll('\\', '\\\\')
        } else {
          const chunks = []
          let start = i
          let k = pat[i] === '!' ? i + 2 : i + 1
          for (;;) {
            k = pat.indexOf('-', k)
            if (k < 0 || k >= j) break
            chunks.push(pat.slice(start, k))
            start = k + 1
            k += 3
          }
          const chunk = pat.slice(start, j)
          if (chunk.length > 0) chunks.push(chunk)
          else chunks[chunks.length - 1] += '-'
          // 去掉空区间（在正则里非法）
          for (let m = chunks.length - 1; m > 0; m -= 1) {
            if (chunks[m - 1].slice(-1) > chunks[m].slice(0, 1)) {
              chunks[m - 1] = chunks[m - 1].slice(0, -1) + chunks[m].slice(1)
              chunks.splice(m, 1)
            }
          }
          // 为集合差（--）转义反斜杠与连字符；构成区间的连字符不转义
          stuff = chunks.map((s) => s.replaceAll('\\', '\\\\').replaceAll('-', '\\-')).join('-')
        }
        // 转义集合运算（&&、~~、||）
        stuff = stuff.replace(/[&~|]/g, '\\$&')
        i = j + 1
        if (stuff.length === 0) {
          res.push('(?!)') // 空区间：永不匹配
        } else if (stuff === '!') {
          res.push('.') // 取反的空区间：匹配任意字符
        } else {
          if (stuff[0] === '!') stuff = `^${stuff.slice(1)}`
          else if (stuff[0] === '^' || stuff[0] === '[') stuff = `\\${stuff}`
          res.push(`[${stuff}]`)
        }
      }
    } else {
      res.push(escapeRegexChar(c))
    }
  }

  // 处理 STAR：首段固定字面量原样前置；其余「STAR + 固定片段」用惰性匹配，
  // 收尾的固定片段前面补 `.*`（贪婪），与 CPython 的展开顺序一致。
  const inp = res
  const outParts = []
  let p = 0
  const total = inp.length
  while (p < total && inp[p] !== STAR) {
    outParts.push(inp[p])
    p += 1
  }
  while (p < total) {
    p += 1 // 跳过 STAR
    if (p === total) {
      outParts.push('.*')
      break
    }
    const fixed = []
    while (p < total && inp[p] !== STAR) {
      fixed.push(inp[p])
      p += 1
    }
    const fixedText = fixed.join('')
    if (p === total) {
      outParts.push('.*')
      outParts.push(fixedText)
    } else {
      outParts.push(`(?:.*?${fixedText})`)
    }
  }
  return `^(?:${outParts.join('')})$`
}
