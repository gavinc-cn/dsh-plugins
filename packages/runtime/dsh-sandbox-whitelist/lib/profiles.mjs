// 平台 argv 构造（纯函数）：把一次 policy + 白名单根翻译成 bwrap / Landlock 的隔离参数。
//
// 设计约束：
//   - **形状必须与官方 `@deepseek-ai/dsh-sandbox-local` 对齐**（bwrap 基础挂载、workspace-write
//     的 `--tmpfs /tmp` + `--bind <ws> <ws>`、`/dev/null` 读写），只**多出**白名单根的 `--bind` /
//     `--rw`；形状漂移会让隔离语义和官方不一致（这里刻意不 import 官方私有构建器：官方只导出
//     `LocalSandboxProvider` 类，`bwrapProfileArgs`/`landlockProfileArgs` 是模块私有的；本文件
//     在单测里逐字对齐官方形状，升级时对照官方 `lib/index.js` 的 `*ProfileArgs` 即可）。
//   - 不读文件系统、不做 canonical 化、不 spawn：`lib/index.mjs` 传入的根已经 canonical + 存在性
//     过滤；本模块只在单测里被逐参数断言。
//   - bwrap 下 `/tmp` 是私有 tmpfs（官方语义），因此不把 `/tmp` 再 bind 成宿主目录；`/dev/null`
//     由 `--dev /dev` 提供，也不重复 `--bind`。

import { tmpdir } from 'node:os'

import { dedupePaths } from './roots.mjs'

/** bwrap 的基础只读挂载（与官方 `bwrapProfileArgs` 完全一致）。 */
const BWRAP_BASE = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']

/**
 * 构造 bwrap 的 profile 参数（`--` 与命令 argv 之前的部分）。
 *
 * @param policy - `{mode, workspaceRoot}`（workspaceRoot 已 canonical）。
 * @param extraRoots - 额外的白名单根（已 canonical、已过滤存在性）。
 * @returns {string[]} bwrap 参数数组。
 */
export function bwrapProfileArgs(policy, extraRoots = []) {
  const args = [...BWRAP_BASE]
  // 已经由基础挂载/私有 tmpfs 覆盖的根，不重复 bind。
  const covered = new Set(['/tmp', '/dev/null'])
  if (policy?.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
    covered.add(policy.workspaceRoot)
  }
  for (const root of Array.isArray(extraRoots) ? extraRoots : []) {
    if (typeof root !== 'string' || root.length === 0 || covered.has(root)) continue
    covered.add(root)
    args.push('--bind', root, root)
  }
  return args
}

/**
 * 构造 Landlock 的可写根列表（`--rw` 的入参；`--ro /` 由调用方固定）。
 *
 * workspace-write 的官方口径（`writableRoots`）= workspaceRoot + `/tmp` + `os.tmpdir()`；
 * 这里在它之后追加白名单根。read-only 只保留 `/dev/null`（写标准流不是文件写入）。
 *
 * @param policy - `{mode, workspaceRoot}`（workspaceRoot 已 canonical）。
 * @param extraRoots - 额外的白名单根（已 canonical、已过滤存在性）。
 * @returns {string[]} 可写根数组（保序去重）。
 */
export function landlockReadWriteRoots(policy, extraRoots = []) {
  const roots = ['/dev/null']
  if (policy?.mode === 'workspace-write') roots.push(policy.workspaceRoot, '/tmp', tmpdir())
  else return dedupePaths(roots)
  return dedupePaths([...roots, ...(Array.isArray(extraRoots) ? extraRoots : [])])
}
