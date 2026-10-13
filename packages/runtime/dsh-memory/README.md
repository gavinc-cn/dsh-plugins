# @gavinc-cn/dsh-memory

DSH 原生跨会话记忆插件：会话首次提交 prompt 时注入两级记忆索引，回合结束时按限流提示模型回顾并写入记忆。

替代 kimi 侧两个 shell hook（`memory_inject.py` / `memory_review.py`）在 DSH 上的失效路径 ——
DSH 的 hook 子进程经 `dsh-hook-protocol` → `bash.execute()`，请求不带 `sandboxPolicy`，回退到部署级
默认沙箱（实测只有 `/tmp` 可写，且**不继承会话预设**），写记忆哨兵直接 `PermissionError` 被脚本
fail-open 吞掉；插件跑在 harness 进程内，不受这层沙箱约束。

## 装到哪

- 包实体：`<dsh home>/profiles/node_modules/@gavinc-cn/dsh-memory/`（跨 profile 共享一份）
- 每个 profile 的 `cordis.patch.yml` 各加一条：

  ```yaml
  - insert:
      - id: dsh-memory
        name: "@gavinc-cn/dsh-memory"
  ```

- **新增条目要重启一次 dsh**；之后改插件文件本身是热重载。

## 两个扩展点

| kimi hook | DSH 扩展点 | 动作 |
|---|---|---|
| UserPromptSubmit / `memory_inject.py` | `agent/pre-step` | 本会话首次（且本次 pre-step 带新消息）时，把 `<memory>` 块作为一条用户消息追加，`source.kind = 'kimi-memory'` |
| Stop / `memory_review.py` | `agent/turn-stopping` | 限流通过时 `agent.steer()` 一条 `[dsh-memory] 会话收尾回顾：…` 指令，让模型再走一步写记忆 |

## 配置（profile patch 条目的 `config`，全部可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时两个监听器直接放行 |
| `dryRun` | `false` | 只记日志：不注入、不 steer、不写哨兵、不计数 |
| `memoryRoot` | `~/.agents/memory` | 记忆根（与 kimi code / DSH desktop 共用一份） |
| `reviewInterval` | `4` | 每 N 次 Stop 提示一次回顾 |
| `maxInjections` | `8` | 每会话最多提示次数（8×4 = 32 次 Stop 上限） |
| `logPath` | `~/.kimi-code/hooks/logs/memory.dsh.log` | 审计日志 |

## 行为口径（与 Python 版对齐）

- 注入块：`<memory>` → `## 全局记忆索引` → `## 项目记忆索引（<key>）` → `</memory>`；两级都缺则整体不注入。
- 截断：每级各取前 200 行且 ≤25KB（UTF-8 字节、按行截断，不拆多字节字符）。
- project-key：git 根绝对路径 `'/'→'_'`（`git -C <cwd> rev-parse --show-toplevel`，2s 超时）；非 git 用 cwd。
- 去重：`.injected/<sanitize(session_id)>` 以 `openSync(..., 'wx')` 原子创建；已存在即跳过。
- 回顾限流：`.reviewed/<session_id>` 存计数，先 +1 再判 `count % 4 === 0 && count < 32`；状态写不了则不 steer（避免失去限流后反复打断）。
- TTL：两个目录内 mtime > 7 天的文件在每次注入/回顾尝试前清理。
- 子代理会话（`header.origin === 'subagent'` 或 `delegationDepth > 0`）：不注入、不回顾、不写哨兵。
- 哨兵写失败不阻断注入（记 `error:sentinel`，退化为每次注入一遍）。

## 日志与排障

格式 `<ISO 时间> | <事件> | <会话短 id> | <详情>`，事件：

`plugin-loaded` / `inject` / `skip:already-injected` / `skip:empty-index` / `skip:no-messages` /
`skip:subagent` / `skip:disabled` / `dry-run` / `review` / `skip:rate-limited` / `error:*`

判定注入真的进了上下文：会话日志里 `source.kind === 'kimi-memory'` 的 `user/message`
（`<dsh home>/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，解压后按行 grep）。
异常不静默：监听器自吞异常后写 `error:*` 行并 `ctx.logger.warn`。

## 测试

```bash
cd <dsh home>/profiles/node_modules/@gavinc-cn/dsh-memory && npm test
```

12 个用例（首次注入 / 哨兵去重 / 空索引 / 无新消息 / 下游 reject / 回顾限流第 1,5,…,29 次 /
`reviewInterval`+`maxInjections` 生效 / 子代理跳过 / `enabled=false` / `dryRun` /
异常不外抛 / 哨兵写失败降级）。测试的 `memoryRoot` 一律指向临时目录，不碰真实记忆。

## 已知边界

- 注入只做一次性：同一会话后续 prompt 不再注入，长会话中新写入的记忆不会中途再注入。
- 子代理会话完全不参与——相对 kimi hook 的一处有意收紧。
- 回顾是**次数**口径，不是「有值得记的信息才提示」：会出现提示了但无内容可记的空转。
- `dryRun` 下不写任何状态（哨兵/计数都不动），便于安全观察。
- 记忆根在 `~/.agents/memory`，该路径在 mutagen 白名单内 → 容器 ⇄ Windows 双向同步同一份
  （`two-way-resolved`：冲突以容器/alpha 为准）。
