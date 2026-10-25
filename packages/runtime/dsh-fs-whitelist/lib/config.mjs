// dsh-fs-whitelist 的配置归一化（纯函数，不依赖宿主服务）。
//
// 设计约束（README「配置」表）：
//   - 本包是 **ctx.fs provider 替换件**：没有 `enabled` 软开关——停用请把 profile/bundle 里本行
//     改回 `disabled: true` 并恢复官方 `- id: fs-sandbox`（fs service 缺失会让 read/write/edit
//     工具级联消失，不能靠一个"软关闭"配置兜底）。
//   - 白名单里的路径必须是绝对路径（支持 `~`）；不存在/非法的根在 lib/index.mjs 的
//     extraRootsFor 阶段剔除（那里才拿得到真实文件系统与 internals 注入点）。
//   - `enforcePresets: []` 表示"所有 workspace-write 会话"；默认只对 `path-rules` 生效
//     （该档本来就是 workspace-write；白名单根从"纸面规则"变成 fs fence 的实际可写根）。
//
// 边界：不读文件、不访问宿主，只做校验/展开/默认值；坏值一律 fail-fast（配置错 = 加载错，
// 不能静默降级成"没有白名单"却看起来像生效）。

import { isAbsolute } from 'node:path'

import { dedupePaths, expandHome } from '@gavinc-cn/dsh-sandbox-whitelist/roots'

/** 默认配置（与 README 的配置表保持同步）。 */
export const DEFAULT_CONFIG = Object.freeze({
  enforcePresets: ['path-rules'],
  whitelist: [],
  autoWhitelistFiles: [],
})

/**
 * 构造带字段名的配置错误（fail-fast 拒绝加载，沿用仓库其它插件的 `配置项 ...` 口径）。
 *
 * @param field - 配置键名（路径数组要带下标，如 `whitelist[1]`）。
 * @param detail - 期望/实际说明。
 * @returns {Error} 配置错误。
 */
function configError(field, detail) {
  return new Error(`dsh-fs-whitelist: 配置项 ${field} ${detail}`)
}

/**
 * 归一化一组"路径字符串"配置：必须是字符串数组、每项非空白；展开 `~` 后必须是绝对路径；
 * 最后保序去重。
 *
 * @param value - 原始值（缺省 = 空数组）。
 * @param field - 字段名（错误信息用）。
 * @returns {string[]} 展开后的绝对路径列表（保序去重）。
 */
function normalizePathList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw configError(field, '必须是字符串数组')
  const paths = value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw configError(`${field}[${index}]`, `必须是非空字符串（实际 ${JSON.stringify(item)}）`)
    }
    const expanded = expandHome(item.trim())
    if (!isAbsolute(expanded)) throw configError(`${field}[${index}]`, `必须是绝对路径：${expanded}`)
    return expanded
  })
  return dedupePaths(paths)
}

/**
 * 归一化配置：校验 + 补默认值 + 去重；不做文件系统访问。
 *
 * @param rawConfig - profile 覆盖行给的 config（可为空/undefined）。
 * @returns {{enforcePresets:string[], whitelist:string[], autoWhitelistFiles:string[]}}
 */
export function normalizeConfig(rawConfig) {
  const raw = rawConfig ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw configError('(根)', '必须是对象')

  const enforcePresets =
    raw.enforcePresets === undefined ? [...DEFAULT_CONFIG.enforcePresets] : raw.enforcePresets
  if (!Array.isArray(enforcePresets)) {
    throw configError('enforcePresets', '必须是字符串数组（空数组 = 所有 workspace-write 会话）')
  }
  const presets = enforcePresets.map((preset, index) => {
    if (typeof preset !== 'string' || preset.trim().length === 0) {
      throw configError(`enforcePresets[${index}]`, `必须是非空字符串（实际 ${JSON.stringify(preset)}）`)
    }
    return preset.trim()
  })

  const whitelist = normalizePathList(raw.whitelist, 'whitelist')
  const autoWhitelistFiles = normalizePathList(raw.autoWhitelistFiles, 'autoWhitelistFiles')

  // 未知键忽略（例如误抄官方 fs-sandbox 的 cwd/diffBasisMaxBytes：本包不支持在配置里改，
  // 见 lib/index.mjs 构造函数的说明）。
  return { enforcePresets: presets, whitelist, autoWhitelistFiles }
}
