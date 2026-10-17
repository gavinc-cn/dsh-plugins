# @gavinc-cn/dsh-path-rules

DSH 第五权限模式「路径规则」的逐调用闸门：挂在 `tools/pre-execute` waterfall 上，
先 `await next()` 取下游守卫（`dsh-git-guard` / `dsh-readonly-guard` 等）的结论，
再按「更严者胜」叠加自己的判定 —— 只可能更严，永不弱化既有守卫。

规则（用户 2026-10-13 定义）：

- 项目内（= 会话工作区根）目录**可读可写**；
- 项目外目录**只读**，写入需要用户审批；
- **白名单**内的目录可读可写（直通，不弹框）；
- **黑名单**内的目录读写**都要审批**（优先级最高，压过白名单与项目内）；
- `bash` / `pwsh`：只读命令直接放行；写入目标可静态解析时按上述规则判定；
  解析不出的命令默认拒绝并提示模型改写成可判定形式。

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
项目外写 → ask
shell 判不出 → unanalyzable 策略（默认 deny + 改写指引）
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
    unanalyzable: deny            # deny | ask：shell 判不出时的兜底
    failMode: closed              # closed | open：插件内部异常时的兜底
    dryRun: false                 # true = 只记日志不拦（灰度用）
    modelFallback: false          # 预留字段：置 true 仅记一条 warn 日志，判定行为不变
    logPath: ~/.kimi-code/hooks/logs/path_rules.dsh.log
```

日志事件：`plugin-loaded / allow / ask / deny / pass / dry-run / error`。

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

## 测试

```bash
cd packages/runtime/dsh-path-rules
node --test test/rules.test.mjs test/classify.test.mjs test/analyze-lex.test.mjs \
  test/analyze-bash.test.mjs test/analyze-pwsh.test.mjs test/decide.test.mjs \
  test/plugin.test.mjs test/analyze-security.test.mjs
```

（Node v24 下 `node --test test/` 目录形式会失败，必须显式给出文件。）

设计文档：`docs/superpowers/specs/2026-10-16-dsh-path-rules-permission-mode-design.md`；
实现计划：`docs/superpowers/plans/2026-10-17-dsh-path-rules-permission-mode.md`。
