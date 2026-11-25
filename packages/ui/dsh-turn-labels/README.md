# @gavinc-cn/dsh-turn-labels

把 DSH Web GUI 右侧的**轮次刻度轨**换成**常驻文字列表**。

## 作用

- 每轮一行，显示该轮的用户提问；当前轮高亮；hover 显示「提问 + 回答」预览；点击跳转到该轮。
- 每个 `ask_user_question` 条目**直接显示用户回答**（0.6.0 起）：一行一个回答，用品牌蓝 accent
  与用户提问行的墨色区分，并**左缩进 8px**（= 提问文字前面那根 2px 高亮条 + 6px 间距）—— 蓝色回答
  的起点与白色提问文字齐平，不会比用户输入更靠左（0.6.1）；hover 出「完整问答」预览（列表那一行
  会被省略号截断）；点击跳到该提问的位置
  （展开候选限定在同一会话滚动区内，避免误点侧栏按钮）。
  - **回答的主口径是会话事件**（0.7.0 起）：原生读 `tool/call` + `tool/result`，PTC 读
    `tool/ptc-dispatch-start` + `tool/ptc-dispatch`（子调用事件不带 turn/step，轮次由
    `parentCallId` 反查父 `run_code` 的 `tool/call`）。这样**提问行是否展开都不影响**回答行 ——
    官方答案卡只在行展开时才渲染，靠 `dsh-patch-ask-expand` 默认展开只是外部补丁（该补丁
    2026-11-20 起曾因官方 bundle 换写法而失效，导致回答行全退回小横杠）。
  - DOM 里的答案卡是**补充口径**：事件里没有这条（例如父调用已滚出事件窗口）时，才读
    `[data-tool="ask_user_question"]` 行内 `dl dd` 的 `textContent`（不能用 `innerText`，
    提问行常处在 `hidden="until-found"` 的折叠组里）；两边都读不到时（未作答 / 整题被跳过 /
    被中断）退回原版小横杠。
  - 事件里多出来的提问**不新增**轨道条目：条目集合仍只覆盖"已加载窗口"，与 0.6.x 行为一致。
- 列宽跟着正文栏宽度自适应（无下限，文字超宽截断），正文拉宽后不压正文。

## 结构

```
lib/index.js          node 半：纯 UI 插件，host 无行为（apply 为空）
lib/client.bundle.js  浏览器半：window.__ModuleLoader__.load({ id: "@gavinc-cn/dsh-turn-labels", … })
test/turn-labels.spec.mjs  单测（node --test）：桩 React + 桩 DOM 跑**真 bundle**
```

## 测试

```bash
node --test test/turn-labels.spec.mjs     # 或 scripts/test-all.sh dsh-turn-labels
```

## 安装

本包**不是 bundle 型包**（未声明 `dsh.bundle`），`dsh plugin add` 只会装成普通依赖、不会加载。
按 profile 本地插件方式安装：

1. 把包放到 `<dsh home>/profiles/node_modules/@gavinc-cn/dsh-turn-labels/`；
2. 在 `<profile>/cordis.patch.yml` 增加注册行：

```yaml
- insert:
    - id: dsh-turn-labels
      name: "@gavinc-cn/dsh-turn-labels"
```

3. 重启一次 dsh web（新增条目要重进启动清单；之后改插件文件本身是热重载）。

> 注册行的 `name` 必须是完整包名；`lib/client.bundle.js` 里 `__ModuleLoader__.load({ id })` 的 id
> 也必须等于完整包名，改了 scope 要同步改 bundle，否则页面报 "loaded without registering"。

## 已知边界

- 零三方依赖；浏览器半的 React 由宿主 `require("react")` 播种。
- 依赖 dsh 客户端的会话/轮次数据结构，dsh 升级后若结构变化需要同步更新 bundle。