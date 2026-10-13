# @gavinc-cn/kanban-board

DSH（DeepSeek Harness）Web GUI 的任务看板插件：五列「待开发 / 正在开发 / 阻塞 / 待审核 / 已完成」，
把「起一个 agent 会话干活」这件事做成拖卡片。

## 作用

- 侧栏入口（`sidebar.footer.action`）开关 + `shell.overlay` 全屏看板。
- **拖入「正在开发」** → `session.create` + `session.prompt` 自动创建会话交给 agent 执行。
- 会话跑完 → 卡片自动移入「待审核」。
- agent 提问 / 请求审批（`events.mux` 的提问帧）→ 卡片自动移入「阻塞」，可直接在卡片上回答；
  回答后自动回到「正在开发」。
- 监听 `events.host`：主界面增删改工作区 → 看板左侧工作区栏实时同步。
- 状态持久化在浏览器 localStorage（键 `kanban-board-state`，另有独立的看板设置键与评论草稿键）。

## 结构

```
lib/index.js          node 半：纯 UI 插件，host 无行为（apply 为空）
lib/client.bundle.js  浏览器半：window.__ModuleLoader__.load({ id: "@gavinc-cn/kanban-board", … })
```

`package.json` 用 `exports["./client"]` + `dsh.client.platform = "web"` 声明浏览器半，由 dsh web 扫描发现。

## 安装

本包**不是 bundle 型包**（未声明 `dsh.bundle`），所以 `dsh plugin --profile web add @gavinc-cn/kanban-board`
只会把它装成普通依赖 + 一行 warning，**不会被加载**。按 profile 本地插件方式安装：

1. 把包放到 `<dsh home>/profiles/node_modules/@gavinc-cn/kanban-board/`（或 `npm i @gavinc-cn/kanban-board` 装到该目录）；
2. 在 `<profile>/cordis.patch.yml` 增加注册行：

```yaml
- insert:
    - id: kanban-board
      name: "@gavinc-cn/kanban-board"
```

3. 重启一次 dsh web（新增条目要重进启动清单；之后改插件文件本身是热重载）。

> 注册行的 `name` 必须是完整包名；`lib/client.bundle.js` 里 `__ModuleLoader__.load({ id })` 的 id
> 也必须等于完整包名，改了 scope 要同步改 bundle，否则页面报 "loaded without registering"。

## 已知边界

- 新会话的工作目录运行时解析，无硬编码路径，顺序为：
  ① 看板对应的工作区目录（`ws.path`，此时会话也挂在该工作区下）
  → ② 看板自己记录的 `boards[key].cwd`（工作区被删后保留的最后一次目录）
  → ③ 宿主工作区列表里的第一个目录（未分组看板"跟着宿主走"，只借用目录、不挂到该工作区）
  → ④ 都没有时**不传 `cwd`**，由宿主回退到自己的默认目录（`session.create` 的 `cwd` 与
  `workspaceId` 都是可选的）。
- 不要用 `~` 当兜底：宿主不对 `cwd` 做 `~` 展开，`mkdir('~')` 会真的建出一个名为 `~` 的目录。
- 零三方依赖；浏览器半的 React 由宿主 `require("react")` 播种。
