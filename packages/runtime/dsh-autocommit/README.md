# @gavinc-cn/dsh-autocommit

DSH 原生的**自动提交守卫**：本会话改过文件、却想接着跑下一回合时挡下来，提示模型先提交。
由 kimi-code 的 `session_autocommit` hook 移植而来。

## 触发点（kimi hook → DSH 扩展点）

| kimi 事件 | DSH 扩展点 |
|---|---|
| `Stop` | `agent/turn-stopping`（serial；靠 `agent.steer()` 强制再跑一步） |
| `PreToolUse`（让行工具） | `tools/pre-execute`（返回 `{ kind: 'deny', reason }`） |
| `PermissionRequest` | `approval/request`（DSH 侧是真瀑布，可决策） |
| `SubagentStart/Stop` | 不用事件追踪：`agent.session.header` 的 `origin` / `delegationDepth` 已能判定子代理回合 |
| 读 `wire.jsonl` 算改动文件 | `session/event` 在线累积 `tool/call`（进程内，不碰会话日志格式） |

判定算法与 kimi 一致：**「本会话写类工具碰过的文件」∩「git status 脏路径」**，宁可漏、不可错。

## 安全姿态（设计约束）

- **绝不 unasked 写操作**：默认只「挡 + 提示模型去提交」；自行提交仅在 `commitOnApproval=true`
  （默认 `false`）时发生，且只在审批弹窗路径上。
- 所有监听器自己吞异常——插件跑在 harness 进程内，抛出去会打断当前工具调用/回合。

## 配置（profile patch 的条目 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（`false` 时完全不介入） |
| `dryRun` | `false` | 只记日志、不挡不提交 |
| `commitOnApproval` | `false` | 审批弹窗路径上由插件代提交 |
| `maxBlocks` | `2` | 同一改动窗口内最多挡几次 |
| `blockWindowMs` | `900000` | 改动窗口（15 分钟） |
| `logPath` | `<home>/.kimi-code/hooks/logs/session_autocommit.dsh.log` | 审计日志 |

环境变量与标记文件（沿用 kimi 侧同名开关）：

- 关闭：`DSH_AUTOCOMMIT=0` / `KIMI_AUTOCOMMIT=0`，或全局标记文件 `~/.kimi-code/hooks/session_autocommit.off`
- 仓库级关闭：仓库根放 `.kimi-autocommit-off`
- 干跑：`DSH_AUTOCOMMIT_DRY_RUN=1` / `KIMI_AUTOCOMMIT_DRY_RUN=1`，或标记文件 `~/.kimi-code/hooks/session_autocommit.dryrun`

## 依赖

运行时 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`，该包**由 dsh 宿主提供**
（`<profiles>/node_modules/@deepseek-ai/*` 是指向 dsh 全局安装的软链，版本随 dsh 走）。
因此 `peerDependencies` 里声明为 `"*"` 且 `optional: true`：既让 dsh 的兼容性检查放行，又**不会**
让 npm/pnpm 去 registry 拉一个 `@deepseek-ai/dsh-llm` 的旧版本盖住宿主那份。

## 安装

本包**不是 bundle 型包**（未声明 `dsh.bundle`），`dsh plugin add` 只会装成普通依赖、不会加载。
按 profile 本地插件方式安装：

1. 把包放到 `<dsh home>/profiles/node_modules/@gavinc-cn/dsh-autocommit/`；
2. 在 `<profile>/cordis.patch.yml` 增加注册行（需要调参时在条目上加 `config:`）：

```yaml
- insert:
    - id: dsh-autocommit
      name: "@gavinc-cn/dsh-autocommit"
```

3. 重启一次 dsh web。

## 已知边界

- **bash 的间接产物识别不了**（例如脚本内部生成的文件），属已知边界，不会被提交。
- 与 kimi 侧共用 `~/.kimi-code/hooks/` 标记文件与日志目录；日志单独一份
  `session_autocommit.dsh.log`，便于与 kimi 侧区分。
