#!/usr/bin/env node
// @gavinc-cn/dsh-file-guard —— argv CLI（kimi 侧 file_guard.py 的命令行等价物）
//
// 与 Python 版的对应关系：
//   python3 ~/.kimi-code/hooks/file_guard.py <子命令> [参数...]
//   node    <pkg>/lib/cli.mjs                  <子命令> [参数...]
//
// 子命令、参数、stdout 文案、退出码逐一对齐（0=正常/无漂移，1=check 发现漂移，
// 2=用法错误或 restore 未加 --yes 等明确拒绝）。差异只在两处，均已记入 README：
//   * 用法/帮助文本里的 prog 名不同（dsh-file-guard vs file_guard.py）；
//   * argparse 的选项前缀缩写（--ses X）不支持。
//
// 之所以要 CLI：skill orca-file-guard 的所有动作（note/check/report/restore/ack/forget）
// 都靠命令行驱动；插件本身只负责每轮收尾的自动检查。

import { pathToFileURL } from 'node:url'
import {
  cmdAck, cmdCheck, cmdForget, cmdNote, cmdReport, cmdRestore, cmdStopHook, createIo,
} from './core.mjs'

const PROG = 'dsh-file-guard'

/** 子命令参数表：positionals=位置参数名（按序），options=选项 → 解析结果字段。 */
const SPECS = {
  note: {
    usage: 'note <path> [--op write] [--tool 工具名] [--prev-from -|--prev sha1] [--message 说明] [--force] [--quiet]',
    help: '记录「现在的状态 = 会话期望状态」',
    positionals: ['path'],
    options: {
      '--op': { key: 'op', kind: 'value', fallback: 'write' },
      '--tool': { key: 'tool', kind: 'value', fallback: null },
      '--prev-from': { key: 'prevFrom', kind: 'value', fallback: null },
      '--prev': { key: 'prev', kind: 'value', fallback: null },
      '--message': { key: 'message', kind: 'value', fallback: null },
      '--force': { key: 'force', kind: 'flag', fallback: false },
      '--quiet': { key: 'quiet', kind: 'flag', fallback: false },
    },
    run: cmdNote,
  },
  check: {
    usage: 'check [--path P] [--quiet] [--json]',
    help: '比对 journal 与磁盘',
    positionals: [],
    options: {
      '--path': { key: 'path', kind: 'value', fallback: null },
      '--quiet': { key: 'quiet', kind: 'flag', fallback: false },
      '--json': { key: 'json', kind: 'flag', fallback: false },
    },
    run: cmdCheck,
  },
  report: {
    usage: 'report [--path P] [--since T]',
    help: '时间线与哈希对照',
    positionals: [],
    options: {
      '--path': { key: 'path', kind: 'value', fallback: null },
      '--since': { key: 'since', kind: 'float', fallback: null },
    },
    run: cmdReport,
  },
  restore: {
    usage: 'restore <path> --to <sha1|last> [--yes]',
    help: '显式恢复（必须 --yes）',
    positionals: ['path'],
    options: {
      '--to': { key: 'to', kind: 'value', fallback: null, required: true },
      '--yes': { key: 'yes', kind: 'flag', fallback: false },
    },
    run: cmdRestore,
  },
  ack: {
    usage: 'ack <path> [--remove]',
    help: '豁免路径（不再告警）',
    positionals: ['path'],
    options: {
      '--remove': { key: 'remove', kind: 'flag', fallback: false },
    },
    run: cmdAck,
  },
  forget: {
    usage: 'forget <path> [--message 说明]',
    help: '解除守护（例如自己删掉了该文件）',
    positionals: ['path'],
    options: {
      '--message': { key: 'message', kind: 'value', fallback: null },
    },
    run: cmdForget,
  },
  'stop-hook': {
    usage: 'stop-hook [--dsh]',
    help: '每轮收尾检查（hook 调用）',
    positionals: [],
    options: {
      '--dsh': { key: 'dsh', kind: 'flag', fallback: false },
    },
    run: cmdStopHook,
  },
}

const CMD_NAMES = Object.keys(SPECS)

/** 用法错误（argparse 口径：stderr + exit 2）。 */
class UsageError extends Error {}

/** 主帮助文本。 */
function mainHelp() {
  const lines = [
    `usage: ${PROG} [-h] [--session SESSION] {${CMD_NAMES.join(',')}} ...`,
    '',
    '会话文件守卫：记录会话写下的文件状态，收尾检查是否被外部覆盖/回退',
    '',
    '子命令:',
  ]
  for (const n of CMD_NAMES) lines.push(`  ${n.padEnd(10)} ${SPECS[n].help}`)
  lines.push('', `选项:`, '  -h, --help           显示帮助', '  --session SESSION    会话 id（默认按工作区自动定位）')
  return lines.join('\n')
}

/** 单个子命令的帮助文本。 */
function subHelp(name) {
  const spec = SPECS[name]
  return `usage: ${PROG} [--session SESSION] ${spec.usage}\n\n${spec.help}\n\n`
    + `选项:\n  -h, --help  显示帮助\n  --session SESSION  会话 id（默认按工作区自动定位）`
}

/**
 * 解析 argv。
 *
 * 与 argparse 的关键行为对齐：`--session` 同时支持写在子命令前/后（Python 侧用
 * default=SUPPRESS 的 parent parser 解决，这里用「先全局摘出 --session 再定位子命令」解决）；
 * `--opt value` 与 `--opt=value` 两种写法都支持；`--` 之后全部按位置参数。
 *
 * @returns {{ok:true, cmd:string, args:object} | {ok:true, help:string} | {ok:false, message:string}}
 */
export function parseArgs(argv) {
  let cmd = null
  let session = null
  const queue = []
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]
    if (tok === '-h' || tok === '--help') {
      // argparse：帮助在任何位置都立即生效；子命令已知时给子命令帮助
      return { ok: true, help: cmd === null ? mainHelp() : subHelp(cmd) }
    }
    if (tok === '--session' || tok.startsWith('--session=')) {
      let value
      if (tok === '--session') {
        value = argv[i + 1]
        if (value === undefined) return { ok: false, message: 'argument --session: expected one argument' }
        i += 1
      } else {
        value = tok.slice('--session='.length)
      }
      session = value
      continue
    }
    if (cmd === null && !tok.startsWith('-')) {
      cmd = tok
      continue
    }
    queue.push(tok)
  }
  if (cmd === null) {
    return { ok: false, message: `the following arguments are required: cmd（可选：${CMD_NAMES.join(', ')}）` }
  }
  const spec = SPECS[cmd]
  if (spec === undefined) {
    return { ok: false, message: `argument cmd: invalid choice: '${cmd}' (choose from ${CMD_NAMES.map((n) => `'${n}'`).join(', ')})` }
  }
  let parsed
  try {
    parsed = parseSub(cmd, spec, queue)
  } catch (error) {
    if (error instanceof UsageError) return { ok: false, message: error.message }
    throw error
  }
  const args = { cmd, session, ...parsed }
  return { ok: true, cmd, args }
}

/** 解析子命令自身的参数队列。 */
function parseSub(cmd, spec, queue) {
  const out = {}
  for (const [name, opt] of Object.entries(spec.options)) out[opt.key] = opt.fallback
  const positionals = []
  let onlyPositional = false
  for (let i = 0; i < queue.length; i += 1) {
    const tok = queue[i]
    if (!onlyPositional && tok === '--') {
      onlyPositional = true
      continue
    }
    if (!onlyPositional && tok.startsWith('--')) {
      let name = tok
      let inline = null
      const eq = tok.indexOf('=')
      if (eq > 0) {
        name = tok.slice(0, eq)
        inline = tok.slice(eq + 1)
      }
      const opt = spec.options[name]
      if (opt === undefined) throw new UsageError(`unrecognized arguments: ${tok}`)
      if (opt.kind === 'flag') {
        if (inline !== null) throw new UsageError(`argument ${name}: ignored explicit argument '${inline}'`)
        out[opt.key] = true
        continue
      }
      let value = inline
      if (value === null) {
        value = queue[i + 1]
        if (value === undefined) throw new UsageError(`argument ${name}: expected one argument`)
        i += 1
      }
      if (opt.kind === 'float') {
        const n = Number(value)
        if (value.trim().length === 0 || Number.isNaN(n)) {
          throw new UsageError(`argument ${name}: invalid float value: '${value}'`)
        }
        out[opt.key] = n
      } else {
        out[opt.key] = value
      }
      continue
    }
    if (!onlyPositional && tok.startsWith('-') && tok !== '-') {
      throw new UsageError(`unrecognized arguments: ${tok}`)
    }
    positionals.push(tok)
  }
  for (const opt of Object.values(spec.options)) {
    if (opt.required === true && (out[opt.key] === null || out[opt.key] === undefined)) {
      const name = Object.keys(spec.options).find((k) => spec.options[k] === opt)
      throw new UsageError(`the following arguments are required: ${name}`)
    }
  }
  if (positionals.length < spec.positionals.length) {
    const missing = spec.positionals.slice(positionals.length)
    throw new UsageError(`the following arguments are required: ${missing.join(', ')}`)
  }
  if (positionals.length > spec.positionals.length) {
    throw new UsageError(`unrecognized arguments: ${positionals.slice(spec.positionals.length).join(' ')}`)
  }
  spec.positionals.forEach((name, idx) => { out[name] = positionals[idx] })
  return out
}

/**
 * CLI 入口。
 *
 * 注意：命令实现里的异常**不**在这里吞掉（Python 的 main 同样不捕获，未捕获异常以
 * 退出码 1 + 栈信息结束，例如会话目录不存在时的 ack/forget）。
 *
 * @param {string[]} argv 不含 node/脚本名的参数
 * @param {object} [ioOverrides] 运行期覆盖（root/cwd/env/stdout/stderr/stdin），测试用
 * @returns {number} 退出码
 */
export function main(argv = process.argv.slice(2), ioOverrides = {}) {
  const io = createIo(ioOverrides)
  const parsed = parseArgs(argv)
  if (parsed.ok !== true) {
    io.err(`usage: ${PROG} [-h] [--session SESSION] {${CMD_NAMES.join(',')}} ...\n`)
    io.err(`${PROG}: error: ${parsed.message}\n`)
    return 2
  }
  if (parsed.help !== undefined) {
    io.out(`${parsed.help}\n`)
    return 0
  }
  return SPECS[parsed.cmd].run(parsed.args, io)
}

// 直接执行（node lib/cli.mjs …）时跑 main；被 import 时只导出。
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}
