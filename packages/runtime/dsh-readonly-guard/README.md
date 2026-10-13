# @gavinc-cn/dsh-readonly-guard

DSH 原生的**只读守卫**：把每一次 `bash` 工具调用分类为「只读」或「可能修改系统」。
只读放行；可能修改系统的默认转 **DSH 原生审批弹窗**（`ask`），用户批准后才执行。

由 kimi-code 的 `readonly_guard.py` hook 移植而来（原文件 610 行，`md5 = 4a0b2cda6b5de0219a32e90b319f07bf`，
`~/.kimi-code/hooks/` 与 `~/.dsh/hooks/` 两份逐字节相同，差分测试对两份都跑）。

## 装到哪

- 包实体：`<dsh home>/profiles/node_modules/@gavinc-cn/dsh-readonly-guard/`（跨 profile 共享一份）
- 每个 profile 的 `cordis.patch.yml` 各加一条：

  ```yaml
  - insert:
      - id: dsh-readonly-guard
        name: "@gavinc-cn/dsh-readonly-guard"
  ```

- **新增条目要重启一次 dsh**；之后改插件文件本身是热重载。
- 装好后记得把 `dsh-hooks.json` 里 `readonly_guard.py` 那条 `PreToolUse` 摘掉，避免两套守卫同时生效
  （插件返回 `{kind:'ask'}`、hook 返回 exit 2，同时挂会互相打架）。本包**只负责插件侧**，不碰 hook 配置。

## 触发点（kimi hook → DSH 扩展点）

| kimi hook | kimi 事件 | DSH 扩展点 | 决定形态 |
|---|---|---|---|
| `readonly_guard.py` | `PreToolUse`（matcher=`bash`） | `tools/pre-execute`（waterfall） | 只读 → `next()`；审批标记/白名单 → `next()`；其余 → `{kind:'ask', reason, displayReason}`（`askMode:'deny'` 时 → `{kind:'deny', reason}`） |

读取的 `exec` 字段：`exec.name`（DSH 侧小写 `bash`）、`exec.arguments.command`、
`exec.agent.session.id`（写 pending 记录的 `session`）、`exec.agent.session.header.cwd`（本插件未用到）。

**为什么改插件**：hook 子进程经 `dsh-hook-protocol` → `bash.execute()`，请求不带 `sandboxPolicy`，
回退到部署级默认沙箱（实测只有 `/tmp` 可写），`record_approval` 写
`~/.kimi-code/readonly_pending.jsonl` 会直接失败；插件跑在 harness 进程内，不受这层沙箱约束，
也不再每次调用都 spawn 一个 Python 进程。

## 文件

| 文件 | 行数 | 内容 |
|---|---|---|
| `lib/index.mjs` | 199 | 插件：配置归一化、监听器、决策、日志 |
| `lib/classify.mjs` | 740 | 分类核心 + 白名单 + 审批记录 + `shlex`/`fnmatch`/`os.path.basename` 的等价实现 |
| `test/plugin.test.mjs` | 357 | `node:test` 单测（假 ctx 驱动） |
| `test/differential.mjs` | 673 | 与 Python 版逐条差分 |

## 配置（profile patch 条目的 `config`，全部可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时监听器直接 `next()` |
| `dryRun` | `false` | 只记日志：不打断、**不写 pending** |
| `askMode` | `'ask'` | `'ask'` = DSH 原生审批弹窗；`'deny'` = 复刻 kimi 的「阻断 + 让模型带标记重试」 |
| `whitelistPath` | `~/.kimi-code/readonly_whitelist.json` | 白名单（只读，与 kimi 侧共用同一份） |
| `pendingPath` | `~/.kimi-code/readonly_pending.jsonl` | 审批记录（追加写，与 kimi 侧共用同一份） |
| `logPath` | `~/.kimi-code/hooks/logs/readonly_guard.dsh.log` | 审计日志 |

`askMode` 取非 `'ask'`/`'deny'` 的任意值时回落为 `'ask'`。

## 行为口径（与 Python 版对齐）

判定顺序（与 `main()` 一致）：

1. `command` 为空 → 放行。
2. **审批标记** —— 命令串以 `######USER_APPROVED######` 开头（`re.match` 锚定在 0 位，行首空格即不认）：
   去掉标记与紧随的空白、`record_approval`、放行；去掉标记后再做一次 sanity check，若结果不是只读，
   记 `allow:marker:non-readonly`（正文与 Python 写 stderr 的那句逐字相同）。
3. **只读** → `isReadOnlyCommand` 为真则放行。
4. **白名单** → 每个 shell 段都命中 `readonly_whitelist.json` 才放行（逐段匹配，`a; rm -rf /` 不能靠前缀蒙混）。
5. 其余 → `ask`（或 `deny`）。

分类逻辑（`lib/classify.mjs` 与 Python 函数一一对应）：

- 先剥行首环境变量赋值（`stripLeadingEnv`），再按**未加引号的** `;` `&&` `||` 换行切段
  （`splitShellSegments`，引号与反斜杠转义会关闭分隔符识别），逐段判定，全段只读才算只读。
- 单段判定顺序：写重定向（`>` `>>` `<>` `>|` `&>` `>&` `&>>` `N>`）→ 命令替换（`$(...)` / 反引号，
  递归判定；`$((...))` 算术展开跳过）→ 首 token → 控制结构 / 解释器 / `ssh` / `git` / `docker` /
  `podman` / `kubectl` / `kimi` 特判 → 常量表兜底（默认 **非只读**）。
- `shlex.split(posix=True)`、`fnmatch.fnmatchcase`、`os.path.basename`、`str.strip()`、Python 的 `\s` 集合
  都在 `lib/classify.mjs` 里按 CPython 3.12 源码逐状态/逐分支重写，避免"看起来差不多"的方言级偏差。

审批记录格式与 Python `record_approval` **逐字节一致**（kimi 侧仍在读这份数据）：

```json
{"cmd": "rm -rf /tmp/xyz", "session": "session-b2a09c73-…", "ts": 1784348476.462378}
```

字段顺序固定 `cmd` / `session` / `ts`，分隔符沿用 `json.dumps` 的默认 `", "` / `": "`（JS 的
`JSON.stringify` 不带空格，所以这一行是手工拼的），非 ASCII 不转义，`ts` 为 Unix 秒
（对应 `payload["session_id"]` 的是 DSH 的 `exec.agent.session.id`）。

## 日志事件

格式 `<ISO 时间> | <事件> | <会话 id> | <详情>`，一行一事件（命令里的换行转义成 `\n` 字面量，
超过 1000 字符截断并标注省略量）。

| 事件 | 时机 |
|---|---|
| `plugin-loaded` | `apply()` 时，带 `askMode` / `dryRun` / `enabled` / `whitelist` |
| `allow:readonly` | 分类为只读 |
| `allow:whitelist` | 命中白名单 |
| `allow:marker` | 带审批标记（后接 `allow:marker:non-readonly` 表示去掉标记后仍非只读） |
| `ask` | 转 DSH 原生审批 |
| `deny` | `askMode='deny'` 时阻断 |
| `dry-run` | `dryRun` 下本应 `ask`/`deny` 的那一步（详情 `would-ask` / `would-deny` / `would-allow:marker`） |
| `error:pre-execute` | 监听器内部异常（fail-open，已放行） |

排障：`tail -f ~/.kimi-code/hooks/logs/readonly_guard.dsh.log`。

## 与 kimi 语义的差异

1. **`askMode` 默认 `'ask'`（最主要的差异）**。kimi 侧只有 `exit 2 = deny` 一种出口，靠「让模型带
   审批标记重试」把问题绕回用户；DSH 有真审批瀑布，所以默认直接弹审批 —— 用户批准即执行，不必再贴标记。
   要严格复刻 kimi（包括它的三段式中文阻断文案）就配 `askMode: 'deny'`。
2. **sanity check 的提示改记日志**。Python 在标记命中且剥后非只读时写 stderr（模型看不到）；
   插件改记 `allow:marker:non-readonly`，正文一字不改。
3. **`dryRun` 下不写 pending**（Python 没有这个开关）。dry-run 的语义是"零副作用观察"，
   所以标记路径也不落盘。
4. **不再每次调用 spawn Python 进程、不受 hook 子进程沙箱限制**（本次迁移的直接原因）。
5. **日志里的命令做单行化 + 1000 字符截断**，避免一条日志把日志文件撑爆；`pending` 记录不受影响。

## 测试

```bash
cd <包目录>        # 例: ~/.dsh/profiles/node_modules/@gavinc-cn/dsh-readonly-guard

# 单测（Node v24.20.0 必须显式给文件路径，`node --test test/` 会失败）
node --test test/plugin.test.mjs

# 与 Python 版差分
node test/differential.mjs

# 加载自检
node -e "import('<包目录>/lib/index.mjs').then(m=>console.log(typeof m.apply, m.name))"
```

2026-10-08 实测（Node v24.20.0 / Python 3.12.14 / CPython `shlex`+`fnmatch`）：

- 单测：`ℹ tests 23 / pass 23 / fail 0`。覆盖 `ls`/`cat` 放行、`touch`/`rm` → ask、白名单命中放行、
  审批标记放行并写 pending、标记不在行首不认、`dryRun` 不打断且不写盘、`askMode='deny'` 返回 deny、
  非 bash 工具放行、内部异常 fail-open、日志单行化、`next()` 返回值透传、标记后的 Unicode 空白剥离；
  最后一个用例另起子进程把 `HOME` 指到临时目录，验证「不带 config 调 `apply()`」时默认路径确实落在
  `$HOME/.kimi-code` 下。
- 差分：语料 **1701 条**（合成 1065 + 仓库既有 636），在 `~/.kimi-code/hooks` 与
  `~/.dsh/hooks` 两个源目录上，`is_read_only_command` **不匹配 0 条**；四个下层 helper
  （`split_shell_segments` / `get_first_token` / `has_write_redirection` / `looks_read_only_python`）
  也各 0 条；白名单 `is_whitelisted` 648 次判定（12 个 fixture）0 条；`record_approval` 写出的
  5 行 jsonl 抹掉 `ts` 后逐字节相同。
- 语料区分度自检：同一批语料上，一个"只看第一个 token"的朴素实现与 Python 分歧 **358 条** ——
  证明"0 不匹配"不是恒真断言。语料分布：只读 696 / 非只读 1005。
- 已知偏差锁定 4 条（见下），逐条核对期望值，全部符合。

语料本身也覆盖了容易踩坑的地方：特殊空白（U+001C-U+001F / U+0085 / U+00A0 / U+2028 / U+3000 /
U+FEFF，20 条）、`python -c` 与 `bash -c` 的嵌套引号、`$(...)`/反引号、重定向、控制结构、
环境变量前缀、`sudo`、`find -exec`、`sed -i`、heredoc、未闭合引号 —— 任何一条与 Python 不一致都会
直接计入"不匹配数"。

所有状态文件（白名单 / pending / 日志）在测试里一律指向 `mkdtempSync` 造出的临时目录，
**不碰** `~/.kimi-code/readonly_whitelist.json` 与 `readonly_pending.jsonl` 的真实文件。

## 已知偏差（无法对齐，已在差分里锁定期望值）

| 输入 | Python | JS | 原因 |
|---|---|---|---|
| `python3 -c "éexec(1)"` | `true` | `false` | Python 的 `\b` 是 Unicode 词边界（`é` 算词字符，`éexec` 里没有边界），JS 的 `\b` 只认 ASCII，于是误命中 `\bexec\s*\(` |
| `python3 -c "caféopen('/tmp/x','w')"` | `true` | `false` | 同上，误命中 `\bopen\s*\(…` |
| `weirdtool 😀`（白名单 `weirdtool ?`） | `true` | `false` | `fnmatch` 的 `?` 在 Python 匹配 1 个**码点**（😀 算 1），JS 正则匹配 1 个 UTF-16 **码元**（😀 算 2） |
| `😀x`（白名单 `[a-😀]x`） | `true` | `false` | 区间端点落到星平面字符时，JS 未加 `u` 标志的字符类按码元匹配 |

四条的**共同方向都是 JS 更保守**（该放行的判成需要审批），不会出现"Python 拦、JS 放"。
触发它们需要命令行或白名单模式里出现非 ASCII 词字符 / 星平面字符；白名单模式由已下线的
`whitelist_learn.py` 生成，shape 限定 `[a-z0-9_-]`，因此现实中不可达。

> 注：Python 与 JS 的 `\s` / `str.strip()` 字符集并不相同（Python 多 U+001C-U+001F、U+0085，
> 少 U+FEFF）。这一类比上面四条更容易撞上，所以 `lib/classify.mjs` 把 Python 的集合显式抄成
> `PY_SPACE` 并用 `pyStrip()` 顶掉 `trim()`，**不再是偏差**。

## 覆盖范围与已知限制（沿用 Python docstring）

覆盖：

- 普通 bash 命令
- `python -c "..."` 片段（按 `PYTHON_WRITE_PATTERNS` 判写操作）
- `bash -c` / `sh -c` / `zsh -c` / `fish -c` 嵌套命令（递归判定）
- `ssh host "command"` 远程命令（跳过选项与主机名后递归判定）
- 控制结构（`for` / `while` / `until` / `if` / `do` / `then` / `else`）：结构内每条命令单独判定
- 命令替换 `$(...)` 与反引号：每条被替换的命令递归判定

限制：

- 静态分析无法完美分类任意 shell。
- 审批标记靠模型"只在真的获批后才加"。
- 管道与后台列表只按第一个命令分类。
- `case`、子 shell `( ... )`、C 风格 `for (( ... ))`、heredoc 不解析，用到它们的命令保守阻断。
- 命令名本身若是命令替换（例如 `` `ls` `pwd` ``），一律按"不认识的首 token"保守阻断（Python 同）。

## 未确证项

- **尚未在真实 DSH 会话里触发过**：profile patch 条目由 Lead 负责写入与热重载；本包只完成到
  「单测 + 差分 + 加载自检」。
- `ask` 弹窗的实际展示文案（`displayReason` 的 `en`/`zh`）未经 GUI 实测，只按
  `@deepseek-ai/dsh-experimental-auto-review` / `dsh-sandbox` 的同类用法书写。
- 桌面端（Windows profile）能否直接跑本插件未验证（需要 `node_modules` 同步到 Windows 侧）。
