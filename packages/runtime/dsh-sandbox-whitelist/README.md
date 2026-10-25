# @gavinc-cn/dsh-sandbox-whitelist

**多根沙箱 provider**（DSH「方案 C」）：顶替官方 `@deepseek-ai/dsh-sandbox-local` 的
`ctx.sandbox` 服务，把「项目根 + 白名单目录 + 临时区」变成**执行层可写根**，其余路径只读：

| 平台 | 实现 | 说明 |
|---|---|---|
| Linux | bwrap（优先）/ Landlock | 内核级；enforcement `full` 或 `partial`（老 ABI） |
| Windows | 官方 `windows-acl` 受限令牌 | 给白名单目录补发该 workspace 写 SID 的 **standing ACE**；enforcement `partial` |
| macOS | 未实现 | 启用会拒绝加载（Seatbelt 多根未做） |

> 为什么需要它：`write-guard` / `path-rules` 是**命令级**闸门（`tools/pre-execute` 里看命令文本），
> 存在「读完脚本到执行之间被改」（TOCTOU）、静态分析表盲区、子进程内再写等残留。本包把这些判定
> 落到执行层：白名单外**底层直接拒绝写入**，白名单内直接放行（不需要每次弹框/升权）。

- **默认不启用**：runtime bundle 里的行是 `disabled: true`；启用必须**成对**改 profile（见下）。
- **只对命中 `enforcePresets` 的会话追加白名单根**：默认 `path-rules`；其它预设（含
  `write-guard` 的 `danger-full-access` 底座）保持官方语义。
- **不能在插件面板里单独启用**：面板只写本行 `disabled`，官方 provider 仍占用同名 service ⇒ 必失败。
  2026-10-24（0.1.2）起 apply 有前置自检，会给出「必须成对改 profile」的可执行说明。
- 0.2.0 起**跨平台**：Linux 与 Windows 都支持；macOS 在 apply 期直接拒绝加载。

## 它做了什么

| 环节 | 行为 |
|---|---|
| 选择 provider | cordis 的 `sandbox` service 同名只能有一个：profile 停用官方 `- id: sandbox`，再启用本行（patch 只能改 `disabled`/`config`，**不能改行的 `name`**，所以是"停用 + 新增"两行） |
| 实现骨架 | 继承官方 `LocalSandboxProvider`：复用它的平台链选择/探测/argv 骨架/结果分类/Windows 授权缓存，本包只覆写 `runnerArgv()`（追加白名单根）与 `confine()`（拒绝 danger-full-access） |
| 可写根 | 命中预设时 = 官方 `writableRoots`（workspaceRoot + `/tmp` + `os.tmpdir()`）+ `whitelist` + `autoWhitelistFiles`（本平台条目）；canonical 化、去重、**按存在性过滤**（Linux 下不存在的根会让整条命令 125 fail-closed） |
| Linux 参数 | bwrap：官方基础挂载 + `--tmpfs /tmp` + `--bind <ws> <ws>` + 白名单根 `--bind`；Landlock：`--ro / --rw /dev/null --rw <ws> --rw /tmp --rw <tmpdir> --rw <白名单…>` |
| Windows 参数 | 官方 runner argv **不变**：`--workspace <ws> --temp <private-temp> --mode workspace-write --write-sid <wsSid> --temp-write-sid <tempSid>`；本包在 argv 生成后把每个白名单目录的 `workspaceWriteSid(workspaceRoot)` ACE 补上（`AclWriteGrant.add(dir, standing=true)`）——受限令牌本来就携带该 SID，所以**不需要改官方 runner CLI** |
| 结果契约 | 返回 `enforcement` / `denialSignatures` / `runnerFailureRules`（与官方 provider 同口径），供 bash 结果把 stderr 分类成 denied / runnerFailed |
| 自动白名单 | `autoWhitelistFiles` 可直接指向 `~/.dsh/path-rules/auto-whitelist.json` / `~/.dsh/write-guard/auto-whitelist.json`；**逐次 confine 读取** ⇒ 审批学习的新目录下一条命令即获可写权，无需重启（Windows 为"下一次命令前补授权"） |

## 启用（profile 覆盖行，成对出现）

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: sandbox
  disabled: true                       # 必须先停用官方 provider（同名 service 独占）
- id: dsh-sandbox-whitelist
  disabled: false
  config:
    enforcePresets: [path-rules]       # [] = 所有预设（验证用；生产按档位精确匹配）
    whitelist: ['<workspace-root>']    # 绝对路径，支持 ~（Linux / Windows 路径均可）
    autoWhitelistFiles: ['<dsh home>/path-rules/auto-whitelist.json']
    probeTimeoutMs: 5000
```

- 激活本行 = 改了行集合/服务提供者 ⇒ **必须重启宿主**（patch 层热重载不够）。
- 停用/回滚：把上面两行反过来（**同时**恢复 `- id: sandbox`），再重启。只停本行不恢复官方行 =
  `ctx.sandbox` 缺失 ⇒ bash 工具与权限档服务一起消失（`bash-sandbox` 注入 `sandbox` 会一直 pending）。
- **不要在插件面板里单独把本行拨成启用**：面板只写本行 `disabled`，不会同时停官方行 ⇒ 必然失败
  （apply 前置自检会给出可执行说明，而不是 cordis 的 `service "sandbox" has been registered`）。

## Windows 语义与边界（0.2.0，务必读）

- **授权身份 = 该 workspace 的写 SID**：Windows 官方 provider 用「受限令牌 + 写 SID ACE」实现写白名单
  （`workspaceWriteSid(workspaceRoot)` + private temp 的 `tempWriteSid`）。本包追加白名单根时，用的是
  **同一个 workspace 写 SID** 的 `standing` ACE —— 令牌本来就携带它，因此无需改官方 runner 的 CLI。
- **standing = 跨重启复用缓存**：与官方 workspace 根的语义一致（官方 workspace ACE 也永不主动撤销）。
  ⇒ **从白名单配置里移除某个目录，不会自动回收已授予的 ACE**（该 SID 只对用它铸造的 token 有效，
  别的 workspace 不受影响；要彻底回收需手动清理 ACL 或换 workspace 路径）。新增/审批学习的目录是
  **增量补授权**。
- **首次授权会给整棵树传播继承 ACE**：官方实现按「大目录可能耗时数分钟」记录过；白名单建议用较窄
  目录。授权失败（无 owner/WRITE_OWNER 等）只 **warn 跳过该根**，命令仍在官方 workspace+temp
  范围内受限执行，**不会**因此变成未隔离。
- **与工作区/系统临时目录重叠的根会被跳过**：授予 workspace SID 会让该 workspace 的所有会话可写
  这些树，且与 private temp capability 重叠会出现 capability 混用。
- `read-only` 不补任何授权；agentless（无 `sessionId`）调用不补授权（官方那种调用由 runner 自管
  private temp，没有 workspace SID 可用）。
- 跨 `D:/` 与 `C:/` 盘符的白名单根可以授权（ACE 不涉盘符）；`relative()` 跨盘返回绝对路径 ⇒ 不会
  被误判成"在工作区内"。
- 平台链不可用（如 runner 探测失败）仍是 fail-closed：`SANDBOX_UNAVAILABLE`，命令不执行。

## 配置

| 键 | 默认 | 校验 / 说明 |
|----|------|-------------|
| `enforcePresets` | `['path-rules']` | 字符串数组；`[]` = 全部预设（含无会话调用）；未命中的会话不追加白名单根 |
| `whitelist` | `[]` | 绝对路径数组（支持 `~`）；运行时 canonical 化 + 存在性过滤，缺失的只 warn 一次 |
| `autoWhitelistFiles` | `[]` | 指向 `{version:1, entries:[{path, platform, …}]}` 状态文件的绝对路径数组；坏文件/缺文件按空处理；逐次读取 |
| `probeTimeoutMs` | `5000` | 正有限数（0 会被 `spawnSync` 当成"无超时"） |

**没有 `enabled` 软开关**：本包是 provider 替换件，软关闭会很危险（见上"停用/回滚"）。

## 安装 / 测试 / 真机验证

```bash
cd packages/runtime/dsh-sandbox-whitelist && npm test     # 33 条：config / roots / profiles / index 接线
node verify/confine-check.mjs                            # Linux 真机内核验证（真实 landlock-run/bwrap）
```

单测需要宿主提供的 `@deepseek-ai/dsh-sandbox`、`@deepseek-ai/dsh-sandbox-local`、
`@deepseek-ai/node-addon-system`（optional peer）与官方 `dsh-sandbox-windows-acl`（由 dsh-sandbox-local
带入）。仓库根 `node_modules/@deepseek-ai/` 已有测试软链；裸检出时建一次：

```bash
mkdir -p node_modules/@deepseek-ai
for p in dsh-sandbox dsh-sandbox-local dsh-sandbox-windows-acl node-addon-system; do
  ln -sfn /path/to/dsh/node_modules/@deepseek-ai/$p node_modules/@deepseek-ai/$p
done
# 或直接：bash scripts/test-all.sh dsh-sandbox-whitelist
```

**Windows 真机验证清单（桌面端重启后）**：

1. 切「路径规则」档，`bash` 写 `<workspace-root>/...`、`<home>/.agents/...` 内文件应成功（白名单根）；
   写 `C:/Windows` 等白名单外路径应被拒（`Access is denied`），bash 结果里有 `sandbox.mode` / `enforcement=partial`。
2. 首次写白名单目录可能因 ACL 树传播而停顿（见上「首次授权」）；`dsh.log` / 插件日志出现
   「Windows 白名单根已授权：<path>」后可复测。
3. 审批学习新目录后，下一条命令即成功（自动白名单逐次读取）。
4. 回滚：profile 两行反过来恢复官方 `- id: sandbox`，重启 → 若仍有异常，先确认 `ctx.sandbox` 存在。

## 已知限制

- **macOS 未实现**（Seatbelt 多根）；apply 期拒绝加载。
- **Windows 是 `partial` 语义**：官方 windows-acl 本身就记录了一些 Everyone / hard-link 边界；本包
  只负责"白名单根也可写"，不改变这些既有边界。
- **Windows 撤销语义**：standing ACE 不自动回收（见上）；这是与 Linux「每次命令重算内核根」的差异。
- 不做进程级限制（网络、exec、pty 等）；只做文件写入范围。
- 不修改 workspace 语义：`read-only` 不追加；`danger-full-access` 由调用方短路（送进来直接抛）。
- 官方 `LocalSandboxProvider` 的内部方法/字段（`windowsAclRunnerArgv` / `workspaceGrants` /
  `materializeAclGrant`）是被复用的非公开面：DSH 升级后必须复跑单测与真机验证（最坏退化为官方语义，
  不会越权）。

## License

MIT
