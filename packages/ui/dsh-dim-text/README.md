# @gavinc-cn/dsh-dim-text

把 DSH Web GUI 的**文字梯度整体调暗**：默认是「调暗一档」，2026-10-24 起可以在
**插件页**里选 **高 / 中 / 低** 三档亮度（**原来的调暗效果 = 最高档「高」**）。

## 作用

经官方扩展点 `ctx.theme.overrideTokens` 覆盖三个 token：

| token | 说明 |
|---|---|
| `--dsw-alias-label-primary` | 主文字 |
| `--dsw-alias-label-secondary` | 次级文字 |
| `--dsw-alias-label-tertiary` | 三级文字 |

**仅深色模式生效**，浅色模式不动（三档的 `light` 值都填原色）。

三档 = 三个 token 沿 DSH 自带的中性蓝灰色板（`--dsw-static-neutral-bluish-*`）**整体下移
一级 / 两级 / 三级**，所以每档内部的层次关系（主要 > 次要 > 三级）保持一致：

| 档位 | primary | secondary | tertiary | 对深色背景 `#151517` 的对比度 |
|---|---|---|---|---|
| 高（默认，原来的效果）| `#cfd3d6`（300）| `#adb2b8`（400）| `#979da6`（500）| 12.11 : 8.54 : 6.68 |
| 中 | `#adb2b8`（400）| `#979da6`（500）| `#81858c`（600）| 8.54 : 6.68 : 4.92 |
| 低 | `#979da6`（500）| `#81858c`（600）| `#61666b`（700）| 6.68 : 4.92 : 3.14 |

只做三档的原因：再下一级（色板 600/700/750）的三级文字 `#43454a` 对 `#151517` 只剩 ~1.9:1，
比 DSH 自己最暗的 caption 文字还暗，没有可用性。

## 在插件页里选档位

侧边栏 **插件** → 已安装插件卡片 **`@gavinc-cn/dsh-plugins-ui`** → 组件行
**「界面文字调暗」** → 点行标题进入该行的配置页：三段选择 **高 / 中 / 低**，
选中**立即生效**（无需保存按钮），下方有该档位的「深色模式预览」色样。

实现方式：浏览器半经官方 keyed slot **`plugins.row.config`** 注册页面，key 是
`<bundle 包名>#<行 id>` = **`@gavinc-cn/dsh-plugins-ui#dsh-dim-text`**。
本插件**没有宿主侧 settings 命名空间**、也不使用插件管理器的配置表单（`form` 参数不用）——
档位由插件自己持久化，因此**不需要为这个页面重启 dsh web**。

> ⚠️ 如果把这个包单独挂到别的 bundle/别的手写 insert 行（行 id 不是 `dsh-dim-text`、
> 或者所在 bundle 不是 `@gavinc-cn/dsh-plugins-ui`），key 对不上 ⇒ 页面不会出现，
> 但插件本体（调暗 + 默认高）照常工作。要改组合方式时同步改
> `lib/client.bundle.js` 里的 `ROW_CONFIG_KEY`。

## 档位持久化

- 键：`localStorage["dsh.dim-text.level"]`，JSON 字符串 `"high" | "medium" | "low"`。
  清掉它 = 回到默认「高」（`localStorage.removeItem("dsh.dim-text.level")`）。
- 与 `dsh-sidebar-width-persist` / `dsh-session-unread-persist` 同一套做法：
  只影响本浏览器 origin，刷新不丢，多标签页经 `storage` 事件同步（只采纳、不回写）。
- localStorage 不可用/坏 JSON/非法值：只 `console.warn` 一次并回落到「高」，不影响插件生效。

## 结构

```
lib/index.js          node 半：纯 UI 插件，host 无行为（apply 为空）
lib/client.bundle.js  浏览器半：window.__ModuleLoader__.load({ id: "@gavinc-cn/dsh-dim-text", … })
test/brightness.spec.mjs  node --test 单测（假 window/localStorage/ctx，materialize 真 bundle）
verify/e2e_brightness_levels.py  Playwright 真机 e2e（真实 dsh web :3080，需 DSH_WEB_TOKEN）
```

浏览器半的 `require("react")` / `require("@deepseek-ai/dsh-client-ui-primitives")` 都走
DSH 客户端的**平台模块表**（`window.__DSH_BOOT__` 的 seed table），零三方依赖；
`dsh.client.external` 不需要声明（两者都是基线模块）。

## 安装

本包**不是 bundle 型包**（未声明 `dsh.bundle`），`dsh plugin add` 只会装成普通依赖、不会加载。
正常用法是装它所属的 bundle：`@gavinc-cn/dsh-plugins-ui`。
单包手挂时按 profile 本地插件方式安装：

1. 把包放到 `<dsh home>/profiles/node_modules/@gavinc-cn/dsh-dim-text/`；
2. 在 `<profile>/cordis.patch.yml` 增加注册行：

```yaml
- insert:
    - id: dsh-dim-text
      name: "@gavinc-cn/dsh-dim-text"
```

3. 重启一次 dsh web（新增条目要重进启动清单；之后改插件文件本身是热重载）。

> 注册行的 `name` 必须是完整包名；`lib/client.bundle.js` 里 `__ModuleLoader__.load({ id })` 的 id
> 也必须等于完整包名，改了 scope 要同步改 bundle，否则页面报 "loaded without registering"。
>
> 注意：手挂行不属于任何 bundle 包时，插件管理器里没有对应的行，也就没有配置页——
> 调暗本体仍按默认「高」生效；想要配置页请用 `@gavinc-cn/dsh-plugins-ui` 下发。

## 测试

```bash
node --test packages/ui/dsh-dim-text/test/brightness.spec.mjs
# 真机 e2e（先部署到共享活副本；token 取 dsh web 启动日志里的 ?token=）
DSH_WEB_TOKEN=<token> python3 packages/ui/dsh-dim-text/verify/e2e_brightness_levels.py
# 截图默认落 /tmp/dsh-dim-text-e2e/shots/；要刷新仓库里已提交的证据图：
#   DSH_E2E_SHOTS=packages/ui/dsh-dim-text/verify/shots DSH_WEB_TOKEN=<token> python3 …e2e_brightness_levels.py
```

## 部署（web + 桌面端都要生效）

- **web**：`bash scripts/deploy-to-dsh.sh dsh-dim-text dsh-plugins-ui`（共享活副本；浏览器插件
  由 client 模块系统热替换）。
- **desktop**：桌面 profile 有自己的本地物化副本（`~/.dsh/profiles/desktop/node_modules/@gavinc-cn/*`）
  会遮蔽共享副本，必须加 `--desktop`：
  `bash scripts/deploy-to-dsh.sh --desktop dsh-dim-text dsh-plugins-ui`。
  客户端半约 2 秒热替换（`dsh-client-hmr` 500ms stat-poll + SSE），不用重启桌面端。
- 注意：`--desktop` 是本地开发回路，桌面端插件面板/pnpm 重装会按 registry 盖回旧版；正式生效
  要发 npm 后在桌面端插件面板更新。细节见仓库 `docs/OPERATIONS-local.md`「双端部署」节。

## 已知边界    

- 覆盖的是 dsh 主题 token（`--dsw-alias-label-*`），token 名变化（dsh 升级）时需要同步更新。
- 档位是**浏览器本地**偏好，不同浏览器/隐身窗口各自独立；要跨浏览器一致需另加宿主侧配置
  （那需要改宿主代码并重启 dsh web，本插件刻意没这么做）。
- `plugins.row.config` 槽需要 DSH 客户端 UI 插件管理器（0.2.1-rc.2 起有）；更老的 dsh
  没有这个槽时页面注册会一直挂着不显示，调暗本体不受影响。
