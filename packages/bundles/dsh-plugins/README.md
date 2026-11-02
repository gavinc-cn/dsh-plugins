# @gavinc-cn/dsh-plugins（聚合元包）

> **0.2.0 起本包不再是 bundle。** 它只是一个「装一个拿到全部」的 npm 入口：
> `dependencies` 指向拆分后的两个 bundle 包，自身不含 `dsh.bundle`、不含任何 `cordis.patch.yml`。

| 版本 | 语义 |
|---|---|
| `0.1.0` / `0.1.1` | 单包全量 bundle：`cordis.patch.yml` 里 13 条 `- insert:`，面板一张卡片 |
| `0.2.0` 起 | 聚合元包：13 个组件拆成两个 bundle，本包只把它们一起装上 |

（拆分时是 UI 5 个 / 运行时 8 个 = 13 行；2026-10-15 `kanban-board` 移出 UI bundle ⇒ 12 行；同日
`dsh-patch-ask-expand` 从运行时 bundle 移到 UI bundle ⇒ UI 5 个 / 运行时 7 个，合计仍 12 个；
2026-10-17 运行时 bundle 新增 `dsh-path-rules`、退役 `sandbox-path-allowlist` ⇒ 仍 12 个；
2026-10-20 运行时 bundle 新增 `dsh-write-guard` ⇒ UI 5 + 运行时 8 = **13 行**；
2026-10-24 运行时 bundle 新增 `dsh-sandbox-whitelist` 与 `dsh-fs-whitelist`（两个 provider，均默认停用）、
同日退役 `dsh-readonly-guard` ⇒ **14 行**（UI 5 + 运行时 9）；2026-10-29 UI 新增 `dsh-prompt-recall` ⇒ **15 行**（UI 6 + 运行时 9）；同日再加入 `dsh-feishu` ⇒ **16 行**（UI 7 + 运行时 9）；2026-10-30 加入 `dsh-session-live-metrics` ⇒ **17 行**（UI 8 + 运行时 9）；2026-11-01 运行时迁出
`dsh-autocommit`（并入 `@gavinc-cn/touchstone-dsh`）⇒ **16 行**（UI 8 + 运行时 8）。）

## 拆分后的两个 bundle

| 包 | 组件数 | 判据 | 面板卡片 |
|---|---|---|---|
| [@gavinc-cn/dsh-plugins-ui](../dsh-plugins-ui/README.md) | 8 | **面向 Web GUI**：7 个声明 `dsh.client.platform: "web"` 的组件（5 个纯浏览器 + Host/client 同包的 `dsh-feishu`、`dsh-session-live-metrics`）+ `dsh-patch-ask-expand`（宿主侧启动时给官方 client bundle 打补丁，效果也是 GUI 观感） | 标题 = 包名 `@gavinc-cn/dsh-plugins-ui` |
| [@gavinc-cn/dsh-plugins-runtime](../dsh-plugins-runtime/README.md) | 8 | 宿主（node）侧的运行支撑组件（记忆/守卫/路径规则与写入闸门、多根沙箱与文件白名单 provider 等），没有 `dsh.client` | 标题 = 包名 `@gavinc-cn/dsh-plugins-runtime` |

两个包合起来 = **16 行**；`kanban-board`、`sandbox-path-allowlist`（2026-10-17 由 `dsh-path-rules`
合并退役）、`dsh-readonly-guard`（2026-10-24 退役）与 `dsh-autocommit`（2026-11-01 迁入
`@gavinc-cn/touchstone-dsh`）不随本包的任何 bundle 下发，仍留在仓库作回滚真源。
既有行 id 与相对顺序都没变（新行只插在中间/末尾）⇒ 各 profile 的覆盖行原样继续命中
（`dsh-patch-ask-expand` 从 runtime 移到 UI 时也是如此，**profile 无需改动**）。

## 安装

```bash
# 想一次拿到两个 bundle 带来的 16 个组件的依赖（但仍要分别选 bundle）
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
