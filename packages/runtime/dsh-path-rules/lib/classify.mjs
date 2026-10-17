// dsh-path-rules 的工具映射层（纯函数）：工具名 + 参数 → 读写意图与目标。
//
// 只处理 spec §5.2 表里的工具；**其余一切工具一律返回 {kind:'pass'}（透传）**：
// 未受控工具若自行写盘，本闸门覆盖不到，这是 spec §9-2 的已知盲区，
// 不能靠"猜一个读写意图"来假装覆盖。

/** 取 file_path 的读工具。 */
const READ_FILE_TOOLS = new Set(['read', 'read_image'])
/** 取 file_path 的写工具。 */
const WRITE_FILE_TOOLS = new Set(['write', 'edit'])
/** 取 path（可缺省为会话 cwd）的搜索工具。 */
const SEARCH_TOOLS = new Set(['glob', 'grep'])
/** bash 里 workdir 的候选参数名（bash 工具有 workdir，部分调用用 cwd）。 */
const WORKDIR_KEYS = ['workdir', 'cwd']

/** 非空字符串判定：类型不符或空白一律当"不可用"。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 统一的 pass 结果。 */
function pass() {
  return { kind: 'pass' }
}

/**
 * 把一个工具调用映射成读写意图。
 *
 * @param name - 工具名（大小写不敏感）。
 * @param args - 工具参数（工具自身会做 schema 校验，这里只做保守提取）。
 * @returns {kind:'pass'}
 *        | {kind:'read'|'write', targets:string[]}
 *        | {kind:'shell', command:string, workdir:string, shell:'bash'|'pwsh'}
 *   `targets` 为空数组表示"没有显式路径"（搜索工具的 path 缺省 = 会话 cwd，由调用方补）。
 */
export function classifyTool(name, args) {
  const tool = String(name ?? '').toLowerCase()
  const a = args !== null && typeof args === 'object' ? args : {}
  if (READ_FILE_TOOLS.has(tool) || WRITE_FILE_TOOLS.has(tool)) {
    const target = nonEmptyString(a['file_path'])
    if (target === undefined) return pass()
    return { kind: READ_FILE_TOOLS.has(tool) ? 'read' : 'write', targets: [target] }
  }
  if (SEARCH_TOOLS.has(tool)) {
    const raw = a['path']
    if (raw !== undefined && nonEmptyString(raw) === undefined) return pass()
    const target = nonEmptyString(raw)
    return { kind: 'read', targets: target === undefined ? [] : [target] }
  }
  if (tool === 'str_replace_editor') {
    const command = nonEmptyString(a['command'])
    const target = nonEmptyString(a['path'])
    if (command === undefined || target === undefined) return pass()
    return { kind: command === 'view' ? 'read' : 'write', targets: [target] }
  }
  if (tool === 'bash' || tool === 'pwsh') {
    const command = nonEmptyString(a['command'])
    if (command === undefined) return pass()
    let workdir = ''
    if (tool === 'bash') {
      for (const key of WORKDIR_KEYS) {
        const value = nonEmptyString(a[key])
        if (value !== undefined) {
          workdir = value
          break
        }
      }
    }
    return { kind: 'shell', command, workdir, shell: tool === 'bash' ? 'bash' : 'pwsh' }
  }
  return pass()
}
