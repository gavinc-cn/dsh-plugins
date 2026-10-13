# @gavinc-cn/dsh-git-guard

DSH 原生的 **git 操作归属守卫**：在 bash 工具真正执行前拦下越界的 git 写操作。
由 kimi-code 的 PreToolUse/Bash hook `git_commit_guard.py`（1176 行，v9.1）移植而来。

拦什么（返回 `{kind:'deny', reason}`，reason 会作为错误文本回给模型，文本与 Python 版逐字一致）：

- `git commit` 的 message 首行不是 `--<6位会话短id>-- ` / `--AGENT-- `；或提取不到 message
  （未写 `-m`、`-F` 文件读不到、引号无法解析等严格模式口径；唯一豁免是 `--amend --no-edit`）；
- `git reset` 只放开 `--soft <ref>` 的 squash，且 `<ref>..HEAD` 全是 agent 前缀提交、暂存区干净、
  范围内无已推送提交；其余模式 / 带路径 / 非祖先 ref / `-C` 跨目录一律拦；
- `git commit --amend`：HEAD 必须是未被远程跟踪分支包含的 agent 前缀提交；
- `git branch`：只读列表放行；写操作仅 `agent/<6位短id>`（或 `agent/AGENT-<14位时间戳>`）的新建/删除；
- `git worktree`：`list` 放行；`add` 须 `-b agent/...` 或检出 agent 分支且目标路径不在仓库内；
  `remove` 须目标 worktree 检出 agent 分支且不带 `--force`；
- `git merge`：仅 `--ff-only agent/<短id>`（当前分支须 master 且可快进）、`--squash agent/<短id>`
  （master 或 agent 分支、暂存区干净、范围全 agent 前缀）、裸 `--abort`；
- `git tag`：只读列表放行；写操作只放开「本地新建全新 tag」（本地/远端/远端跟踪引用均无同名）；
  `-f/--force` 覆盖移动、`-d` 删除、签名/校验/清理等未开放选项一律拦；
- `git config`：只读形式放行，写形式（含 `alias.*`）拦；未知子命令若配了同名 git 别名也拦；
- `git checkout` / `git switch`：一切形式拦（要隔离工作区用 agent 分支 worktree）；
- 多段命令（`&&`/`||`/`;`/`|`/`&`）逐段检查，任一段违规即拦整条。

## 触发点（kimi hook → DSH 扩展点）

| kimi | DSH | 说明 |
|---|---|---|
| `PreToolUse` / `Bash` | `tools/pre-execute`（waterfall） | 只处理工具名 `bash`（大小写不敏感），返回 `{kind:'deny', reason}`；放行走 `next()` |
| 退出码 2 + stderr | deny 的 `reason` | 文本与 Python 版逐字一致 |
| 退出码 0 | `next()` | 不覆盖下游决定 |
| `tool_input.cwd` / 会话 state.json | `exec.arguments.workdir` → `exec.agent.session.header.cwd` → `process.cwd()` | 不再读 `~/.kimi-code/sessions/*/state.json` |

脚本自身异常按 **fail-open** 放行（与 Python hook 的异常语义一致），并写 `error:pre-execute` 日志。

## 装到哪

- 包实体：`<dsh home>/profiles/node_modules/@gavinc-cn/dsh-git-guard/`
- 每个 profile 的 `cordis.patch.yml` 各加一条：

  ```yaml
  - insert:
      - id: dsh-git-guard
        name: "@gavinc-cn/dsh-git-guard"
        # 需要调参时：
        # config:
        #   enabled: true
        #   dryRun: false
        #   logPath: ~/.kimi-code/hooks/logs/git_guard.dsh.log
        #   gitTimeoutMs: 20000
  ```

- **新增条目要重启一次 dsh**；之后改插件文件本身是热重载。
- 本包不依赖 `@deepseek-ai/dsh-*`，故未声明任何 `peerDependencies`。

## 配置（profile patch 条目的 `config`，全部可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时完全不介入（不判定、不记日志） |
| `dryRun` | `false` | 只记 `dry-run` 日志、不拦（用于观察误伤） |
| `logPath` | `~/.kimi-code/hooks/logs/git_guard.dsh.log` | 审计日志（与 kimi 侧同目录，文件名单列一份） |
| `gitTimeoutMs` | `20000` | 单个 git 子进程超时；远端 `ls-remote` 探测按其 1.5 倍（默认 30s） |

## 日志事件

格式 `<ISO 时间> | <事件> | <详情…>`：

| 事件 | 触发 | 示例 |
|---|---|---|
| `plugin-loaded` | 插件装载 | `2026-10-08T14:30:00 \| plugin-loaded \| enabled=true \| dryRun=false \| gitTimeoutMs=20000` |
| `allow` | 命令含受控子命令且放行 | `… \| allow \| git branch \| <工作目录>` |
| `deny` | 拦截 | `… \| deny \| commit message 首行必须以 "--<6位会话短id>-- "… \| <工作目录>` |
| `dry-run` | dryRun 下本应拦截 | `… \| dry-run \| <完整原因> \| <工作目录>` |
| `error:pre-execute` | 判定自身异常（fail-open） | `… \| error:pre-execute \| Error: boom` |

`allow` 只在命令里出现受控子命令（commit/reset/branch/worktree/merge/checkout/switch/config/tag
或未知子命令别名检查）时记录，避免每条 bash 调用都写一行（Python 版没有 allow 日志）。

## 行为口径（与 Python 版对齐）

- **快路径**：命令里没有受控 git 子命令时不 spawn 任何 git 子进程——DSH 的每次 bash 调用都会过这里。
- 解析：`shlex.split`（含引号/反斜杠/空引号/heredoc 正文）、`str.strip`/`str.splitlines` 的
  Unicode 空白与换行集合、Python `.` 只排除 `\n`、`\d` 用 `\p{Nd}`，均按 CPython 3.12 口径移植。
- 归属判定的唯一标准仍是**提交/分支前缀**：agent 提交被用户改写过 message 即失去前缀，视同用户提交。
- 一切「无法核实」的情况一律保守拒绝（宁拦不放），与 Python 版同。

## 测试

```bash
cd <dsh home>/profiles/node_modules/@gavinc-cn/dsh-git-guard
node --test test/plugin.test.mjs      # 单测（Node v24 下不能写 `node --test test/`）
node test/differential.mjs            # 与 Python 版的差分对比（需要 python3 + 源 hook 在位）
```

- 单测：17 个用例（非 bash 放行 / 快路径不 spawn git〔用假 git 探针验证〕/ commit 前缀与严格模式 /
  heredoc 与 `-F` / reset 归属 / checkout / 多段 / branch+config+tag / dryRun / enabled=false /
  内部异常 fail-open / cwd 解析顺序 / 日志事件 / 参数形状健壮性）。
- 差分：`test/differential.mjs` 在 `/tmp/dsh-git-guard-diff-*` 里造 10 个 cwd
  （有远端仓库 / 无远端仓库 / 已推送仓库 / HEAD 指向 agent 分支 / 暂存区脏 / 范围内混入用户提交 /
  HEAD 是用户提交 / 当前分支是 main / 非仓库目录 / 仓库子目录），把 Python `evaluate()` 与
  JS `evaluate()` 跑在**同一批命令 × 同一 cwd** 上比「是否拒绝」，并统计 30 条关键拦截规则的
  命中次数（确认分支真的被打到）；语料 = Python 单测里抽出的 231 条命令（含 33 条 f-string）
  + 合成用例，去重后 457 条。另外会打印判定分布的抽点表。要求：**不匹配数 = 0**。

## 测试证据（2026-10-08 实跑）

```
$ node --test test/plugin.test.mjs
ℹ tests 17   ℹ pass 17   ℹ fail 0

$ node test/differential.mjs                     # exit=0，约 32s
语料合计 457 条命令 × 10 个 cwd = 4570 次判定
规则命中（语料打到的拦截分支）：30 条规则全部 ≥1 次（无「未覆盖规则」输出）
Python 判定分布 ：deny 2748 / allow 1822 / error 0（拒绝原因 190 种）
不匹配数        ：0
reason 文本差异 ：0
Python 侧异常   ：0
JS 侧异常       ：0

$ node -e "import('<包路径>/lib/index.mjs').then(m=>console.log(typeof m.apply, m.name))"
function dsh-git-guard
```

## 已知偏差与边界

1. **会话 cwd 来源**：不再读 `~/.kimi-code/sessions/*/state.json`，改用进程内的
   `exec.agent.session.header.cwd`（DSH 的权威值），其余顺序一致。
2. **超时可配**：Python 版写死 4s（本地）/6s（远端），本插件默认 20s/30s。超时或 git 起不来时，
   两条实现都走「保守拒绝」分支，但**原因文案会带各自的异常文本**（Python 的
   `TimeoutExpired`/`FileNotFoundError` vs Node 的 `Error: spawn git ENOENT` 等）。
3. **realpath 的 `..`**：Node 侧先做词法归一化（`path.resolve`）再解析符号链接，Python 是逐段解析；
   「符号链接 + `..` 混合」的极少数路径可能与 Python 结果不同（沙盒里已覆盖符号链接指向同目录 /
   子目录的常规用法，差分 0 不匹配）。
4. **`~user` 不展开**：只展开 `~` 与 `~/`（Python 在找不到该用户时同样原样返回，常见用法一致）。
5. **工具名**：只处理 `bash`（大小写不敏感）。DSH 若换用别的 shell 工具名，本插件不会介入。
6. **只用了一个扩展点**：`agent/turn-stopping` / `session/event` / `session/disposed` 均未使用。
7. **子 shell 绕过**：`(git reset ...)` 仅在括号紧跟段首时识别，子 shell 仍可绕过——与 Python 版
   完全相同的残余风险，靠权限层 deny 规则叠加兜底。
8. **POSIX 语义**：按 Linux/macOS 路径语义移植，不考虑 Windows 盘符/反斜杠路径。
9. **`dryRun` 不写任何状态**：只记日志，便于安全观察误伤。

## 测试证据（2026-10-08）

```
$ node --test test/plugin.test.mjs
ℹ tests 17   ℹ pass 17   ℹ fail 0

$ node test/differential.mjs
语料合计 449 条命令 × 5 个 cwd = 2245 次判定
Python 判定分布 ：deny 1348 / allow 897 / error 0（拒绝原因 175 种）
不匹配数        ：0
reason 文本差异 ：0
Python 侧异常   ：0
JS 侧异常       ：0
```

```
$ node -e "import('~/.dsh/profiles/node_modules/@gavinc-cn/dsh-git-guard/lib/index.mjs').then(m=>console.log(typeof m.apply, m.name))"
function dsh-git-guard
```
