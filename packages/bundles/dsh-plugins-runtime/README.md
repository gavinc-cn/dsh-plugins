# @gavinc-cn/dsh-plugins-runtime

把**宿主（node）侧运行**的自研插件收成一个可安装单位的 bundle 包：装上它，Plugins 面板里多出
一张标题为**包名**的卡片（`@gavinc-cn/dsh-plugins-runtime`）；卡片里的每个**组件**（组合行）= 一个**独立开关**。

> 标题为什么是包名：面板标题的取值链是「`locale/*.json` 的 `meta.title` → 缺省回落 `package.json`
> 的 `name`」。本包**故意不写 `meta.title`**（2026-10-15 起），只保留 `meta.description` 供描述
> 本地化 —— 这样卡片标题与 `@gavinc-cn/touchstone-dsh` 一样直接显示包名。

- **一个包 = 面板一张卡片**：包名出现在 profile 的 `dsh.profile.bundles` 里，本包的
  `cordis.patch.yml` 就会被当作一个配置层叠加进组合树。
- **组件 = 行 = 开关**：本包每条 `- insert:` 声明一个组件；行状态（`disabled`）由各 profile
  的 `cordis.patch.yml` 覆盖行持有，面板里拨开关就是往那里写回。
- **整包开关**：包名在不在 `dsh.profile.bundles`（改它要重启宿主）。

## 归属判据

包内组件都是**宿主（node）侧的运行支撑**：记忆、提交/文件/git 守卫、路径规则闸门、
沙箱升权等 —— 它们的 package.json 里**没有** `dsh.client` 声明。

面向 Web GUI 的组件（含纯浏览器组件，以及 2026-10-15 从本包移出的 `dsh-patch-ask-expand`）在
[@gavinc-cn/dsh-plugins-ui](../dsh-plugins-ui/README.md)。归属判据自 2026-10-15 起是
**「面向谁」而不是「代码跑在哪」**：`dsh-patch-ask-expand` 的运行体确实在宿主侧（启动时对官方
`dsh-client-ui-tool` 的 client bundle 打文本补丁），但它是纯 GUI 观感功能 ⇒ 归 UI 包，
免得「只想装 UI 包」的人发现不了它。两个包合起来 = **16 行**（UI 8 + 本包 8）。
`kanban-board`、`sandbox-path-allowlist` 与 `dsh-readonly-guard` 不随任何 bundle 下发
（`sandbox-path-allowlist` 2026-10-17 由 `dsh-path-rules` 合并退役、`dsh-readonly-guard`
2026-10-24 退役，白名单/只读判定能力分别由 `dsh-path-rules` 与第五/六档 + 原生沙箱承接）；
`dsh-autocommit` 2026-11-01 迁入 `@gavinc-cn/touchstone-dsh` 的 bundle patch（行 id 全树唯一，
两边都带会判 unaddressable），本仓只留包体作真源。

## 安装

```bash
# 装进某个 profile（pnpm 会把依赖里的 8 个组件包一并装上）
dsh plugin --profile web add @gavinc-cn/dsh-plugins-runtime
```

- CLI 这条路径会在 pnpm 成功后**自动**把新 bundle 追加进 `dsh.profile.bundles`（装完即启用）。
- 走 **Plugins 面板**的安装入口则**不会**自动选择 bundle，装完要自己把整包开关打开。
- **`dsh.profile.bundles` 与 `dependencies` 两处都要有本包名**：前者决定是否作为配置层加载，
  后者决定面板里卡片是否显示（客户端按 `installed` 过滤，只看 `dependencies`）。
- 改了 `dsh.profile.bundles` 要**重启宿主**才生效（启动时读）；profile patch 层是 live 热重载，
  行级开关不需要重启。

## 组件（8 个）

| 行 id | 包 | 做什么 |
|---|---|---|
| `dsh-superpowers-priming` | `@gavinc-cn/dsh-superpowers-priming` | 给「重开的会话」补一份 superpowers 开场说明（按会话历史判重，不重复注入） |
| `dsh-memory` | `@gavinc-cn/dsh-memory` | 跨会话记忆：首轮注入两级记忆索引，回合收尾限流提示写记忆 |
| `dsh-git-guard` | `@gavinc-cn/dsh-git-guard` | git 操作归属守卫（按提交前缀/分支命名判定，拦下越权 git 写操作） |
| `dsh-file-guard` | `@gavinc-cn/dsh-file-guard` | 回合收尾比对「本会话写下的文件」与磁盘漂移，只报告不自动改回 |
| `dsh-path-rules` | `@gavinc-cn/dsh-path-rules` | 第五权限模式「路径规则」的逐调用闸门：项目内可读写 / 项目外读允许·写审批 / 白名单直通 / 黑名单读写都审批 / bash·pwsh 只读放行。**只在预设身份为 `path-rules` 时介入**，其余四档完全空转（2026-10-17 起承接退役的 `sandbox-path-allowlist` 白名单能力；`autoWhitelist` 可把用户批准的升权写入目录自动记入白名单）。**v2（0.1.2）**：判不出读写的命令交给沙箱在运行时拦写（`unanalyzable: pass`）、判不出的命令做黑名单文本粗检（`opaqueBlacklistScan`）。**v3（0.2.0，2026-10-24）**：`staticGate: true`（默认）保留逐调用静态判定；配置 `staticGate: false` 后写判定交给执行层多根件（`dsh-sandbox-whitelist` + `dsh-fs-whitelist`），本插件只留黑名单与审批学习；预置升权 `preemptiveWhitelistEscalation` 已删除 |
| `dsh-write-guard` | `@gavinc-cn/dsh-write-guard` | 第六权限模式「完全权限（拦截）」的逐调用写入闸门：读任意文件 / 项目内 / 白名单写直通，越界写弹框并自动学习白名单，判不出的 `bash`·`pwsh` 交当前会话模型判定。**只在预设身份为 `write-guard` 时介入**，其余档位完全空转；插件停用 = 完全不拦截 |
| `dsh-sandbox-whitelist` | `@gavinc-cn/dsh-sandbox-whitelist` | 多根沙箱 provider（方案 C，Linux + Windows）：顶替官方 `- id: sandbox`，把项目根 + 白名单根 + 临时区变成执行层可写根（Linux bwrap/Landlock；Windows 官方 windows-acl 受限令牌 + 写 SID ACE），其余只读；只对 `enforcePresets` 命中的会话追加白名单根。**包内默认 `disabled: true`**，启用必须同时停用官方 `sandbox` 行；macOS 未实现（apply 拒绝） |
| `dsh-fs-whitelist` | `@gavinc-cn/dsh-fs-whitelist` | fs provider 替换件（方案 C 第 2 步，跨平台）：顶替官方 `- id: fs-sandbox`，让 `write`/`edit` 的 fence 也把白名单 + 自动白名单目录当作可写根（trusted-code 策略判定，不是内核边界）；只对 `enforcePresets` 命中的会话生效。**包内默认 `disabled: true`**，启用必须同时停用官方 `fs-sandbox` 行，否则 `ctx.fs` 抢注册 / 缺失会让 read/write/edit 四个工具一起消失 |

> **已迁出（2026-11-01）**：`dsh-autocommit`（自动提交守卫）的行与依赖已从本 bundle 移除，
> 并进 `@gavinc-cn/touchstone-dsh` 的 bundle patch 第二行（`id: dsh-autocommit`，
> `name: "@gavinc-cn/touchstone-dsh/autocommit"`）。理由：它是 Touchstone 的产品行为
> （看板卡片一轮结束/挂起时把本会话改动落成提交），且**同一个行 id 全树只能出现一次** ——
> 两边都带会判 unaddressable 并双份拦截。包本体留在仓库 `packages/runtime/dsh-autocommit/` 作
> 真源存档（`scripts/check-bundles.mjs` 的 UNBUNDLED 已登记）。

> **已退役（2026-10-24）**：`dsh-readonly-guard` 的行与依赖已从本 bundle 移除（包本体仍留在仓库
> `packages/runtime/dsh-readonly-guard/` 作回滚真源，也可在 profile 手写 insert 单独挂）。
> 退役理由：bash 只读判定已被第五档 `dsh-path-rules`、第六档 `dsh-write-guard`（按写入目标判、
> 更精准）与原生沙箱覆盖；且它判「非只读」时不调 `next()`，会短路其后注册的闸门。
> 详见 `doc_ai/spec/permissions/permission-gates.md`。

行 id 的约定是**包名去掉 scope**（`@gavinc-cn/dsh-memory` → `dsh-memory`）：profile 覆盖行按它命中，
面板开关按它写回。要改组件集合，改本包的 `cordis.patch.yml` 即可（**改完 patch 层当场热重载**）。

## 机器相关配置不要写进这里

本包只下发「有哪些组件 + 默认行为」。只有某台机器才成立的值（本地检出路径、状态目录、日志路径）
请写在 profile 覆盖层：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: dsh-superpowers-priming
  config:
    skillPath: /path/to/superpowers/skills/using-superpowers/SKILL.md
```

覆盖行只按 `id` 命中，**不要写 `insert`、也不写 `name`**（与官方 `writePluginEnabled()` 同形状）。

| 组件 | 可覆盖项 | 默认值 |
|---|---|---|
| `dsh-superpowers-priming` | `skillPath`（或 env `SUPERPOWERS_SKILL_PATH`） | `~/superpowers/skills/using-superpowers/SKILL.md`（文件不存在只记日志、不注入） |
| `dsh-file-guard` | `stateRoot`（或 env `FILE_GUARD_ROOT`） | `~/.orca/file-guard` |
| `dsh-path-rules` | `whitelist` / `blacklist`（绝对路径数组）、`activationPreset`、`unanalyzable`、`staticGate`、`failMode`、`dryRun`、`autoWhitelist` / `autoWhitelistFile`、`opaqueBlacklistScan`、`logPath` | 白/黑名单默认 `[]`（只按项目内/外判定）；`activationPreset: path-rules`、`unanalyzable: pass`（v2 默认；`deny` / `ask` 可改回严格）、`staticGate: true`（`false` = 写交给执行层多根件，只保留黑名单与审批学习）、`failMode: closed`、`allowTempRoots: true`、`autoWhitelist: false`（状态文件缺省 `<dsh home>/path-rules/auto-whitelist.json`）、`opaqueBlacklistScan: true` |
| `dsh-write-guard` | `enabled` / `activationPreset` / `whitelist` / `allowTempRoots` / `judge` / `judgeTimeoutMs` / `judgeCacheSize` / `autoWhitelist` / `autoWhitelistFile` / `failMode` / `dryRun` / `logPath` | `activationPreset: write-guard`、`whitelist: []`、`allowTempRoots: true`、`judge: true`、`judgeTimeoutMs: 20000`、`autoWhitelist: true`、`failMode: ask`；`autoWhitelistFile` 缺省 `<dsh home>/write-guard/auto-whitelist.json`、`judgeCacheSize: 200`、`dryRun: false`、`logPath` 缺省 `~/.kimi-code/hooks/logs/write_guard.dsh.log` |
| `dsh-sandbox-whitelist` | `enforcePresets` / `whitelist` / `autoWhitelistFiles` / `probeTimeoutMs` | 行默认 `disabled: true`（启用须同时停用官方 `- id: sandbox`）；`enforcePresets: ['path-rules']`（空数组 = 所有预设）、`whitelist: []`、`autoWhitelistFiles: []`（可指向 path-rules / write-guard 的自动白名单 JSON）、`probeTimeoutMs: 5000`；**无 `enabled` 软开关**：停用只能恢复官方行 |
| `dsh-fs-whitelist` | `enforcePresets` / `whitelist` / `autoWhitelistFiles` | 行默认 `disabled: true`（启用须同时停用官方 `- id: fs-sandbox`）；`enforcePresets: ['path-rules']`（空数组 = 所有 workspace-write 会话）、`whitelist: []`、`autoWhitelistFiles: []`；**无 `enabled` 软开关**：停用只能恢复官方行 |
| 各组件 | `logPath` / `enabled` / `dryRun` | 日志在 `~/.kimi-code/hooks/logs/`，默认启用 |

> `dsh-patch-ask-expand` 的 `bundlePath` 等可覆盖项随它一起去了 UI bundle，
> 见 [@gavinc-cn/dsh-plugins-ui](../dsh-plugins-ui/README.md) 与它自己的 README。

## 已知限制

- 桌面端（Electron 宿主）改 `dsh.profile.bundles` 后必须**重启 App**；只有 patch 层是 live 热重载。
- 面板里 node 侧组件的标题/说明来自各组件包自己的 `locale/*.json`；本包的 `locale/*.json` 只提供
  卡片标题与描述。`pluginPackages.metaOf()` 每次列举都实时读盘（2026-10-15 实测）⇒ 改 `locale`
  刷新面板即可，不必重启宿主（旧版「启动时缓存」的说法已证伪）。
- 某些组件只在特定平台有意义（宿主侧的状态目录、日志目录等按上表各自配置）。

## License

MIT
