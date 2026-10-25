// fs fence 的词法包含判定（纯函数，无文件系统访问）。
//
// 语义：target 等于 root，或以 `root + path.sep` 开头 = 「在 root 之下」。
//
// 这是**词法**判定：调用方传进来的 targetKey 已经 canonical 化（`this.resolve()` 会 realpath
// 最深的已存在祖先），白名单根也由本包的 `canonicalPath()` 产生，两边拼写同源，因此不需要
// 官方 `dsh-fs-sandbox` 里 dev/ino 的文件系统身份兜底。少掉的兜底只影响"更保守"的方向
// （Windows 8.3 别名/大小写差异的极少数拼写会少放行一次，落回官方 deny + 升权链），
// 不会把不在白名单里的路径误判成可写。
//
// 边界：本判定是 trusted-code fence 的一部分，**不是内核边界**（见 lib/index.mjs 文件头）。

import { sep } from 'node:path'

/**
 * 按大小写语义取比较用的拼写。
 *
 * @param path - 已 canonical 的路径。
 * @param caseSensitive - 是否保留大小写。
 * @returns {string} 比较用拼写。
 */
function comparablePath(path, caseSensitive) {
  return caseSensitive ? path : path.toLowerCase()
}

/**
 * 判断 target 是否等于 root 或位于 root 之下（纯词法）。
 *
 * @param target - 已 canonical 的目标路径（`FsTarget.targetKey`）。
 * @param root - 已 canonical 的可写根。
 * @param caseSensitive - 是否大小写敏感；默认按宿主平台约定（win32 不敏感）。
 * @returns {boolean} 在 root 之下（含相等）返回 true；非法输入返回 false（不抛）。
 */
export function isUnder(target, root, caseSensitive = process.platform !== 'win32') {
  if (typeof target !== 'string' || typeof root !== 'string' || root.length === 0) return false
  const comparableTarget = comparablePath(target, caseSensitive)
  const comparableRoot = comparablePath(root, caseSensitive)
  if (comparableTarget === comparableRoot) return true
  // root 以分隔符结尾（含文件系统根 `/`）时不能拼出 `//`：直接拿它当前缀。
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep
  return comparableTarget.startsWith(prefix)
}
