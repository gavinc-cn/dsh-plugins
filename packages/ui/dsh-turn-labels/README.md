# @gavinc-cn/dsh-turn-labels

把 DSH Web GUI 右侧的**轮次刻度轨**换成**常驻文字列表**。

## 作用

- 每轮一行，显示该轮的用户提问；当前轮高亮；hover 显示「提问 + 回答」预览；点击跳转到该轮。
- 每轮文字行下方，为该轮的 `ask_user_question` 各加一条原版小横杠，点击跳到该提问的位置
  （展开候选限定在同一会话滚动区内，避免误点侧栏按钮）。
- 列宽跟着正文栏宽度自适应（无下限，文字超宽截断），正文拉宽后不压正文。

## 结构

```
lib/index.js          node 半：纯 UI 插件，host 无行为（apply 为空）
lib/client.bundle.js  浏览器半：window.__ModuleLoader__.load({ id: "@gavinc-cn/dsh-turn-labels", … })
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
