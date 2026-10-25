// dsh-fs-whitelist 插件接线：用「白名单根版的 fs provider」顶替官方
// `- id: fs-sandbox`（cordis service `fs` 同名只能有一个 provider）。
//
// 目的：
//   `write` / `edit` 工具走 `ctx.fs` seam（官方 `@deepseek-ai/dsh-fs-sandbox`），它的 fence 只认
//   官方 `writableRoots(policy)` = workspace + `/tmp` + `os.tmpdir()`，**不读白名单**。因此即使
//   `dsh-sandbox-whitelist` 已把白名单目录变成 shell 的内核可写根，`write`/`edit` 写白名单目录
//   仍然会「沙箱拒 → 模型带 sandbox_permissions 升权重试 → 审批」。本包把同一份白名单（含审批
//   学习出来的自动白名单）接进 fs fence 的可写根，让这一路径一次成功。
//
// 生效链路（profile/bundle 层）：
//   ① profile 覆盖行停用官方 `- id: fs-sandbox`；
//   ② profile 覆盖行启用本行（bundle 里默认 `disabled: true`），config 配 `enforcePresets` /
//      `whitelist` / `autoWhitelistFiles`；
//   ③ 只有命中 `enforcePresets` 的会话（`policy.sessionId` → `sessions.get` →
//      `permissionPresets.current` 反查）才追加白名单根；其余预设保持官方单根语义。
//
// 设计约束：
//   - 本包是 provider **替换件**：没有 `enabled` 软开关——停用必须恢复官方 `- id: fs-sandbox`，
//     否则 `ctx.fs` 缺失会让 `dsh-tool-fs`（inject 含 `fs`）整组 read/read_image/write/edit 工具
//     级联消失。
//   - 只加「workspace-write 会话的白名单根」，不改 read-only / danger-full-access 的语义；拒绝
//     一律交官方 `checkedTarget`（`FS_SANDBOX_DENIED` 文案与升权标记保持原样，tool 层映射不变）。
//   - 白名单根必须 canonical + 存在性过滤：fs fence 按 canonical 身份比较，不存在的根匹配不到
//     任何目标（过滤掉即可，不需要像 Landlock 那样 fail-closed）。
//   - 自动白名单文件逐次读取（文件很小）：审批学习的新目录下一次 write/edit 就能放行，不需要
//     重启/热重载。
//
// 已知边界：
//   - 这是 **trusted-code fence（策略判定）不是内核边界**：只约束本 seam 自己的 open/rename，
//     真正隔离不可信代码仍靠 `ctx.shell` 的沙箱（本包不改内核可写根，那是 dsh-sandbox-whitelist
//     的职责）。
//   - 残留 TOCTOU（检查完到落盘之间祖先软链被换）与官方同口径：用 `this.resolve()` 在写入前
//     重新 canonical 化来收窄，「检查的身份 = 写入的身份」；威胁模型与官方 `dsh-fs-sandbox` 一致。
//   - 白名单根只在 `workspace-write` 且仅对命中 `enforcePresets` 的会话生效；`danger-full-access`
//     本来就是不 fence，`read-only` 仍然全拒。
//   - Windows：词法包含判定默认按 win32 大小写不敏感；官方有 dev/ino 别名兜底，本包刻意不做
//     （见 lib/containment.mjs 文件头）。

import { existsSync } from 'node:fs'

import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import { loadAutoWhitelistPaths } from '@gavinc-cn/dsh-sandbox-whitelist/roots'

import { normalizeConfig } from './config.mjs'
import { isUnder } from './containment.mjs'

/** 插件显示名（= 包名去 scope，= bundle 行 id）。 */
export const name = 'dsh-fs-whitelist'

/**
 * 注入声明：官方 `SandboxedFileSystem` 的构造会读 `ctx.sandboxPolicy.defaultMode`（能力事实
 * `sandboxMode`），所以本行必须等 `sandboxPolicy` 服务就绪后再 apply；否则 `ctx.sandboxPolicy`
 * 的属性访问会抛 `cannot get property "sandboxPolicy" without inject`。官方 provider 用等价的
 * `static inject = ['sandboxPolicy']` 表达同一依赖。
 */
export const inject = ['sandboxPolicy']

/**
 * diff 基线上限：与官方 `@deepseek-ai/dsh-fs-local` 构造函数里的 `DEFAULT_DIFF_BASIS_MAX_BYTES`
 * 一致（10 MiB）。超过该大小的既有文件不生成 diff 基线（只影响 write 的 diff 展示，不影响
 * 写入本身）。不 import fs-local 的常量：它不是本包的 peer（官方 fs-sandbox 直接依赖它），
 * 这里硬编码 + 注释对齐，漂移风险由单测的构造用例兜住。
 */
const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

/**
 * 白名单根版的 fs provider：继承官方 `SandboxedFileSystem`，只在 `checkedTarget` 的
 * workspace-write 分支里多认一组白名单根；其余（读写机制、原子写、编辑临界区、拒绝文案、
 * 能力事实 `sandboxMode`）全部原样继承。
 *
 * 测试注入口 `internals`（生产不传，与官方 provider 的 `internals` 同思路）：
 *   `{platform, pathExists, readAutoWhitelist}` —— 默认 `process.platform` / `existsSync` /
 *   `loadAutoWhitelistPaths`。注意父类 `LocalFileSystem` 也有一个同名的 `internals` 字段
 *   （fsio 原子写测试钩子，生产默认 `{}`）；这里的注入对象在生产同样是 `{}`，键不重叠，
 *   覆盖它是安全的（单测借此固定平台/文件系统行为）。
 */
export class WhitelistFileSystem extends SandboxedFileSystem {
  /**
   * @param ctx - 插件上下文（`Service` 构造会通过 `ctx.reflect.provide('fs', this)` 注册服务）。
   * @param config - `normalizeConfig()` 的返回值（额外给出 `cwd` 时生效）。
   * @param internals - 测试注入口（见类注释）。
   */
  constructor(ctx, config, internals = {}) {
    // 为什么把插件配置并进传给 super 的 config：父类 LocalFileSystem 把 `this.config` 当作
    // **自己的**运行配置（`resolve()`/`stat()` 读 `cwd`、`writeText()` 读 `diffBasisMaxBytes`）。
    // 构造后再执行 `this.config = 插件配置` 会覆盖掉这两个字段，父类 `resolve()` 会在
    // `isAbsolute(undefined)` 处抛 ERR_INVALID_ARG_TYPE（= 所有 write/edit 直接坏掉）。官方
    // fs-sandbox 也是把同一份 config 交给 fs-local 的，这里只是多带三个插件键。
    // 注意：`normalizeConfig()` 会忽略未知键，所以生产环境的 cwd 恒为 process.cwd()
    // （与官方 fs-local 的默认一致）；`cwd` 直接构造（单测/未来扩展）时才生效。
    super(ctx, {
      ...config,
      cwd: config?.cwd ?? process.cwd(),
      diffBasisMaxBytes: DEFAULT_DIFF_BASIS_MAX_BYTES,
    })
    this.internals = internals
  }

  /** 平台判定依据（测试可注入；影响自动白名单的条目过滤）。 */
  platform() {
    return this.internals.platform ?? process.platform
  }

  /**
   * 该调用会话是否命中 `enforcePresets`。
   *
   * 空数组 = 所有（workspace-write）会话都生效；否则必须精确命中。服务/会话/预设任一缺失都
   * 返回 false（fail-safe：白名单根宁可不生效，也不能因宿主状态异常把整个 session 的写入搞挂）。
   *
   * @param policy - 本次调用的 file-effect policy。
   * @returns {boolean} 是否追加白名单根。
   */
  presetMatches(policy) {
    const presets = this.config.enforcePresets ?? []
    if (presets.length === 0) return true
    const sessionId = policy?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    try {
      const session = this.ctx.get('sessions')?.get?.(sessionId)
      if (session === undefined) return false
      const preset = this.ctx.get('permissionPresets')?.current?.(session)
      return typeof preset === 'string' && presets.includes(preset)
    } catch {
      return false
    }
  }

  /**
   * 读一个自动白名单状态文件（测试可注入）；坏文件/缺文件按空处理。
   *
   * 逐次读而不是缓存：审批学习的新目录下一次 write/edit 立即生效（与 dsh-sandbox-whitelist
   * 的命令级口径一致）。
   *
   * @param file - 状态文件绝对路径。
   * @returns {string[]} 本平台条目里的路径（保序去重；异常时为空）。
   */
  readAutoWhitelist(file) {
    try {
      const impl = this.internals.readAutoWhitelist ?? loadAutoWhitelistPaths
      return impl(file, this.platform())
    } catch {
      return []
    }
  }

  /** 路径存在性（默认 `existsSync`，测试可注入；异常按不存在处理）。 */
  fileExists(path) {
    const impl = this.internals.pathExists ?? existsSync
    try {
      return impl(path)
    } catch {
      return false
    }
  }

  /**
   * 本次调用额外认作可写根的白名单目录：配置白名单 + 自动白名单（本平台条目），已 canonical、
   * 已过滤不存在的、已保序去重，并剔除官方 `writableRoots` 已经覆盖的同名根。
   *
   * read-only（官方一律拒绝）与预设不命中的会话返回空数组 = 完全走官方语义。
   *
   * @param policy - 本次调用的 file-effect policy（需已含 workspaceRoot/mode/sessionId）。
   * @returns {string[]} 追加的可写根（canonical 绝对路径）。
   */
  extraRootsFor(policy) {
    if (policy?.mode !== 'workspace-write') return []
    if (!this.presetMatches(policy)) return []

    const candidates = [...(this.config.whitelist ?? [])]
    for (const file of this.config.autoWhitelistFiles ?? []) candidates.push(...this.readAutoWhitelist(file))

    // 官方已允许的根（workspace + /tmp + os.tmpdir()）：剔掉完全相同的项，少一层比较
    // （只是优化，正确性不依赖它）。
    const official = new Set(writableRoots(policy))
    const roots = []
    for (const candidate of candidates) {
      // canonicalPath 失败时原样返回拼写（官方实现内部已 catch），交给存在性过滤兜住。
      const canonical = canonicalPath(candidate)
      if (official.has(canonical)) continue
      if (!this.fileExists(canonical)) continue
      if (!roots.includes(canonical)) roots.push(canonical)
    }
    return roots
  }

  /**
   * 官方 fence 的「白名单根版」：workspace-write 时先看目标是否落在附加可写根里，命中则返回
   * 重新 canonical 化后的 target（检查的身份 = 写入的身份）；否则原样交官方实现。
   *
   * 拒绝的全部文案/错误码/升权标记都来自官方 `super.checkedTarget`，本包不自己拼错误。
   *
   * @param target - `ctx.fs` 解析出的目标。
   * @param sandboxPolicy - 本次调用的 policy；缺省用 `ctx.sandboxPolicy.resolve()` 的部署兜底。
   * @returns {Promise<object>} 实际用于写入/编辑的 target。
   * @throws {FsError} 官方拒绝时抛 `FS_SANDBOX_DENIED`（或 read-only 的对应文案）。
   */
  async checkedTarget(target, sandboxPolicy) {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    // read-only / danger-full-access 一律交官方实现。
    if (policy.mode !== 'workspace-write') return super.checkedTarget(target, policy)

    const extras = this.extraRootsFor(policy)
    if (extras.length === 0) return super.checkedTarget(target, policy)

    // 与官方同口径：写入前重新 canonical 化（resolve 会 realpath 化最深的已存在祖先），
    // 收窄「检查完到落盘之间祖先软链被换」的 TOCTOU。
    const fresh = await this.resolve(target.displayPath)
    for (const root of extras) {
      if (isUnder(fresh.targetKey, root)) return fresh
    }
    // 不在白名单根里：交官方判定（workspace/tmp 放行，其余抛官方 `FS_SANDBOX_DENIED`）。
    return super.checkedTarget(target, policy)
  }
}

/**
 * 插件入口：归一化配置 → 注册白名单根 fs provider（cordis service `fs`）。
 *
 * @param ctx - 插件上下文（Service 构造需要 `ctx.reflect.provide` 与 `ctx.sandboxPolicy`）。
 * @param rawConfig - profile 覆盖行给的 config（可为空）。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  // 替换件前置检查（2026-10-24）：本包顶替官方 `- id: fs-sandbox`，`fs` 是独占 service。
  // 面板单独启用必失败（官方 provider 仍注册着）——提前把「必须成对改 profile 行 + 重启」
  // 说清楚，而不是抛出 cordis 的 `service "fs" has been registered at <SandboxedFileSystem>`。
  // instanceof 判断避免热重载时把旧实例（同一个类）误报成冲突。
  const existing = ctx?.get?.('fs')
  if (existing !== undefined && !(existing instanceof WhitelistFileSystem)) {
    throw new Error(
      'dsh-fs-whitelist: ctx.fs 已被其它 provider 占用。本组件是 fs provider 替换件：' +
        '启用必须同时把官方 `- id: fs-sandbox` 行停用（两行成对写进 profile 的 cordis.patch.yml），' +
        '不能在插件面板里单独打开本行；改完需要重启宿主。',
    )
  }
  new WhitelistFileSystem(ctx, config)
  ctx?.logger?.info?.(
    `dsh-fs-whitelist: 已接管 ctx.fs（enforcePresets=` +
      `${config.enforcePresets.length === 0 ? '(全部 workspace-write 会话)' : config.enforcePresets.join(',')}，` +
      `whitelist=${config.whitelist.length} 条，autoWhitelistFiles=${config.autoWhitelistFiles.length} 个）`,
  )
  // 注意：不能 return provider —— cordis 把 apply 的返回值当 effect（函数=disposer、
  // 可迭代=批处理、其它对象=抛 `Invalid effect`）；provider 已经通过 Service 构造注册进
  // `ctx.fs`，返回值必须是 undefined。
  return undefined
}
