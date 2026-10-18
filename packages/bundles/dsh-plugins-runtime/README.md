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

包内组件都是**宿主（node）侧的运行支撑**：记忆、提交/文件/git 守卫、只读闸门、路径规则闸门、
沙箱升权等 —— 它们的 package.json 里**没有** `dsh.client` 声明。

面向 Web GUI 的组件（含纯浏览器组件，以及 2026-10-15 从本包移出的 `dsh-patch-ask-expand`）在
[@gavinc-cn/dsh-plugins-ui](../dsh-plugins-ui/README.md)。归属判据自 2026-10-15 起是
**「面向谁」而不是「代码跑在哪」**：`dsh-patch-ask-expand` 的运行体确实在宿主侧（启动时对官方
`dsh-client-ui-tool` 的 client bundle 打文本补丁），但它是纯 GUI 观感功能 ⇒ 归 UI 包，
免得「只想装 UI 包」的人发现不了它。两个包合起来 = **12 行**（UI 5 + 本包 7）。
`kanban-board` 与 `sandbox-path-allowlist` 不随任何 bundle 下发（后者 2026-10-17 由
`dsh-path-rules` 合并退役，白名单能力由它的 `approval/request` 监听承接）。

## 安装

```bash
# 装进某个 profile（pnpm 会把依赖里的 7 个组件包一并装上）
dsh plugin --profile web add @gavinc-cn/dsh-plugins-runtime
```

- CLI 这条路径会在 pnpm 成功后**自动**把新 bundle 追加进 `dsh.profile.bundles`（装完即启用）。
- 走 **Plugins 面板**的安装入口则**不会**自动选择 bundle，装完要自己把整包开关打开。
- **`dsh.profile.bundles` 与 `dependencies` 两处都要有本包名**：前者决定是否作为配置层加载，
  后者决定面板里卡片是否显示（客户端按 `installed` 过滤，只看 `dependencies`）。
- 改了 `dsh.profile.bundles` 要**重启宿主**才生效（启动时读）；profile patch 层是 live 热重载，
  行级开关不需要重启。

## 组件（7 个）

| 行 id | 包 | 做什么 |
|---|---|---|
| `dsh-superpowers-priming` | `@gavinc-cn/dsh-superpowers-priming` | 给「重开的会话」补一份 superpowers 开场说明（按会话历史判重，不重复注入） |
| `dsh-memory` | `@gavinc-cn/dsh-memory` | 跨会话记忆：首轮注入两级记忆索引，回合收尾限流提示写记忆 |
| `dsh-autocommit` | `@gavinc-cn/dsh-autocommit` | 回合收尾时若本会话还有未提交改动，挡下并提示模型先提交 |
| `dsh-git-guard` | `@gavinc-cn/dsh-git-guard` | git 操作归属守卫（按提交前缀/分支命名判定，拦下越权 git 写操作） |
| `dsh-file-guard` | `@gavinc-cn/dsh-file-guard` | 回合收尾比对「本会话写下的文件」与磁盘漂移，只报告不自动改回 |
| `dsh-path-rules` | `@gavinc-cn/dsh-path-rules` | 第五权限模式「路径规则」的逐调用闸门：项目内可读写 / 项目外读允许·写审批 / 白名单直通 / 黑名单读写都审批 / bash·pwsh 只读放行。**只在预设身份为 `path-rules` 时介入**，其余四档完全空转（2026-10-17 起，承接退役的 `sandbox-path-allowlist` 白名单能力；2026-10-18 起 `autoWhitelist` 可把用户批准的升权写入目录自动记入白名单） |
| `dsh-readonly-guard` | `@gavinc-cn/dsh-readonly-guard` | bash 只读闸门：只读命令放行，可能改系统的转 DSH 原生审批。包内默认 `disabled: true` |

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
| `dsh-path-rules` | `whitelist` / `blacklist`（绝对路径数组）、`activationPreset`、`unanalyzable`、`failMode`、`dryRun`、`autoWhitelist` / `autoWhitelistFile`、`logPath` | 白/黑名单默认 `[]`（只按项目内/外判定）；`activationPreset: path-rules`、`unanalyzable: deny`、`failMode: closed`、`allowTempRoots: true`、`autoWhitelist: false`（状态文件缺省 `<dsh home>/path-rules/auto-whitelist.json`） |
| `dsh-readonly-guard` | `enabled` / `dryRun` / `askMode` / `whitelistPath` / `pendingPath` / `logPath` | 行默认 `disabled: true`；`whitelistPath`/`pendingPath` 缺省与 kimi 共用 `~/.kimi-code/readonly_whitelist.json` / `readonly_pending.jsonl` |
| 各组件 | `logPath` / `enabled` / `dryRun` | 日志在 `~/.kimi-code/hooks/logs/`，默认启用 |

> `dsh-patch-ask-expand` 的 `bundlePath` 等可覆盖项随它一起去了 UI bundle，
> 见 [@gavinc-cn/dsh-plugins-ui](../dsh-plugins-ui/README.md) 与它自己的 README。

## 已知限制

- 桌面端（Electron 宿主）改 `dsh.profile.bundles` 后必须**重启 App**；只有 patch 层是 live 热重载。
- 面板里 node 侧组件的标题/说明来自各组件包自己的 `locale/*.json`；本包的 `locale/*.json` 只提供
  卡片标题与描述。host 启动时缓存行元数据（`pluginPackages.metaOf`）⇒ 运行中新增/改 `locale` 要重启宿主才看到。
- 某些组件只在特定平台有意义（宿主侧的状态目录、日志目录等按上表各自配置）。

## License

MIT
