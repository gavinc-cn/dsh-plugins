// dsh-sandbox-whitelist 插件接线：用「多根版」本地沙箱 provider 顶替官方
// `- id: sandbox`（cordis service，同名只能有一个 provider）。
//
// 目的：把「项目根 + 显式白名单 + 自动学习白名单 + 临时区」变成执行层真正可写的根（Linux 内核级、
// Windows ACL 级），其余路径只读；命令级闸门（path-rules / write-guard）的判定由此落到执行层，
// TOCTOU 与静态分析盲区有底层兜底。
//
// 架构（2026-10-24 v0.2.0 起跨平台）：
//   * 继承官方 `@deepseek-ai/dsh-sandbox-local` 的 `LocalSandboxProvider`，复用它成熟的
//     平台链选择/探测/结果分类/授权缓存：
//       Linux   = bwrap（优先）→ Landlock；
//       Windows = windows-acl（受限令牌 + 写权限 SID，enforcement=partial）；
//       macOS   = 不支持（apply 期直接拒绝加载，避免 provider 半可用）。
//   * 只覆写两处：
//       ① `runnerArgv()`：Linux 在官方 profile 参数上追加白名单根的 `--bind` / `--rw`；
//          Windows 用官方 argv（`--workspace/--temp/--write-sid/--temp-write-sid`）不变，另把
//          白名单目录的 **workspace 写 SID ACE** 预授予（`AclWriteGrant.add(dir, standing=true)`）——
//          受限令牌本来就携带该 SID，因此不需要改官方 runner 的 CLI；
//       ② `confine()`：拒绝 `danger-full-access`（调用方应先短路，不做"静默不隔离"降级）。
//   * 白名单根的过滤：read-only 不追加；预设不命中不追加；不存在/不是目录的根跳过（warn 一次）。
//     自动白名单文件逐次读取：审批学习的新目录下一次 confine 即生效（Windows 侧为"下一次命令前
//     补授权"，同样是逐次）。
//
// Windows 语义与边界（务必读）：
//   * 追加授权用的是**该 workspace 的 standing 写 SID**（与官方 workspace 根同一身份），ACE 标记为
//     standing ⇒ 与官方 workspace 根一样是跨重启复用的缓存：**从白名单配置里移除某个目录不会自动
//     撤销已授予的 ACE**（ACE 只是让该 SID 可写；别的 workspace 的 token 不携带它 ⇒ 不影响隔离；
//     彻底回收需手动清理 ACL 或换 workspace 路径）。新增/学习目录会补授权，属增量语义。
//   * `AclWriteGrant.add()` 首次会给整棵树传播继承 ACE（官方文档：大目录可能耗时数分钟）；白名单
//     建议用较窄目录。授权失败（无 owner/WRITE_OWNER 等）只 warn 跳过该根，命令仍在官方
//     workspace+temp 范围内受限执行（不会因此变成未隔离）。
//   * 跳过与工作区/系统临时目录重叠的根：授予 workspace SID 会让该 workspace 的所有会话可写这些
//     树，且与 private temp capability 重叠会出现 capability 混用。
//
// 生效链路（profile/bundle 层）：
//   ① profile 覆盖行停用官方 `- id: sandbox`；
//   ② profile 覆盖行启用本行（bundle 里默认 `disabled: true`），config 配 `enforcePresets` /
//      `whitelist` / `autoWhitelistFiles` / `probeTimeoutMs`；
//   ③ 只有命中 `enforcePresets` 的会话（`policy.sessionId` → `sessions.get` →
//      `permissionPresets.current` 反查）才追加白名单根；其余预设保持官方语义。
//
// 边界（与 spec 一致）：
//   - 本包是 provider **替换件**：没有 `enabled` 软开关——停用必须恢复官方 `- id: sandbox`，
//     否则 `ctx.sandbox` 缺失会让 bash 工具与权限档一起级联消失。
//   - 插件面板**不能**单独启用本行（面板只写本行 `disabled`，官方 provider 仍占用 service）；
//     必须 profile 成对改行 + 重启。
//   - 白名单根只加 canonical 且存在的目录：Linux 侧 Landlock 对不存在规则路径会让整条命令 125
//     fail-closed，Windows 侧 ACL 授权失败会污染日志且无意义，所以都在 confine 前剔除。

import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'

import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import { grantArgs } from '@deepseek-ai/node-addon-system/landlock-run'

import { normalizeConfig } from './config.mjs'
import { bwrapProfileArgs, landlockReadWriteRoots } from './profiles.mjs'
import { dedupePaths, loadAutoWhitelistPaths } from './roots.mjs'

/** 插件显示名（= 包名去 scope，= bundle 行 id）。 */
export const name = 'dsh-sandbox-whitelist'

/** 支持的宿主平台（macOS Seatbelt 多根未实现，apply 期直接拒绝）。 */
const SUPPORTED_PLATFORMS = new Set(['linux', 'win32'])

/**
 * 校验宿主平台是否有本 provider 的实现。
 *
 * 单独导出便于单测（apply 读 `process.platform`，测试机上无法模拟 darwin）。
 *
 * @param platform - `process.platform` 取值。
 * @throws 不支持时抛错（apply 期拒绝加载，避免 provider 半可用）。
 */
export function assertSupportedPlatform(platform) {
  if (SUPPORTED_PLATFORMS.has(platform)) return
  throw new Error(
    `dsh-sandbox-whitelist: 仅支持 Linux 与 Windows（当前 ${platform}）。macOS 的多根 Seatbelt 未实现；` +
      '请保持本行停用、沿用官方 sandbox provider。',
  )
}

/**
 * 纯函数：预设身份是否命中 `enforcePresets`（空数组 = 全部）。
 *
 * @param preset - 当前会话的预设身份（可 undefined）。
 * @param enforcePresets - 配置里的预设名列表。
 * @returns 是否追加白名单根。
 */
export function presetMatches(preset, enforcePresets) {
  const list = Array.isArray(enforcePresets) ? enforcePresets : []
  if (list.length === 0) return true
  return typeof preset === 'string' && list.includes(preset)
}

/**
 * parent 是否等于 child 或包含 child（两者都先 canonical 化；跨盘符返回 false）。
 *
 * @param parent - 候选父目录。
 * @param child - 候选子目录/文件。
 * @returns 包含（含相等）返回 true。
 */
function containsPath(parent, child) {
  try {
    const rel = relative(canonicalPath(parent), canonicalPath(child))
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  } catch {
    return false
  }
}

/**
 * 多根版本地沙箱 provider：官方 provider 的平台链 + 白名单根。
 *
 * 测试注入口 `internals`（沿用官方 provider 的同名钩子，生产不传）：
 *   `{platform, probeBwrap, probeLandlock, probeWindowsAcl, landlockLauncher, windowsAclRunnerArgs}`
 * 之外本包另加：`{pathExists, readAutoWhitelist}`（路径/状态文件注入）。
 */
export class WhitelistSandboxProvider extends LocalSandboxProvider {
  /**
   * @param ctx - 插件上下文（Service 构造会注册 `ctx.sandbox`；官方构造还要求 `ctx.effect`）。
   * @param config - `normalizeConfig()` 的返回值。
   * @param internals - 测试注入口（生产不传）。
   */
  constructor(ctx, config, internals = {}) {
    super(ctx, {
      runnerCommand: [],
      runnerFailureSignatures: [],
      probeTimeoutMs: config.probeTimeoutMs,
    })
    this.config = config
    this.internals = { ...this.internals, ...internals }
    /** 已补授权的 Windows 白名单根（workspaceRoot → Set<path>），避免重复 grant。 */
    this.win32GrantedExtras = new Map()
    /** 已 warn 过的消息（避免每条命令刷屏）。 */
    this.warned = new Set()
  }

  /** 平台判定依据（测试可注入）。 */
  platform() {
    return this.internals.platform ?? process.platform
  }

  /**
   * 拒绝 `danger-full-access`：调用方（bash/pwsh/terminal 执行器）本应在沙箱外短路；
   * 真送进来时宁可报错，也不静默不隔离。
   *
   * @param argv - 即将 spawn 的 argv。
   * @param policy - 每次调用携带的 file-effect policy。
   * @param signal - 取消信号。
   * @returns 官方 confine 的结果。
   */
  async confine(argv, policy, signal) {
    if (policy?.mode === 'danger-full-access') {
      throw new Error('dsh-sandbox-whitelist: confine() 不接受 danger-full-access 策略（调用方应先短路）')
    }
    return super.confine(argv, policy, signal)
  }

  /**
   * 在官方 runner argv 骨架之上追加白名单根。
   *
   * @param runner - 平台链选中的 runner（`bwrap` / `landlock` / `windows-acl` / …）。
   * @param policy - 已 canonical 化的 policy。
   * @returns runner 的 argv 前缀（不含 `--` 与用户命令）。
   */
  runnerArgv(runner, policy) {
    if (runner === 'bwrap') {
      return ['bwrap', ...bwrapProfileArgs(policy, this.extraRootsFor(policy))]
    }
    if (runner === 'landlock') {
      const readWrite = landlockReadWriteRoots(policy, this.extraRootsFor(policy))
      return [this.landlockLauncher(), ...grantArgs({ readOnly: ['/'], readWrite })]
    }
    if (runner === 'windows-acl') {
      // 官方 argv 不动（含 --workspace/--temp/--write-sid/--temp-write-sid），
      // 只为白名单根补 workspace SID 的 standing ACE（受限令牌已携带该 SID）。
      const argv = super.windowsAclRunnerArgv(policy)
      this.grantWindowsExtras(policy)
      return argv
    }
    return super.runnerArgv(runner, policy)
  }

  /**
   * 本次调用要追加的白名单根：配置白名单 + 自动白名单（本平台条目）→ canonical → 去重 →
   * 只保留存在的目录；read-only / 预设不命中时为空。
   *
   * @param policy - file-effect policy（需含 mode/workspaceRoot/sessionId）。
   * @returns 白名单根（canonical 绝对路径）。
   */
  extraRootsFor(policy) {
    if (policy?.mode !== 'workspace-write') return []
    if (!this.presetAllows(policy)) return []

    const candidates = [...this.config.whitelist]
    for (const file of this.config.autoWhitelistFiles) {
      candidates.push(...this.readAutoWhitelist(file))
    }

    const roots = []
    for (const candidate of candidates) {
      const canonical = canonicalPath(candidate)
      if (roots.includes(canonical)) continue
      if (!this.isDirectory(canonical)) {
        this.warnOnce(`dsh-sandbox-whitelist: 白名单根不存在或不是目录，已跳过：${canonical}`)
        continue
      }
      roots.push(canonical)
    }
    return dedupePaths(roots)
  }

  /**
   * 该调用的预设是否命中 `enforcePresets`（服务/会话缺失 ⇒ 不追加，fail-safe）。
   *
   * @param policy - file-effect policy。
   * @returns 是否追加白名单根。
   */
  presetAllows(policy) {
    if (this.config.enforcePresets.length === 0) return true
    const sessionId = policy?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    try {
      const session = this.ctx.get('sessions')?.get?.(sessionId)
      if (session === undefined) return false
      return presetMatches(this.ctx.get('permissionPresets')?.current?.(session), this.config.enforcePresets)
    } catch {
      return false
    }
  }

  /**
   * Windows：给白名单根补 workspace 写 SID 的 standing ACE。
   *
   * 只对「有 sessionId 的 workspace-write 调用」生效（与官方 workspace grant 同条件；agentless
   * 或 read-only 调用没有可用的 workspace SID）。授权失败只 warn 跳过该根，命令仍按官方
   * workspace+temp 范围受限（不会因此变成未隔离）。
   *
   * @param policy - file-effect policy。
   */
  grantWindowsExtras(policy) {
    if (this.platform() !== 'win32') return
    if (policy?.mode !== 'workspace-write' || policy.sessionId === undefined) return
    const workspaceRoot = canonicalPath(policy.workspaceRoot)
    const grant = this.workspaceGrants?.get(workspaceRoot)
    if (grant === undefined) return

    let granted = this.win32GrantedExtras.get(workspaceRoot)
    if (granted === undefined) {
      granted = new Set()
      this.win32GrantedExtras.set(workspaceRoot, granted)
    }

    for (const root of this.extraRootsFor(policy)) {
      if (granted.has(root)) continue
      const skipReason = this.windowsSkipReason(root, workspaceRoot)
      if (skipReason !== undefined) {
        this.warnOnce(`dsh-sandbox-whitelist: Windows 白名单根跳过（${skipReason}）：${root}`)
        continue
      }
      try {
        grant.add(root, true)
        granted.add(root)
        this.ctx?.logger?.info?.(`dsh-sandbox-whitelist: Windows 白名单根已授权：${root}`)
      } catch (error) {
        this.warnOnce(`dsh-sandbox-whitelist: Windows 白名单根 ACL 授权失败，已跳过：${root}（${String(error)}）`)
      }
    }
  }

  /**
   * Windows 下不补授权的原因：与工作区或系统临时目录重叠会让 workspace SID 的血缘越过预期边界
   * （临时目录另有 private temp capability，重叠会出现 capability 混用）。
   *
   * @param root - 候选白名单根（canonical）。
   * @param workspaceRoot - 本次调用的工作区（canonical）。
   * @returns 跳过原因；可以授予时返回 undefined。
   */
  windowsSkipReason(root, workspaceRoot) {
    if (containsPath(workspaceRoot, root)) return '位于工作区内，本来就可写'
    const temp = canonicalPath(tmpdir())
    if (containsPath(root, temp) || containsPath(temp, root)) return '与系统临时目录重叠'
    return undefined
  }

  /** 路径存在且是目录（测试可注入；异常按 false）。 */
  isDirectory(path) {
    try {
      const exists = (this.internals.pathExists ?? existsSync)(path)
      if (!exists) return false
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  /** 读一个自动白名单状态文件（测试可注入；坏文件按空）。 */
  readAutoWhitelist(file) {
    try {
      const impl = this.internals.readAutoWhitelist ?? loadAutoWhitelistPaths
      return impl(file, this.platform())
    } catch {
      return []
    }
  }

  /** 每个消息只 warn 一次（命令行/路径类噪音）。 */
  warnOnce(message) {
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.ctx?.logger?.warn?.(message)
  }
}

/**
 * 插件入口：归一化配置 → 注册多根 provider（cordis service `sandbox`）。
 *
 * @param ctx - 插件上下文（Service 构造需要 `ctx.reflect.provide` / `ctx.get` / `ctx.effect`）。
 * @param rawConfig - profile 覆盖行给的 config（可为空）。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  assertSupportedPlatform(process.platform)

  // 替换件前置检查（2026-10-24）：本包顶替官方 `- id: sandbox`，同名 service 只能有一个 provider。
  // 面板单独启用必失败（官方 provider 仍在）——提前给出可执行说明。
  // instanceof 判断避免热重载时把旧实例（同一个类）误报成冲突。
  const existing = ctx?.get?.('sandbox')
  if (existing !== undefined && !(existing instanceof WhitelistSandboxProvider)) {
    throw new Error(
      'dsh-sandbox-whitelist: ctx.sandbox 已被其它 provider 占用。本组件是 provider 替换件：' +
        '启用必须同时把官方 `- id: sandbox` 行停用（两行成对写进 profile 的 cordis.patch.yml），' +
        '不能在插件面板里单独打开本行；改完需要重启宿主。',
    )
  }

  const provider = new WhitelistSandboxProvider(ctx, config)
  ctx?.logger?.info?.(
    `dsh-sandbox-whitelist: 已接管 ctx.sandbox（platform=${process.platform}，` +
      `enforcePresets=${config.enforcePresets.length === 0 ? '(全部)' : config.enforcePresets.join(',')}，` +
      `whitelist=${config.whitelist.length} 条，autoWhitelistFiles=${config.autoWhitelistFiles.length} 个）`,
  )
  // 注意：不能 return provider —— cordis 把 apply 的返回值当 effect（函数=disposer、
  // 可迭代=批处理、其它对象=抛 `Invalid effect`）；provider 已经通过 Service 构造注册进
  // `ctx.sandbox`，返回值必须是 undefined。
  void provider
  return undefined
}
