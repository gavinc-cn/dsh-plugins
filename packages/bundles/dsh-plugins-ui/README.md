# @gavinc-cn/dsh-plugins-ui

把**只作用于 Web GUI** 的自研插件收成一个可安装单位的 bundle 包：装上它，Plugins 面板里多出
一张「自研插件 · UI」卡片；卡片里的每个**组件**（组合行）= 一个**独立开关**。

- **一个包 = 面板一张卡片**：包名出现在 profile 的 `dsh.profile.bundles` 里，本包的
  `cordis.patch.yml` 就会被当作一个配置层叠加进组合树。
- **组件 = 行 = 开关**：本包每条 `- insert:` 声明一个组件；行状态（`disabled`）由各 profile
  的 `cordis.patch.yml` 覆盖行持有，面板里拨开关就是往那里写回。
- **整包开关**：包名在不在 `dsh.profile.bundles`（改它要重启宿主）。

## 归属判据

包内组件的 `package.json` 里都声明了 `dsh.client.platform: "web"`，浏览器半边经
`exports["./client"]` 指向 `lib/client.bundle.js`，node 半边是空 `apply()`。
不满足该判据的组件一律归 [@gavinc-cn/dsh-plugins-runtime](../dsh-plugins-runtime/README.md)
（两个包合起来 = 拆分前 `@gavinc-cn/dsh-plugins` 的全部 13 个组件）。

## 安装

```bash
# 装进某个 profile（pnpm 会把依赖里的 5 个组件包一并装上）
dsh plugin --profile web add @gavinc-cn/dsh-plugins-ui
```

- CLI 这条路径会在 pnpm 成功后**自动**把新 bundle 追加进 `dsh.profile.bundles`（装完即启用）。
- 走 **Plugins 面板**的安装入口则**不会**自动选择 bundle，装完要自己把整包开关打开。
- **`dsh.profile.bundles` 与 `dependencies` 两处都要有本包名**：前者决定是否作为配置层加载，
  后者决定面板里卡片是否显示（客户端按 `installed` 过滤，只看 `dependencies`）。
- 改了 `dsh.profile.bundles` 要**重启宿主**才生效（启动时读）；profile patch 层是 live 热重载，
  行级开关不需要重启。

## 组件（5 个）

| 行 id | 包 | 做什么 |
|---|---|---|
| `kanban-board` | `@gavinc-cn/kanban-board` | Web GUI 任务看板（待开发/开发中/阻塞/待审核/已完成），拖进「开发中」自动建会话。包内默认 `disabled: true` |
| `dsh-dim-text` | `@gavinc-cn/dsh-dim-text` | 把 Web GUI 文字梯度整体调暗一档（仅深色模式） |
| `dsh-session-unread-persist` | `@gavinc-cn/dsh-session-unread-persist` | 会话列表「已完成未查看」绿点持久化到 localStorage |
| `dsh-turn-labels` | `@gavinc-cn/dsh-turn-labels` | 右侧轮次刻度轨换成常驻文字（每轮一行显示该轮提问） |
| `dsh-sidebar-width-persist` | `@gavinc-cn/dsh-sidebar-width-persist` | 左侧边栏拖动宽度持久化 |

行 id 的约定是**包名去掉 scope**（`@gavinc-cn/dsh-turn-labels` → `dsh-turn-labels`）：profile 覆盖行
按它命中，面板开关按它写回。要改组件集合，改本包的 `cordis.patch.yml` 即可（**改完 patch 层当场热重载**）。

## 机器相关配置不要写进这里

本包只下发「有哪些组件 + 默认行为」。只有某台机器才成立的值（本地检出路径、状态目录、日志路径）
请写在 profile 覆盖层，例如：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: dsh-superpowers-priming      # 该组件在 runtime 包里，这里只演示覆盖行形状
  config:
    skillPath: /path/to/using-superpowers/SKILL.md
```

覆盖行只按 `id` 命中，**不要写 `insert`、也不写 `name`**（与官方 `writePluginEnabled()` 同形状）。

## 已知限制

- 面板里组件的标题/说明来自各组件包自己的 `locale/*.json`；本包的 `locale/*.json` 只提供卡片
  标题与描述。host 启动时缓存行元数据（`pluginPackages.metaOf`）⇒ 运行中新增/改 `locale` 要重启宿主才看到。
- `kanban-board` 包内默认 `disabled: true`（容器 web 侧默认不开）；桌面端在自己的覆盖行里决定开/关。

## License

MIT
