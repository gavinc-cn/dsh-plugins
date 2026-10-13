// 沙箱路径白名单插件 (零依赖, 纯 ESM): 对配置目录内的 write/edit 沙箱升权自动放行,
// 在 Web 弹框 answerer 之前短路 approval/request 瀑布, 用户不再收到弹框。
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

export const name = 'sandbox-path-allowlist'
export const inject = ['approval']

const ESCALATION_PREFIX = 'escalate sandbox to '

function comparable(path, caseSensitive) {
  return caseSensitive ? path : path.toLowerCase()
}

// 词法包含判断: 目标等于根或位于根之下 (同名前缀的兄弟目录不算)。
function pathUnderRoot(target, root, caseSensitive = process.platform !== 'win32') {
  const t = comparable(target, caseSensitive)
  const r = comparable(root, caseSensitive)
  if (t === r) return true
  const boundary = r.endsWith(sep) ? r : r + sep
  return t.startsWith(boundary)
}

// 粗粒度子串扫描: 命令文本里提到配置根目录即放行 (仅 allowShell 开启时用)。
function commandMentionsRoot(command, root, caseSensitive = process.platform !== 'win32') {
  return comparable(command, caseSensitive).includes(comparable(root, caseSensitive))
}

// 规范化: 解析符号链接; 路径不存在时原样返回 (保守)。
function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

function fileTarget(raw, cwd) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw)
  return canonical(absolute)
}

// 从 tool/call 事件的 JSON 参数里提取目标: write/edit 取 file_path, bash/pwsh 取 command (需 allowShell)。
function targetOfCall(event, cwd, allowShell) {
  let args
  try {
    args = JSON.parse(event.data.arguments)
  } catch {
    return undefined
  }
  if (typeof args !== 'object' || args === null) return undefined
  switch (event.data.name) {
    case 'write':
    case 'edit': {
      const p = fileTarget(args['file_path'], cwd)
      return p === undefined ? undefined : { kind: 'file', path: p }
    }
    case 'bash':
    case 'pwsh': {
      if (!allowShell) return undefined
      const text = args['command']
      return typeof text === 'string' && text.trim().length > 0 ? { kind: 'command', text } : undefined
    }
    default:
      return undefined
  }
}

// 按 callId 在会话日志里找到最新一条 tool/call 事件。
function escalationTarget(session, callId, allowShell) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (!event || event.type !== 'tool/call' || event.data.callId !== callId) continue
    return targetOfCall(event, session.header.cwd, allowShell)
  }
  return undefined
}

function grantFor(target, roots) {
  if (target.kind === 'file') return roots.some((root) => pathUnderRoot(target.path, root))
  return roots.some((root) => commandMentionsRoot(target.text, root))
}

function renderContext(roots, allowShell) {
  const sentence = `Sandbox escalation for file targets under these directories is pre-authorized: ${roots.join(', ')}. `
    + 'When a write or edit under one of them would be denied by the file sandbox, call the tool with sandbox_permissions and a justification; '
    + "the approval resolves automatically when the call's file target lies under a pre-authorized directory, so no user prompt appears."
  return allowShell
    ? `${sentence} Shell commands that mention a pre-authorized directory are pre-authorized as well.`
    : sentence
}

export function apply(ctx, config) {
  const paths = (config && config.paths) || []
  if (paths.length === 0) throw new Error('sandbox-path-allowlist: paths must name at least one absolute directory')
  const roots = paths.map((path) => {
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw new Error(`sandbox-path-allowlist: path must be absolute, got ${JSON.stringify(path)}`)
    }
    return canonical(path)
  })
  const allowShell = config.allowShell === true

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'sandbox:path-allowlist',
      order: 111,
      text: (context) => (context.agent === undefined ? '' : renderContext(roots, allowShell)),
    })
  })

  ctx.on('approval/request', (request, next) => {
    if (request.callId === undefined) return next()
    if (request.reason === undefined || !request.reason.startsWith(ESCALATION_PREFIX)) return next()
    const target = escalationTarget(request.agent.session, request.callId, allowShell)
    if (target === undefined) return next()
    return grantFor(target, roots) ? 'allowed-once' : next()
  }, { prepend: true })
}
