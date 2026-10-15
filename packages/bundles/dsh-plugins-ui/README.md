# @gavinc-cn/dsh-plugins-ui

把**面向 Web GUI** 的自研插件收成一个可安装单位的 bundle 包：装上它，Plugins 面板里多出
一张标题为**包名**的卡片（`@gavinc-cn/dsh-plugins-ui`）；卡片里的每个**组件**（组合行）= 一个**独立开关**。

> 标题为什么是包名：面板标题的取值链是「`locale/*.json` 的 `meta.title` → 缺省回落 `package.json`
> 的 `name`」。本包**故意不写 `meta.title`**（2026-10-15 起），只保留 `meta.description` 供描述
> 本地化 —— 这样卡片标题与 `@gavinc-cn/touchstone-dsh` 一样直接显示包名。

- **一个包 = 面板一张卡片**：包名出现在 profile 的 `dsh.profile.bundles` 里，本包的
  `cordis.patch.yml` 就会被当作一个配置层叠加进组合树。
- **组件 = 行 = 开关**：本包每条 `- insert:` 声明一个组件；行状态（`disabled`）由各 profile
  的 `cordis.patch.yml` 覆盖行持有，面板里拨开关就是往那里写回。
- **整包开关**：包名在不在 `dsh.profile.bundles`（改它要重启宿主）。

## 归属判据

**面向 Web GUI 的组件归本包**（2026-10-15 修订；此前是「声明了 `dsh.client.platform: "web"` 才算」）：

| 组件 | 形态 |
|---|---|
| `dsh-dim-text` / `dsh-session-unread-persist` / `dsh-turn-labels` / `dsh-sidebar-width-persist` | 纯浏览器组件：`exports["./client"]` 指向 `lib/client.bundle.js`，node 半边是空 `apply()` |
| `dsh-patch-ask-expand` | **运行体在宿主侧**（没有 `dsh.client`）：启动时对官方 `dsh-client-ui-tool` 的 client bundle 打幂等文本补丁；效果完全是 GUI 观感（提问行默认展开） |

修订缘由：按旧判据它属运行时包，但「只想装 UI 包」的人就永远发现不了它。判据因此从
「代码跑在哪」改成「面向谁」。其余宿主侧组件（记忆/守卫/沙箱等）仍在
[@gavinc-cn/dsh-plugins-runtime](../dsh-plugins-runtime/README.md)。
两个包的行合起来 = **12 个组件**（拆分前 `@gavinc-cn/dsh-plugins` 的 13 个里，`kanban-board`
已移出 bundle，见下「不随本包下发的组件」）。

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
| `dsh-dim-text` | `@gavinc-cn/dsh-dim-text` | 把 Web GUI 文字梯度整体调暗一档（仅深色模式） |
| `dsh-session-unread-persist` | `@gavinc-cn/dsh-session-unread-persist` | 会话列表「已完成未查看」绿点持久化到 localStorage |
| `dsh-turn-labels` | `@gavinc-cn/dsh-turn-labels` | 右侧轮次刻度轨换成常驻文字（每轮一行显示该轮提问；提问条目直接显示用户回答——蓝色区分、hover 出完整问答，读不到回答时退回原版小横杠） |
| `dsh-sidebar-width-persist` | `@gavinc-cn/dsh-sidebar-width-persist` | 左侧边栏拖动宽度持久化 |
| `dsh-patch-ask-expand` | `@gavinc-cn/dsh-patch-ask-expand` | 「提问 / 回答」那一行默认展开。**本包唯一的宿主侧实现**：启动时写官方 `@deepseek-ai/dsh-client-ui-tool` 的 `lib/client.js`（保留 `.orig` 备份；锚点对不上就跳过，只记日志） |

行 id 的约定是**包名去掉 scope**（`@gavinc-cn/dsh-turn-labels` → `dsh-turn-labels`）：profile 覆盖行
按它命中，面板开关按它写回。要改组件集合，改本包的 `cordis.patch.yml` 即可（**改完 patch 层当场热重载**）。

### 不随本包下发的组件

`@gavinc-cn/kanban-board`（Web GUI 任务看板）**不在本包内**（2026-10-15 从本包移除：行与
`dependencies` 都删了）。它仍是本仓库 `packages/ui/kanban-board/` 里的组件包（npm 上的
`0.1.2` 也仍可单独安装），只是不随任何 bundle 下发 ⇒ 装本包**不会**带上它。

要在某个 profile 里挂它，就在该 profile 的 `cordis.patch.yml` 里手写一条 insert：

```yaml
- insert:
    - id: kanban-board
      name: "@gavinc-cn/kanban-board"
```

注意两点：① 手写 insert 在 Plugins 面板里**没有行、也没有开关**（面板只渲染 bundle 包自带
patch 里 insert 的行）；② 同一个行 id 在整棵组合树里只能出现一次，所以别在别处再写同名 insert。

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
- 卡片描述里的组件数是写死的文案（`locale/*.json`），加组件/减组件时要一起改（本次
  `kanban-board` 移出、`dsh-patch-ask-expand` 移入，文案从「5 个」→「4 个」→「5 个」，注意
  **两次的 5 个不是同一批**：现在是 4 个纯 UI + `dsh-patch-ask-expand`）。
- 本包因此**不是纯浏览器组件集合**：`dsh-patch-ask-expand` 会在宿主启动时写另一个 npm 包的
  安装目录（`<dsh home>/profiles/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js`）。
  它幂等、失败只记日志（`~/.kimi-code/hooks/logs/patch_ask_expand.log`），但如果你在只读挂载
  或共享安装上跑，会看到「跳过/失败」日志而不是补丁生效。

## License

MIT
