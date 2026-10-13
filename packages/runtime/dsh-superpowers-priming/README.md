# @gavinc-cn/dsh-superpowers-priming

DSH 原生 Cordis 插件：**给"重开的会话"补上 superpowers 开场说明，且保证每个会话最多一份。**

## 解决什么问题

superpowers 的 `SessionStart` 走 Claude Code 桥接（`~/.dsh/profiles/web/dsh-hooks.json`），
matcher 是 `startup|clear|compact`；而 DSH 的 agent 只有两种创建来源：

| source | 何时 | 桥接会注入吗 |
|---|---|---|
| `startup` | 新建会话 | ✅ 会 |
| `resume` | 会话在持久化日志里存在、但当前没有活 agent，于是被复活（最常见：**dsh web 重启后再打开旧会话**） | ❌ matcher 不含 `resume` |

而"该不该补"不能只看是不是 `resume`：

- 会话建好后**用过**才重开的 → 历史里已经有那条注入消息，模型重放历史时看得到 ⇒ 再注入就是重复（单份约 3405 字符 ≈ 950 tokens）；
- 会话建好后**从没用过**就重开的（点了新建任务、隔天才来提问）→ `agent.inject()` 只落在内存 inbox 里，
  agent 被 dispose 时连同 inbox 一起消失，**日志里一个字节都没有** ⇒ 历史里确实缺这段开场说明。

## 做法

`agent/created` 且 `source` 命中配置的 `sources`（默认 `['resume']`）时：

1. 跳过子代理会话（`origin === 'subagent'` 或 `delegationDepth > 0`）；
2. `ctx.sessionQuery.readSession(sessionId)` 读一次会话日志（非 deprecated 的异步读，不再用 `session.snapshotEvents()`）；
3. 扫有没有 priming 消息 —— `user/message` 且 `source.kind ∈ { 'hooks-claude-code'（桥接注入，老会话就是它）, 'superpowers-priming'（本插件） }`：
   - 有 → `skip:already-primed`，不注入；
   - 没有 → `agent.inject()` 一份 `using-superpowers` 全文（首行标明执行者），`source.kind = 'superpowers-priming'`。

**分工**：`startup` 默认仍归桥接（避免同一次 startup 两边各注入一份）；若哪天摘掉桥接那条
`SessionStart`，把 `sources` 设成 `['startup','resume']` 即由本插件独占这条注入（历史判重同样生效）。
上游 superpowers 仓库**零改动**：正文在注入时读它的 `skills/using-superpowers/SKILL.md`。

## 失败与边界

- **读不到会话日志**（没有 `sessionQuery` 服务、或读抛错）→ **不注入**并记 `skip:no-session-query` / `skip:read-failed`。
  宁可漏一次，也不要因为读失败在每次重开时反复注入、把上下文撑起来。
- 只处理主会话，子代理不补（生命周期短，注入是噪音）。
- 任何异常都自己吞掉并记 `error:agent-created` 日志，绝不影响会话创建。
- 已知误差：会话被 compaction 摘要掉那段 priming 后，判重仍会认为"已有"而不注入（可接受）。

## 配置（profile patch 条目的 `config`，全部可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时不注册监听 |
| `dryRun` | `false` | 只记 `dry-run` 日志、不注入 |
| `sources` | `['resume']` | 要兜底的创建来源，可选 `startup` / `resume` |
| `skillPath` |  `~/superpowers/skills/using-superpowers/SKILL.md`（可用 env `SUPERPOWERS_SKILL_PATH` 覆盖） | 开场说明正文来源 |
| `logPath` | `~/.kimi-code/hooks/logs/superpowers_priming.dsh.log` | 审计日志 |

## 验证与运维

- 单测：`node --test test/plugin.test.mjs`（14 例：补注入 / 桥接已注入 / 本插件已注入 / startup 不插手 /
  sources 扩展 / 子代理 / 读失败 / 无服务 / enabled=false / dryRun / 技能文件缺失 / 判重函数 / 文案）。
- 日志看点：`inject | resume | session=<8位> | events=N | bytes=M`、`skip:already-primed`。
- 加载方式：profile patch 新增条目是 **live 重载**（本次实测写完约 2 秒后插件即 `plugin-loaded`，无需重启）。
