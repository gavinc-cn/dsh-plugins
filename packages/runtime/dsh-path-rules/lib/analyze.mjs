// dsh-path-rules 的 shell 分析层（纯函数）。
//
// 分两层：
//   * tokenizeShell —— 词法层：按 shell 规则切段/切词，收集重定向目标、输入目标与命令替换；
//   * analyzeCommand —— 语义层（Task 5/6 补）：把命令表映射成 reads/writes，判不出的标记 unanalyzable。
//
// 保守原则：任何"看不懂"的成分都不猜，一律交给上层的 unanalyzable 策略处理
// （spec §5.3：宁可拒绝并让模型改写成可判定形式，也不放行一个可能越权的命令）。

import { basename, resolve } from 'node:path'

/** 新建一个空的段。`expansion` 标记"本段含真实展开的 `$`"（引号/转义里的字面 `$` 不算）。 */
function newSegment() {
  return { words: [], redirects: [], inputs: [], substitutions: [], expansion: false }
}

/**
 * 把一个 shell 命令切分成段（管道/`;`/`&&`/`||`/子壳/换行分隔）。
 *
 * 段的形状：`{ words, redirects, inputs, substitutions, expansion }`
 *   * `words`         —— 普通词（引号内的空格不切词，转义已解码）；
 *   * `redirects`     —— 写重定向目标（`>`、`>>`、`>|`、`n>`、`n>>`、`&>`、`&>>`）；
 *   * `inputs`        —— 读重定向目标（`<`）—— 黑名单读必须能被拦到，故单独收集；
 *   * `substitutions` —— `$(...)` / 反引号的内层命令文本，供递归分析；
 *   * `expansion`     —— 段内是否有真实展开的 `$`（单引号/转义里的字面 `$` 不算）。
 *
 * `2>&1`、`n>&m` 这种 fd 复制、以及 `<<`/`<<<` 的分隔符都**不是**路径目标；
 * heredoc 的正文在物理换行后整体跳过，不产出任何词。
 *
 * @param command - 原始命令文本。
 * @returns `{ segments, error }`：无法解析时 `error = { reason, fragment }`（此时 `segments` 是已扫出的部分）。
 */
export function tokenizeShell(command) {
  const text = String(command ?? '')
  const segments = []
  let seg = newSegment()
  let word = ''
  let hasWord = false
  /** 待接收目标的运算符：'out'（写）| 'in'（读）| 'heredoc'（记录分隔符）| 'herestring'（吞掉一个词）。 */
  let pending = null
  /** 当前 heredoc 是否为 `<<-`（允许行首 tab）。 */
  let pendingStripTabs = false
  /** 当前命令行上待跳过的 heredoc 列表（物理换行后按顺序吞掉正文）。 */
  let heredocs = []
  let error = null
  let i = 0

  const append = (ch) => {
    word += ch
    hasWord = true
  }

  /** 收尾当前词：按 pending 决定它落到哪一类。 */
  const endWord = () => {
    if (!hasWord) return
    if (pending === 'out') seg.redirects.push(word)
    else if (pending === 'in') seg.inputs.push(word)
    else if (pending === 'heredoc') {
      // heredoc 分隔符不是路径；正文在物理换行后整体跳过
      heredocs.push({ delimiter: word, stripTabs: pendingStripTabs })
    } else if (pending === 'herestring') {
      // herestring 的词是数据而不是路径目标，直接吞掉
    } else seg.words.push(word)
    pending = null
    pendingStripTabs = false
    word = ''
    hasWord = false
  }

  /** 收尾当前段（空段丢弃）。 */
  const endSegment = () => {
    endWord()
    if (seg.words.length > 0 || seg.redirects.length > 0 || seg.inputs.length > 0 || seg.substitutions.length > 0) {
      segments.push(seg)
    }
    seg = newSegment()
    pending = null
    pendingStripTabs = false
  }

  const fail = (reason, at) => {
    if (error === null) error = { reason, fragment: text.slice(Math.max(0, at - 12), at + 12) }
    i = text.length
  }

  /**
   * 跳过 heredoc 正文：从 `start`（物理换行之后）出发，按声明顺序找到每个分隔符所在的
   * "单独成行"的结束行；正文与结束行都不产出任何词。
   *
   * `<<-` 允许结束行以 tab 开头（先剥行首 tab，再按 trim 比较）。
   * 某个分隔符始终没出现时记 `error`（未闭合 heredoc），并返回文本末尾。
   */
  const skipHeredocBodies = (start, pendingDocs) => {
    let j = start
    for (const doc of pendingDocs) {
      let found = false
      while (j <= text.length) {
        const lineEnd = text.indexOf('\n', j)
        const end = lineEnd === -1 ? text.length : lineEnd
        let line = text.slice(j, end)
        if (doc.stripTabs) line = line.replace(/^\t+/, '')
        if (line.trim() === doc.delimiter) {
          found = true
          j = end === text.length ? text.length : end + 1
          break
        }
        if (end === text.length) break
        j = end + 1
      }
      if (!found) {
        fail(`heredoc 未闭合（缺少分隔符 ${doc.delimiter}）`, j)
        return text.length
      }
    }
    return j
  }

  /** 读 `$( ... )` 的内层文本（括号配平，跳过引号内部）。 */
  const readParen = (start) => {
    let depth = 0
    let j = start
    let out = ''
    let quote = null
    while (j < text.length) {
      const ch = text[j]
      if (quote !== null) {
        out += ch
        if (ch === '\\' && quote === '"') {
          out += text[j + 1] ?? ''
          j += 2
          continue
        }
        if (ch === quote) quote = null
        j += 1
        continue
      }
      if (ch === "'" || ch === '"') {
        quote = ch
        out += ch
        j += 1
        continue
      }
      if (ch === '(') {
        depth += 1
        out += ch
        j += 1
        continue
      }
      if (ch === ')') {
        if (depth === 0) return { body: out, next: j + 1 }
        depth -= 1
        out += ch
        j += 1
        continue
      }
      out += ch
      j += 1
    }
    return null
  }

  /** 读反引号的内层文本。 */
  const readBacktick = (start) => {
    let j = start
    let out = ''
    while (j < text.length) {
      const ch = text[j]
      if (ch === '\\') {
        out += text[j + 1] ?? ''
        j += 2
        continue
      }
      if (ch === '`') return { body: out, next: j + 1 }
      out += ch
      j += 1
    }
    return null
  }

  while (i < text.length) {
    const ch = text[i]

    // 转义：反斜杠把下一个字符原样并入当前词
    if (ch === '\\') {
      if (i + 1 >= text.length) {
        fail('命令以孤立的反斜杠结尾', i)
        break
      }
      append(text[i + 1])
      i += 2
      continue
    }

    // 单引号：内部一切原样
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      if (end === -1) {
        fail('单引号未闭合', i)
        break
      }
      for (let k = i + 1; k < end; k += 1) append(text[k])
      i = end + 1
      continue
    }

    // $'...'：ANSI-C 引号（保守处理：解码反斜杠，不做字符转义展开）
    if (ch === '$' && text[i + 1] === "'") {
      let j = i + 2
      let closed = false
      while (j < text.length) {
        if (text[j] === '\\') {
          append(text[j + 1] ?? '')
          j += 2
          continue
        }
        if (text[j] === "'") {
          closed = true
          break
        }
        append(text[j])
        j += 1
      }
      if (!closed) {
        fail("$'...' 引号未闭合", i)
        break
      }
      i = j + 1
      continue
    }

    // 双引号：转义受限，但命令替换仍然生效
    if (ch === '"') {
      let j = i + 1
      let closed = false
      while (j < text.length) {
        const c = text[j]
        if (c === '\\') {
          const next = text[j + 1]
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            append(next)
            j += 2
            continue
          }
          append(c)
          j += 1
          continue
        }
        if (c === '`') {
          const sub = readBacktick(j + 1)
          if (sub === null) {
            fail('反引号未闭合', j)
            break
          }
          seg.substitutions.push(sub.body)
          j = sub.next
          continue
        }
        if (c === '$' && text[j + 1] === '(') {
          const sub = readParen(j + 2)
          if (sub === null) {
            fail('命令替换 $( 未闭合', j)
            break
          }
          seg.substitutions.push(sub.body)
          j = sub.next
          continue
        }
        if (c === '"') {
          closed = true
          break
        }
        // 双引号内的 `$` 是真实展开（`$(...)`/反引号已单独递归，`\$` 已在上面解码成字面）
        if (c === '$') seg.expansion = true
        append(c)
        j += 1
      }
      if (error !== null) break
      if (!closed) {
        fail('双引号未闭合', i)
        break
      }
      i = j + 1
      continue
    }

    // 命令替换（引号外）
    if (ch === '`') {
      const sub = readBacktick(i + 1)
      if (sub === null) {
        fail('反引号未闭合', i)
        break
      }
      seg.substitutions.push(sub.body)
      i = sub.next
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      const sub = readParen(i + 2)
      if (sub === null) {
        fail('命令替换 $( 未闭合', i)
        break
      }
      seg.substitutions.push(sub.body)
      i = sub.next
      continue
    }

    // 空白：结束当前词
    if (ch === ' ' || ch === '\t') {
      endWord()
      i += 1
      continue
    }

    // 物理换行：先收尾当前段；若有 heredoc，正文从这里开始整体跳过
    if (ch === '\n') {
      if (pending === 'heredoc' && !hasWord) {
        fail('heredoc 缺少分隔符', i)
        break
      }
      endSegment()
      i += 1
      if (heredocs.length > 0) {
        i = skipHeredocBodies(i, heredocs)
        heredocs = []
        if (error !== null) break
      }
      continue
    }

    // 其余段分隔符
    if (ch === ';' || ch === '(' || ch === ')') {
      endSegment()
      i += 1
      continue
    }
    if (ch === '|') {
      if (text[i + 1] === '|') i += 1
      endSegment()
      i += 1
      continue
    }
    if (ch === '&') {
      if (text[i + 1] === '&') {
        endSegment()
        i += 2
        continue
      }
      if (text[i + 1] === '>') {
        endWord()
        pending = 'out'
        i += text[i + 2] === '>' ? 3 : 2
        continue
      }
      endSegment()
      i += 1
      continue
    }

    // 写重定向
    if (ch === '>') {
      if (hasWord && /^\d+$/.test(word)) {
        word = ''
        hasWord = false
      } else {
        endWord()
      }
      let j = i + 1
      if (text[j] === '>' || text[j] === '|') j += 1
      if (text[j] === '&') {
        // fd 复制（2>&1、>&2）：不是路径目标
        j += 1
        while (j < text.length && /[0-9-]/.test(text[j])) j += 1
        i = j
        continue
      }
      pending = 'out'
      i = j
      continue
    }

    // 读重定向 / heredoc / herestring
    if (ch === '<') {
      endWord()
      if (text[i + 1] === '<') {
        if (text[i + 2] === '<') {
          // herestring：只吞掉后面一个词（词是数据，不是路径目标）
          pending = 'herestring'
          i += 3
          continue
        }
        let j = i + 2
        pendingStripTabs = false
        if (text[j] === '-') {
          // `<<-`：结束行允许行首 tab
          pendingStripTabs = true
          j += 1
        }
        pending = 'heredoc'
        i = j
        continue
      }
      pending = 'in'
      i += 1
      continue
    }

    if (ch === '$') seg.expansion = true
    append(ch)
    i += 1
  }

  if (error !== null) return { segments, error }
  endSegment()
  return { segments, error: null }
}

// ─────────────────────────── 语义层（命令表） ───────────────────────────

/** 递归嵌套上限（`$( )`、反引号、`bash -c` 共用）。 */
const MAX_NESTING = 3

/**
 * 只读命令：命中即证明"没有写副作用"。
 * `sed`/`find`/`curl`/`wget`/`sort`/`uniq`/`less`/`more`/`env` 等能写或能起程序的命令不在此表。
 * 注意 `awk`/`xargs`/`eval` 这类"程序里还能再写文件"的命令**故意不入表** ⇒ 走 unanalyzable。
 */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df', 'tree', 'realpath', 'readlink',
  'grep', 'rg', 'cut', 'tr', 'diff', 'cmp', 'echo', 'printf', 'printenv',
  'date', 'pwd', 'which', 'type', 'whoami', 'id', 'uname', 'ps', 'hostname', 'uptime', 'free',
  'seq', 'sleep', 'true', 'false', 'test', 'expr', 'basename', 'dirname', 'jq', 'md5sum',
  'sha256sum',
])

/** 只读命令里确实带文件路径参数的那些（其余命令的参数不是路径，不做黑名单判定）。 */
const PATH_READ_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df', 'tree', 'realpath', 'readlink',
  'cut', 'diff', 'cmp', 'grep', 'rg', 'basename', 'dirname', 'jq', 'md5sum', 'sha256sum',
])

/** 命令取值的选项（`-e script` 这种，后面那个词不是路径）。 */
const GREP_VALUE_OPTIONS = new Set(['-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '-B', '-C', '--include', '--exclude', '--exclude-dir'])
const SED_VALUE_OPTIONS = new Set(['-e', '--expression', '-f', '--file'])
const CURL_VALUE_OPTIONS = new Set(['-o', '--output', '-H', '--header', '-d', '--data', '-X', '--request', '-u', '--user', '-A', '--user-agent'])
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir'])
const ENV_FLAG_OPTIONS = new Set(['-', '-i', '--ignore-environment', '-0', '--null', '-v', '--debug', '--help', '--version'])
const GIT_WORKTREE_ADD_VALUE_OPTIONS = new Set(['-b', '-B', '--reason', '--prefix'])
const WGET_VALUE_OPTIONS = new Set([
  '-O', '--output-document', '-o', '--output-file', '-P', '--directory-prefix',
  '-a', '--append-output', '-e', '--execute', '-t', '--tries', '-T', '--timeout',
  '-w', '--wait', '--waitretry', '--limit-rate', '-U', '--user-agent',
  '--header', '--post-data', '--post-file', '--body-data', '--body-file',
  '-Y', '--proxy', '--http-user', '--http-password', '--user', '--password',
  '--ca-certificate', '--certificate', '--private-key', '--bind-address',
  '--dns-timeout', '--connect-timeout', '--read-timeout', '-l', '--level',
  '--referer', '-i', '--input-file', '-B', '--base', '--cut-dirs',
  '-A', '--accept', '-R', '--reject', '-D', '--domains', '-X', '--exclude-directories',
  '--progress', '-Q', '--quota', '-F', '--force-html', '--default-page',
])
const SORT_VALUE_OPTIONS = new Set([
  '-o', '--output', '-k', '--key', '-t', '--field-separator', '-T', '--temporary-directory',
  '-S', '--buffer-size', '--parallel', '--batch-size', '--files0-from', '--sort',
  '--random-source', '--compress-program',
])
const UNIQ_VALUE_OPTIONS = new Set(['-f', '--skip-fields', '-s', '--skip-chars', '-w', '--check-chars'])
const PAGER_VALUE_OPTIONS = new Set([
  '-o', '--log-file', '-p', '--pattern', '-b', '--buffers', '-h', '--max-back-scroll',
  '-j', '--jump-target', '-x', '--tabs', '-y', '--max-forw-scroll', '-z', '--window',
  '-t', '--tag', '-T', '--tag-file', '-P', '--prompt', '-D', '--color',
])

/** shell 解释器：`bash -c "..."` 的内层要递归分析。 */
const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash'])

/** git 的只读子命令（其余一律按"写仓库目录"处理，内容层面的规则交给 dsh-git-guard）。 */
const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'rev-list', 'ls-files', 'ls-remote',
  'describe', 'shortlog', 'reflog', 'cat-file', 'grep', 'count-objects', 'symbolic-ref',
  'merge-base', 'show-ref', 'whatchanged', 'var', 'version', 'help',
])

/** 写命令的路径提取规则：mode = all（所有位置参数）/ last（末位是写、前面是读）/ 专用模式。 */
const WRITE_COMMANDS = new Map([
  ['touch', { mode: 'all' }],
  ['mkdir', { mode: 'all' }],
  ['rmdir', { mode: 'all' }],
  ['rm', { mode: 'all' }],
  ['truncate', { mode: 'all', valueOptions: ['-s', '--size', '-r', '--reference'] }],
  ['chmod', { mode: 'all', skip: 1 }],
  ['chown', { mode: 'all', skip: 1 }],
  ['chgrp', { mode: 'all', skip: 1 }],
  ['ln', { mode: 'last', leadingReads: true }],
  ['cp', { mode: 'last', leadingReads: true }],
  ['install', { mode: 'last', leadingReads: true }],
  ['mv', { mode: 'all' }],
  ['rsync', { mode: 'all' }],
  ['tee', { mode: 'all' }],
  ['dd', { mode: 'dd' }],
  ['find', { mode: 'find' }],
  ['sed', { mode: 'sed' }],
  ['git', { mode: 'git' }],
  ['curl', { mode: 'curl' }],
  ['wget', { mode: 'wget' }],
  ['sort', { mode: 'sort' }],
  ['uniq', { mode: 'uniq' }],
  ['less', { mode: 'pager' }],
  ['more', { mode: 'pager' }],
  ['env', { mode: 'env' }],
])

/** 取某个选项的值：支持 `-o val` / `--opt=val` / `-oval`。 */
function optionValue(words, names) {
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i]
    for (const name of names) {
      if (word === name) return words[i + 1]
      if (word.startsWith(`${name}=`)) return word.slice(name.length + 1)
      if (name.length === 2 && name.startsWith('-') && !name.startsWith('--') && word.startsWith(name) && word.length > 2) {
        return word.slice(name.length)
      }
    }
  }
  return undefined
}

/** 是否出现某个选项（含 `--opt=val` 与 `-oval` 形态）。 */
function hasOption(words, names) {
  return words.some((word) => names.some((name) => {
    if (word === name) return true
    if (word.startsWith(`${name}=`)) return true
    return name.length === 2 && !name.startsWith('--') && word.startsWith(name) && word.length > 2
  }))
}

/** 位置参数（跳过选项与取值选项的值）。 */
function positionalsOf(words, valueOptions = new Set()) {
  const out = []
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i]
    if (word.startsWith('-') && word !== '-') {
      if (valueOptions.has(word)) i += 1
      continue
    }
    out.push(word)
  }
  return out
}

/** 相对路径按 cwd 解析；绝对路径原样规范化。 */
function toAbsolute(word, cwd) {
  return resolve(cwd, word)
}

/** 只读命令贡献的读目标。 */
function readPathsOf(cmd, words, cwd) {
  if (!PATH_READ_COMMANDS.has(cmd)) return []
  if (cmd === 'grep' || cmd === 'rg') {
    const positionals = positionalsOf(words, GREP_VALUE_OPTIONS)
    const hasPatternOption = hasOption(words, ['-e', '--regexp', '-f', '--file'])
    const paths = hasPatternOption ? positionals : positionals.slice(1)
    return paths.map((word) => toAbsolute(word, cwd))
  }
  return positionalsOf(words).map((word) => toAbsolute(word, cwd))
}

/**
 * 跳过 `env` 开头的环境变量赋值与选项，返回其后的命令词与 `-C/--chdir` 指定的工作目录。
 * 无法安全跳过的选项（如 `-S`）标记 unanalyzable 并返回 null。
 */
function envCommandWords(words, flag) {
  let i = 1
  let chdir
  while (i < words.length) {
    const word = words[i]
    // 开头的 NAME=value 是环境变量赋值，不是命令
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i += 1
      continue
    }
    if (word === '--') {
      i += 1
      break
    }
    if (ENV_FLAG_OPTIONS.has(word)) {
      i += 1
      continue
    }
    if (word === '-S' || word === '--split-string' || word.startsWith('--split-string=')) {
      // -S 会把一个字符串再拆成命令词，静态展开成本高，保守拒绝
      flag('env -S/--split-string 无法静态判定', word)
      return null
    }
    const eq = word.indexOf('=')
    const name = eq === -1 ? word : word.slice(0, eq)
    if (ENV_VALUE_OPTIONS.has(name)) {
      // `-u NAME` / `--unset=NAME` / `-C DIR` / `--chdir=DIR`
      const value = eq === -1 ? words[i + 1] : word.slice(eq + 1)
      if (name === '-C' || name === '--chdir') chdir = value
      i += eq === -1 ? 2 : 1
      continue
    }
    if ((word.startsWith('-u') || word.startsWith('-C')) && word.length > 2) {
      // `-uNAME` / `-CDIR` 粘写形态
      if (word.startsWith('-C')) chdir = word.slice(2)
      i += 1
      continue
    }
    if (word.startsWith('-') && word.length > 1) {
      flag(`env 的选项无法判定：${word}`, word)
      return null
    }
    break
  }
  return { words: words.slice(i), chdir }
}

/** 跳过 git 的全局选项（含取值），返回子命令在 words 中的下标。 */
function gitSubcommandIndex(words) {
  let i = 1
  while (i < words.length && words[i].startsWith('-')) {
    const name = words[i].split('=')[0]
    i += GIT_VALUE_OPTIONS.has(name) && !words[i].includes('=') ? 2 : 1
  }
  return i
}

/** 取第一个位置参数（跳过选项与取值选项的值；`--` 之后直接取）。 */
function firstPositional(words, valueOptions = new Set()) {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]
    if (word === '--') return words[i + 1]
    if (word.startsWith('-') && word !== '-') {
      if (valueOptions.has(word)) i += 1
      continue
    }
    return word
  }
  return undefined
}

/**
 * 分析 `git worktree ...`：
 *   * `list` 只读（读仓库目录）；
 *   * `add <path>` / `remove <path>` 写该 path；
 *   * `prune` 写仓库目录（改 .git/worktrees 元数据）；
 *   * 其余子命令保守 unanalyzable。
 */
function analyzeGitWorktree(words, ctx, acc, flag, repoDir) {
  const index = gitSubcommandIndex(words)
  const action = words[index + 1]
  const rest = words.slice(index + 2)
  if (action === 'list') {
    acc.reads.push(repoDir)
    return
  }
  if (action === 'prune') {
    acc.writes.push(repoDir)
    return
  }
  if (action === 'add' || action === 'remove') {
    const path = firstPositional(rest, action === 'add' ? GIT_WORKTREE_ADD_VALUE_OPTIONS : new Set())
    if (path === undefined) {
      flag(`git worktree ${action} 缺少路径`, words[0])
      return
    }
    acc.writes.push(toAbsolute(path, ctx.cwd))
    return
  }
  flag(`git worktree 子命令无法判定：${action ?? '(无)'}`, words[0])
}

/**
 * 分析一条 shell 命令的读写目标。
 *
 * @param command - 命令文本（可含管道/重定向/命令替换）。
 * @param options - `{ shell: 'bash'|'pwsh', cwd, depth }`；`depth` 为内部递归用。
 * @returns `{ unanalyzable, reads, writes, readOnly }`：
 *   `unanalyzable = { reason, fragment }` 表示静态判不出来，由调用方按策略处理（默认拒绝）。
 */
export function analyzeCommand(command, options = {}) {
  const shell = options.shell === 'pwsh' ? 'pwsh' : 'bash'
  const cwd = typeof options.cwd === 'string' && options.cwd.trim().length > 0 ? options.cwd : process.cwd()
  const depth = Number.isInteger(options.depth) ? options.depth : 0
  const text = String(command ?? '')
  if (depth > MAX_NESTING) {
    return { unanalyzable: { reason: `嵌套超过 ${MAX_NESTING} 层，无法静态判定`, fragment: text }, reads: [], writes: [], readOnly: false }
  }
  const { segments, error } = tokenizeShell(text)
  if (error !== null) return { unanalyzable: error, reads: [], writes: [], readOnly: false }
  if (shell === 'pwsh') return analyzePwsh(segments, { cwd, depth })
  const acc = { reads: [], writes: [], unanalyzable: null }
  for (const seg of segments) {
    analyzeBashSegment(seg, { cwd, depth }, acc)
    if (acc.unanalyzable !== null) break
  }
  const reads = [...new Set(acc.reads)]
  const writes = [...new Set(acc.writes)]
  return { unanalyzable: acc.unanalyzable, reads, writes, readOnly: acc.unanalyzable === null && writes.length === 0 }
}

/** 分析一个段（bash 语义）；结果累加到 acc。 */
function analyzeBashSegment(seg, ctx, acc) {
  const flag = (reason, fragment) => {
    if (acc.unanalyzable === null) acc.unanalyzable = { reason, fragment }
  }
  for (const sub of seg.substitutions) {
    const nested = analyzeCommand(sub, { shell: 'bash', cwd: ctx.cwd, depth: ctx.depth + 1 })
    if (nested.unanalyzable !== null) {
      flag(`命令替换无法判定：${nested.unanalyzable.reason}`, sub)
      return
    }
    acc.reads.push(...nested.reads)
    acc.writes.push(...nested.writes)
  }
  if (seg.expansion === true) {
    // 只有真实展开（引号外/双引号内的 `$`）才判不出来；单引号/转义里的字面 `$` 不算
    const fragment = [...seg.words, ...seg.redirects, ...seg.inputs].find((word) => word.includes('$')) ?? '$'
    flag(`命令含未展开的变量或替换：${fragment}`, fragment)
    return
  }
  for (const input of seg.inputs) acc.reads.push(toAbsolute(input, ctx.cwd))
  for (const redirect of seg.redirects) acc.writes.push(toAbsolute(redirect, ctx.cwd))
  analyzeBashWords(seg.words, ctx, acc, flag)
}

/** 分析一条命令词（words[0] 是程序名）；`env` 递归等场景与段分析复用。 */
function analyzeBashWords(words, ctx, acc, flag) {
  if (words.length === 0) return
  const cmd = basename(words[0])

  if (SHELL_COMMANDS.has(cmd)) {
    const index = words.indexOf('-c')
    if (index === -1) {
      flag(`${cmd} 未见 -c，无法判定内层命令`, words[0])
      return
    }
    const inner = words.slice(index + 1).join(' ').trim()
    if (inner.length === 0) {
      flag(`${cmd} -c 后没有命令文本`, words[0])
      return
    }
    const nested = analyzeCommand(inner, { shell: 'bash', cwd: ctx.cwd, depth: ctx.depth + 1 })
    if (nested.unanalyzable !== null) {
      flag(`内层命令无法判定：${nested.unanalyzable.reason}`, inner)
      return
    }
    acc.reads.push(...nested.reads)
    acc.writes.push(...nested.writes)
    return
  }

  if (READ_ONLY_COMMANDS.has(cmd)) {
    acc.reads.push(...readPathsOf(cmd, words, ctx.cwd))
    return
  }

  const rule = WRITE_COMMANDS.get(cmd)
  if (rule === undefined) {
    flag(`未收录的命令（无法判定读写）：${cmd}`, words[0])
    return
  }

  if (rule.mode === 'env') {
    const parsed = envCommandWords(words, flag)
    if (parsed === null || parsed.words.length === 0) return
    const nestedDepth = ctx.depth + 1
    if (nestedDepth > MAX_NESTING) {
      flag(`嵌套超过 ${MAX_NESTING} 层，无法静态判定`, words[0])
      return
    }
    // `env -C DIR cmd`：内层命令的相对路径以 DIR 为基准
    const nestedCwd = parsed.chdir === undefined ? ctx.cwd : resolve(ctx.cwd, parsed.chdir)
    analyzeBashWords(parsed.words, { cwd: nestedCwd, depth: nestedDepth }, acc, flag)
    return
  }

  if (rule.mode === 'dd') {
    for (const word of words.slice(1)) {
      if (word.startsWith('of=')) acc.writes.push(toAbsolute(word.slice(3), ctx.cwd))
      else if (word.startsWith('if=')) acc.reads.push(toAbsolute(word.slice(3), ctx.cwd))
      else if (!word.includes('=')) {
        flag(`dd 的位置参数无法判定：${word}`, word)
        return
      }
    }
    return
  }

  if (rule.mode === 'find') {
    const operands = words.slice(1)
    const firstOption = words.findIndex((word, i) => i > 0 && word.startsWith('-'))
    const startPaths = (firstOption === -1 ? operands : words.slice(1, firstOption)).map((word) => toAbsolute(word, ctx.cwd))
    if (words.some((word) => word.startsWith('-exec') || word === '-ok' || word === '-okdir' || word.startsWith('-fprint'))) {
      flag('find 的 -exec/-fprint 无法静态判定', words[0])
      return
    }
    if (words.includes('-delete')) acc.writes.push(...startPaths)
    else acc.reads.push(...startPaths)
    return
  }

  if (rule.mode === 'sed') {
    const positionals = positionalsOf(words, SED_VALUE_OPTIONS)
    const hasScriptOption = hasOption(words, ['-e', '--expression', '-f', '--file'])
    const files = hasScriptOption ? positionals : positionals.slice(1)
    const targets = files.map((word) => toAbsolute(word, ctx.cwd))
    // -i 就地改写是写；不带 -i 时文件操作数只是读（之前直接 return 会漏掉黑名单读）
    if (hasOption(words, ['-i', '--in-place'])) acc.writes.push(...targets)
    else acc.reads.push(...targets)
    return
  }

  if (rule.mode === 'git') {
    const positionals = positionalsOf(words, GIT_VALUE_OPTIONS)
    const sub = positionals[0]
    if (sub === undefined) {
      flag('git 未给出子命令', words[0])
      return
    }
    const repoDir = toAbsolute(optionValue(words, ['-C']) ?? ctx.cwd, ctx.cwd)
    if (sub === 'clone') {
      const dest = positionals[1]
      acc.writes.push(dest === undefined ? repoDir : toAbsolute(dest, ctx.cwd))
      return
    }
    if (sub === 'worktree') {
      analyzeGitWorktree(words, ctx, acc, flag, repoDir)
      return
    }
    const readOnlyForm = GIT_READ_SUBCOMMANDS.has(sub)
      || ((sub === 'branch' || sub === 'tag') && (hasOption(words, ['--list']) || positionals.length === 1))
      || (sub === 'remote' && positionals.length === 1)
      || (sub === 'config' && hasOption(words, ['--get', '--list', '-l']))
      || (sub === 'stash' && (positionals[1] === 'list' || positionals[1] === 'show'))
    if (readOnlyForm) acc.reads.push(repoDir)
    else acc.writes.push(repoDir)
    return
  }

  if (rule.mode === 'curl') {
    const output = optionValue(words, ['-o', '--output'])
    if (output !== undefined) {
      acc.writes.push(toAbsolute(output, ctx.cwd))
      return
    }
    if (hasOption(words, ['-O', '--remote-name'])) {
      const positionals = positionalsOf(words, CURL_VALUE_OPTIONS)
      const url = positionals[positionals.length - 1]
      if (url === undefined) {
        flag('curl -O 无法确定输出文件名', words[0])
        return
      }
      acc.writes.push(toAbsolute(basename(url), ctx.cwd))
    }
    return
  }

  if (rule.mode === 'wget') {
    const positionals = positionalsOf(words, WGET_VALUE_OPTIONS)
    const url = positionals[positionals.length - 1]
    if (url === undefined) {
      flag('wget 未给出 URL，无法判定输出目标', words[0])
      return
    }
    const output = optionValue(words, ['-O', '--output-document'])
    const logFile = optionValue(words, ['-o', '--output-file'])
    const prefix = optionValue(words, ['-P', '--directory-prefix'])
    let explicit = false
    if (output !== undefined) {
      explicit = true
      if (output !== '-') acc.writes.push(toAbsolute(output, ctx.cwd))
    }
    if (logFile !== undefined) {
      explicit = true
      if (logFile !== '-') acc.writes.push(toAbsolute(logFile, ctx.cwd))
    }
    if (prefix !== undefined) {
      explicit = true
      acc.writes.push(toAbsolute(prefix, ctx.cwd))
    }
    if (!explicit) {
      // 没有显式输出选项时，wget 把文件存到 cwd 下的 URL basename
      const name = basename(url)
      if (name.length === 0) {
        flag('wget 无法确定输出文件名', url)
        return
      }
      acc.writes.push(toAbsolute(name, ctx.cwd))
    }
    return
  }

  if (rule.mode === 'sort') {
    const output = optionValue(words, ['-o', '--output'])
    if (output !== undefined) acc.writes.push(toAbsolute(output, ctx.cwd))
    acc.reads.push(...positionalsOf(words, SORT_VALUE_OPTIONS).map((word) => toAbsolute(word, ctx.cwd)))
    return
  }

  if (rule.mode === 'uniq') {
    const targets = positionalsOf(words, UNIQ_VALUE_OPTIONS).map((word) => toAbsolute(word, ctx.cwd))
    if (targets.length >= 2) {
      acc.reads.push(...targets.slice(0, -1))
      acc.writes.push(targets[targets.length - 1])
    } else if (targets.length === 1) {
      acc.reads.push(targets[0])
    }
    return
  }

  if (rule.mode === 'pager') {
    const logFile = optionValue(words, ['-o', '--log-file'])
    if (logFile === undefined) {
      // 分页器可在交互中执行命令/写文件（`!`、`s` 等），没有日志文件时无法静态判定
      flag(`分页器 ${cmd} 可交互逃逸，无法静态判定`, words[0])
      return
    }
    acc.writes.push(toAbsolute(logFile, ctx.cwd))
    acc.reads.push(...positionalsOf(words, PAGER_VALUE_OPTIONS).map((word) => toAbsolute(word, ctx.cwd)))
    return
  }

  const valueOptions = new Set(rule.valueOptions ?? [])
  const targetDir = rule.mode === 'last' ? optionValue(words, ['-t', '--target-directory']) : undefined
  const positionals = positionalsOf(words, valueOptions)
  if (rule.mode === 'last') {
    if (targetDir !== undefined) {
      acc.reads.push(...positionals.map((word) => toAbsolute(word, ctx.cwd)))
      acc.writes.push(toAbsolute(targetDir, ctx.cwd))
      return
    }
    if (positionals.length === 0) return
    const last = positionals[positionals.length - 1]
    const leading = rule.leadingReads === true ? positionals.slice(0, -1) : []
    acc.reads.push(...leading.map((word) => toAbsolute(word, ctx.cwd)))
    acc.writes.push(toAbsolute(last, ctx.cwd))
    return
  }
  const targets = positionals.slice(rule.skip ?? 0)
  acc.writes.push(...targets.map((word) => toAbsolute(word, ctx.cwd)))
}

// ─────────────────────────── PowerShell 语义层 ───────────────────────────

/** PowerShell 的路径参数（`-Path val` / `-Path:val` 两种形态）。 */
const PWSH_PATH_PARAMS = ['-path', '-literalpath', '-destination', '-filepath', '-outfile', '-target', '-source', '-childpath']

/** 写 cmdlet（含常用别名）→ 提取模式：path（路径参数）/ all（全部目标）/ last（末位是目标）。 */
const PWSH_WRITE_CMDLETS = new Map([
  ['set-content', 'path'], ['sc', 'path'],
  ['add-content', 'path'], ['ac', 'path'],
  ['out-file', 'path'],
  ['new-item', 'path'], ['ni', 'path'], ['mkdir', 'path'], ['md', 'path'],
  ['remove-item', 'path'], ['rm', 'path'], ['del', 'path'], ['erase', 'path'], ['rd', 'path'], ['rmdir', 'path'],
  ['clear-content', 'path'],
  ['set-item', 'path'], ['si', 'path'],
  ['set-itemproperty', 'path'],
  ['move-item', 'all'], ['mv', 'all'], ['move', 'all'],
  ['rename-item', 'all'], ['ren', 'all'],
  ['copy-item', 'last'], ['cp', 'last'], ['copy', 'last'], ['cpi', 'last'],
])

/** 只读 cmdlet（含常用别名）。 */
const PWSH_READ_CMDLETS = new Set([
  'get-childitem', 'gci', 'ls', 'dir',
  'get-content', 'gc', 'cat', 'type',
  'select-string', 'sls',
  'test-path', 'get-item', 'gi', 'get-itemproperty', 'gp',
  'measure-object', 'write-output', 'write', 'echo', 'write-host',
  'resolve-path', 'get-location', 'pwd', 'get-command', 'gcm',
  'where-object', 'where', 'select-object', 'select', 'sort-object', 'sort',
  'format-table', 'ft', 'format-list', 'fl', 'out-string', 'get-filehash', 'get-acl',
  'get-process', 'get-service', 'test-connection', 'compare-object', 'clear-host', 'cls', 'clc',
])

/** 明确不可静态判定的 cmdlet / 程序（会再起进程、或文本不可见）。 */
const PWSH_OPAQUE = new Set([
  'invoke-expression', 'iex', 'start-process', 'saps', 'start',
  'invoke-command', 'icm', 'invoke-webrequest', 'iwr', 'curl', 'wget',
  'invoke-restmethod', 'irm', 'set-executionpolicy', 'register-scheduledtask',
  'new-scheduledtask', 'pwsh', 'powershell', 'cmd', 'wsl', 'bash', 'sh',
])

/** 拆 PowerShell 参数：路径参数成对取值，其余 `-开关` 不消费下一个词（保守，宁可多算一个项目内目标）。 */
function pwshArgs(words) {
  const named = new Map()
  const positionals = []
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i]
    if (word.startsWith('-')) {
      const colon = word.indexOf(':')
      const key = (colon === -1 ? word : word.slice(0, colon)).toLowerCase()
      if (!PWSH_PATH_PARAMS.includes(key)) continue
      if (colon !== -1) {
        named.set(key, word.slice(colon + 1))
        continue
      }
      const value = words[i + 1]
      if (value !== undefined && !value.startsWith('-')) {
        named.set(key, value)
        i += 1
      }
      continue
    }
    positionals.push(word)
  }
  const namedPaths = []
  for (const key of PWSH_PATH_PARAMS) {
    const value = named.get(key)
    if (value !== undefined && value.length > 0) namedPaths.push(value)
  }
  return { namedPaths, positionals }
}

/** 分析 pwsh 命令的段列表；与 bash 侧同构。 */
function analyzePwsh(segments, ctx) {
  const acc = { reads: [], writes: [], unanalyzable: null }
  for (const seg of segments) {
    analyzePwshSegment(seg, ctx, acc)
    if (acc.unanalyzable !== null) break
  }
  const reads = [...new Set(acc.reads)]
  const writes = [...new Set(acc.writes)]
  return { unanalyzable: acc.unanalyzable, reads, writes, readOnly: acc.unanalyzable === null && writes.length === 0 }
}

/** 分析一个 pwsh 段；结果累加到 acc。 */
function analyzePwshSegment(seg, ctx, acc) {
  const flag = (reason, fragment) => {
    if (acc.unanalyzable === null) acc.unanalyzable = { reason, fragment }
  }
  for (const sub of seg.substitutions) {
    const nested = analyzeCommand(sub, { shell: 'pwsh', cwd: ctx.cwd, depth: ctx.depth + 1 })
    if (nested.unanalyzable !== null) {
      flag(`命令替换无法判定：${nested.unanalyzable.reason}`, sub)
      return
    }
    acc.reads.push(...nested.reads)
    acc.writes.push(...nested.writes)
  }
  if (seg.expansion === true) {
    // 与 bash 侧同口径：单引号/转义里的字面 `$` 不触发未展开判定
    const fragment = [...seg.words, ...seg.redirects, ...seg.inputs].find((word) => word.includes('$')) ?? '$'
    flag(`命令含未展开的变量或替换：${fragment}`, fragment)
    return
  }
  for (const input of seg.inputs) acc.reads.push(toAbsolute(input, ctx.cwd))
  for (const redirect of seg.redirects) acc.writes.push(toAbsolute(redirect, ctx.cwd))
  if (seg.words.length === 0) return
  const cmd = seg.words[0].toLowerCase().replace(/\.exe$/, '')
  if (PWSH_OPAQUE.has(cmd)) {
    flag(`无法静态判定：${cmd}`, seg.words[0])
    return
  }
  const { namedPaths, positionals } = pwshArgs(seg.words)
  const targets = namedPaths.length > 0 ? namedPaths : positionals
  const writeMode = PWSH_WRITE_CMDLETS.get(cmd)
  if (writeMode !== undefined) {
    if (writeMode === 'last' && targets.length > 0) {
      acc.reads.push(...targets.slice(0, -1).map((word) => toAbsolute(word, ctx.cwd)))
      acc.writes.push(toAbsolute(targets[targets.length - 1], ctx.cwd))
      return
    }
    if (writeMode === 'last') return
    acc.writes.push(...targets.map((word) => toAbsolute(word, ctx.cwd)))
    return
  }
  if (PWSH_READ_CMDLETS.has(cmd)) {
    acc.reads.push(...targets.map((word) => toAbsolute(word, ctx.cwd)))
    return
  }
  // 未知命令：只有"该段本身在写重定向、且首词像裸值/表达式"时才算可判定（如 `"x" > out.txt`）
  const looksLikeValue = !cmd.includes('/') && !cmd.includes('\\') && !cmd.includes('.')
  if (looksLikeValue && seg.redirects.length > 0) return
  flag(`未收录的 cmdlet/程序（无法判定读写）：${cmd}`, seg.words[0])
}
