# dsh-plugins —— @gavinc-cn 的 DSH 插件集

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的自研插件：**15 个组件包** +
**2 个 bundle** + **1 个聚合元包**。本仓库是这些插件源码的真源，npm 上的包由这里的
`packages/<分组>/<包>/` 逐个发布。

## 装什么、怎么装

| 想要什么 | 装哪个 | 装完得到 |
|---|---|---|
| 全都要 | `@gavinc-cn/dsh-plugins` | 16 个包：13 个组件 + 2 个 bundle + 元包自身（靠 `dependencies` 传递） |
| 只要 UI 那 5 个 | `@gavinc-cn/dsh-plugins-ui` | 6 个包：5 个面向 Web GUI 的组件 + bundle |
| 只要运行时那 8 个 | `@gavinc-cn/dsh-plugins-runtime` | 9 个包：8 个宿主侧组件 + bundle |

> **版本说明（2026-10-21，第 8 轮）**：新增组件包 `dsh-write-guard@0.1.0`（首发）—— 第六权限模式
> 「完全权限（拦截）」的逐调用写入闸门：读任意文件放行；项目内（会话工作区根）与白名单目录写直通；
> 越界写弹框并把目录自动学进白名单；静态判不出写目标的 `bash`/`pwsh` 交当前会话模型判定（safe →
> 放行，unsafe/unknown → 带理由问用户）。**只在预设身份为 `write-guard` 时介入**，其余档位零影响；
> 插件停用 = 完全不拦截。随之 `dsh-path-rules@0.1.3` 新增 `./analyze` 等 subpath exports（行为不变，
> 供 write-guard 复用判定链）、`dsh-plugins-runtime@0.1.5` 加入第 8 行（依赖范围提到 `^0.1.3` 与
> `^0.1.0`）、聚合元包 `dsh-plugins@0.2.3` 更新组件数文案。上表包数是本仓库当前代码的形态。
>
> **版本说明（2026-10-18，第 6 轮）**：`dsh-path-rules@0.1.1` 新增 `autoWhitelist` —— 用户批准一次
> 沙箱升权写入后，把该目录记进自动白名单，同目录后续的升权请求由插件自动放行、不再弹框
> （**默认关闭**；状态文件在 `<dsh home>/path-rules/auto-whitelist.json`，可用 `autoWhitelistFile`
> 覆盖）。`dsh-plugins-runtime@0.1.3` 的 README 同步记录该参数，对 `dsh-path-rules` 的依赖范围提到
> `^0.1.1`；聚合元包 `dsh-plugins@0.2.2` 内容未变、不重发。
>
> **版本说明（2026-10-19，第 7 轮）**：`dsh-path-rules@0.1.2` 起，路径规则档成为 `workspace-write`
> 的**超集**：判不出读写的命令不再命令级拒绝，默认透传给沙箱按运行时拦截（`unanalyzable: pass`）；
> 白名单目录的写入会预置升权、一次成功且不弹框（`preemptiveWhitelistEscalation`）；判不出的命令
> 会对命令文本做黑名单粗检（`opaqueBlacklistScan`，黑名单「读」的唯一兜底）。回滚：`unanalyzable: deny`
> + `preemptiveWhitelistEscalation: false`。`dsh-plugins-runtime@0.1.4` 的 README 同步记录上述默认值
> 与参数，对 `dsh-path-rules` 的依赖范围提到 `^0.1.2`；聚合元包 `dsh-plugins@0.2.2` 内容未变、不重发。
>
> **版本说明（2026-10-18）**：`dsh-plugins-runtime@0.1.2` / `dsh-plugins@0.2.2` 起，新增组件包
> `dsh-path-rules@0.1.0`（首发）—— ① 运行时 bundle 用 `dsh-path-rules`（第五权限模式「路径规则」的
> 逐调用闸门）替换职责重叠的 `sandbox-path-allowlist`，后者**合并退役**：行与依赖移除，包本体仍留在
> 仓库 `packages/runtime/sandbox-path-allowlist/` 作回滚真源、npm 上也可单独安装；② 随 bundle 下发的
> 组件仍是 12 个（UI 5 + 运行时 7），上表包数不变。
>
> **版本说明（2026-10-16）**：`dsh-plugins-ui@0.1.1` / `dsh-plugins-runtime@0.1.1` 起 ——
> ① `kanban-board` 不再随 UI bundle 下发；② `dsh-patch-ask-expand` 从运行时 bundle 移到 UI bundle
> （它同时 bump 到 0.1.2），UI bundle 对 `dsh-turn-labels` 的依赖范围随之提到 `^0.6.1`
> （`dsh-turn-labels@0.6.x` 新增「提问条目直接显示用户回答」）。上表的包数是本仓库当前代码的形态。

```bash
npm i @gavinc-cn/dsh-plugins          # 或者 pnpm add
```

> **装下来 ≠ 已启用。** 还要把 **bundle 包名**写进目标 profile 的 `dsh.profile.bundles`
> 与 `dependencies` 两处，然后**重启宿主**：`bundles` 清单是启动时读的，改完不重启不生效。
> `dependencies` 那处决定 Plugins 面板里是否显示这张卡片。

```jsonc
// <profile>/package.json
{
  "dsh": { "profile": { "bundles": ["@gavinc-cn/dsh-plugins-ui", "@gavinc-cn/dsh-plugins-runtime"] } },
  "dependencies": {
    "@gavinc-cn/dsh-plugins-ui": "^0.1.0",
    "@gavinc-cn/dsh-plugins-runtime": "^0.1.0"
  }
}
```

## 包里有什么

### `@gavinc-cn/dsh-plugins-ui`（5 个，面向 Web GUI）

| 组件 | 说明 |
|---|---|
| `dsh-dim-text` | 文字梯度整体调暗一档（走官方 `ctx.theme.overrideTokens` 扩展点，仅深色模式） |
| `dsh-session-unread-persist` | 会话列表「已完成未查看」绿点持久化到 localStorage：刷新/重开浏览器后仍在，点开会话照常消失 |
| `dsh-turn-labels` | 把右侧轮次刻度轨换成常驻文字：每轮一行显示提问，当前轮高亮，hover 预览，点击跳转；提问条目直接显示用户回答（蓝色区分、hover 出完整问答，读不到回答时退回原版小横杠） |
| `dsh-sidebar-width-persist` | 左侧边栏拖动宽度持久化：刷新后仍是上次的宽度，收起再展开不丢 |
| `dsh-patch-ask-expand` | 让 `ask_user_question` 那一行默认展开。**本 bundle 唯一运行体在宿主侧的组件**：启动时对官方 client bundle 打幂等文本补丁（保留 `.orig` 备份，锚点对不上就跳过） |

> 归属判据自 2026-10-15 起是**「面向谁」**：`dsh-patch-ask-expand` 的实现跑在宿主侧，但效果是
> 纯 GUI 观感 ⇒ 归 UI bundle，免得只想装 UI 包的人发现不了它。

> `@gavinc-cn/kanban-board`（任务看板）**不随本 bundle 下发**：包还在本仓库
> `packages/ui/kanban-board/`、npm 上也可单独安装，但装 `dsh-plugins-ui` 不会带上它。
> 要用就在 profile 的 `cordis.patch.yml` 里手写一条 insert（面板里不会有行/开关）。

### `@gavinc-cn/dsh-plugins-runtime`（8 个，宿主侧）

| 组件 | 说明 |
|---|---|
| `dsh-superpowers-priming` | 会话重开时补注入一次 superpowers 开场说明；已有则跳过，避免重复占上下文 |
| `dsh-memory` | 跨会话记忆：首次 prompt 注入两级记忆索引，回合结束按限流提示写入（记忆根 `~/.agents/memory`） |
| `dsh-autocommit` | 自动提交守卫：本会话改过文件却要接着跑下一回合时挡下，提示模型先提交（不自行提交） |
| `dsh-git-guard` | git 归属守卫：拦下缺 agent 前缀的 commit、越界的 reset/amend/branch/worktree/merge/tag/config 等写操作 |
| `dsh-file-guard` | 文件漂移守卫：每轮收尾比对「本会话写过的文件」与磁盘，发现被外部覆盖/回退时提示（不自动改回） |
| `dsh-path-rules` | 第五权限模式「路径规则」的逐调用闸门：项目内可读写 / 项目外读允许·写审批 / 白名单直通 / 黑名单读写都审批 / bash·pwsh 只读放行；只在预设身份为 `path-rules` 时介入（2026-10-17 起承接退役的 `sandbox-path-allowlist` 白名单能力；2026-10-18 起 `autoWhitelist` 可把用户批准的升权写入目录自动记入白名单） |
| `dsh-write-guard` | 第六权限模式「完全权限（拦截）」的逐调用写入闸门：读任意文件 / 项目内 / 白名单写入直通；越界写入弹框确认并自动学习白名单；判不出的 `bash`·`pwsh` 交当前会话模型判定。只在预设身份为 `write-guard` 时介入（2026-10-21 新增），其余档位零影响；**插件停用 = 完全不拦截** |
| `dsh-readonly-guard` | 只读守卫：bash 只读命令放行，可能改系统的默认转 DSH 原生审批；**默认停用** |

### `@gavinc-cn/dsh-plugins`（聚合元包）

自身**不是 bundle**（不含任何配置行，没有 `dsh.bundle`），只把上面两个 bundle 一起装上。
**不要把它写进 `dsh.profile.bundles`** —— 它没有 patch 层，宿主会判 `declares no dsh.bundle` 并跳过该层。

## 几个概念（别混）

| 概念 | 是什么 | 谁决定 |
|---|---|---|
| **包**（package） | npm 发布单位，一个目录一个 `package.json` | 本仓库 `packages/<分组>/<包>/` |
| **组件**（行） | Plugins 面板里某张 bundle 卡片内的一个独立开关 | 该 bundle 包 `cordis.patch.yml` 里的一条 `- insert:` |
| **整包开关** | 某个 bundle 是否参与组合 | profile `dsh.profile.bundles` |
| **行状态** | 某组件在本 profile 开/关 + 机器相关 config | profile 的 `cordis.patch.yml` 覆盖行（只写 `- id:`，不写 `insert`/`name`） |

## 目录结构

```
packages/
  ui/          6 个面向 Web GUI 的组件包（4 个声明 dsh.client.platform: "web"；dsh-patch-ask-expand 宿主侧实现；
              kanban-board 不随 bundle 下发）
  runtime/     9 个宿主（node）侧组件包（sandbox-path-allowlist 不随 bundle 下发）
  bundles/     dsh-plugins-ui（UI 5 行）/ dsh-plugins-runtime（运行时 8 行）/ dsh-plugins（聚合元包）
scripts/
  deploy-to-dsh.sh     把仓库铺到 dsh 实际加载的「共享活副本」~/.dsh/profiles/node_modules/@gavinc-cn/
  check-bundles.mjs    结构校验：行 id 全局唯一、行 ∈ dependencies、目录名 = 包名短名
```

## 本地开发

```bash
node scripts/check-bundles.mjs               # 结构校验（改完 patch/依赖先跑它）
bash scripts/deploy-to-dsh.sh --dry-run      # 看会改哪些文件
bash scripts/deploy-to-dsh.sh                # 铺到共享活副本（patch 层热重载，无需重装/重启）
```

`--prune` 才删除「共享副本里有、仓库里没有」的文件（默认只报告不删）。

## 注意事项

1. **同一个行 id 在整棵组合树里只能出现一次**：profile 不要再 `insert` 一个 bundle 已经
   `insert` 的 id —— 同 id 两行会被判成 `unaddressable`，面板里既没开关也拨不动（且不报错）。
   要改行状态/config，只写不带 `insert`、不带 `name` 的覆盖行。`scripts/check-bundles.mjs` 会拦这类冲突。
2. **bundle 包名必须同时写进 profile 的 `dsh.profile.bundles` 与 `dependencies`**：前者决定是否作为
   配置层加载，后者决定面板里卡片是否显示（客户端按 `installed` 过滤，只看 `dependencies`）。
3. **`disabled` 的极性与直觉相反**：`disabled: true` = 停用，`disabled: false` = 启用。
4. **包间依赖写普通 semver**（如 `^0.1.0`），不要用 `workspace:` 协议。
5. **不要在 profile 目录里跑 `pnpm install`**：bundle 的 `dependencies` 会把组件包下载成 profile
   自己的副本（`<profile>/node_modules/@gavinc-cn/*`），按 Node 解析顺序盖住共享活副本里你改的那份源码。
6. 面板上组件行的标题/说明来自**组件包自己**的 `locale/*.json`，卡片标题/描述来自 **bundle 包**的
   `locale/*.json`；宿主启动时缓存行元数据 ⇒ 运行中改 `locale` 要重启宿主才看得到。

## 发布

顺序有硬依赖：**15 个组件包先发 → 两个 bundle → 聚合元包**（先发后面的会让别人 `pnpm add` 时解析失败；
其中 `dsh-readonly-guard` 与 `dsh-path-rules` 必须先于运行时 bundle 上 registry；`dsh-write-guard`
依赖 `dsh-path-rules` 的 subpath exports，所以 `dsh-path-rules` → `dsh-write-guard` → 运行时 bundle
这个顺序不能反）。

```bash
npm publish <tarball> --registry=https://registry.npmjs.org --access public
```

包内 `publishConfig` 已固化 registry 与 `access: public`；包之间的依赖一律写普通 semver
（`workspace:` 协议只在 pnpm 下会被改写，npm 解析不了）。发布前先跑 `node scripts/check-bundles.mjs`，
确认行 id 全局唯一、每行都写进了对应 bundle 的 `dependencies`。

## 相关文档

各包自己的 README 见 `packages/<分组>/<包>/README.md`（也是随 npm 发布的那份）。

## License

MIT
