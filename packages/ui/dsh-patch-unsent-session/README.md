# @gavinc-cn/dsh-patch-unsent-session

让 DSH Web 侧栏继续显示**写过草稿但还没发送**的新会话（官方 `blank` Session），并用草稿首行做行标题。

## 问题

官方 `@deepseek-ai/dsh-client-ui-workspace` 的 `sessionVisible()` 只保留**当前选中**的 blank Session：

```js
if (session.blank && session.id !== current) return false
```

于是用户在新会话输入框里写了一段话、切到别的会话后，这一行就从侧栏消失；草稿其实还留在
`localStorage["dsh.conversation.<sessionId>"]`，但界面上没有入口回到它。重新点「新会话」只会打开
当前 Workspace 的那一个 blank，换过 Workspace 时就找不回来了。

## 做法

本包是宿主侧 Cordis 插件，不注册任何客户端 slot；启动时对 webserver 实际服务的
`@deepseek-ai/dsh-client-ui-workspace/lib/client.js` 打两处幂等文本补丁：

1. `sessionVisible()`：blank 会话只要 `localStorage` 里有非空文字/引用草稿，就继续显示；
2. `displayTitle()`：这类行的标题改成草稿首个非空行（超过 48 字符截断），不再一律显示「新会话」。

补丁只读侧栏已有的数据，不改 Session、不改草稿存储格式、不新增网络请求。官方文件内容一变，
dsh web 的 HMR 会自动让浏览器重新拉取，无需重启。

## 配置

profile patch 的覆盖行里可选：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `disable` | `false` | 只停止后续重打补丁，不撤销已经写入的内容 |
| `bundlePath` | `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js` | 补丁目标 |
| `logPath` | `~/.kimi-code/hooks/logs/patch_unsent_session.log` | 结果日志 |
| `reapply` | `false` | 定时兜底重打（成品包被重装覆盖时） |
| `reapplyMs` | `5000` | 兜底间隔（≥1000） |

## 已知边界

- 只认文字与引用草稿；**纯附件草稿**本来就不进 `localStorage`（官方行为），侧栏不会为它保留行。
- 标题是渲染时读 `localStorage` 的快照：在当前 blank 里继续输入不会实时刷新侧栏标题，切走再切回后才是最新首行。
- 官方升级后 bundle 被压缩/改写时锚点会失配：补丁整体拒绝并写日志，不会半打补丁；需要按新写法更新 `lib/patch.mjs` 的锚点。
- 与 `@gavinc-cn/dsh-patch-ask-expand` 一样，补丁写的是全局安装的成品包文件，升级/重装 dsh 后要重新应用（默认每次启动重打，`reapply` 可兜底）。

## 验证

- 单测：`node --test packages/ui/dsh-patch-unsent-session/test/patch.spec.mjs`（9/9）。
- 真机（补丁生效后刷新页面）：`verify/shots/unsent-row.png` = 切到其它会话后草稿行仍在；
  `verify/shots/unsent-row-reload.png` = 刷新页面后行与草稿都还在。
- 面板里的新行要**重启 dsh web** 才出现（新增 bundle 行不热加载）；补丁本身由 HMR 立即生效。

## 移除

在 Plugins 面板关闭本行（只停止重打），再把 `lib/client.js.orig` 覆盖回 `lib/client.js`
（或重装 `@deepseek-ai/dsh-client-ui-workspace`），刷新页面。
