# @gavinc-cn/dsh-plugins-runtime

把**宿主（node）侧运行**的自研插件收成一个可安装单位的 bundle 包：装上它，Plugins 面板里多出
一张「自研插件 · 运行时」卡片；卡片里的每个**组件**（组合行）= 一个**独立开关**。

- **一个包 = 面板一张卡片**：包名出现在 profile 的 `dsh.profile.bundles` 里，本包的
  `cordis.patch.yml` 就会被当作一个配置层叠加进组合树。
- **组件 = 行 = 开关**：本包每条 `- insert:` 声明一个组件；行状态（`disabled`）由各 profile
  的 `cordis.patch.yml` 覆盖行持有，面板里拨开关就是往那里写回。
- **整包开关**：包名在不在 `dsh.profile.bundles`（改它要重启宿主）。

## 归属判据

包内组件的 `package.json` 里**没有** `dsh.client` 声明 —— 即运行体在宿主（node）侧。
声明了 `dsh.client.platform: "web"` 的纯 UI 组件在
[@gavinc-cn/dsh-plugins-ui](../dsh-plugins-ui/README.md)（两个包合起来 = 拆分前
`@gavinc-cn/dsh-plugins` 的全部 13 个组件）。

特例：`dsh-patch-ask-expand` 的效果在 UI 上（给官方 `dsh-client-ui-tool` 的成品 client bundle
打幂等文本补丁），但运行体在宿主侧、没有 `dsh.client` ⇒ 按判据归本包。**只装 UI 包不会得到它。**

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
| `dsh-patch-ask-expand` | `@gavinc-cn/dsh-patch-ask-expand` | 让 Web GUI 里「提问 / 回答」那一行默认展开（对官方 client bundle 打幂等文本补丁） |
| `dsh-superpowers-priming` | `@gavinc-cn/dsh-superpowers-priming` | 给「重开的会话」补一份 superpowers 开场说明（按会话历史判重，不重复注入） |
| `dsh-memory` | `@gavinc-cn/dsh-memory` | 跨会话记忆：首轮注入两级记忆索引，回合收尾限流提示写记忆 |
| `dsh-autocommit` | `@gavinc-cn/dsh-autocommit` | 回合收尾时若本会话还有未提交改动，挡下并提示模型先提交 |
| `dsh-git-guard` | `@gavinc-cn/dsh-git-guard` | git 操作归属守卫（按提交前缀/分支命名判定，拦下越权 git 写操作） |
| `dsh-file-guard` | `@gavinc-cn/dsh-file-guard` | 回合收尾比对「本会话写下的文件」与磁盘漂移，只报告不自动改回 |
| `sandbox-path-allowlist` | `@gavinc-cn/sandbox-path-allowlist` | 沙箱升权白名单：配置目录内的 write/edit 升权请求自动放行（默认 `paths` 为空 = 空转，靠 profile 覆盖行给本机路径） |
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
| `dsh-patch-ask-expand` | `bundlePath` | `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js` |
| `sandbox-path-allowlist` | `paths`（数组，绝对路径）/ `allowShell` | `paths: []` = 不生效（**必须**由覆盖行给本机路径才有作用） |
| `dsh-readonly-guard` | `enabled` / `dryRun` / `askMode` / `whitelistPath` / `pendingPath` / `logPath` | 行默认 `disabled: true`；`whitelistPath`/`pendingPath` 缺省与 kimi 共用 `~/.kimi-code/readonly_whitelist.json` / `readonly_pending.jsonl` |
| 各组件 | `logPath` / `enabled` / `dryRun` | 日志在 `~/.kimi-code/hooks/logs/`，默认启用 |

## 已知限制

- 桌面端（Electron 宿主）改 `dsh.profile.bundles` 后必须**重启 App**；只有 patch 层是 live 热重载。
- 面板里 node 侧组件的标题/说明来自各组件包自己的 `locale/*.json`；本包的 `locale/*.json` 只提供
  卡片标题与描述。host 启动时缓存行元数据（`pluginPackages.metaOf`）⇒ 运行中新增/改 `locale` 要重启宿主才看到。
- 某些组件只在特定平台有意义（宿主侧的状态目录、日志目录等按上表各自配置）。

## License

MIT
