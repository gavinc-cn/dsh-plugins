# @gavinc-cn/dsh-plugins（聚合元包）

> **0.2.0 起本包不再是 bundle。** 它只是一个「装一个拿到全部」的 npm 入口：
> `dependencies` 指向拆分后的两个 bundle 包，自身不含 `dsh.bundle`、不含任何 `cordis.patch.yml`。

| 版本 | 语义 |
|---|---|
| `0.1.0` / `0.1.1` | 单包全量 bundle：`cordis.patch.yml` 里 13 条 `- insert:`，面板一张卡片 |
| `0.2.0` 起 | 聚合元包：13 个组件拆成两个 bundle，本包只把它们一起装上 |

（拆分时是 UI 5 个 / 运行时 8 个；2026-10-15 `kanban-board` 移出 UI bundle 后两个 bundle
合计 12 个；同日 `dsh-patch-ask-expand` 从运行时 bundle 移到 UI bundle ⇒ UI 5 个 / 运行时 7 个，
合计仍是 12 个；2026-10-17 运行时 bundle 新增 `dsh-path-rules`、同时退役 `sandbox-path-allowlist`
⇒ 仍是 UI 5 个 / 运行时 7 个，合计 **12 个**。）

## 拆分后的两个 bundle

| 包 | 组件数 | 判据 | 面板卡片 |
|---|---|---|---|
| [@gavinc-cn/dsh-plugins-ui](../dsh-plugins-ui/README.md) | 5 | **面向 Web GUI**：4 个纯浏览器组件（声明 `dsh.client.platform: "web"`）+ `dsh-patch-ask-expand`（宿主侧启动时给官方 client bundle 打补丁，效果也是 GUI 观感） | 标题 = 包名 `@gavinc-cn/dsh-plugins-ui` |
| [@gavinc-cn/dsh-plugins-runtime](../dsh-plugins-runtime/README.md) | 7 | 宿主（node）侧的运行支撑组件（记忆/守卫/路径规则闸门等），没有 `dsh.client` | 标题 = 包名 `@gavinc-cn/dsh-plugins-runtime` |

两个包合起来 = **12 行**；`kanban-board` 与 `sandbox-path-allowlist`（后者 2026-10-17 由
`dsh-path-rules` 合并退役）不随任何 bundle 下发，仍留在仓库作回滚真源。
行 id 与相对顺序都没变 ⇒ 各 profile 的覆盖行原样继续命中（`dsh-patch-ask-expand` 从 runtime
移到 UI 时也是如此，**profile 无需改动**）。

## 安装

```bash
# 想一次拿到两个 bundle 带来的 12 个组件的依赖（但仍要分别选 bundle）
pnpm add @gavinc-cn/dsh-plugins

# 真正把它挂进某个 profile：分别装两个 bundle（dsh plugin 会把包名追加进 dsh.profile.bundles）
dsh plugin --profile web add @gavinc-cn/dsh-plugins-ui
dsh plugin --profile web add @gavinc-cn/dsh-plugins-runtime
```

**不要**把本包名写进 `dsh.profile.bundles`：它声明不了 `dsh.bundle`，加载时会被判为
`declares no dsh.bundle` 并跳过该层（面板里也会显示成一条 `not-bundle` 异常卡片）。
用 `dsh plugin add @gavinc-cn/dsh-plugins` 装它时，CLI 会按**普通依赖**安装并打一条同样的 warning —— 这是预期行为。

两个 bundle 的 `dsh.profile.bundles` + `dependencies` 都要写（后者决定面板卡片是否显示），
改完重启宿主才生效；行级开关是 live 热重载。

## License

MIT
