# @gavinc-cn/dsh-fs-whitelist

**文件白名单根**（`ctx.fs` provider 替换件）：在官方 `@deepseek-ai/dsh-fs-sandbox` 的
「工作区 + `/tmp` + `os.tmpdir()`」之外，把**白名单目录**（含审批学习出来的自动白名单）也算作
`write` / `edit` 的**可写根**，让白名单目录的写文件不再走「沙箱拒 → 模型带
`sandbox_permissions` 重试 → 审批」。

> 这是 **trusted-code 的策略 fence，不是内核边界**。只改 `ctx.fs` seam 自己的写入判定；
> 真正隔离不可信代码（shell 命令的内核可写根）是 `@gavinc-cn/dsh-sandbox-whitelist` 的职责。

## 为什么需要它

DSH 的写文件能力分成两条 seam，各有各的可写根：

| seam | 谁在用 | 可写根来源 | 是否读白名单 |
|---|---|---|---|
| `ctx.sandbox`（`dsh-sandbox-whitelist`） | `bash` 命令 | 工作区 + `/tmp` + 白名单 + 自动白名单（**内核** bwrap/Landlock） | ✅ |
| `ctx.fs`（官方 `dsh-fs-sandbox`） | `write` / `edit` 工具 | 官方 `writableRoots(policy)` = 工作区 + `/tmp` + `os.tmpdir()` | ❌ |

`dsh-sandbox-whitelist` 只顶替了第一条。即使白名单目录已经是 shell 的内核可写根，`write` /
`edit` 写同一个目录仍然被 fs fence 拒绝，只能靠模型重试 + 升权审批——每次都要弹框、每次都可能
被模型绕开或放弃。本包补齐第二条 seam：**同一份白名单，两条 seam 都认**。

## 启用（必须成对，缺一行就会级联故障）

patch 只能改**已存在行的** `disabled` / `config`，不能改行的 `name`；`fs` 是 cordis service，同名
只能有一个 provider。所以启用 = 「停用官方 `fs-sandbox`」+「启用本行」**两行同时改**：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: fs-sandbox
  disabled: true                    # ① 停用官方 fs provider（同名 service 只能有一个）
- id: dsh-fs-whitelist
  disabled: false                   # ② 启用本行（组合行由 runtime bundle 下发，默认 disabled: true）
  config:
    enforcePresets: [path-rules]    # 只对「路径规则」档生效；[] = 所有 workspace-write 会话
    whitelist:                      # 绝对路径，支持 ~；运行时 canonical 化 + 存在性过滤
      - '<workspace-root>'
      - '~/.agents'
    autoWhitelistFiles:             # 审批学习出来的自动白名单（与 sandbox-whitelist 同一份数据）
      - '<dsh home>/path-rules/auto-whitelist.json'
      - '<dsh home>/write-guard/auto-whitelist.json'
```

- 如果仓库/组合树里还没有本行（未接 runtime bundle），profile 侧要用带 `name` 的 insert 行：
  ```yaml
  - insert:
      - id: dsh-fs-whitelist
        disabled: false
        name: "@gavinc-cn/dsh-fs-whitelist"
        config: { enforcePresets: [path-rules], whitelist: ['<workspace-root>'] }
  ```
- 激活本行改了**服务提供者**⇒ 必须**重启宿主**（patch 层热重载不够）。
- 建议白名单与 `dsh-sandbox-whitelist` 的 `whitelist` 保持一致：两条 seam 的判定不一致时，
  模型会看到「bash 能写、write 不能写」的怪现象。
- **不要在插件面板里单独把本行拨成启用**：面板只写本行 `disabled`，不会同时停官方 `fs-sandbox` 行
  ⇒ 必然失败。2026-10-24（0.1.1）起本包在 `apply` 里提前自检并给出可执行的错误
  `ctx.fs 已被其它 provider 占用…`，而不是抛出 cordis 的
  `service "fs" has been registered at <SandboxedFileSystem>`。

## 配置

| 键 | 默认 | 校验 / 说明 |
|----|------|-------------|
| `enforcePresets` | `['path-rules']` | 字符串数组；`[]` = 所有 `workspace-write` 会话（含无会话调用）；未命中的会话保持官方单根语义 |
| `whitelist` | `[]` | 绝对路径数组（支持 `~`，逐项校验，相对路径 fail-fast）；运行时 canonical 化 + 存在性过滤 + 保序去重 |
| `autoWhitelistFiles` | `[]` | 指向 `{version:1, entries:[{path, platform, …}]}` 状态文件的绝对路径数组；按运行平台过滤，坏/缺文件按空处理，**逐次读取**（审批学习立即生效） |

- **没有 `enabled` 软开关**：本包是 provider 替换件，软关闭会让 `ctx.fs` 看起来在、实际不 fence
  （危险），所以停用只能换回官方行（见「回滚」）。
- 未知配置键**静默忽略**（包括官方 `fs-sandbox` 的 `cwd` / `diffBasisMaxBytes`：本包固定
  `cwd = process.cwd()`，与官方默认一致）。
- 白名单根**不包含** DSH home（`~/.dsh`，含 profile patch 与插件状态）——把那里放进可写根等于
  允许模型改配置关掉本 provider（自绕过）；该目录的写入仍走 `path-rules` 档自己的白名单/审批链。

## 测试

```bash
cd packages/runtime/dsh-fs-whitelist && npm test     # 41 条：config / containment / index 接线（含「替换件前置自检」2 条）
```

单测需要宿主的 `@deepseek-ai/dsh-fs-sandbox`、`@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-sandbox`
（optional peer，由 DSH 提供）。本仓库根 `node_modules/@deepseek-ai/` 已有软链；裸检出时建一次：

```bash
mkdir -p node_modules/@deepseek-ai
for p in dsh-fs dsh-fs-sandbox dsh-sandbox; do
  ln -sfn /path/to/dsh/node_modules/@deepseek-ai/$p node_modules/@deepseek-ai/$p
done
# 或直接：bash scripts/test-all.sh dsh-fs-whitelist
```

## 已知边界

- **策略 fence，不是内核边界**：只约束 `ctx.fs` 的 open/rename；其他进程、shell 命令的写入由
  `ctx.sandbox` 的内核可写根负责，本包不影响。
- **TOCTOU 与官方同口径**：检查完到落盘之间祖先软链被换的残留窗口，靠写入前再 `resolve()`
  canonical 化收窄（「检查的身份 = 写入的身份」），威胁模型与官方 `dsh-fs-sandbox` 一致。
- **只影响 `workspace-write`**：`read-only` 仍然全拒；`danger-full-access` 本来就不 fence。
- **只影响命中 `enforcePresets` 的会话**：其它预设（如 `write-guard` 的 danger 底座）保持官方语义。
- **Windows 大小写**：词法包含判定在 win32 上大小写不敏感；官方还有 dev/ino 身份兜底
  （8.3 别名），本包刻意不做——差异只会导致极少数拼写**少放行一次**（落回官方 deny），
  不会越权放行。
- 白名单根必须**存在**才生效（不存在的根被过滤，不报错）；用软链配根没关系（canonical 后比较）。
- 与 `dsh-sandbox-whitelist` 一样**只看写入目标**，不限制网络 / exec / pty。

## 回滚

把「启用」的两行反过来即可（**必须成对**）：

1. profile 覆盖行：`- id: dsh-fs-whitelist` 改回 `disabled: true`，并把 `- id: fs-sandbox` 的
   `disabled: true` 删掉/改回 `false`（恢复官方 provider）；
2. **重启宿主**（服务提供者变更）；
3. 代码回滚：bundle 的 insert 行 + `dependencies` 条目一起删掉后重新部署。

## `ctx.fs` 缺失的级联症状（排查用）

只停官方行、没启用本行（或本行加载失败）时，`ctx.fs` 不存在，而 `dsh-tool-fs` 的
`inject = ["tools", "fs", "systemPrompt", "workingDirectory"]` 会一直 pending：

- 模型侧 `read` / `read_image` / `write` / `edit` **四个工具一起消失**（不是只坏写入）；
- 会话里出现「工具不存在 / 文件读不了」的报错，Plugins 面板中 `tool-fs` 行（`dsh-tool-fs`）不活跃；
- 修复 = 恢复官方 `- id: fs-sandbox` 或重新启用本行，然后重启。

## 维护者要点

- `normalizeConfig()` 只接受上表三个键；`apply` 把归一化配置**并进**传给父类的 config 对象
  （不是构造后再 `this.config = ...`）：父类 `LocalFileSystem` 的 `resolve()` / `writeText()` 会读
  `this.config.cwd` / `diffBasisMaxBytes`，覆盖会让所有 write/edit 以 `ERR_INVALID_ARG_TYPE` 失败
  （有单测兜住）。
- 本模块导出 `inject = ['sandboxPolicy']`：官方 `SandboxedFileSystem` 构造会读
  `ctx.sandboxPolicy.defaultMode`（能力事实 `sandboxMode`），必须等该服务就绪再 apply。
- `apply()` 必须 `return undefined`：cordis 把返回值当 effect，返回 provider 实例会抛
  `TypeError: Invalid effect`（有单测兜住）。
- 拒绝文案 / 错误码 / 升权标记全部来自官方 `super.checkedTarget`，本包不自己拼错误串
  （tool 层与模型提示词依赖官方口径）。

## License

MIT
