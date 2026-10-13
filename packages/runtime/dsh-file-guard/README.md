# @gavinc-cn/dsh-file-guard

会话文件守卫的 DSH 原生 Cordis 插件 + 等价 CLI：记录「本会话写下的文件状态」，每轮收尾比对磁盘，
发现被外部进程、并行会话或文件同步（mutagen 双向同步）覆盖/回退时**只报告、不自动改回**。

Python 源：`~/.kimi-code/hooks/file_guard.py`（765 行，只读）；本包是它的忠实移植，
**状态格式与 Python 版双向兼容**（同一 `STATE_ROOT` 下互读互写，见「互操作」）。

## 为什么必须搬到插件

DSH 的 hook 子进程走 `dsh-hook-protocol.runHook()` → `bash.execute()`，请求里不带 `sandboxPolicy`，
回退到部署级默认沙箱（工作区可写、root = 进程 cwd），实测只有 `/tmp` 可写：
`python3 file_guard.py stop-hook --dsh` 读得到 `~/.orca/file-guard/` 下的 journal，
却写不了 `state.json`（去重标记）与 `reports/`，异常被 `cmd_stop_hook` 的 `except` 静默吞掉
→ 每轮收尾要么不提示、要么反复提示同一批漂移。插件跑在 harness 进程内，不受这层沙箱约束。

## 装到哪

- 包实体：`<dsh home>/profiles/node_modules/@gavinc-cn/dsh-file-guard/`（跨 profile 共享一份）
- 每个 profile 的 `cordis.patch.yml` 各加一条：

  ```yaml
  - insert:
      - id: dsh-file-guard
        name: "@gavinc-cn/dsh-file-guard"
        config:
          stateRoot: ~/.orca/file-guard
  ```

- **新增条目要重启一次 dsh**（本包未擅自改 profile 配置）；之后改插件文件本身是热重载。

## 扩展点映射

| kimi hook | DSH 扩展点 | 动作 |
|---|---|---|
| `Stop` → `file_guard.py stop-hook` | `agent/turn-stopping` | 有漂移时 `agent.steer()` 一条 `short_notice` 文案（`source.kind = 'dsh-file-guard'`）；无漂移静默 |
| `SubagentStop` → 同一个 `stop-hook` | 同一个 `agent/turn-stopping` | 子代理会话有自己的 session id 与状态目录，照常检查；没有记录则静默（不做「子代理一律跳过」的特殊化） |

收尾检查的三条硬约束（与 Python 一致）：**只报告不自动改回**、**同一批漂移只提示一次**、
**任何异常都自己吞掉**（记 `error:*` 日志，绝不影响回合收尾）。

## CLI（与 Python 命令一一对应）

```bash
# Python（kimi 侧，skill orca-file-guard 现在用的写法）
python3 ~/.kimi-code/hooks/file_guard.py <子命令> [参数]

# 本包（DSH 侧，同一套参数与输出）
node <pkg>/lib/cli.mjs <子命令> [参数]
```

| 子命令 | 参数 | 说明 | 退出码 |
|---|---|---|---|
| `note <path>` | `--op`(write) `--tool` `--prev-from -` `--prev <sha1>` `--message` `--force` `--quiet` | 记录「该文件现在的状态 = 本会话期望状态」，并自动存内容副本 | 0 / 2（文件不存在或读不到） |
| `check` | `--path P` `--quiet` `--json` | 比对 journal 与磁盘 | 0（无漂移/静默）/ 1（有漂移） |
| `report` | `--path P` `--since T` | 时间线 + 当前漂移详情 + 恢复命令 | 0 |
| `restore <path>` | `--to <sha1\|last>`（必填）`--yes` | 显式恢复；无 `--yes` 一律拒绝 | 0 / 2 |
| `ack <path>` | `--remove` | 豁免路径（不再告警） | 0 / 2 |
| `forget <path>` | `--message` | 解除守护（写 `op=forget` 墓碑，副本保留） | 0 / 2 |
| `stop-hook` | `--dsh` | 每轮收尾检查；无漂移静默 | 恒 0 |

`--session <id>` 写在子命令**前后都生效**（Python 侧靠 `default=SUPPRESS` 的 parent parser，
本包靠「先全局摘出 `--session` 再定位子命令」）；`--opt value` 与 `--opt=value` 均支持。
`status` 类退出码已经逐条实测对齐（见「测试」F1 用例）。

## 状态格式（与 Python 同一份）

```
<state_root>/<session_id>/journal.ndjson   每条 = 会话期望的文件状态（单行 JSON，O_APPEND）
<state_root>/<session_id>/state.json       workspace/created_at/reported/ack/last_report_at
<state_root>/<session_id>/blobs/<sha1>     内容副本（恢复用；>2MiB 只记元数据）
<state_root>/<session_id>/reports/<YYYYmmdd_HHMMSS>.json   历次收尾报告（只留最近 50 份）
```

- `<state_root>`：默认 `~/.orca/file-guard`，env `FILE_GUARD_ROOT` 覆盖（插件用 `stateRoot` 配置）。
- `<session_id>`：`sanitize()` 后的会话 id（Unicode 字母数字与 `-_.` 保留，其余 → `_`，按码点截断 120）；
  CLI 未指定会话时用 `--session` → env `FILE_GUARD_SESSION` → `ws-<工作区目录名>`。
- `journal.ndjson` 记录字段：
  `ts abs path root op tool sha1 size inode mtime prev_blob last_good_blob note`；
  forget 墓碑少 `inode/mtime/prev_blob/last_good_blob`，`sha1` 为 `""`、`size` 为 `0`。
- `state.json` 字段：`workspace`（会话工作区，用于按 cwd 定位会话）、`created_at`、
  `reported`（`{绝对路径: 已报告的 sha1 或 kind}`，同一批漂移只提示一次的凭据）、
  `ack`（已豁免路径列表，排序后写入）、`last_report_at`。
- JSON 排版与 Python `json.dumps(..., ensure_ascii=False, indent=1)` 一致（含键序与空容器形态）。

## 配置（profile patch 条目的 `config`，全部可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时收尾直接放行 |
| `dryRun` | `false` | 只观察：不 steer、不写 `state.json`、不写 `reports/` |
| `stateRoot` | `~/.orca/file-guard` | 状态根（与 kimi 侧 `FILE_GUARD_ROOT` 同源才能互读） |
| `notifyOnStop` | `true` | `false` 时仍检查并落盘去重/报告，但不 `steer`（不打断回合） |
| `resolve` | `auto` | 状态目录解析档位：`auto`（默认，会话目录优先、退回 workspace）/ `session`（复刻 Python `stop-hook`）/ `workspace`（按 CLI 的 workspace 口径） |
| `logPath` | `~/.kimi-code/hooks/logs/file_guard.dsh.log` | 审计日志 |

### `resolve` 这一档为什么存在（2026-10-08 复核）

Python 的 `stop-hook` 在负载带 `session_id` 时**只**看 `<state_root>/<sanitize(session_id)>`，
而 CLI 默认的 `note`（不带 `--session`）写的是 `<state_root>/ws-<工作区目录名>`
（`default_session_id()`）——两条路径对不上，标准流程下 hook 永远查不到记录、静默空转。
实机佐证：`~/.orca/file-guard/` 下只有 `ws-private`（journal 里有本工作区的 note 记录）
与历史 `session-11e24c83-…`，而 DSH 会话 id 是 `session-<uuid>`，永远没有对应目录。

所以插件默认 `auto`：① 会话目录里有记录就用它（支持 `note --session <id>`，与 Python 语义一致）；
② 否则按 `resolve_session(None)` 的 workspace 口径找（`state.json.workspace` == cwd 所在 git 仓库根）；
③ 都没有 → 静默。想完全回到 Python `stop-hook` 语义（空转也在所不惜）就把 `resolve` 设成 `session`。
日志里会打 `via=session|workspace` 与最终 `dir=`，便于排障。


## 日志事件

格式 `<ISO 时间> | <事件> | <详情...>`（与 dsh-memory 同排版）：

| 事件 | 何时 | 例子 |
|---|---|---|
| `plugin-loaded` | 插件装载 | `plugin-loaded \| enabled=true \| dryRun=false \| stateRoot=~/.orca/file-guard \| notifyOnStop=true \| resolve=auto` |
| `stop:clean` | 无漂移 / 无守卫记录 / 已报告过 / 关闭 | `stop:clean \| n=0 \| reason=no-journal \| resolve=auto \| session=1a2b3c4d` |
| `stop:drift` | 有新的漂移 | `stop:drift \| n=2 \| session=1a2b3c4d \| subagent=false \| via=workspace \| dir=~/.orca/file-guard/ws-private` |
| `dry-run` | `dryRun=true` | `dry-run \| n=2 \| session=1a2b3c4d` |
| `error:<阶段>` | 监听器内异常（不外抛） | `error:turn-stopping \| Error: ... \| session=1a2b3c4d` |

判定漂移真的提示过：会话日志里 `source.kind === 'dsh-file-guard'` 的 `user/message`。

## 与 Python 对齐的两个坑（刻意保留，别"顺手修好"）

1. **`diff_hint` 的"行数"**：Python 源码里那句 f-string 写的是 `old.count(b'\\n')`，
   在 f-string 中 `b'\\n'` 是「反斜杠 + n」两个字节，不是换行符 —— 所以它数的是字面量 `\n`
   序列的出现次数（普通文本恒为 0 → 恒显示 `1 -> 1`）。本包 `countEscapedNewline()` 复刻该口径，
   与 Python 逐字节一致；真正的「首个差异在第 N 行」用的是真换行，两边相同。
2. **`mtime` 的浮点**：CPython 的 `st_mtime = (double)sec + (double)nsec*1e-9`，而 Node 的
   `st.mtimeMs/1000` 多一次乘除舍入。实测 500 个随机纳秒值里 148 个与 Python 差 1 ULP，
   会让 `check --json` 的 `actual_mtime` 两边对不上；本包改用 BigInt 纳秒复刻同一算式（500/500 一致）。

## 互操作（`test/interop.mjs`）

两个方向都实测通过，且**逐字节一致**（不是"都能跑"而已）：

- A) Python `note` 写 → JS `check/report/restore` 读出同样结果（含用 Python 存的 blob 恢复）；
- B) JS `note` 写 → Python `check/report/restore` 读出同样结果；同一会话交替写 journal、塞坏行都能读；
- C) 外部改动/删除后两边判出的漂移集合、`kind`、`expected_sha1`、`actual_sha1`、`recoverable`、
   `content_known_to_session` 完全一致；
- D) `check --json` 的文本输出逐字节相同（键序、浮点、空数组形态）；`check` 文本输出逐字节相同；
   `ack`/`forget` 写的 `state.json` 另一侧立刻认账；
- E) `stop-hook --dsh` 的 `{"decision":"block","reason":...}` 与 `short_notice` 文案逐字节相同
  （含 `--session <目录名>（有副本可恢复）` 结尾），第二次调用两边都静默；
- F) 各子命令退出码对齐（含用法错误 2、`restore` 未加 `--yes` 的 2、超 2MiB 无副本的 2）。

## 测试

```bash
cd <dsh home>/profiles/node_modules/@gavinc-cn/dsh-file-guard
node --test test/plugin.test.mjs     # 52 个用例：core/CLI 行为 + 插件（假 ctx）
node --test test/interop.mjs         # 14 个用例：与 Python CLI 双向互操作
```

单测口径覆盖了 Python 侧 `~/.kimi-code/hooks/tests/test_file_guard.py` 的全部 18 个用例
（静默、覆盖详情、内容回退、丢失、无基线、去重、重新记录后再提示、ack、restore 显式确认、
时间线、噪音路径、forget 墓碑与复活、超限无副本），另加插件层用例（steer 文案、
`dryRun`/`enabled=false`/`notifyOnStop=false`、子代理会话、steer 抛异常不外抛、stateRoot 缺失）。
所有状态根都在 `mktemp -d` 的临时目录里，**绝不触碰真实的 `~/.orca/file-guard/`**。

## 已知偏差与未确证项

**偏差（都很小，逐条点名）**

1. 用法/帮助文本里的 prog 名是 `dsh-file-guard`（Python 是 `file_guard.py`）：正常子命令的
   stdout 文案逐字节对齐，只有 argparse 的用法错误文本不同，**退出码仍对齐为 2**。
2. 不支持 argparse 的选项前缀缩写（`--ses X` 这种写法）；`--opt=value`、`--`、`-h/--help` 均支持。
3. `FILE_GUARD_ROOT=` 设成空串时按「未设置」处理（Python 会退化成 `Path('')` = 当前目录）。
   `FILE_GUARD_SESSION=` 空串两边同效（都当未设置）。
4. `note --prev-from -` 在**无管道输入**（TTY）时：Python 阻塞等 EOF，本包读不到就当空内容继续
   （不阻塞）。管道/重定向用法完全一致。
5. `dryRun` 与 `notifyOnStop` 是插件新增开关（Python 侧没有），默认值保持 Python 行为
   （`dryRun=false`、`notifyOnStop=true`）。
6. `short_notice` 结尾仍指向 `python3 ~/.kimi-code/hooks/file_guard.py report ...`：
   与 Python 逐字节一致**是刻意的**（Python CLI 仍然可用），不改成 JS 路径。
7. 插件的收尾检查不读 stdin payload（会话 id 取自 `agent.session.id`），因此 DSH 会话与
   kimi 会话各自有独立的状态目录 —— 状态是按 session id 索引的，两者本就不该混用；
   同一个 DSH 会话内 JS/Python 两种 CLI 写下的记录是互认的。
8. **状态目录解析默认用 `auto`（相对 Python `stop-hook` 的刻意偏差，2026-10-08 加）**：
   Python 只看 `session-<id>` 目录，而 CLI 默认 note 写 `ws-<目录名>`，导致 hook 空转；
   `auto` 会在会话目录无记录时退回 workspace 口径。要回到 Python 语义设 `resolve:'session'`。
   详见上文「`resolve` 这一档为什么存在」。
9. 读 journal 时按 `\n` 切行（Python 用 `str.splitlines()`，还会在 `\r`、U+2028 等
   Unicode 行分隔符上切）。只有当路径/备注里出现这些字符时才有差别，且本包的行为更不易误伤；
   真实数据（JSON 转义后的单行记录）两边完全一致。

**未确证项**

- 插件在真实 harness 进程内被 Cordis 装载的路径未实测（本次不重启 dsh，也没有改
  `cordis.patch.yml`）；已做的是 `import()` 自检 + 假 ctx 驱动全部监听器逻辑。
- `agent/turn-stopping` 在子代理会话上是否与主会话同样触发，取决于 harness 实现；
  插件不依赖该假设（真触发了就按同一套逻辑检查，没有记录就静默）。
- Python 侧 `st_ino` 与本包 `Number(st.ino)` 的极端大 inode（> 2^53）未构造用例，
  本机 inode 量级远低于该阈值。

## 已知边界（与 Python 同源）

- 两次收尾之间「覆盖后又自愈」查不出来；> 2MiB 的文件只记元数据、不存副本（报告会写明"无副本"）。
- 文件层无法区分「会话用别的方式写的（忘了 note）」与「外部进程/同步写的」，因此一律报告并标注
  `changed_after_note` / `content_known_to_session` 两条事实线索，不下结论。
- `restore --yes` 按定义会丢弃磁盘上的当前版本，必须用户明确同意后才用。
