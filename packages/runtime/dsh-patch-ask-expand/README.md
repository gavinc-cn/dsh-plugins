# @gavinc-cn/dsh-patch-ask-expand

让 DSH Web GUI 里「提问 / 回答」这一行（`ask_user_question`）**默认展开**。

## 做法与风险（请先读）

`@deepseek-ai/dsh-client-ui-tool` 是 npm 上的成品包（本机没有对应源码），因此本插件在启动时对该包的
client bundle 打一个**幂等文本补丁**：

```
<dsh home>/profiles/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js
```

⚠️ **它会改写另一个已安装包的源文件**（并保留 `.orig` 备份）。dsh 升级或 `dsh-client-ui-tool` 升级后
锚点可能失效，此时插件会检测到并**跳过**（日志里提示核对 `ToolRow` / `QuestionToolRow` 的
`expandable` / `open` 写法后更新锚点），不会把文件改坏。

卸载方式：从 profile patch 删掉注册行，再把 `lib/client.js.orig` 覆盖回 `lib/client.js`。

## 结构

```
lib/index.mjs    node 半：启动时应用/回滚补丁（apply）
lib/patch.mjs    幂等文本补丁的实现（applyPatch / isPatched / restoreOriginal）
test/            node --test 单测 + 组件渲染测试（开发用，不随包发布）
```

## 配置（profile patch 的条目 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `disable` | `false` | 置 `true` 时不打补丁（可用来临时关掉） |
| `bundlePath` | `<dsh home>/profiles/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js` | 目标文件 |
| `logPath` | `<home>/.kimi-code/hooks/logs/patch_ask_expand.log` | 日志文件 |
| `reapply` | `false` | 置 `true` 时周期性复查并重打补丁（用于 dsh 热升级后自动修复） |
| `reapplyMs` | `5000` | 复查间隔（≥1000ms） |

## 安装

本包**不是 bundle 型包**（未声明 `dsh.bundle`），`dsh plugin add` 只会装成普通依赖、不会加载。
按 profile 本地插件方式安装：

1. 把包放到 `<dsh home>/profiles/node_modules/@gavinc-cn/dsh-patch-ask-expand/`；
2. 在 `<profile>/cordis.patch.yml` 增加注册行（需要调参时在条目上加 `config:`）：

```yaml
- insert:
    - id: dsh-patch-ask-expand
      name: "@gavinc-cn/dsh-patch-ask-expand"
```

3. 重启一次 dsh web。

## 开发

```bash
npm test        # node --test test/patch.spec.mjs test/component-render.spec.mjs
```

## 已知边界

- 零三方依赖（只用 `node:` 内置模块）。
- 强依赖被补丁包的文本结构，属「成品包补丁」形态，dsh 升级后需要跟进锚点。
