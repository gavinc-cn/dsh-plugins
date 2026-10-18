# @gavinc-cn/dsh-path-rules

DSH 第五权限模式「路径规则」的逐调用闸门：挂在 `tools/pre-execute` waterfall 上，
先 `await next()` 取下游守卫（`dsh-git-guard` / `dsh-readonly-guard` 等）的结论，
再按「更严者胜」叠加自己的判定 —— 只可能更严，永不弱化既有守卫。

规则（用户 2026-10-13 定义）：

- 项目内（= 会话工作区根）目录**可读可写**；
- 项目外目录**只读**，写入需要用户审批；
- **白名单**内的目录可读可写（直通，不弹框）；
- **黑名单**内的目录读写**都要审批**（优先级最高，压过白名单与项目内）；
- `bash` / `pwsh`：只读命令直接放行；写入目标可静态解析时按上述规则判定；**解析不出的命令默认交给沙箱**
  （workspace-write 的运行时写拦截，与「工作区内修改」档一致），可用 `unanalyzable: deny|ask` 改回严格；
- **白名单写入预置升权**（`preemptiveWhitelistEscalation`，默认开）：静态可判定的白名单写一次成功、不弹框
  （预置 danger-full-access + 插件自动 `allowed-once`，见下文）；
- **自动白名单**（可选，`autoWhitelist: true`）：用户在审批框里批准的沙箱升权写入目标，
  其目录会自动进入白名单（持久化），下次同目录的写入不再弹框。见下文。

## 激活条件

插件**只在预设身份为 `path-rules` 时介入**（`permissionPresets.current(session)`）：

- 其它四档（`read-only` / `workspace-write` / `danger-full-access` / `auto`）行为一字不变；
- 子代理（`session.header.origin === 'subagent'`）沿 `parentSession` 上溯取祖先身份
  （框架不向子代理继承非 `auto`/`danger-full-access` 的预设身份）；
- 插件未加载 / `enabled: false` / 服务缺失 / 无 agent 的调用：一律透传，最坏退化成现状
  （沙箱仍把写入限制在会话工作区 + 临时区），不会敞开。

## 判定链（先命中者胜）

```
黑名单命中 → ask        白名单命中 → allow       项目内 → allow
临时区（/tmp、os.tmpdir()）→ allow                项目外读 → allow
项目外写 → ask（工作区外写交给沙箱升权）
shell 判不出 → 黑名单文本粗检（命中 ⇒ ask）→ 否则按 `unanalyzable` 策略（默认 pass，交给沙箱）
```

`ask` 走框架标准审批流程（`ctx.approval.request`）；会话审批通道为 `never`（子代理被框架钉成
`never`）时，插件在判定阶段就把 `ask` 改写成 `deny` 并提示回主会话执行 —— 那些会话里没有弹框
可弹，只能拒绝。

## 配置（插件 config；机器相关配置写在各 profile 的覆盖行）

```yaml
- id: dsh-path-rules
  name: "@gavinc-cn/dsh-path-rules"
  config:
    enabled: true                 # 总开关（false = 完全空转）
    activationPreset: path-rules  # 哪个预设身份激活本插件
    whitelist: []                 # 绝对路径；可读可写，压过"项目外"，但被黑名单压过
    blacklist: []                 # 绝对路径；读写都要审批，压过一切
    allowTempRoots: true          # /tmp + os.tmpdir() 视为可写（与沙箱口径一致）
    unanalyzable: pass            # deny | ask | pass：shell 判不出时的兜底（pass=交给沙箱，v2 默认）
    failMode: closed              # closed | open：插件内部异常时的兜底
    dryRun: false                 # true = 只记日志不拦（灰度用）
    modelFallback: false          # 预留字段：置 true 仅记一条 warn 日志，判定行为不变
    autoWhitelist: false          # true = 用户批准的沙箱升权写入目标自动进白名单（默认关闭）
    preemptiveWhitelistEscalation: true  # 白名单写预置升权：一次成功、不弹框（v2 默认开）
    opaqueBlacklistScan: true     # 判不出命令的黑名单文本粗检（黑名单读的唯一兜底，v2 默认开）
    autoWhitelistFile: <dsh home>/path-rules/auto-whitelist.json   # 自动白名单状态文件（可选）
    logPath: ~/.kimi-code/hooks/logs/path_rules.dsh.log
```

日志事件：`plugin-loaded / allow / ask / deny / pass / dry-run / error`，
以及自动白名单的 `auto-whitelist / auto-whitelist-skip / auto-whitelist-load /
auto-whitelist-save / auto-whitelist-error`。

## 自动白名单（`autoWhitelist`，2026-10-18 新增）

**用途**：路径规则档下，项目外写入的审批通路是"沙箱拒绝 → 模型带 `sandbox_permissions` 重试 →
框架弹审批框"。同一个目录反复写就会反复弹框。打开 `autoWhitelist` 后，用户**批准过一次**的写入目标，
其目录会被自动记进白名单；之后同一目录的升权请求由本插件直接答 `allowed-once`（不弹框）。

**触发条件**（缺一不可）：

1. `autoWhitelist: true` 且 `enabled: true`、`dryRun: false`；
2. 会话当前处于「路径规则」档（`activationPreset` 命中，子代理沿父链上溯；其它四档不学习）；
3. 审批类型是**沙箱升权**（`reason` 以 `escalate sandbox to ` 开头）；
4. 用户在审批框点了同意（`approval/request` 瀑布下游返回 `allowed-once`；拒绝/取消/不可用都不学）。

**学什么**：从该次调用的参数静态解析写入目标 —— `write`/`edit` 的 `file_path`、`bash`/`pwsh` 的
写目标（复用 `analyze.mjs`）；目标是已存在的目录就取它自己，否则取父目录。**解析不出就什么都不学**
（不猜）：MCP/未知工具、判不出的 shell 命令、参数没被记住的调用都只记一条 skip 日志。

**生效方式**：条目并入内存白名单（下一条消息起系统提示里可见），此后：

- 该目录的写入由本插件直接 `allow`（但**沙箱仍会先拒绝首次写入** —— 跨层限制见下）；
- 模型按提示带 `sandbox_permissions` 重试时，`approval/request` 命中白名单 ⇒ 插件答 `allowed-once`，
  用户**不再看到弹框**。

命令类（`bash`/`pwsh`）升权请求的命中判定 2026-10-18 起改为**按静态写目标**：全部写目标都落在
白名单/项目内/临时区、且至少一个命中白名单才自动放行；任一目标命中黑名单或项目外就交给用户。
只有命令判不出写目标时才退回旧的「命令文本包含白名单路径」粗粒度口径。
（旧口径会把 `cp /white/f.txt /elsewhere/f.txt` 这类命令静默放行；自动白名单让白名单动态变化后必须收紧。）

**持久化**：默认状态文件 `<dsh home>/path-rules/auto-whitelist.json`（可用 `autoWhitelistFile` 覆盖，
支持 `~`），格式：

```json
{
  "version": 1,
  "entries": [
    { "path": "/srv/data", "platform": "linux", "addedAt": "2026-10-18T06:00:00.000Z", "tool": "write", "callId": "call_..." }
  ]
}
```

- 按 `process.platform` **分区存放**：容器（linux）与宿主（win32）共享同一份 `~/.dsh` 时互不串味，
  写回时保留另一平台的条目；跨平台写法的路径在加载时直接忽略。
- 原子写（临时文件 + rename）、坏文件容错（只记 error 日志，不影响插件加载）、上限 200 条
  （超出淘汰最旧）。
- 用户可直接编辑/删除该文件；**生效时机 = 插件重新加载**（改本行 config 是 patch 层热加载约 2 秒；
  改代码需重启 dsh）。`loader` 日志里 `auto-whitelist loaded=N` 可确认读到了多少条。

**安全护栏**（自动加入前逐条过滤，丢弃原因写进日志）：

| 跳过原因 | 含义 |
|---|---|
| `blacklist` | 目标/目录命中黑名单 ⇒ 不学（黑名单优先级最高，加了也无效） |
| `no-need` | 目标在项目内或临时区，本来就直通，无需白名单 |
| `already-whitelisted` | 目录已被现有白名单覆盖 |
| `protected` | 与插件状态/日志文件或 DSH home 相关（防"自动白名单自己改写自己"） |
| `sensitive` | 目录是系统根（`/`、`/etc`、`/usr`、`/var`、`/opt` …）或用户 home **自身或其祖先** |

即：批准一个文件**不会**被放大成整个 home/系统目录的长期信任；`/root/data` 这类更深层目录可以自动加入，
但 `/root` 本身不行（要用就手工写进 config 的 `whitelist`）。

**跨层限制（重要）**：自动白名单**不突破沙箱**。工作区外第一次写入仍会被 `workspace-write` 拒绝一次，
模型需按错误提示带 `sandbox_permissions` + `justification` 重试；区别只在于重试的审批请求
由插件自动放行、不再弹框。详见下文「已知盲区 8」。

## 白名单写入的预置升权（`preemptiveWhitelistEscalation`，2026-10-18 v2）

**用途**：白名单目录在沙箱可写根（会话工作区 + 临时区）之外，静态判定放行后沙箱仍会先拒绝一次，
模型需带 `sandbox_permissions` 重试、插件再自动放行。预置升权把这一步提前，让白名单写**一次成功**。

**条件（全部满足）**：开启且非 `dryRun`；工具是 `bash`/`pwsh`；静态分析判得出写目标且非空；每个写目标
∈ 白名单/项目内/临时区；至少一个命中白名单；至少一个在沙箱可写根之外；调用参数里没有
`sandbox_permissions`/`justification`（尊重模型自己的升权请求）。

**机制**：pre-execute 里给该次调用预置 `sandbox_permissions: danger-full-access` + justification；
bash/pwsh 工具随后发起升权审批，插件自己的 `approval/request` 监听器按白名单自动答 `allowed-once`
（不弹框）。执行策略与"模型重试后自动放行"完全相同，不新增放权面；注入失败（参数不可写等）只记
`preempt-escalation-error` 日志并退回原链路。方案 C（自研 sandbox provider 让白名单成为运行时 RW 根）
落地后应关闭本项（`preemptiveWhitelistEscalation: false`），否则会绕过 C 的运行时拦截。

## 已知盲区（未覆盖，别当安全）

1. **长驻进程自行写盘**：`bash` 的 `run_in_background`、`job_*` 起的进程在命令文本之外写文件。
2. **未受控工具透传**：MCP 工具与未来新增工具若自行写盘，本闸门与沙箱都可能覆盖不到。
3. **`glob`/`grep` 的 `pattern` 不是路径**：只对 `path` 参数做黑名单判定。
4. **子代理没有审批通道**（框架钉 `approval: never`）⇒ 只能"拒绝"，不能"弹框"。
5. **编码/不可判定命令**：`-EncodedCommand`、`eval`、超过 3 层的 `bash -c` 嵌套、未闭合引号一律
   按 `unanalyzable` 处理。
6. **读操作不受沙箱保护**：黑名单读的防护 100% 依赖本插件处于激活状态。
7. **大小写敏感按平台**：Linux 下按大小写敏感匹配；Windows 桌面端目前**未**实现大小写不敏感回退
   （目录大小写不同但实际相同的路径可能漏判黑名单，已知未覆盖）。
8. **跨层分工**：插件批准**不能**突破 `workspace-write` 沙箱（可写根 = 会话工作区 + `/tmp` + `os.tmpdir()`）。
   项目外/白名单（工作区外）的写会被沙箱拦下，模型需带 `sandbox_permissions` + `justification`
   重试同一调用以触发框架审批；白名单目标的升权请求由本插件自动答 `allowed-once`（无弹框）。
   详见 spec §4.4。
9. **自动白名单只学"能静态解析写目标"的调用**：MCP/未知工具、`unanalyzable` 的 shell、参数未被记忆的
   调用都不学习（只记 skip 日志）；`bash` 的间接产物（脚本内部、后台进程）同既有盲区。
10. **自动白名单是父目录粒度**：批准 `/a/b/f.txt` 会把整个 `/a/b` 加入白名单（用户语义如此）；
    敏感根保护只挡系统根与 home 自身/祖先，不挡更深的目录。
11. **命令判不出写目标时升权放行退回子串口径**：`bash`/`pwsh` 命令若静态分析判不出（`unanalyzable`、
    参数未记忆），仍按"命令文本包含白名单路径"粗粒度放行 —— 这是旧插件沿用口径，无法在不分析的前提下收紧。
12. **判不出命令的黑名单「读」**：沙箱只拦写、不拦读，本插件对判不出的命令只剩"命令文本粗检"
    （`opaqueBlacklistScan`）；脚本内部/间接读取（如脚本文件里读黑名单路径）不可见。
13. **判不出命令的白名单「写」**：无法预判写目标 ⇒ 仍走"沙箱首拒 → 升权重试"；且升权审批因解析不出目标
    会弹用户框、`autoWhitelist` 也学不到（`writableDirsOf` 对 unanalyzable 返回空）。
14. **预置升权（`preemptiveWhitelistEscalation`）使该次调用失去沙箱写兜底**：与既有"模型重试后插件自动
    放行"属同一信任级别（最终都是 danger-full-access），但仍依赖静态分析正确；可用
    `preemptiveWhitelistEscalation: false` 关闭，退回"首拒 + 重试"链路。

## 测试

```bash
cd packages/runtime/dsh-path-rules
node --test test/rules.test.mjs test/classify.test.mjs test/analyze-lex.test.mjs \
  test/analyze-bash.test.mjs test/analyze-pwsh.test.mjs test/decide.test.mjs \
  test/plugin.test.mjs test/analyze-security.test.mjs test/auto-whitelist.test.mjs
```

（Node v24 下 `node --test test/` 目录形式会失败，必须显式给出文件；`npm test` 已包含全部 9 个文件。）

v2 设计（路径规则 = workspace-write 超集，2026-10-18）：`docs/superpowers/specs/2026-10-18-path-rules-v2-superset-design.md`；
设计文档（v1）：`docs/superpowers/specs/2026-10-16-dsh-path-rules-permission-mode-design.md`；
实现计划：`docs/superpowers/plans/2026-10-17-dsh-path-rules-permission-mode.md`。
