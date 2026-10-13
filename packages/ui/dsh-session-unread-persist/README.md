# @gavinc-cn/dsh-session-unread-persist

把 DSH Web GUI 会话列表的「已完成未查看」**绿点持久化**到 localStorage：刷新页面、重开浏览器后绿点仍在，
点开会话后照常消失且不再回弹。

## 背景

绿点原本只是 Web 客户端 `UiSession` 服务里的一个内存 `Set`（`completionUnread`），刷新即重建为空；
宿主只在 agent 状态**变化**时广播 `api-session/status`、重连不回放，因此刷新后绿点必然消失。
本插件在不改任何成品包的前提下，把这个集合镜像到 localStorage。

## 行为要点

- **播种**：`apply(ctx)` 时读存储 → 灌回内存集合 → `publishStatus()`（列表 `phase === "pending"` 时也照常播种）。
- **对账**：`sessionStatus` / `sessions.list` 的每次通知合并到一个微任务里执行，避开 dsh 自己延迟发布的列表快照。
- **清理判据**：会话不在列表（且曾出现过）/ 原生运行表也同意它在跑 / 已成为当前查看的会话 → 剪掉；列表非 `ready` 时一律不清理。
- **多标签页**：监听 `storage` 事件，只采纳「别的标签页标为已读」的删除，不采纳新增。
- **容错**：无 localStorage、坏 JSON、结构缺字段 → 只 `console.warn`，降级为「没有这个插件」。
- 卸载时 `ctx.effect` 的清理函数摘掉订阅与 `storage` 监听。

存储键：`dsh.sessions.completionUnread`（JSON 字符串数组）。

## 结构

```
lib/index.js             node 半：no-op（纯 UI 插件）
lib/client.bundle.js     浏览器半：__ModuleLoader__.load({ id: "@gavinc-cn/dsh-session-unread-persist", … })
test/persist.spec.mjs    node --test 单测（假 window/__ModuleLoader__ + 假 ctx，测真 bundle）
verify/                  真实 Chromium 端到端脚本 + 整页取证截图（开发用，不随包发布）
```

## 安装

本包**不是 bundle 型包**（未声明 `dsh.bundle`），`dsh plugin add` 只会装成普通依赖、不会加载。
按 profile 本地插件方式安装：

1. 把包放到 `<dsh home>/profiles/node_modules/@gavinc-cn/dsh-session-unread-persist/`；
2. 在 `<profile>/cordis.patch.yml` 增加注册行：

```yaml
- insert:
    - id: dsh-session-unread-persist
      name: "@gavinc-cn/dsh-session-unread-persist"
```

3. 重启一次 dsh web。彻底清理可在浏览器控制台执行
   `localStorage.removeItem("dsh.sessions.completionUnread")`。

> 注册行的 `name` 必须是完整包名；`lib/client.bundle.js` 里 `__ModuleLoader__.load({ id })` 的 id
> 也必须等于完整包名，改了 scope 要同步改 bundle，否则页面报 "loaded without registering"。

## 开发

```bash
npm test        # node --test test/persist.spec.mjs
```

## 已知边界

- 零三方依赖；浏览器半的 React 由宿主 `require("react")` 播种。
- 依赖 `uiSession.completionUnread` / `sessions.list` 快照等内部字段，dsh 升级后若结构变化需同步更新。
