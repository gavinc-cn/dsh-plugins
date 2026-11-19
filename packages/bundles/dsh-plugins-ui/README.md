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
| `dsh-dim-text` / `dsh-session-unread-persist` / `dsh-turn-labels` / `dsh-sidebar-width-persist` / `dsh-prompt-recall` | 纯浏览器组件：`exports["./client"]` 指向 `lib/client.bundle.js`，node 半边是空 `apply()` |
| `dsh-feishu` | **Host + client 同包**（2026-10-29 新增）：宿主半边负责飞书扫码/绑定/收发出站/提问审批，浏览器半边提供侧栏面板；因「面向 GUI」归本包 |
| `dsh-session-live-metrics` | **Host projection + client 胶囊**（2026-10-30 新增）：宿主累计逐请求 DeepSeek token 费用和最近 5 分钟 decode 样本，浏览器在状态栏显示近 1 分钟速度与 session 费用估算 |
| `dsh-patch-ask-expand` | **运行体在宿主侧**（没有 `dsh.client`）：启动时对官方 `dsh-client-ui-tool` 的 client bundle 打幂等文本补丁；效果完全是 GUI 观感（提问行默认展开） |
| `dsh-patch-unsent-session` | **运行体在宿主侧**（2026-11-18 新增）：对官方 `dsh-client-ui-workspace` 打幂等文本补丁，让写过草稿的 blank 会话留在侧栏、标题取草稿首行 |
| `dsh-patch-draft-attachment` | **运行体在宿主侧**（2026-11-18 新增）：对官方 `dsh-client-ui-conversation` 打幂等文本补丁，让草稿里的附件跨会话/刷新保留（localStorage 索引 + IndexedDB） |

修订缘由：按旧判据它属运行时包，但「只想装 UI 包」的人就永远发现不了它。判据因此从
「代码跑在哪」改成「面向谁」。其余宿主侧组件（记忆/守卫/沙箱等）仍在
[@gavinc-cn/dsh-plugins-runtime](../dsh-plugins-runtime/README.md)。
两个包的行合起来 = **18 个组件** = 本包 10 + 运行时 bundle 8。`kanban-board`、
`sandbox-path-allowlist`、`dsh-readonly-guard` 与 2026-11-01 迁入 `@gavinc-cn/touchstone-dsh`
的 `dsh-autocommit` 不随本包下发；本包第 5 行是
2026-10-30 新增的 `dsh-session-live-metrics`，第 6 行是 2026-10-29 的 `dsh-prompt-recall`，
第 7 行是同日的 `dsh-feishu`；末三行（8–10）是三个 `dsh-patch-*` 宿主侧补丁，最后两个
`dsh-patch-unsent-session` / `dsh-patch-draft-attachment` 于 2026-11-18 追加。

## 安装

```bash
# 装进某个 profile（pnpm 会把 optionalDependencies 里的 10 个组件包一并装上；
# 镜像缺个别包时只跳过那一个，见下一节）
dsh plugin --profile web add @gavinc-cn/dsh-plugins-ui
```

- CLI 这条路径会在 pnpm 成功后**自动**把新 bundle 追加进 `dsh.profile.bundles`（装完即启用）。
- 走 **Plugins 面板**的安装入口则**不会**自动选择 bundle，装完要自己把整包开关打开。
- **`dsh.profile.bundles` 与 `dependencies` 两处都要有本包名**：前者决定是否作为配置层加载，
  后者决定面板里卡片是否显示（客户端按 `installed` 过滤，只看 `dependencies`）。
- 改了 `dsh.profile.bundles` 要**重启宿主**才生效（启动时读）；profile patch 层是 live 热重载，
  行级开关不需要重启。

### 组件依赖是可选的（2026-11-19 起，缺包不阻塞整包）

10 个组件包写在 `optionalDependencies` 里：镜像缺某个组件时，pnpm 只跳过那一个，其余组件和
bundle 本体照常安装（pnpm 12.4.1 实测）。bundle 仍会进入 `dsh.profile.bundles`；缺失组件的行仍留在
组合树里，宿主启动时只打一条 warning（非 required 行不阻断启动）：

```text
dsh: warning: 1 entry did not activate
dsh-dim-text (@gavinc-cn/dsh-dim-text): failed to import: ... ERR_MODULE_NOT_FOUND
```

面板里该行显示为 failed，其他行不受影响。**装成功 ≠ 10 个组件都在**：缺失的包补装后重启宿主
（重跑 `dsh plugin --profile <p> install`，或镜像恢复后重装本包）即可恢复。若手里已有缺失包的
tgz，也可以在 profile 的 `pnpm-workspace.yaml` 用 `file:` overrides 补上，保留完整 10 个组件；
镜像恢复本身仍按发布 spec 逐包核对。

## 组件（10 个）

| 行 id | 包 | 做什么 |
|---|---|---|
| `dsh-dim-text` | `@gavinc-cn/dsh-dim-text` | 把 Web GUI 文字梯度整体调暗（仅深色模式）；该行详情页可选 **高/中/低** 三档亮度（原来的效果 = 最高档，2026-10-24 新增） |
| `dsh-session-unread-persist` | `@gavinc-cn/dsh-session-unread-persist` | 会话列表「已完成未查看」绿点持久化到 localStorage |
| `dsh-turn-labels` | `@gavinc-cn/dsh-turn-labels` | 右侧轮次刻度轨换成常驻文字（每轮一行显示该轮提问；提问条目直接显示用户回答——蓝色区分、hover 出完整问答，读不到回答时退回原版小横杠） |
| `dsh-sidebar-width-persist` | `@gavinc-cn/dsh-sidebar-width-persist` | 左侧边栏拖动宽度持久化 |
| `dsh-session-live-metrics` | `@gavinc-cn/dsh-session-live-metrics` | 状态栏新增近 1 分钟 decode 加权速度与当前主 session 的 DeepSeek 模型 token 费用估算；含宿主 projection，新增后需重启 |
| `dsh-prompt-recall` | `@gavinc-cn/dsh-prompt-recall` | 当前会话空输入框按 `ArrowUp` 召回上一条真人提问的完整文本；召回后按 `ArrowDown` 恢复原草稿。不自动发送 |
| `dsh-feishu` | `@gavinc-cn/dsh-feishu` | 飞书私聊桥：扫码配置应用、一次性绑定码绑定 open_id、文本/图片/文件入站、答复与云文档出站、飞书内提问/审批双通道；仅私聊且仅插件自建会话 |
| `dsh-patch-ask-expand` | `@gavinc-cn/dsh-patch-ask-expand` | 「提问 / 回答」那一行默认展开。宿主侧实现：启动时写官方 `@deepseek-ai/dsh-client-ui-tool` 的 `lib/client.js`（保留 `.orig` 备份；锚点对不上就跳过，只记日志） |
| `dsh-patch-unsent-session` | `@gavinc-cn/dsh-patch-unsent-session` | 写过草稿但未发送的 blank 会话继续留在侧栏，行标题取草稿首个非空行。宿主侧实现：写官方 `@deepseek-ai/dsh-client-ui-workspace` 的 `lib/client.js` |
| `dsh-patch-draft-attachment` | `@gavinc-cn/dsh-patch-draft-attachment` | composer 草稿里的截图/图片/文件跨会话与刷新保留。宿主侧实现：写官方 `@deepseek-ai/dsh-client-ui-conversation` 的 `lib/client.js`，附件字节额外落 localStorage 索引 + IndexedDB |

行 id 的约定是**包名去掉 scope**（`@gavinc-cn/dsh-turn-labels` → `dsh-turn-labels`）：profile 覆盖行
按它命中，面板开关按它写回。要改组件集合，改本包的 `cordis.patch.yml` 即可（**改完 patch 层当场热重载**）。

### 不随本包下发的组件

`@gavinc-cn/kanban-board`（Web GUI 任务看板）**不在本包内**（2026-10-15 从本包移除：行与
`dependencies` 都删了）。它仍是本仓库 `packages/ui/kanban-board/` 里的组件包（npm 上的
`0.1.3` 也仍可单独安装），只是不随任何 bundle 下发 ⇒ 装本包**不会**带上它。

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
  标题与描述。`pluginPackages.metaOf()` 每次列举都实时读盘（2026-10-15 实测）⇒ 改 `locale`
  刷新面板即可，不必重启宿主（旧版「启动时缓存」的说法已证伪）。
- 组件依赖是 `optionalDependencies`（2026-11-19 起）：缺包时 pnpm 通常**不打印明确的警告**，
  只能从启动 warning 或面板 failed 行发现；若某组件行一直 failed，先查它的包是否真的装上。
- 卡片描述里的组件数是写死的文案（`locale/*.json`），加组件/减组件时要一起改（`kanban-board`
  移出、`dsh-patch-ask-expand` 移入、2026-11-18 追加两个 `dsh-patch-*` 时都已同步；当前是
  **10 个 = 7 个带 `dsh.client` + 3 个 `dsh-patch-*`**）。
- 本包因此**不是纯浏览器组件集合**：`dsh-feishu` 的宿主半边会在 DSH 进程内连接飞书并持有
  WS/定时器；`dsh-session-live-metrics` 在宿主注册 projection；三个 `dsh-patch-*`
  会在宿主启动时写官方 npm 包的安装目录
  （`<dsh home>/profiles/node_modules/@deepseek-ai/dsh-client-ui-{tool,workspace,conversation}/lib/client.js`）。
  它们幂等、失败只记日志（`~/.kimi-code/hooks/logs/patch_{ask_expand,unsent_session,draft_attachment}.log`），
  但如果你在只读挂载或共享安装上跑，会看到「跳过/失败」日志而不是补丁生效。

## License

MIT
