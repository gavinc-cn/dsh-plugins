// dsh-write-guard 的判定链（纯函数，不依赖宿主服务）。
//
// 职责：把一次工具调用（`exec`）判定成 pass / allow / ask：
//   * `classifyTool` 给出读写意图（读工具与未知工具直接透传，不猜写入语义）；
//   * 写目标先 `normalizePath`（realpath 最深存在前缀，防软链逃逸），再按
//     project → whitelist → temp → outside 分类，先命中者胜；
//   * 伪设备/标准流（`/dev/null`、`/dev/stdout`、`/dev/fd/*`、Windows `NUL` 等）在归一化
//     之前剔除：它们不是文件写入，不参与分类、不触发审批；含 `..` 段的原始路径（如
//     `/dev/fd/../../../etc/hosts`）**不**按 sink 处理，必须先归一化再分类；Windows 设备名
//     只在 `win32` 平台生效（Linux 上的 `aux`/`nul` 是普通文件名）；
//   * shell（bash/pwsh）用 `analyzeCommand` 静态分析：判不出（unanalyzable）时**先**交给
//     注入的 `judge` 回调、绝不先按 sink 放行；只有可分析命令才剔除 sink，剩余写目标为空
//     才按只读放行；
//   * 含 `~` 展开、建链/链接传播命令（`ln`/`link`/`mklink`/`New-Item`、`cp` 的 `-l/-s`、
//     递归/不解引用/归档等参数）或 heredoc 正文含命令替换视为不可静态分析：分析器按字面量
//     解析 `~/x`、无法表达"同命令先建链再写"的时序、且 tokenizer 会跳过 heredoc 正文，
//     本层保守改判 unanalyzable；命令替换/反引号（`$(...)`、`` `...` ``）与
//     `bash -c` / `pwsh -Command` 的内层命令递归扫描，防止把建链藏进替换里绕过；
//   * 越界写 / judge 不安全 / judge 不可用 → ask，审计理由以 `[write-guard] ` 开头，
//     并附 zh/en 一句展示理由（审批卡本地化）。
//
// 边界：
//   * 不判断激活状态（权限档、子代理父链、服务是否存在）——那是 lib/index.mjs 的职责；
//     本模块只处理「已经确认激活」的调用，`config.enabled === false` 仅作廉价兜底；
//   * 不产生 deny（无审批通道时的降级由 index.mjs 合成，spec §4.3-⑤）；
//   * 不读写文件、不写审计日志、不学白名单、不访问网络；唯一的文件系统接触是
//     path-rules 的 `normalizePath` 为防逃逸所做的 realpath（其内部行为）；
//   * cwd / roots / config / judge 全部来自 `context`，便于单测（spec §4.3）。
//
// spec 对应：§4.3 判定链、§5.1 工具分类、§5.2 路径归一与分类、§5.3 shell 静态分析、§5.6 ask 文案。

import { tmpdir } from 'node:os'
import { analyzeCommand, tokenizeShell } from '@gavinc-cn/dsh-path-rules/analyze'
import { classifyTool } from '@gavinc-cn/dsh-path-rules/classify'
import { normalizePath, underRoot } from '@gavinc-cn/dsh-path-rules/rules'

/** 审计理由的固定标记（与 spec §5.6 一致，模型/日志可见）。 */
const REASON_PREFIX = '[write-guard] '

/** 临时区的固定候选；`os.tmpdir()` 运行时再追加。 */
const TEMP_ROOT_CANDIDATES = ['/tmp']

/** POSIX 伪设备/标准流的固定目标（大小写敏感，只认这些精确路径）。 */
const POSIX_IGNORED_WRITE_SINKS = new Set([
  '/dev/null',
  '/dev/zero',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
])

/** POSIX fd 目录前缀：`/dev/fd/1`、`/proc/self/fd/2` 等。 */
const POSIX_IGNORED_WRITE_SINK_PREFIXES = ['/dev/fd/', '/proc/self/fd/']

/** Windows 设备名（DOS 保留名）：比较 basename，大小写不敏感；**只在 win32 生效**。 */
const WINDOWS_DEVICE_NAMES = new Set([
  'nul',
  'con',
  'prn',
  'aux',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

/** 会建立链接（软链/硬链/目录联接）的命令：命令词的 basename，大小写不敏感。 */
const LINK_COMMANDS = new Set(['ln', 'link', 'mklink', 'new-item'])

/**
 * `cp` 短选项簇里会建链或**传播链接**的字母：
 *   a（--archive，含 -r 与 --preserve=links）、d / P（--no-dereference）、
 *   r / R（--recursive）、l（--link）、s（--symbolic-link）。
 * 这些模式会原样复制符号链接，后续写链内路径即可逃出项目（I2 残留）。
 */
const CP_RISKY_SHORT_FLAGS = new Set(['a', 'd', 'P', 'r', 'R', 'l', 's'])

/** `cp` 里会建链/传播链接的长选项（GNU 长选项缩写由 isCpRiskyFlag 统一覆盖）。 */
const CP_RISKY_LONG_FLAGS = ['--archive', '--no-dereference', '--recursive']

/** GNU 长选项缩写：`--l…` 命中 --link，`--s…` 命中 --symbolic-link（I2 残留）。 */
const CP_RISKY_LONG_PREFIXES = ['--l', '--s']

/** 内层命令需要递归扫描的 shell（`bash -c` / `pwsh -Command` 里的建链同样不能漏）。 */
const NESTED_SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell'])

/** 建链检测的最大递归层数（与 path-rules 的 MAX_NESTING 同口径，防病态嵌套）。 */
const MAX_RISK_NESTING = 3

/** `~` 展开风险的固定理由（写进 ask 的审计理由）。 */
const TILDE_UNANALYZABLE_REASON = '命令含 ~ 展开，静态分析不可靠'

/** 建链命令的固定理由（写进 ask 的审计理由）。 */
const LINK_UNANALYZABLE_REASON = '命令含建链操作，静态分析不可靠'

/** heredoc 正文含命令替换的固定理由（tokenizer 会跳过正文，静态分析看不到）。 */
const HEREDOC_SUBSTITUTION_UNANALYZABLE_REASON = '命令含 heredoc 内命令替换，静态分析不可靠'

/** bash 执行前删除的反斜杠续行（`\`+LF，容忍 CRLF）：风险扫描看执行等价文本。 */
const LINE_CONTINUATION_RE = /\\\r?\n/g

/** heredoc 运算符（`<<` / `<<-` / `<<~`）；排除 here-string `<<<`（它的词仍会被 tokenizer 扫描）。 */
const HEREDOC_OPERATOR_RE = /(?<![<])<<(?!<)/

/** 命令替换标记：`$(` 或反引号。 */
const COMMAND_SUBSTITUTION_RE = /\$\(|`/

/** 命令替换/内层 shell 递归超限的固定理由（不再假装能静态判定）。 */
const NESTED_UNANALYZABLE_REASON = `命令替换嵌套超过 ${MAX_RISK_NESTING} 层，静态分析不可靠`

/** 统一的透传结果（未受控工具/读操作）。 */
function pass() {
  return { kind: 'pass' }
}

/** 统一的放行结果；`code` 说明为什么可以放行。 */
function allow(code) {
  return { kind: 'allow', code }
}

/**
 * 统一的拦截结果：补上审计标记；`targets` 一律是归一化后的绝对路径数组。
 *
 * @param code - OUTSIDE_WRITE | JUDGE_UNSAFE | JUDGE_UNKNOWN | JUDGE_DISABLED。
 * @param reason - 审计理由正文（不含 `[write-guard] ` 标记）。
 * @param displayReason - `{zh, en}` 一句展示理由（不含标记）。
 * @param targets - 越界/可疑目标列表。
 */
function ask(code, reason, displayReason, targets = []) {
  return { kind: 'ask', code, reason: `${REASON_PREFIX}${reason}`, displayReason, targets }
}

/** 把项目根渲染成适合放进文案的短标签。 */
function projectLabel(project) {
  return typeof project === 'string' && project.length > 0 ? project : '(未知)'
}

/** 临时区根列表：`/tmp` 与 `os.tmpdir()` 各自归一化后去重（spec §5.2）。 */
export function tempRoots() {
  const roots = []
  for (const candidate of [...TEMP_ROOT_CANDIDATES, tmpdir()]) {
    const normalized = normalizePath(candidate, '/')
    if (normalized.length > 0 && !roots.includes(normalized)) roots.push(normalized)
  }
  return roots
}

/**
 * 目标路径归类（先命中者胜：project → whitelist → temp → outside）。
 *
 * 入参 `target` 应已由 `normalizePath` 归一化、`roots` 已归一化（配置由加载期
 * `normalizeRoots` 处理）；空白目标直接归为 outside，不参与放行。
 *
 * @param target - 归一化后的目标路径。
 * @param roots - `{project:string, whitelist:string[], temp:string[]}`。
 * @returns 'project' | 'whitelist' | 'temp' | 'outside'
 */
export function classifyTargetKind(target, roots) {
  const r = roots ?? {}
  if (typeof target !== 'string' || target.length === 0) return 'outside'
  if (typeof r.project === 'string' && r.project.length > 0 && underRoot(target, r.project)) {
    return 'project'
  }
  if (Array.isArray(r.whitelist) && r.whitelist.some((root) => underRoot(target, root))) {
    return 'whitelist'
  }
  if (Array.isArray(r.temp) && r.temp.some((root) => underRoot(target, root))) {
    return 'temp'
  }
  return 'outside'
}

/**
 * 原始路径里是否含 `..` 路径段（`/../`、结尾 `/..`、Windows `\..\` 都算）。
 *
 * 为什么单独判：伪设备/标准流判断是纯词法的，`/dev/fd/../../../etc/hosts` 的 basename
 * 仍是 `hosts`，但它会经 `..` 逃出 `/dev/fd` 落到 `/etc`。这类路径必须先归一化再分类，
 * 绝不能当作 sink 提前放行（review C2）。
 *
 * @param target - 原始路径（未归一化）。
 * @returns 含 `..` 段返回 true。
 */
export function hasDotDotSegment(target) {
  if (typeof target !== 'string' || target.length === 0) return false
  return target.split(/[\\/]+/).some((segment) => segment === '..')
}

/**
 * 判断写目标是否是「非文件写入槽」：伪设备 / 标准流。
 *
 * 写入这些目标不修改任何文件（`cat /etc/hosts > /dev/null`、`cmd 2>/dev/stderr`），
 * 因此不应触发越界写入审批。判断是**纯词法**的，不访问文件系统：
 *   * POSIX：精确匹配 `/dev/null`、`/dev/zero`、`/dev/stdout`、`/dev/stderr`、`/dev/tty`；
 *     前缀匹配 `/dev/fd/`、`/proc/self/fd/`（如 `/dev/fd/1`、`/proc/self/fd/2`）——与平台无关；
 *   * Windows：basename（大小写不敏感）为 `nul` / `con` / `prn` / `aux` /
 *     `com1..com9` / `lpt1..lpt9` —— **只在 `platform === 'win32'` 时生效**：
 *     Linux 上 `/etc/sudoers.d/aux` 是普通文件，不能因为名字像设备名就放行（review C4）。
 *
 * 必须作用在 `normalizePath` 之前的原始目标上：realpath 会把 `/dev/stdout` 等解析成
 * 真实的 fd 目标，归一化后再比对反而认不出来。调用方还应先排除含 `..` 段的路径
 * （`hasDotDotSegment`），否则会漏掉「经 sink 前缀逃逸」的写法（review C2）。
 *
 * @param target - 原始写目标（未归一化）。
 * @param platform - 平台判定依据（默认 `process.platform`；单测可显式传 'linux'/'win32'）。
 * @returns 非文件写入槽返回 true；非字符串/空白/普通路径返回 false。
 */
export function isIgnoredWriteSink(target, platform = process.platform) {
  if (typeof target !== 'string') return false
  const text = target.trim()
  if (text.length === 0) return false
  if (POSIX_IGNORED_WRITE_SINKS.has(text)) return true
  if (POSIX_IGNORED_WRITE_SINK_PREFIXES.some((prefix) => text.startsWith(prefix))) return true
  if (platform !== 'win32') return false
  // 兼容 `C:\tmp\NUL` 这类混合分隔符：取最后一段做设备名比较。
  const base = text.split(/[\\/]/).pop() ?? ''
  return WINDOWS_DEVICE_NAMES.has(base.toLowerCase())
}

/**
 * 判定用的 sink 候选：既要是伪设备/标准流，又不能含 `..` 段。
 *
 * `decideWriteTargets` 与 shell 写目标过滤都走这里；含 `..` 的路径放行进入正常
 * 归一化/分类流程，最终按真实落点判项目外写入（review C2）。
 *
 * @param target - 原始写目标。
 * @returns 可以安全剔除（不落盘）返回 true。
 */
function isSinkCandidate(target) {
  if (hasDotDotSegment(target)) return false
  return isIgnoredWriteSink(target)
}

/** 取路径的最后一段（同时认 `/` 与 `\`，用于 Windows 风格的命令词）。 */
function baseNameOf(word) {
  return String(word ?? '').split(/[\\/]/).pop() ?? ''
}

/** `env` 里带取值的选项：值不是命令词，必须连同值一起跳过（否则 `env -u FOO ln …` 会漏判）。 */
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir'])

/**
 * 取一段命令词里的「命令词」下标：跳过前缀环境变量赋值与 `env` 包装。
 *
 * 为什么跳过 `env`：`env ln -s /etc /proj/etc` 的 words[0] 是 `env`，但真正建链的是
 * `ln`；分析器会把 `env` 递归成 `ln` 的写目标，若不在这里识别建链就会漏掉（I2）。
 *
 * @param words - `tokenizeShell` 的段内普通词列表。
 * @returns 命令词下标；没有可识别的命令词返回 -1。
 */
function commandWordIndex(words) {
  if (!Array.isArray(words) || words.length === 0) return -1
  let index = 0
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1
  if (index >= words.length) return -1
  if (baseNameOf(words[index]).toLowerCase() !== 'env') return index
  index += 1
  // 跳过 env 的选项与 NAME=value；`-u NAME`/`-C DIR` 的值段不能被误当成命令词。
  while (index < words.length) {
    const word = words[index]
    if (word === '--') {
      index += 1
      break
    }
    const eq = word.indexOf('=')
    const name = eq === -1 ? word : word.slice(0, eq)
    if (ENV_VALUE_OPTIONS.has(name)) {
      index += eq === -1 ? 2 : 1
      continue
    }
    if (word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1
      continue
    }
    break
  }
  return index < words.length ? index : -1
}

/**
 * `cp` 的单个参数是否会建链或传播符号链接（I2 残留）。
 *
 *   * 短选项簇含 `a,d,P,r,R,l,s`（`-al` / `-rl` / `-aP` …）：归档/递归/不解引用模式
 *     都会原样复制符号链接，`-l`/`-s` 直接建链；后续写链内路径即可写穿到项目外。
 *   * 长选项 `--archive` / `--no-dereference` / `--recursive` / `--preserve=links`
 *     （`--preserve=all` 也含 links）。
 *   * GNU 长选项缩写：任何以 `--l` / `--s` 开头的长选项（`--lin` / `--symbol` 等）都
 *     可能是 `--link` / `--symbolic-link`，保守改判；`--sparse` / `--suffix` 的误报
 *     只会多问一次，可接受（review 残留 2/3）。`--archive` 等也按 GNU 前缀规则覆盖。
 *
 * 普通 `cp a.txt b.txt` / `cp -t /tmp a` 不含上述形态，仍交给分析器按普通复制判定。
 *
 * @param word - `cp` 之后的单个参数。
 * @returns 会建链/传播链接返回 true。
 */
function isCpRiskyFlag(word) {
  const text = String(word ?? '')
  if (text.length < 2 || text === '--' || !text.startsWith('-')) return false
  if (text.startsWith('--')) {
    const eq = text.indexOf('=')
    const name = eq === -1 ? text : text.slice(0, eq)
    const value = eq === -1 ? '' : text.slice(eq + 1)
    if (CP_RISKY_LONG_PREFIXES.some((prefix) => name.startsWith(prefix))) return true
    if (CP_RISKY_LONG_FLAGS.some((flag) => flag.startsWith(name))) return true
    // `--preserve=links`（含 `--pres=links` 这类 GNU 缩写）同样会保留链接。
    if ('--preserve'.startsWith(name) && name.length > 2) {
      return value
        .split(',')
        .some((attr) => attr.trim() === 'links' || attr.trim() === 'all')
    }
    return false
  }
  // 短选项簇：单个 `-` 开头且后接纯字母；附着的取值（如 `-t/tmp`）不按簇处理。
  return /^-[A-Za-z]+$/.test(text) && /[adPrRls]/.test(text.slice(1))
}

/**
 * 取内层 shell 的命令文本：bash 类看 `-c`，pwsh 类还看 `-Command`（大小写不敏感）。
 *
 * @param words - 段内普通词。
 * @param start - 命令词之后的下标（跳过 `env` 等包装后的位置）。
 * @param cmd - 已小写化的命令词。
 * @returns 内层命令文本；没有内层命令时返回空串。
 */
function nestedShellCommand(words, start, cmd) {
  const isPwsh = cmd === 'pwsh' || cmd === 'powershell'
  const flags = isPwsh ? new Set(['-c', '-command']) : new Set(['-c'])
  for (let index = start; index < words.length; index += 1) {
    if (flags.has(String(words[index] ?? '').toLowerCase())) {
      return words.slice(index + 1).join(' ').trim()
    }
  }
  return ''
}

/**
 * 删除反斜杠续行：bash 在解析前会先删掉所有 `\`+换行（`\<LF>`，CRLF 同样处理），
 * 然后才做 heredoc/命令替换/选项解析。风险层若直接看原始文本，
 * `$\<LF>(` 拼出的 `$(...)`、`cp -a\<LF>`/`cp --arch\<LF>ive` 这类写法就会漏检。
 *
 * 这里只做与执行等价的最小归一化；单引号内保留字面反斜杠等差异、以及其它非常规
 * 拼写变体属于 README / spec §8 的文档化残留（仍有审批/关档兜底）。
 *
 * @param command - 原始命令文本。
 * @returns 删除续行后的文本；非字符串按空命令处理。
 */
function stripLineContinuations(command) {
  return typeof command === 'string' ? command.replace(LINE_CONTINUATION_RE, '') : ''
}

/**
 * 原始命令文本里是否同时含 heredoc 与命令替换标记（I2 残留）。
 *
 * 为什么必须看原始文本：tokenizer 在物理换行后整体跳过 heredoc 正文
 * （path-rules `skipHeredocBodies`），正文里的 `$(ln -s ...)` 不会进
 * `segment.substitutions`；但 shell 执行 heredoc 时仍会展开正文里的命令替换，
 * 链接会真实创建。静态分析无法可靠表达这一时序，按 unanalyzable 交 judge/审批。
 * 纯 heredoc（正文无替换）不受影响；here-string `<<<` 不是 heredoc，排除。
 *
 * @param command - 原始命令文本。
 * @returns 命中返回 true。
 */
function hasHeredocSubstitution(command) {
  const text = typeof command === 'string' ? command : ''
  if (!HEREDOC_OPERATOR_RE.test(text)) return false
  return COMMAND_SUBSTITUTION_RE.test(text)
}

/**
 * 检测分析器的结构性盲区，命中即改判 unanalyzable（review C3 / I2）。
 *
 *   * `~`：`analyzeCommand` 把 `~/secret` 当相对字面量解析到 `<cwd>/~/secret`，
 *     而真实 shell 会展开成用户 home；只要命令文本里出现 `~` 就保守交给 judge
 *     （引号里的字面 `~` 也会被问一次，属于可接受的保守代价）；
 *   * heredoc 正文里的命令替换：tokenizer 跳过正文，`$(ln -s /etc .wg-link)` 不会
 *     出现在 `segment.substitutions`；但执行时仍会建链 ⇒ 原始文本同时含 heredoc
 *     运算符与 `$(`/反引号时改判 unanalyzable（纯 heredoc 仍可分析）；
 *   * 建链/链接传播命令：`ln -s /etc /proj/etc && echo x > /proj/etc/hosts` 的写目标
 *     都在项目内，但链接会让第二条写在**执行时**落到 `/etc`；静态分析表达不了同命令
 *     内的建链时序（TOCTOU），因此把建链命令一律改判 unanalyzable。`cp` 的 `-l`/`-s`
 *     直接建链，`-a`/`-d`/`-P`/`-r`/`-R` 及对应长选项会原样传播符号链接，同样改判；
 *     普通 `cp` 不触发。
 *   * 命令替换/反引号：`echo $(ln -s /etc .wg-link); echo pwn > .wg-link/hosts` 的静态写
 *     目标都在项目内，但替换里的 `ln` 会真实执行 ⇒ 必须递归扫描 `segment.substitutions`。
 *     `bash -c "..."` / `pwsh -Command "..."` 的内层文本同样递归扫描；递归超过
 *     `MAX_RISK_NESTING` 层时保守判 unanalyzable（不再假装能判完）。
 *   * 反斜杠续行：bash 解析前会删除 `\`+换行，风险层扫描前做同样归一化；
 *     `$\<LF>(`、`cp -a\<LF>`、`cp --arch\<LF>ive` 按执行等价文本识别。
 *
 * 只在分析结果为可判定时才有机会改变结论；命中时优先于分析器的理由（如 `link` 本身
 * 也会被判"未收录命令"，但写成"命令含建链操作"更准确）。
 *
 * @param effect - `classifyTool` 的 shell 结果（读 `command`）。
 * @param depth - 内部递归层数（默认 0）。
 * @returns `{reason, fragment}` 或 null（没有风险）。
 */
function detectUnanalyzableRisk(effect, depth = 0) {
  // ⓪ 先与 bash 对齐：删除 `\`+换行。heredoc 正文里的 `$\<LF>(...)` 与
  //    `cp -a\<LF>` / `cp --arch\<LF>ive` 在原始文本上都不命中下面的检查，
  //    但执行时会被拼回完整命令（line continuation 绕过）。
  const command = stripLineContinuations(effect?.command)
  // ① `~` 展开：先在原始文本上找，避免被词法层的引号处理掩盖。
  const tilde = command.indexOf('~')
  if (tilde !== -1) {
    return {
      reason: TILDE_UNANALYZABLE_REASON,
      fragment: command.slice(Math.max(0, tilde - 12), tilde + 13),
    }
  }
  // ② heredoc 正文里的命令替换：tokenizer 跳过正文，substitutions 收集不到（I2 残留）。
  if (hasHeredocSubstitution(command)) {
    const at = command.search(HEREDOC_OPERATOR_RE)
    return {
      reason: HEREDOC_SUBSTITUTION_UNANALYZABLE_REASON,
      fragment: command.slice(Math.max(0, at - 12), at + 48),
    }
  }
  // ③ 递归预算用尽：再往下扫也无法保证不漏建链命令，按 unanalyzable 处理。
  if (depth > MAX_RISK_NESTING) {
    return { reason: NESTED_UNANALYZABLE_REASON, fragment: command.slice(0, 120) }
  }
  // ④ 建链命令：按段扫描命令词；tokenize 失败时分析器已判不出，这里不再兜底。
  let segments = []
  try {
    segments = tokenizeShell(command).segments
  } catch {
    segments = []
  }
  for (const segment of Array.isArray(segments) ? segments : []) {
    // ④-a 命令替换 / 反引号：内层命令会真实执行，先递归扫一遍（与下面的 bash -c 共用预算）。
    for (const substitution of Array.isArray(segment?.substitutions) ? segment.substitutions : []) {
      if (typeof substitution !== 'string' || substitution.trim().length === 0) continue
      const nested = detectUnanalyzableRisk({ command: substitution }, depth + 1)
      if (nested !== null) return nested
    }

    const words = Array.isArray(segment?.words) ? segment.words : []
    const index = commandWordIndex(words)
    if (index === -1) continue
    const cmd = baseNameOf(words[index]).toLowerCase()
    if (LINK_COMMANDS.has(cmd)) {
      return {
        reason: LINK_UNANALYZABLE_REASON,
        fragment: String(words.join(' ')).slice(0, 120),
      }
    }
    // `cp` 的建链/链接传播参数；普通 `cp` 保持可分析。
    if (cmd === 'cp' && words.slice(index + 1).some((word) => isCpRiskyFlag(word))) {
      return {
        reason: LINK_UNANALYZABLE_REASON,
        fragment: String(words.join(' ')).slice(0, 120),
      }
    }
    // `bash -c "<inner>"` / `pwsh -Command "<inner>"`：分析器会递归分析内层（视为可判定），
    // 本层也必须递归扫建链。
    if (NESTED_SHELL_COMMANDS.has(cmd)) {
      const inner = nestedShellCommand(words, index + 1, cmd)
      if (inner.length > 0) {
        const nested = detectUnanalyzableRisk({ command: inner }, depth + 1)
        if (nested !== null) return nested
      }
    }
  }
  return null
}

/**
 * shell 命令的解析基准：workdir 为空用会话 cwd；否则相对 cwd 解析并归一化。
 *
 * 约定 `context.cwd` 是会话工作区的绝对路径（index.mjs 保证），因此空 workdir
 * 时原样返回 cwd；给出 workdir 时统一走 `normalizePath`，保证返回绝对路径。
 *
 * @param effect - `classifyTool` 的 shell 结果（含 `workdir`）。
 * @param cwd - 会话工作目录。
 * @returns 绝对路径形式的解析基准。
 */
export function resolveWorkdir(effect, cwd) {
  const base = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : process.cwd()
  const workdir = typeof effect?.workdir === 'string' ? effect.workdir.trim() : ''
  if (workdir.length === 0) return base
  return normalizePath(workdir, base)
}

/**
 * 补齐 pwsh 的 workdir（review C5）。
 *
 * `@gavinc-cn/dsh-path-rules/classify` 目前只从 bash 参数里读 `workdir`，pwsh 的
 * `effect.workdir` 恒为空；但 `pwsh` 工具有真实的 `arguments.workdir`，不读它会把
 * "在 `/outside` 里写 `secret.txt`" 误判成项目内。这里只在 pwsh 且 effect 未给 workdir
 * 时补取（不改 path-rules 的行为），取值后与 bash 共用 `resolveWorkdir` 的解析口径。
 *
 * @param exec - `tools/pre-execute` 的 exec（只读 arguments.workdir）。
 * @param effect - `classifyTool` 的结果。
 * @returns 补好 workdir 的 effect（非 shell 结果原样返回）。
 */
function withShellWorkdir(exec, effect) {
  if (effect?.kind !== 'shell' || effect.shell !== 'pwsh') return effect
  if (typeof effect.workdir === 'string' && effect.workdir.trim().length > 0) return effect
  let workdir
  try {
    workdir = exec?.arguments?.workdir
  } catch {
    // arguments 的 getter 抛错：维持空 workdir（后续按 cwd 解析），异常由外层 failMode 兜底。
    return effect
  }
  if (typeof workdir !== 'string' || workdir.trim().length === 0) return effect
  return { ...effect, workdir: workdir.trim() }
}

/**
 * 组装生效中的根集合：`allowTempRoots:false` 时丢弃临时区（临时区不再作为放行依据）。
 * `roots.temp` 缺失时现算 `tempRoots()`；显式空数组表示「本次不含临时区」。
 */
function effectiveRoots(context) {
  const roots = context?.roots ?? {}
  const allowTemp = context?.config?.allowTempRoots !== false
  let temp = []
  if (allowTemp) temp = Array.isArray(roots.temp) ? roots.temp : tempRoots()
  return {
    project: typeof roots.project === 'string' ? roots.project : '',
    whitelist: Array.isArray(roots.whitelist) ? roots.whitelist : [],
    temp,
  }
}

/** 归一化一批目标：逐项 normalizePath，丢弃空白，去重保序。 */
function normalizeTargets(targets, base) {
  const normalized = []
  for (const target of Array.isArray(targets) ? targets : []) {
    const path = normalizePath(target, base)
    if (path.length > 0 && !normalized.includes(path)) normalized.push(path)
  }
  return normalized
}

/** 越界写的展示理由（一句中文 + 一句英文，不带审计标记）。 */
function outsideDisplay(outsideTargets, project) {
  const list = outsideTargets.join('、')
  const root = projectLabel(project)
  return {
    zh: `写入目标 ${list} 不在当前项目（${root}）或白名单内，批准后目标目录会自动加入白名单。`,
    en: `Write target(s) ${list} are outside the current project (${root}) and the whitelist; approving adds the target directories to the whitelist automatically.`,
  }
}

/** judge 认为不安全的展示理由。 */
function unsafeDisplay(outsideTargets) {
  const list = outsideTargets.length > 0 ? outsideTargets.join('、') : '未给出具体路径'
  return {
    zh: `AI 判定这条命令可能修改项目/白名单之外的文件（${list}），需要你确认。`,
    en: `The AI judge considers this command may modify files outside the project and whitelist (${list}); please confirm.`,
  }
}

/** judge 无法判断的展示理由。 */
function unknownDisplay() {
  return {
    zh: '这条命令无法静态判定，AI 也无法确认它只写项目/白名单内，需要你确认。',
    en: 'This command cannot be statically analyzed and the AI could not confirm it only writes inside the project and whitelist; please confirm.',
  }
}

/** judge 不可用的展示理由。 */
function unavailableDisplay() {
  return {
    zh: '这条命令无法静态判定，且 AI 判定当前不可用，需要你确认。',
    en: 'This command cannot be statically analyzed and the AI judge is currently unavailable; please confirm.',
  }
}

/**
 * 写目标判定：全部落在 project/whitelist/temp 才放行；任一 outside 就合并成一条 ask。
 *
 * 分类前先剔除伪设备/标准流（`isSinkCandidate`）：它们不落盘，既不参与分类也不进入
 * ask 的 targets（文件工具理论上也可能写 `/dev/null`）。含 `..` 的原始路径不按 sink 剔除，
 * 会先归一化再分类（`/dev/fd/../../../etc/hosts` ⇒ `/etc/hosts` ⇒ ask）。
 *
 * @param targets - 原始写目标（文件工具的 file_path 或 shell 的 writes）。
 * @param base - 归一化基准（文件工具 = cwd；shell = 解析后的 workdir）。
 * @param roots - 生效中的根集合。
 * @returns `{kind:'allow', code:'WRITE_INSIDE'}` 或 OUTSIDE_WRITE 的 ask。
 */
function decideWriteTargets(targets, base, roots) {
  const fileTargets = (Array.isArray(targets) ? targets : []).filter(
    (target) => !isSinkCandidate(target),
  )
  const outside = normalizeTargets(fileTargets, base).filter(
    (target) => classifyTargetKind(target, roots) === 'outside',
  )
  if (outside.length === 0) return allow('WRITE_INSIDE')
  const list = outside.join(', ')
  return ask(
    'OUTSIDE_WRITE',
    `项目/白名单之外的写入需要确认：${list}（项目根：${projectLabel(roots.project)}）。批准后目录会自动加入白名单。`,
    outsideDisplay(outside, roots.project),
    outside,
  )
}

/**
 * shell 命令静态判不出时的处理：judge 禁用 → JUDGE_DISABLED；否则调用 judge 回调。
 *
 * judge 返回 `safe` → JUDGE_SAFE；`unsafe` → JUDGE_UNSAFE；其余（unknown/非法枚举/
 * 缺失/抛错）→ JUDGE_UNKNOWN。`unsafe`/`unknown` 的 targets 取 `outsidePaths` 归一化结果。
 *
 * @param effect - `classifyTool` 的 shell 结果。
 * @param base - 解析后的工作目录（同时作为 outsidePaths 的归一化基准）。
 * @param analysis - `analyzeCommand` 的 `unanalyzable`（`{reason, fragment}`）。
 * @param context - `{config, judge}`。
 */
async function decideUnanalyzable(effect, base, analysis, context) {
  const reasonText = typeof analysis?.reason === 'string' ? analysis.reason : '(原因未知)'
  const judge = context?.judge
  // spec §4.3-③：`judge=false` 即禁用，不依赖 index 是否把回调传成 null（两种写法都兜住）。
  const judgeEnabled = context?.config?.judge !== false
  if (!judgeEnabled || typeof judge !== 'function') {
    const why = judgeEnabled ? '未注入 judge 回调' : '配置 judge=false'
    return ask(
      'JUDGE_DISABLED',
      `命令无法静态判定（${reasonText}），AI 判定不可用（${why}），需要确认`,
      unavailableDisplay(),
      [],
    )
  }

  let result
  try {
    result = await judge({
      command: effect.command,
      shell: effect.shell,
      workdir: base,
      analysis: analysis ?? null,
    })
  } catch (error) {
    // judge 回调抛错（模型/网络失败）按「无法判断」处理，绝不误放行。
    const message = error instanceof Error ? error.message : String(error)
    return ask(
      'JUDGE_UNKNOWN',
      `命令无法静态判定（${reasonText}），AI 判定失败：${message}`,
      unknownDisplay(),
      [],
    )
  }

  const decision = typeof result?.decision === 'string' ? result.decision : 'unknown'
  const outside = normalizeTargets(result?.outsidePaths, base)
  const judgeReason =
    typeof result?.reason === 'string' && result.reason.trim().length > 0
      ? result.reason.trim()
      : '(judge 未给出理由)'

  if (decision === 'safe') return allow('JUDGE_SAFE')
  if (decision === 'unsafe') {
    const paths = outside.length > 0 ? outside.join(', ') : '未给出'
    return ask(
      'JUDGE_UNSAFE',
      `AI 判定该命令可能修改项目/白名单之外的文件：${judgeReason}（可疑路径：${paths}）`,
      unsafeDisplay(outside),
      outside,
    )
  }
  return ask(
    'JUDGE_UNKNOWN',
    `命令无法静态判定，AI 也无法确认是否只写项目/白名单内：${judgeReason}`,
    unknownDisplay(),
    outside,
  )
}

/**
 * 判定一次工具调用（纯函数；`judge` 回调是唯一异步来源）。
 *
 * 判定顺序（spec §4.3）：
 *   ① disabled → pass；② classifyTool：pass/read → pass，write → 目标分类；
 *   ③ shell：先看 unanalyzable（含 `~` / 建链/链接传播 / heredoc 内命令替换的结构性盲区）
 *      → judge；**只有可分析命令**
 *      才剔除伪设备/标准流 —— 剩余无写目标 → READ_ONLY，否则按 writes 分类；
 *   ④ 写目标任一 outside → 单条 ask；否则 allow。
 *
 * 顺序要点（review C1）：unanalyzable 必须先于 sink 过滤。否则 `npm test > /dev/null`
 * 这类"未收录命令 + 唯一写目标是标准流"会在分析器判不出时被提前放行、绕过 AI 判定。
 *
 * @param exec - `tools/pre-execute` 的 exec（只读 `name` / `arguments`）。
 * @param context - `{config, cwd, roots, judge}`：
 *   `roots` 为已归一化的 `{project, whitelist, temp}`；`judge` 为
 *   `async ({command, shell, workdir, analysis}) => {decision, outsidePaths, reason}`，
 *   禁用时传 `null`。
 * @returns {Promise<{kind:'pass'} | {kind:'allow', code:string} |
 *   {kind:'ask', code:string, reason:string, displayReason:{zh:string,en:string}, targets:string[]}>}
 */
export async function decideCall(exec, context) {
  // ① 停用兜底：激活判定在 index.mjs，这里只做「明确关闭就不介入」的廉价保护。
  if (context?.config?.enabled === false) return pass()

  const cwd =
    typeof context?.cwd === 'string' && context.cwd.trim().length > 0
      ? context.cwd.trim()
      : process.cwd()
  const effect = withShellWorkdir(exec, classifyTool(exec?.name, exec?.arguments))
  // ② 读操作/未知工具（含 MCP）：透传，不猜写入语义（spec §5.1 已知盲区）。
  if (effect.kind === 'pass' || effect.kind === 'read') return pass()

  const roots = effectiveRoots(context)

  if (effect.kind === 'write') {
    return decideWriteTargets(effect.targets, resolveWorkdir(effect, cwd), roots)
  }

  // ③ shell：先静态分析；命中本层保守规则（~ / 建链/链接传播 / heredoc 内命令替换）或
  // 分析器判不出 → judge。
  const base = resolveWorkdir(effect, cwd)
  const analysis = analyzeCommand(effect.command, { shell: effect.shell, cwd: base })
  // 本层保守规则优先：`ln`/`link`/`cp -a` 等建链/链接传播理由要稳定写进 ask（I2）；`link`
  // 本身也可能先被分析器标成"未收录命令"，这里统一成"命令含建链操作"更准确。
  const risk = detectUnanalyzableRisk(effect)
  const unanalyzable = risk ?? analysis?.unanalyzable ?? null
  // review C1：unanalyzable 必须**先**走 judge，不能因为写目标全是 sink 就提前放行。
  if (unanalyzable !== null) return decideUnanalyzable(effect, base, unanalyzable, context)

  const writes = Array.isArray(analysis?.writes) ? analysis.writes : []
  // 只有可分析命令才剔除 sink：含 `..` 的路径不算 sink（C2），仍按归一化后的真实落点分类。
  const fileWrites = writes.filter((target) => !isSinkCandidate(target))
  // 无（剩余）写目标 = 只读命令，直接放行（spec §4.3-③）。
  if (fileWrites.length === 0) return allow('READ_ONLY')

  // ④ 逐写目标分类；多目标任一越界 ⇒ 合并成一条 ask。
  return decideWriteTargets(fileWrites, base, roots)
}
