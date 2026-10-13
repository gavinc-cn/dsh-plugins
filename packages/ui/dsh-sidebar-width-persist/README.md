# @gavinc-cn/dsh-sidebar-width-persist

把 DSH Web GUI 左侧边栏的**拖动宽度持久化**到 localStorage：刷新页面、重开浏览器后仍是上次拖出来的宽度；
收起侧栏**不丢**宽度，再展开时回到该宽度（dsh 原生语义是「收起即忘、重开回默认 280」，本插件按用户
2026-10-09 的选择覆盖了后半句）。

## 背景

侧栏宽度只是 `dsh-client-ui-layout` 布局 store 里的一个**内存字段**：

- `createLayoutStore()` 的 `init` 硬编码 `layoutInfo.sidebar = 280`（`columns.d.ts` 的 `SIDEBAR_DEFAULT`）；
- `defineStore` 的 spec **没有传 `persist`**（`@deepseek-ai/dsh-client-store` 是支持 `persist` →
  localStorage 的，`dsh-client-ui-workspace` 的 `dsh.sessions.current` 就是这么存的）。

于是刷新页面 = 重建 store = 必回 280。**这是设计如此，不是 bug**；本插件在不改任何成品包的前提下补上这层持久化。

## 做法

1. 找实例：`ctx.slots.entries("root")` 的条目上带 `.store`（`dsh-client-ui-slots` 把注册时的
   `options.store` 原样存进条目），而 ui-layout 注册时传的是 **`{...handle, create: () => instance}`** ——
   所以 `store.create()` 拿到的就是 AppFrame 正在用的那个活实例。之后 `getSnapshot()` 读、
   `subscribe()` 听、`actions.setSidebar()` 写。
   指纹只做结构判断（`spec.actions.setSidebar` 是函数），不执行别人的 `init`；
   找不到时订阅 `ctx.slots.subscribe("root", …)` 等它注册 / 热重载后重新挂载，不依赖插件加载顺序。
2. 语义（`sidebar` 快照只有三个来源：拖动、`toggleSidebar`、本插件的恢复）：

   | 快照变化 | 处理 |
   |---|---|
   | 首次挂载，盘上有值 | `setSidebar(记住值)` |
   | `>0 → >0`（拖动） | 记为当前值，**去抖 200ms 落盘**（拖动是每帧发布，不能每帧写 localStorage） |
   | `>0 → 0`（收起） | 只记内存，**不落盘**，盘上保留宽度 |
   | `0 → >0`（重开） | 原生写死 280，这里覆盖成盘上的记住值 |

   判据依据：AppFrame 只在 `!sidebarCollapsed` 时渲染拖动把手，**折叠态根本没有把手**，
   所以 `setSidebar` 不可能在 0 态被调用 ⇒ 快照的 `0 → >0` 只可能是「重开」。
3. 兜底：`pagehide` / `visibilitychange(hidden)` 时补一次 flush（刚拖完就刷新不丢值）；
   卸载（禁用插件 / 页面销毁）时摘掉 store 订阅与全局监听。

存储键：`dsh.layout.sidebarWidth`（JSON 数字，264–420）。清掉它即回到「从未拖动过」的原生行为。

## 结构

```
~/.dsh/profiles/node_modules/@gavinc-cn/dsh-sidebar-width-persist/
├── package.json             ← 本地包，零三方依赖；exports["./client"] + dsh.client.platform=web
├── lib/
│   ├── index.js             ← node 半：no-op（纯 UI 插件）
│   └── client.bundle.js     ← 浏览器半：__ModuleLoader__.load({ id: "@gavinc-cn/dsh-sidebar-width-persist", … })
├── test/width.spec.mjs      ← node --test 单测（假 window/document/localStorage + 假 ctx + 假布局 store，测真 bundle）
└── verify/
    ├── e2e_sidebar_width.py ← 真实 Chromium 打 :3080 的 A/B 对照（baseline / plugin 两种模式）
    └── shots/               ← 各阶段整页取证截图
```

## 安装（profile 本地插件）

`~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-sidebar-width-persist
      name: "@gavinc-cn/dsh-sidebar-width-persist"
```

> 注册行的 `id` 与 `name` 都必须是**完整包名**；`lib/client.bundle.js` 里 `__ModuleLoader__.load({ id })`
> 也必须等于包名，否则页面报 "loaded without registering"。

## 生效与回滚

- **新增/删除条目是 live 的**：profile patch 热重载后，客户端 boot 清单（页面 HTML 里的
  `plugins/??…/client.js` 组合行）立刻包含/移除本行，**不需要重启 dsh web**，刷新页面即可生效
  （2026-10-09 实测：写 patch 约 2 秒后 `curl /` 的 HTML 里已出现/消失该行）。
- 改 `lib/client.bundle.js` 本身是热重载（webserver stat-poll 到变化即广播新 rev）。
- 回滚：删掉 patch 条目 + 删除本目录（+ 可选 `localStorage.removeItem("dsh.layout.sidebarWidth")`），
  刷新页面。想临时停用而不删条目：在该行加 `disabled: true`。

## 验证

```bash
npm test                                                   # 16 例单测
python3 verify/e2e_sidebar_width.py --mode plugin          # 真机: 拖动→刷新保持 / 收起→展开恢复
python3 verify/e2e_sidebar_width.py --mode baseline        # 对照: 需先把 patch 条目临时 disabled: true
```

2026-10-09 实测结果（本机 :3080，Chromium 1440×900）：

- baseline（不挂插件）4/4：初始 280 → 拖动 400 → **刷新回到 280**（复现问题）；
- plugin 12/12：拖动 400 → 落盘 `dsh.layout.sidebarWidth=400` → **刷新仍是 400** →
  收起（轨道 56，盘上仍 400）→ 展开**回到 400 而不是原生 280** → 再刷新仍是 400；两条路径 0 console error。

## 已知边界

- 依赖 dsh 内部字段（root 条目的 `store`、`layoutInfo.sidebar`、`toggleSidebar` 的重开值 280）：
  dsh 升级后若结构变化，只 `console.warn` 并降级为「没有这个插件」，不会打断界面。
- **折叠状态本身不持久化**（用户选的是「记住宽度」而不是「记住折叠」）：收起后刷新，侧栏仍是打开的，
  宽度 = 记住值。
- 多标签页：最后一次改动者胜；只在「首次挂载 / 重开」时读盘，不做运行时互相同步。
- 从未拖动过的浏览器里 localStorage 是空的，行为与原生完全一致。
- 存储按浏览器 origin：换端口 / 换 host（如隧道域名）是各自独立的一套。
