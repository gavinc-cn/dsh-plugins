// @gavinc-cn/dsh-file-guard —— 会话文件守卫核心（kimi 侧 file_guard.py 的逐函数 JS 移植）
//
// 为什么搬迁：DSH 的 hook 子进程经 dsh-hook-protocol → bash.execute()，请求不带 sandboxPolicy，
// 回退到部署级默认沙箱（实测只有 /tmp 可写），`file_guard.py stop-hook` 因此无法读 ~/.orca/file-guard/
// 下的 journal/state（读得到但写不了 state.json 去重标记与 reports/，异常被脚本 fail-open 吞掉
// → 每轮要么不报要么重复报）。插件跑在 harness 进程内，不受这层沙箱约束。
//
// 本文件是「状态格式的唯一权威实现」，与 Python 版**双向兼容**：
//   <state_root>/<session_id>/journal.ndjson   每条 = 会话期望的文件状态（单行 JSON）
//   <state_root>/<session_id>/state.json       reported（已报告去重）/ ack / workspace / created_at
//   <state_root>/<session_id>/blobs/<sha1>     内容副本（恢复用；>2MiB 只记元数据）
//   <state_root>/<session_id>/reports/<时间>.json  历次收尾报告
//
// 兼容性硬约束（改动前先想清楚）：
//   * 目录名 sanitize 规则与 Python 一致（Unicode isalnum 保留，其余 → `_`，按码点截断 120）；
//   * journal/state 的 JSON 键名、键序、缩进与 Python json.dumps(..., ensure_ascii=False, indent=1) 对齐；
//   * 时间戳一律「浮点秒」（Python time.time() 口径，JS 侧 Date.now()/1000）；
//   * blob 文件名就是内容 sha1 十六进制，两边同算同取。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { homedir } from 'node:os'

// ── 常量 ────────────────────────────────────────────────────────────────────────

/** 状态根默认位置：家目录下的 `.orca/file-guard`（可用 env FILE_GUARD_ROOT 或插件配置
 *  `stateRoot` 覆盖；与 Python 版同源 —— 两边指向同一份状态目录才能互读互写）。
 *  按 homedir 解析而非写死绝对路径，别机（非 root 用户 / Windows）装上也能落地。 */
export const DEFAULT_STATE_ROOT = join(homedir(), '.orca', 'file-guard')
/** 单个 blob 的存储上限：超过则只记元数据（可检出漂移，但无法提供副本）。 */
export const BLOB_MAX_BYTES = 2 * 1024 * 1024
/** 不记录/不检查的路径目录名（构建产物、缓存、版本控制内部目录）。 */
export const IGNORE_DIRS = new Set(['.git', '__pycache__', 'node_modules', '.venv', 'venv',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.idea', '.obsidian'])
/** 不记录/不检查的后缀（构建产物/日志/临时文件）。 */
export const IGNORE_SUFFIXES = new Set(['.pyc', '.pyo', '.so', '.o', '.obj', '.exe', '.dll',
  '.dylib', '.log', '.tmp', '.swp', '.lock'])

// ── 基础工具 ────────────────────────────────────────────────────────────────────

/** 当前时间戳（秒，浮点）；独立函数便于测试打桩（对应 Python now()）。 */
export function now() {
  return Date.now() / 1000
}

/** 字节流的 sha1 十六进制（对应 Python sha1_bytes）。 */
export function sha1Bytes(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  return createHash('sha1').update(buf).digest('hex')
}

/** 读文件字节；不存在/不可读返回 null（对应 Python read_bytes）。 */
export function readBytes(path) {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

/**
 * 一次 lstat，返回 Python os.lstat 口径的数值（size/ino 为 Number，mtime 为浮点秒）。
 *
 * mtime 必须走 BigInt 纳秒自己算：CPython 的 st_mtime = (double)sec + (double)nsec*1e-9，
 * 而 Node 的 st.mtimeMs/1000 会多一次乘除舍入 —— 实测 500 个随机纳秒值里有 148 个与 Python
 * 差 1 ULP，导致 check --json 的 actual_mtime 两边对不上。不复刻这个算式就无法逐字节对齐。
 */
function lstatPy(path) {
  const st = lstatSync(path, { bigint: true })
  const ns = st.mtimeNs
  const sec = ns / 1000000000n
  const rem = ns % 1000000000n
  return {
    size: Number(st.size),
    ino: Number(st.ino),
    mtime: Number(sec) + Number(rem) * 1e-9,
  }
}

/** Python PurePath.suffix 口径：仅最后一个点、且点不在首尾时算后缀。 */
function suffixOf(path) {
  const name = String(path).split(/[\\/]/).pop() ?? ''
  const i = name.lastIndexOf('.')
  if (i > 0 && i < name.length - 1) return name.slice(i)
  return ''
}

/**
 * 默认豁免的噪音路径（构建产物/缓存/日志）；显式 note 过的路径不受影响。
 * 与 Python is_ignored 同口径：按路径分量判目录名 + 末段后缀。
 */
export function isIgnored(path) {
  const parts = String(path).split(/[\\/]+/).filter((p) => p.length > 0)
  if (parts.some((p) => IGNORE_DIRS.has(p))) return true
  return IGNORE_SUFFIXES.has(suffixOf(path))
}

/**
 * Python Path.resolve() 的非严格等价物：解析已有前缀的符号链接，剩余部分原样拼接；
 * 路径完全不存在时也不抛（Python 3.6+ 的 strict=False 语义）。
 */
function resolveNonStrict(path) {
  const abs = resolve(String(path))
  const tail = []
  let cur = abs
  for (;;) {
    try {
      const real = realpathSync(cur)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs
      tail.unshift(basename(cur))
      cur = parent
    }
  }
}

/**
 * 所在 git 仓库根；不在仓库内返回该文件所在目录（对应 Python repo_root_of）。
 * 超时 5s，与 Python 版一致；git 输出原样返回（不额外解析符号链接）。
 */
export function repoRootOf(path, cwd = process.cwd()) {
  const p = resolveNonStrict(path)
  let dir
  try {
    dir = statSync(p).isDirectory() ? p : dirname(p)
  } catch {
    dir = dirname(p)
  }
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const root = out.trim()
    if (root.length > 0) return root
  } catch {
    /* 非 git 仓库 / git 缺失 / 超时 → 退回目录本身 */
  }
  return dir
}

/** os.path.relpath 等价物；同一路径返回 '.'（Node 的 relative 返回空串）。 */
export function relPath(target, base) {
  const rel = normalize(relative(resolve(String(base)), resolve(String(target))))
  return rel.length === 0 ? '.' : rel
}

/** Python 字符串比较口径：按码点排序（JS 默认按 UTF-16 码元，非 BMP 字符会不同）。 */
export function cmpCodePoints(a, b) {
  const ai = String(a)[Symbol.iterator]()
  const bi = String(b)[Symbol.iterator]()
  for (;;) {
    const x = ai.next()
    const y = bi.next()
    if (x.done === true && y.done === true) return 0
    if (x.done === true) return -1
    if (y.done === true) return 1
    const cx = x.value.codePointAt(0)
    const cy = y.value.codePointAt(0)
    if (cx !== cy) return cx < cy ? -1 : 1
  }
}

// ── Python 打印口径的小工具（CLI 文案逐字对齐用） ────────────────────────────────

/** Python str() 口径（None → 'None'，True → 'True'）。 */
export function pyStr(v) {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return pyNumStr(v)
  return String(v)
}

/** Python str(float) 只在需要时补 '.0'；整数按 int 打印。 */
function pyNumStr(n) {
  if (Number.isNaN(n)) return 'nan'
  if (n === Infinity) return 'inf'
  if (n === -Infinity) return '-inf'
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n)
  const s = String(n)
  return Number.isInteger(n) && !s.includes('e') ? `${s}.0` : s
}

/** Python bool 格式化（'{x}'.format(True) → 'True'）。 */
export function pyBool(v) {
  return v ? 'True' : 'False'
}

/** Python 字符串切片 s[:n]（按码点，不按 UTF-16 码元）。 */
export function pySlice(s, n) {
  const str = String(s)
  const cp = [...str]
  return cp.length <= n ? str : cp.slice(0, n).join('')
}

/**
 * Python json.dumps(obj, ensure_ascii=False) 的紧凑版（默认 separators=(', ', ': ')）。
 *
 * JS 的 JSON.stringify 用 ',' / ':' 无空格，与 Python 的默认分隔符不同；stop-hook 的
 * `--dsh` 输出要与 Python 逐字节一致（DSH 桥接按 JSON 解析，空格不影响语义，但
 * 对比测试与人工核对时逐字节一致更省事）。
 */
export function pyJsonDumps(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN'
    if (value === Infinity) return 'Infinity'
    if (value === -Infinity) return '-Infinity'
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => pyJsonDumps(v)).join(', ')}]`
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`).join(', ')}}`
}

/** Python str.ljust(n)：按码点补空格。 */
export function pyLjust(s, n) {
  const str = String(s)
  const len = [...str].length
  return len >= n ? str : str + ' '.repeat(n - len)
}

// ── 会话定位 ────────────────────────────────────────────────────────────────────

/** 状态根：显式参数 > env FILE_GUARD_ROOT > 默认（对应 Python 的 STATE_ROOT）。 */
export function stateRoot(explicit, env = process.env) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const v = env?.FILE_GUARD_ROOT
  return typeof v === 'string' && v.length > 0 ? v : DEFAULT_STATE_ROOT
}

/** 所有会话状态目录（按 mtime 倒序），对应 Python session_dirs。 */
export function sessionDirs(root) {
  if (!isDir(root)) return []
  const dirs = []
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    if (!isDir(p)) continue
    try {
      dirs.push({ path: p, mtime: statSync(p).mtimeMs })
    } catch {
      /* 竞态删除 → 跳过 */
    }
  }
  dirs.sort((a, b) => b.mtime - a.mtime)
  return dirs.map((d) => d.path)
}

/** 会话记录的工作区根（state.json 里存；缺省用 journal 首条的 root）。 */
export function sessionWorkspace(d) {
  const st = readState(d)
  if (st.workspace) return st.workspace
  for (const rec of readJournal(d)) {
    if (rec.root) return rec.root
  }
  return ''
}

/**
 * 定位当前会话状态目录（对应 Python resolve_session）。
 *
 * 优先 explicit；否则取「工作区 == cwd 所在 git 仓库根」且最近更新的会话；再退化为 null。
 * 同一 cwd 可能有多个历史会话，新会话首次 note 时由 newSessionDir 创建。
 *
 * @returns {string|null} 会话状态目录绝对/相对路径，找不到返回 null
 */
export function resolveSession(explicit, options = {}) {
  const root = stateRoot(options.root, options.env)
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  if (explicit) {
    const d = String(explicit)
    return isAbsolute(d) ? d : join(root, d)
  }
  const envSid = env?.FILE_GUARD_SESSION
  if (envSid) return join(root, sanitize(envSid))
  const here = repoRootOf(cwd, cwd)
  for (const d of sessionDirs(root)) {
    const ws = sessionWorkspace(d)
    if (ws && pathKey(ws) === pathKey(here)) return d
  }
  return null
}

/** 路径比较口径（Python PurePath 相等）：折叠多余分隔符/`.`，忽略结尾斜杠。 */
function pathKey(p) {
  const n = normalize(String(p))
  const stripped = n.replace(/\/+$/, '')
  return stripped.length === 0 ? '/' : stripped
}

/** 会话 id 过滤成安全目录名（对应 Python sanitize）。 */
export function sanitize(name) {
  const keep = []
  for (const ch of String(name)) {
    keep.push(isAlnum(ch) || ch === '-' || ch === '_' || ch === '.' ? ch : '_')
  }
  const out = keep.slice(0, 120).join('')
  return out.length > 0 ? out : 'unknown'
}

/** Python str.isalnum() 口径：Unicode 字母/数字类（\p{L} 与 \p{N}）。 */
function isAlnum(ch) {
  return /[\p{L}\p{N}]/u.test(ch)
}

/** 创建会话状态目录并写入 workspace 归属（对应 Python new_session_dir）。 */
export function newSessionDir(sessionId, workspace, root) {
  const d = join(String(root), sanitize(sessionId))
  mkdirSync(d, { recursive: true })
  const st = readState(d)
  st.workspace = String(workspace)
  if (st.created_at === undefined) st.created_at = now()
  writeState(d, st)
  return d
}

/** CLI 未指定会话时的兜底 id：按工作区目录名生成，保证同工作区可续写。 */
export function defaultSessionId(cwd = process.cwd()) {
  const root = repoRootOf(cwd, cwd)
  return `ws-${sanitize(basename(root) || 'default')}`
}

// ── 状态与 journal ──────────────────────────────────────────────────────────────

/** state.json 路径（对应 Python state_path）。 */
export function statePath(d) {
  return join(String(d), 'state.json')
}

/** 读 state.json；坏文件返回空对象（fail-open，不因状态坏了阻断会话）。 */
export function readState(d) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(d), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 原子写 state.json（tmp + rename），缩进与 Python json.dumps(indent=1) 一致。 */
export function writeState(d, st) {
  const p = statePath(d)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(st, null, 1), 'utf8')
  renameSync(tmp, p)
}

/** journal.ndjson 路径（对应 Python journal_path）。 */
export function journalPath(d) {
  return join(String(d), 'journal.ndjson')
}

/** 追加一条 journal（单行 JSON，O_APPEND 保证并发下不撕裂），并刷新 state.json 的 mtime。 */
export function appendJournal(d, rec) {
  const line = `${JSON.stringify(rec)}\n`
  const p = journalPath(d)
  const fd = openSync(p, 'a')
  try {
    writeSync(fd, line)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // 刷新 state.json 的 mtime：会话定位按「最近更新的会话」挑选，不刷新的话多会话
  // 并存时可能选错会话（journal 本身在 O_APPEND 下 mtime 也会变，但 state.json 是
  // 定位时的首选标记，显式刷新更可靠）。
  const stPath = statePath(d)
  if (isFile(stPath)) {
    try {
      const t = new Date()
      utimesSync(stPath, t, t)
    } catch {
      /* 刷新失败不影响主流程 */
    }
  }
}

/** 读全部 journal；坏行跳过（不因一行坏数据报废整条时间线）。 */
export function readJournal(d) {
  const p = journalPath(d)
  if (!isFile(p)) return []
  let text
  try {
    text = readFileSync(p, 'utf8')   // 非法 UTF-8 由 Node 替换成 U+FFFD，与 Python errors="replace" 同口径
  } catch {
    return []
  }
  const out = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    try {
      const rec = JSON.parse(line)
      if (rec !== null && typeof rec === 'object' && !Array.isArray(rec)) out.push(rec)
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

/** 同一路径取最后一条记录（会话期望的最新状态）。 */
export function latestByPath(records) {
  const latest = new Map()
  for (const r of records) {
    if (r.abs) latest.set(r.abs, r)
  }
  return latest
}

/** 存一个内容副本，返回 sha1；data 为 null 或超限时不存（返回 null）。 */
export function storeBlob(d, data) {
  if (data === null || data === undefined || data.length > BLOB_MAX_BYTES) return null
  const h = sha1Bytes(data)
  const bdir = join(String(d), 'blobs')
  mkdirSync(bdir, { recursive: true })
  const target = join(bdir, h)
  if (!existsSync(target)) {
    const tmp = join(bdir, `${h}.tmp`)
    writeFileSync(tmp, data)
    renameSync(tmp, target)
  }
  return h
}

/** 取回复制的内容；不存在返回 null。 */
export function blobBytes(d, sha) {
  if (!sha) return null
  return readBytes(join(String(d), 'blobs', String(sha)))
}

// ── 漂移检测 ────────────────────────────────────────────────────────────────────

/** 磁盘当前指纹：不存在/不可读 → 明确的状态，绝不与「未变化」混淆。 */
export function currentFingerprint(path) {
  let st
  try {
    st = lstatPy(path)
  } catch {
    return { state: 'missing' }
  }
  let isRegularFile = false
  try {
    isRegularFile = statSync(path).isFile()
  } catch {
    isRegularFile = false
  }
  const size = st.size
  const mtime = st.mtime
  if (!isRegularFile) return { state: 'not-file', size, mtime }
  const data = readBytes(path)
  if (data === null) return { state: 'unreadable', size, mtime }
  return { state: 'present', sha1: sha1Bytes(data), size: data.length, mtime, inode: st.ino, bytes: data }
}

/** 把「磁盘现状 vs 会话期望」判成漂移类型（nil 表示无漂移）。 */
export function classify(rec, fp) {
  if (fp.state === 'missing') return 'missing'
  if (fp.state === 'not-file') return 'not-file'
  if (fp.state === 'unreadable') return 'unreadable'
  if (fp.sha1 !== (rec.sha1 ?? null)) return 'changed'
  return null
}

/** 给「被覆盖」场景一句内容级线索：行数/字节差 + 首个差异位置。 */
export function diffHint(oldBuf, newBuf) {
  if (oldBuf === null || oldBuf === undefined || newBuf === null || newBuf === undefined) {
    return '无副本可比较（超限或缺失）'
  }
  if (oldBuf.equals(newBuf)) return '内容相同'
  const n = Math.min(oldBuf.length, newBuf.length)
  let i = 0
  while (i < n && oldBuf[i] === newBuf[i]) i += 1
  const line = countByte(oldBuf.subarray(0, i), 0x0a) + 1
  // 注意：Python 源码这里是 f"...{old.count(b'\\n') + 1}..."，f-string 里的 b'\\n' 是
  // 「反斜杠 + n」两个字节而不是换行符，所以它数的是字面量 \n 序列的出现次数（正常文本里
  // 恒为 0 → 恒显示 1）。这里是刻意对齐该行为，不要"顺手修好"。
  return `字节 ${oldBuf.length} -> ${newBuf.length}，行数 `
    + `${countEscapedNewline(oldBuf) + 1} -> ${countEscapedNewline(newBuf) + 1}，`
    + `首个差异在第 ${line} 行（偏移 ${i}）`
}

/** 统计 Buffer 中某个字节出现次数（等价 Python bytes.count）。 */
function countByte(buf, byte) {
  let n = 0
  for (const b of buf) if (b === byte) n += 1
  return n
}

/** 统计「反斜杠 + n」两字节序列的出现次数（对齐 Python 源码里 b'\\n' 的实际语义）。 */
function countEscapedNewline(buf) {
  let n = 0
  for (let i = 0; i + 1 < buf.length; i += 1) {
    if (buf[i] === 0x5c && buf[i + 1] === 0x6e) n += 1
  }
  return n
}

/**
 * 比对 journal 与磁盘，返回漂移列表（含证据、判定线索与恢复可行性）。
 *
 * 「谁的改动」在文件层不可判定，守卫不做推断、只给事实，供人或模型判断：
 *   * changed_after_note：文件 mtime 晚于该路径最后一次记录的时刻。
 *   * content_known_to_session：磁盘内容命中该路径历史上任一「会话写下的内容」副本。
 * 结论：报告 + 去重（同一批漂移只提示一次），恢复永远由人显式决定。
 *
 * @param {string} d 会话状态目录
 * @param {string|null} onlyPath 只检查该路径（按 os.path.abspath 归一）
 * @param {string} cwd onlyPath 相对路径的基准目录
 */
export function collectDrift(d, onlyPath = null, cwd = process.cwd()) {
  const records = readJournal(d)
  if (records.length === 0) return []
  const latest = latestByPath(records)
  const knownBlobs = allGoodBlobs(records)
  const st = readState(d)
  const ack = new Set(Array.isArray(st.ack) ? st.ack : [])
  const drift = []
  const entries = [...latest.entries()].sort((a, b) => cmpCodePoints(a[0], b[0]))
  for (const [absPath, rec] of entries) {
    // 墓碑（forget）：本会话有意让该文件不再处于守护状态（例如删掉演练文件）
    if (rec.op === 'forget') continue
    if (onlyPath && resolve(cwd, String(onlyPath)) !== absPath) continue
    if (ack.has(absPath)) continue
    const fp = currentFingerprint(absPath)
    const kind = classify(rec, fp)
    if (!kind) continue
    // 可恢复性来自 last_good_blob（note 时存的「会话写下的内容」副本）。
    // prev_blob 只是写前更早的历史版本，单独出现时不足以恢复。
    const good = rec.last_good_blob ?? null
    const mtime = fp.mtime
    const ts = typeof rec.ts === 'number' ? rec.ts : 0
    const item = {
      path: rec.path || absPath,
      abs: absPath,
      kind,
      expected_sha1: rec.sha1 ?? null,
      expected_size: rec.size ?? null,
      expected_at: rec.ts ?? null,
      noted_by: rec.tool || rec.op || '?',
      prev_blob: rec.prev_blob ?? null,
      last_good_blob: good,
      has_prev: Boolean(rec.prev_blob),
      recoverable: Boolean(good) && (kind === 'changed' || kind === 'missing'),
      changed_after_note: Boolean(mtime !== undefined && mtime !== null && mtime > ts),
      content_known_to_session: Boolean(
        fp.sha1 && (knownBlobs.get(absPath) ?? new Set()).has(fp.sha1)),
    }
    if (kind === 'changed') {
      item.actual_sha1 = fp.sha1 ?? null
      item.actual_size = fp.size ?? null
      item.actual_mtime = fp.mtime ?? null
      // 对比基线用「会话写下的内容」副本：last_good 缺失时退回更早的写前版本
      item.diff_hint = diffHint(blobBytes(d, good || rec.prev_blob), fp.bytes)
    } else {
      // 注意键序：Python 侧这里是 dict 事后追加，actual_sha1 落在最后
      item.actual_sha1 = null
    }
    drift.push(item)
  }
  return drift
}

/** 同一路径历史上存过的所有「会话写下内容」副本 sha1 集合。 */
export function allGoodBlobs(records) {
  const out = new Map()
  for (const r of records) {
    const b = r.last_good_blob
    if (r.abs && b) {
      if (!out.has(r.abs)) out.set(r.abs, new Set())
      out.get(r.abs).add(b)
    }
  }
  return out
}

/** 漂移集合的签名：同一批漂移只提示一次（Python 侧同名函数，当前未被调用，保留以便对齐）。 */
export function driftSignature(items) {
  const key = items.map((i) => `${i.abs}:${i.kind}:${i.actual_sha1 || ''}`).join('|')
  return sha1Bytes(Buffer.from(key, 'utf8'))
}

/** 剔除「已经报告过且磁盘内容未再变化」的项，并记录本次报告。 */
export function filterReported(d, items) {
  const st = readState(d)
  const reported = (st.reported !== null && typeof st.reported === 'object' && !Array.isArray(st.reported))
    ? st.reported : {}
  const fresh = []
  for (const i of items) {
    const sig = i.actual_sha1 || i.kind
    if (reported[i.abs] === sig) continue
    fresh.push(i)
    reported[i.abs] = sig
  }
  if (fresh.length > 0) {
    st.reported = reported
    st.last_report_at = now()
    writeState(d, st)
  }
  return fresh
}

// ── 命令实现 ────────────────────────────────────────────────────────────────────

/**
 * 运行期上下文（把 Python 的全局 process 状态显式化，便于插件内/测试内复用）。
 * root/cwd/env/stdin/out/err 全部可注入，命令实现里不直接摸 process。
 */
export function createIo(overrides = {}) {
  const env = overrides.env ?? process.env
  const cwd = overrides.cwd ?? process.cwd()
  return {
    root: stateRoot(overrides.root, env),
    env,
    cwd,
    out: overrides.out ?? ((text) => process.stdout.write(text)),
    err: overrides.err ?? ((text) => process.stderr.write(text)),
    readStdin: overrides.readStdin ?? readStdinBytes,
  }
}

let stdinCache
/** 一次性读全 stdin（字节）；不可读（如 TTY）返回 null，与 Python 的异常路径同效。 */
export function readStdinBytes() {
  if (stdinCache === undefined) {
    try {
      stdinCache = readFileSync(0)
    } catch {
      stdinCache = null
    }
  }
  return stdinCache
}

/** 打印一行（等价 Python print）。 */
function pr(io, text) {
  io.out(`${text}\n`)
}

/**
 * note <path>：记录「文件现在的状态 = 本会话期望的状态」。
 *
 * --prev-from -    从 stdin 读「写前内容」存副本（模型写文件前先喂旧内容）
 * --prev <sha1>    指定已存在的副本
 */
export function cmdNote(args, io) {
  const absPath = resolve(io.cwd, String(args.path))
  if (!existsSync(absPath)) {
    io.err(`note: 文件不存在：${absPath}（先创建再 note）\n`)
    return 2
  }
  if (isIgnored(absPath) && !args.force) {
    // 不拦截，只提醒：构建产物/日志这类噪音记进来会持续制造无意义告警
    io.err(`note: 提示 ${absPath} 属于默认忽略的噪音路径（构建产物/缓存/日志）；确实要守护请加 --force。\n`)
  }
  const root = repoRootOf(absPath, io.cwd)
  const sid = args.session || io.env.FILE_GUARD_SESSION || defaultSessionId(io.cwd)
  const d = newSessionDir(sid, root, io.root)

  let prevBlob = args.prev || null
  if (args.prevFrom === '-') {
    const data = io.readStdin()
    prevBlob = storeBlob(d, data)
  }
  const data = readBytes(absPath)
  if (data === null) {
    io.err(`note: 读不到内容：${absPath}\n`)
    return 2
  }
  const st = lstatPy(absPath)
  // 自动存一份「会话写下的内容」副本：它是恢复的唯一依据，也让被覆盖时能算出
  // 内容级差异（只存 prev 的话，没喂写前内容就既无法 diff 也无法恢复）。
  const goodBlob = storeBlob(d, data)
  const rec = {
    ts: now(),
    abs: absPath,
    path: relPath(absPath, root),
    root,
    op: args.op,
    tool: args.tool || 'cli',
    sha1: sha1Bytes(data),
    size: data.length,
    inode: st.ino,
    mtime: st.mtime,
    prev_blob: prevBlob,
    last_good_blob: goodBlob,
    note: args.message || '',
  }
  appendJournal(d, rec)
  // 本条已重新记录，清掉它的历史报告标记（下次再漂移要能再次提示）
  const stt = readState(d)
  const rep = (stt.reported !== null && typeof stt.reported === 'object' && !Array.isArray(stt.reported))
    ? stt.reported : {}
  if (Object.prototype.hasOwnProperty.call(rep, absPath)) {
    delete rep[absPath]
    stt.reported = rep
    writeState(d, stt)
  }
  if (args.quiet) return 0
  pr(io, `已记录 ${rec.path}  sha1=${pySlice(rec.sha1, 10)} size=${rec.size} `
    + `prev=${prevBlob ? '有' : '无'}`)
  return 0
}

/** check：比对 journal 与磁盘；无漂移静默，有漂移输出证据。 */
export function cmdCheck(args, io) {
  const d = resolveSession(args.session, io)
  if (d === null) {
    if (!args.quiet) pr(io, '本工作区没有守卫记录（journal 为空）：没有可校验的会话期望状态。')
    return 0
  }
  const items = collectDrift(d, args.path, io.cwd)
  if (args.json) {
    pr(io, JSON.stringify(items, null, 1))
    return 0
  }
  if (items.length === 0) {
    if (!args.quiet) pr(io, '守卫检查：所有已记录文件与磁盘一致（无漂移）。')
    return 0
  }
  pr(io, `守卫检查：发现 ${items.length} 处漂移（不自动改回，详情见 guard report）`)
  for (const i of items) {
    pr(io, `- [${i.kind}] ${i.path}`)
    pr(io, `    会话期望: sha1=${pySlice(pyStr(i.expected_sha1), 10)} size=${pyStr(i.expected_size)}`
      + `（${fmtClock(i.expected_at)} 由 ${pyStr(i.noted_by)} 记录）`)
    if (i.kind === 'changed') {
      pr(io, `    磁盘现状: sha1=${pySlice(pyStr(i.actual_sha1), 10)} size=${pyStr(i.actual_size)}`
        + `（mtime ${fmtClock(i.actual_mtime)}）`)
      pr(io, `    内容线索: ${pyStr(i.diff_hint)}`)
      pr(io, `    判定线索: 改动发生在记录之后=${pyBool(i.changed_after_note)}；`
        + `内容命中会话写过的版本=${pyBool(i.content_known_to_session)}`)
    } else if (i.kind === 'missing') {
      pr(io, '    磁盘现状: 文件已不存在')
    } else {
      pr(io, `    磁盘现状: ${i.kind}（不可按普通文件读取）`)
    }
    pr(io, `    可恢复性: ${i.recoverable ? '有写前副本，可 restore' : '无副本（只报告）'}`)
  }
  return items.length > 0 ? 1 : 0
}

/** report：完整时间线（某个路径或全部）的记录历史 + 当前漂移详情。 */
export function cmdReport(args, io) {
  const d = resolveSession(args.session, io)
  if (d === null) {
    pr(io, '没有守卫记录。')
    return 0
  }
  let records = readJournal(d)
  if (args.path) {
    const want = resolve(io.cwd, String(args.path))
    records = records.filter((r) => r.abs === want)
  }
  if (args.since !== null && args.since !== undefined) {
    records = records.filter((r) => (typeof r.ts === 'number' ? r.ts : 0) >= args.since)
  }
  pr(io, `会话状态目录: ${d}`)
  pr(io, `记录条数: ${records.length}`)
  for (const r of records) {
    const ts = typeof r.ts === 'number' ? r.ts : 0
    pr(io, `  ${fmtDateTime(ts)}  ${pyLjust(pyStr(r.op), 8)} ${pyStr(r.path)}`)
    pr(io, `      sha1=${pySlice(pyStr(r.sha1), 12)} size=${pyStr(r.size)}`
      + ` prev=${r.prev_blob ? '有' : '无'}`
      + (r.note ? ` 备注: ${r.note}` : ''))
  }
  const items = collectDrift(d, args.path, io.cwd)
  if (items.length > 0) {
    pr(io, `\n当前漂移 ${items.length} 处：`)
    for (const i of items) {
      pr(io, `- [${i.kind}] ${i.path}  期望 ${pySlice(pyStr(i.expected_sha1), 10)}`
        + ` → 实际 ${pySlice(pyStr(i.actual_sha1), 10)}`)
      if (i.diff_hint) pr(io, `    ${i.diff_hint}`)
      pr(io, `    改动在记录之后=${pyBool(i.changed_after_note)}`
        + ` 内容命中会话写过的版本=${pyBool(i.content_known_to_session)}`)
      if (i.recoverable) {
        pr(io, `    恢复命令: guard restore ${i.path} --to ${i.last_good_blob} --yes`)
      }
    }
  } else {
    pr(io, '\n当前无漂移。')
  }
  return 0
}

/**
 * restore：显式恢复：把某路径写回指定副本内容。默认拒绝（必须 --yes）。
 *
 * --to <sha1> 指定副本；--to last 取该路径最近一次 note 存下的「会话写下的内容」
 * 副本（比让人手抄 sha1 安全，也是报告里推荐的用法）。
 */
export function cmdRestore(args, io) {
  if (!args.yes) {
    io.err('restore 会覆盖磁盘上的当前版本（可能是更新的外部改动），必须显式加 --yes。\n')
    return 2
  }
  const d = resolveSession(args.session, io)
  if (d === null) {
    io.err('没有守卫记录。\n')
    return 2
  }
  const absPath = resolve(io.cwd, String(args.path))
  let to = args.to
  if (to === 'last') {
    const rec = latestByPath(readJournal(d)).get(absPath)
    to = rec?.last_good_blob ?? null
    if (!to) {
      io.err(`该路径没有可用副本（从未 note 或内容超限）：${absPath}\n`)
      return 2
    }
  }
  const data = blobBytes(d, to)
  if (data === null) {
    io.err(`副本不存在：${to}（未存储或已清理）\n`)
    return 2
  }
  const cur = readBytes(absPath)
  pr(io, `恢复目标: ${absPath}`)
  pr(io, `当前内容: sha1=${cur !== null ? pySlice(sha1Bytes(cur), 10) : '(不存在)'}`
    + ` size=${cur !== null ? cur.length : 0}`)
  pr(io, `恢复内容: sha1=${pySlice(String(to), 10)} size=${data.length}`)
  mkdirSync(dirname(absPath), { recursive: true })
  const tmp = `${absPath}.guard-restore.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, absPath)
  const root = repoRootOf(absPath, io.cwd)
  const stAfter = lstatPy(absPath)
  appendJournal(d, {
    ts: now(),
    abs: absPath,
    path: relPath(absPath, repoRootOf(absPath, io.cwd)),
    root,
    op: 'restore',
    tool: 'cli',
    sha1: sha1Bytes(data),
    size: data.length,
    inode: stAfter.ino,
    mtime: stAfter.mtime,
    prev_blob: storeBlob(d, cur),
    last_good_blob: to,
    note: `restore from ${pySlice(String(to), 10)}`,
  })
  pr(io, '已恢复（本次恢复动作已记入 journal）。')
  return 0
}

/** ack：豁免某路径（不再对它告警），用于「确认过的外部改动」。 */
export function cmdAck(args, io) {
  const d = resolveSession(args.session, io)
  if (d === null) {
    io.err('没有守卫记录。\n')
    return 2
  }
  const absPath = resolve(io.cwd, String(args.path))
  const st = readState(d)
  const ack = new Set(Array.isArray(st.ack) ? st.ack : [])
  if (args.remove) ack.delete(absPath)
  else ack.add(absPath)
  st.ack = [...ack].sort(cmpCodePoints)
  writeState(d, st)
  pr(io, `${args.remove ? '已取消豁免' : '已豁免'}：${absPath}`)
  return 0
}

/**
 * forget：有意让某路径不再受守护（例如会话自己删掉了它）。
 *
 * 写一条 op=forget 的墓碑记录，collectDrift 见到墓碑就跳过该路径；内容副本保留
 * （仍可用 restore --to <sha1> 找回），所以这是「停止守护」而不是「销毁证据」。
 */
export function cmdForget(args, io) {
  const d = resolveSession(args.session, io)
  if (d === null) {
    io.err('没有守卫记录。\n')
    return 2
  }
  const absPath = resolve(io.cwd, String(args.path))
  const root = repoRootOf(absPath, io.cwd)
  appendJournal(d, {
    ts: now(),
    abs: absPath,
    path: relPath(absPath, root),
    root,
    op: 'forget',
    tool: 'cli',
    sha1: '',
    size: 0,
    note: args.message || '有意解除守护',
  })
  pr(io, `已解除守护（不再对 ${absPath} 告警；副本仍保留）。`)
  return 0
}

/**
 * stop-hook：每轮收尾调用；无漂移静默放行，有漂移输出简短提示（不自动改回）。
 *
 * 会话定位优先 stdin payload 的 session_id（hook 侧最可靠），退回 resolve_session。
 * 任何一步异常都 fail-open（返回 0、不输出），绝不因守卫自身问题阻断会话。
 */
export function cmdStopHook(args, io) {
  let payload
  try {
    const raw = io.readStdin()
    payload = JSON.parse(raw === null || raw === undefined ? '' : raw.toString('utf8'))
  } catch {
    return 0 // 输入异常静默放行（fail-open，不能阻断会话）
  }
  let d
  const sidValue = (payload !== null && typeof payload === 'object' && !Array.isArray(payload))
    ? payload.session_id : undefined
  const sid = sidValue ? pyStr(sidValue) : ''
  if (sid) {
    d = join(io.root, sanitize(sid))
    if (!isFile(statePath(d)) && !isFile(journalPath(d))) {
      return 0 // 本会话没有守卫记录：不打扰
    }
  } else {
    d = resolveSession(null, io)
    if (d === null) return 0
  }
  try {
    const items = collectDrift(d, null, io.cwd)
    const fresh = filterReported(d, items)
    if (fresh.length === 0) return 0
    const short = shortNotice(fresh, d)
    writeReport(d, fresh)
    if (args.dsh) pr(io, pyJsonDumps({ decision: 'block', reason: short }))
    else pr(io, short)
  } catch {
    return 0 // 守卫自身异常绝不影响会话
  }
  return 0
}

/**
 * 简短提示：一行说清「哪些文件在会话写后又被改动」，并指向详细报告。
 *
 * 措辞只说事实，不替人或模型断定「一定是外部覆盖」：文件层无法区分
 * 「会话用别的方式写的（忘了 note）」与「外部进程/同步写的」。
 *
 * `opts.tag` 标明执行者（默认 `[file-guard]`，与 Python 侧逐字节一致；
 * DSH 插件传 `[dsh-file-guard]`）；`opts.detail` 覆盖「详情」指向（默认 Python CLI 命令，
 * DSH 插件传本次落盘的报告路径）。
 */
export function shortNotice(items, d, opts = {}) {
  const tag = typeof opts.tag === 'string' && opts.tag.length > 0 ? opts.tag : '[file-guard]'
  const detail = typeof opts.detail === 'string' && opts.detail.length > 0
    ? opts.detail
    : `python3 ~/.kimi-code/hooks/file_guard.py report --session ${basename(String(d))}`
  const names = items.slice(0, 4).map((i) => basename(String(i.path))).join('、')
  const more = items.length > 4 ? ` 等 ${items.length} 个` : ''
  const kinds = new Set(items.map((i) => i.kind))
  let verb = '状态异常'
  if (kinds.has('changed')) verb = '写入后又被改动'
  else if (kinds.has('missing')) verb = '不见了'
  const unknown = items.filter((i) => !i.content_known_to_session)
  const guess = unknown.length > 0 ? '（改动内容与守卫记录里的版本不同）' : ''
  const tail = items.some((i) => i.recoverable) ? '（有副本可恢复）' : '（无副本，仅报告）'
  return `${tag} ${names}${more} ${verb}${guess}。`
    + '请简短告知用户、不要自行改回（确为本会话所写可用 note 更新基线）；'
    + `详情 ${detail}${tail}`
}

/** 把本次报告落盘（reports/ 下按时间命名），只保留最近 50 份；返回本次报告路径。 */
export function writeReport(d, items) {
  const rdir = join(String(d), 'reports')
  mkdirSync(rdir, { recursive: true })
  const p = join(rdir, `${stampCompact(new Date())}.json`)
  writeFileSync(p, JSON.stringify({ at: now(), items }, null, 1), 'utf8')
  const files = readdirSync(rdir).filter((n) => n.endsWith('.json')).sort(cmpCodePoints)
  for (const f of files.slice(0, Math.max(0, files.length - 50))) {
    try {
      unlinkSync(join(rdir, f))
    } catch {
      /* 删除失败不影响主流程 */
    }
  }
  return p
}

// ── 时间格式化（对齐 Python time.strftime 的本地时间口径） ───────────────────────

const pad2 = (n) => String(n).padStart(2, '0')

/** '%H:%M:%S'（本地时区）。 */
export function fmtClock(ts) {
  const dt = new Date((typeof ts === 'number' ? ts : now()) * 1000)
  return `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`
}

/** '%Y-%m-%d %H:%M:%S'（本地时区）。 */
export function fmtDateTime(ts) {
  const dt = new Date((typeof ts === 'number' ? ts : 0) * 1000)
  return `${String(dt.getFullYear()).padStart(4, '0')}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
    + ` ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`
}

/** '%Y%m%d_%H%M%S'（本地时区，report 文件名用）。 */
export function stampCompact(dt) {
  return `${String(dt.getFullYear()).padStart(4, '0')}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}`
    + `_${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`
}

// ── fs 小工具 ───────────────────────────────────────────────────────────────────

/** 目录判定（跟随符号链接，等价 Python Path.is_dir）。 */
export function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 普通文件判定（跟随符号链接，等价 Python Path.is_file）。 */
export function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
