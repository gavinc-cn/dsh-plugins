// 白名单根的纯工具：`~` 展开、自动白名单文件解析、去重与存在性过滤。
//
// 设计约束：
//   - 自动白名单文件是**其它插件**（`dsh-path-rules` / `dsh-write-guard`）写的状态文件，格式
//     固定为 `{version:1, entries:[{path, platform, ...}]}`；这里只读、只按运行平台过滤，
//     任何缺失/坏 JSON/形状不符都返回空数组（不抛错——白名单缺失不能让每条命令都失败）。
//   - 不做 realpath/canonical 化：那是 confine 阶段（lib/index.mjs）用宿主 `canonicalPath` 做的，
//     本模块保持纯函数、可在单测里用假文件验证。

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 展开 `~` / `~/x`（Shell 风格），其它路径原样返回。
 *
 * 只认当前用户的 home（不做 `~user` 展开：白名单是绝对路径配置，`~user` 语义模糊且跨平台不一致）。
 *
 * @param path - 原始路径文本。
 * @returns 展开后的路径。
 */
export function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 保序去重（剔除空值/非字符串），避免重复的 `--rw`/`--bind`。
 *
 * @param paths - 路径数组（可含空值）。
 * @returns 去重后的路径数组。
 */
export function dedupePaths(paths) {
  const seen = new Set()
  const out = []
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path !== 'string' || path.length === 0 || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/**
 * 按存在性拆分路径（Landlock 对不存在的规则路径会整条 fail-closed，必须先过滤）。
 *
 * @param paths - 待检查路径。
 * @param exists - 存在性判定（默认 `existsSync`；单测可注入）。
 * @returns {{usable:string[], missing:string[]}}
 */
export function splitExisting(paths, exists = existsSync) {
  const usable = []
  const missing = []
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path !== 'string' || path.length === 0) continue
    ;(exists(path) ? usable : missing).push(path)
  }
  return { usable, missing }
}

/**
 * 读取一个自动白名单状态文件，返回本平台可用的路径列表。
 *
 * 坏文件/缺文件/形状不符一律返回空数组：这是"锦上添花"的输入，不是判定依据。
 *
 * @param file - 状态文件绝对路径。
 * @param platform - 平台过滤依据（`process.platform` 的取值）。
 * @returns {string[]} 本平台条目里的路径（保序去重）。
 */
export function loadAutoWhitelistPaths(file, platform) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    const paths = []
    for (const entry of entries) {
      if (typeof entry?.path !== 'string' || entry.path.length === 0) continue
      if (entry.platform !== platform) continue
      paths.push(entry.path)
    }
    return dedupePaths(paths)
  } catch {
    return []
  }
}
