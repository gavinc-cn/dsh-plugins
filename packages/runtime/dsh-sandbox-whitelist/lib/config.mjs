// dsh-sandbox-whitelist 的配置归一化（纯函数，不依赖宿主服务）。
//
// 设计约束（spec §配置）：
//   - 本包是 **sandbox provider 替换件**：没有 `enabled` 开关——停用请把 bundle/profile 里的
//     本行 `disabled: true` 并恢复官方 `- id: sandbox`（provider 缺失会让 bash/权限档一起级联消失，
//     不能靠一个"软关闭"配置兜底）。
//   - 白名单里的路径必须是绝对路径（支持 `~`）；不存在/非法的根在 confine 时剔除（Landlock 对
//     不存在的规则路径会整条 fail-closed）。
//   - `enforcePresets: []` 表示"所有预设都生效"；默认只对 `path-rules` 生效（该档本来就是
//     `workspace-write`，白名单根从"纸面规则"变成"内核可写根"）。
//
// 边界：不读文件、不访问宿主，只做校验/展开/默认值；路径的 canonical 化与存在性检查在
// lib/index.mjs 的 confine 阶段做（那里才拿得到真实文件系统与 internals 注入点）。

import { isAbsolute } from 'node:path'

import { expandHome } from './roots.mjs'

/** 默认配置（与 README/spec 的配置表保持同步）。 */
export const DEFAULT_CONFIG = Object.freeze({
  enforcePresets: ['path-rules'],
  whitelist: [],
  autoWhitelistFiles: [],
  probeTimeoutMs: 5000,
})

/**
 * 构造带字段名的配置错误（fail-fast 拒绝加载，沿用仓库其它插件的 `配置项 ...` 口径）。
 *
 * @param field - 配置键名。
 * @param detail - 期望/实际说明。
 * @returns {Error} 配置错误。
 */
function configError(field, detail) {
  return new Error(`dsh-sandbox-whitelist: 配置项 ${field} ${detail}`)
}

/**
 * 归一化一组"路径字符串"配置：必须是字符串数组、每项非空白；展开 `~` 后必须绝对路径。
 *
 * @param value - 原始值（缺省 = 空数组）。
 * @param field - 字段名（错误信息用）。
 * @returns {string[]} 展开后的绝对路径列表。
 */
function normalizePathList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw configError(field, '必须是字符串数组')
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw configError(field, `的每一项必须是非空字符串（实际 ${JSON.stringify(item)}）`)
    }
    const expanded = expandHome(item.trim())
    if (!isAbsolute(expanded)) throw configError(field, `的路径必须是绝对路径（实际 ${expanded}）`)
    return expanded
  })
}

/**
 * 归一化配置：校验 + 补默认值；不做文件系统访问。
 *
 * @param rawConfig - profile 覆盖行给的 config（可为空/undefined）。
 * @returns {{enforcePresets:string[], whitelist:string[], autoWhitelistFiles:string[], probeTimeoutMs:number}}
 */
export function normalizeConfig(rawConfig) {
  const raw = rawConfig ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw configError('(根)', '必须是对象')

  const enforcePresets = raw.enforcePresets === undefined ? [...DEFAULT_CONFIG.enforcePresets] : raw.enforcePresets
  if (!Array.isArray(enforcePresets)) throw configError('enforcePresets', '必须是字符串数组（空数组 = 所有预设）')
  const presets = enforcePresets.map((preset) => {
    if (typeof preset !== 'string' || preset.trim().length === 0) {
      throw configError('enforcePresets', `的每一项必须是非空字符串（实际 ${JSON.stringify(preset)}）`)
    }
    return preset.trim()
  })

  const whitelist = normalizePathList(raw.whitelist, 'whitelist')
  const autoWhitelistFiles = normalizePathList(raw.autoWhitelistFiles, 'autoWhitelistFiles')

  const probeTimeoutMs = raw.probeTimeoutMs === undefined ? DEFAULT_CONFIG.probeTimeoutMs : raw.probeTimeoutMs
  // 0 会被 spawnSync 当成"无超时"（与字段承诺相反），因此只接受正有限数。
  if (typeof probeTimeoutMs !== 'number' || !Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) {
    throw configError('probeTimeoutMs', `必须是正有限数（实际 ${JSON.stringify(probeTimeoutMs)}）`)
  }

  return { enforcePresets: presets, whitelist, autoWhitelistFiles, probeTimeoutMs }
}
