# @gavinc-cn/dsh-feishu

DSH 的独立飞书桥插件：在 DSH 进程内完成飞书应用**扫码配置**、**绑定用户私聊**、
**文本/图片/文件入站**、**DSH 答复/云文档出站**，以及**飞书内提问与审批**闭环。
Host 与 client 同包，随 UI bundle（`@gavinc-cn/dsh-plugins-ui`）下发，在 Plugins 面板单独开关。

- **仅私聊、仅绑定 open_id、仅插件自建的 DSH 会话**；不支持群聊、用户 OAuth、任意既有会话接管或 DSH 附件回传飞书。
- **无运行时 npm 依赖**：二维码用随包 vendor 的 MIT 实现（qrcode core + dijkstra，许可证随目录保留），
  `@deepseek-ai/dsh-storage-domain` / `zod` 为 optional peer，由 DSH 宿主提供。

## 能力

| 能力 | 行为 |
|---|---|
| 扫码配置 | Device Flow + addons；面板显示真实二维码（本地 vendor 生成，data URL）与备用链接；成功后先存凭据再回调。`apply` / `publish` 只能显式点击，发布后仍需租户管理员审批 |
| 绑定 | 面板生成一次性绑定码（10 分钟、限频、只存内存）；用户在飞书私聊发 `/bind <码>` 完成 open_id 绑定；换应用后旧绑定不再沿用，需重新绑定 |
| 会话 | 每 open_id 独立会话集合与当前会话；首条普通消息惰性建会话，`mode: 'queue'` 排队；只能操作本插件为其创建的会话 |
| 入站 | `text` / `post` / `image` / `file`；先持久 inbox 再 ACK，串行 worker 处理；`message_id` 幂等去重，并作为 `feishu:<message_id>` requestId 的来源 |
| 附件 | 图片按 DSH `imageLimits` 准入（单消息最多 9 张）；文件默认上限 50 MiB，走 `fileUploads.uploadStream → receiptId → prompt`；任何资源失败则整条不投 |
| 答复 | durable assistant + `turn/end` 归集；短文本直接私聊（uuid=requestId）；长/结构化 Markdown 建/追加飞书云文档，私聊只回摘要 + 链接 |
| 交互 | 提问与审批同时投递飞书卡片与 GUI，**先答者胜**；审批仅 `allowed-once` / `rejected`；文本命令 `/answer`、`/approve`、`/deny` 等价可用 |
| 恢复 | inbox/outbox 持久状态、指数退避、人工重试；重启后核对 requestId；重载取消未完成认领，后台异常全部自吞 |
| 安全 | App ID/Secret 只经 CredentialRef（`DSH_FEISHU_APP_ID` / `DSH_FEISHU_APP_SECRET`）；面板 API owner-only；status/日志只回脱敏状态、打码 open_id，绝不回传 Secret、`device_code`、正文或 access token |

## 结构

```
lib/index.mjs                 Cordis 插件入口与 Host 总装：依赖注入、生命周期、脱敏 status
lib/provision.mjs             扫码状态机（Device Flow → 保存凭据 → 显式 apply/publish）
lib/binding.mjs               一次性绑定码（10 分钟、一次性、限频）
lib/inbound.mjs               WS 生命周期、持久 inbox、消息归一与 ACK
lib/attachments.mjs           图片/文件解析、限长下载、receipt 上传（全有或全无）
lib/sessions.mjs              每用户会话、斜杠命令、queue prompt 与取消
lib/replies.mjs               durable 答复归集、outbox 退避与重试
lib/interactions.mjs          提问/审批 waterfall 认领、飞书卡片、答案归一
lib/documents.mjs             Markdown→docx、同主题追加、链接权限与协作者
lib/store.mjs                 storageDomain schema、credentials、inbox/outbox 恢复
lib/routes.mjs                owner-only 管理 API（7 条 exact route）
lib/client.bundle.js          浏览器侧栏面板（扫码/绑定/连接/失败重试）
lib/feishu/{device,ws,rest,pyjson}.mjs  飞书协议底座（Device Flow / pbbp2 WS / OpenAPI REST）
lib/vendor/qrcode/            随包 MIT 二维码实现（core + SVG renderer + dijkstra，附许可证）
lib/utils.mjs                 错误脱敏 / 文本分片 / 文件名净化 / 穷尽分支检查
locale/{zh,en}.json           面板标题「飞书桥」/ Feishu Bridge
test/*.test.mjs               单元、集成与假飞书端到端测试（node:test）
```

## 飞书内命令

| 命令 | 作用 |
|---|---|
| `/bind <码>` | 用面板生成的一次性绑定码绑定当前 open_id |
| `/new [标题]` | 新建并切换到新会话 |
| `/sessions` | 查看本人会话（有界列表） |
| `/use <序号>` / `/current` | 切换 / 查看当前会话 |
| `/leave` | 离开当前会话（保留 DSH 历史） |
| `/stop` | 停止当前会话（cancel，不产生 prompt） |
| `/answer <答案>` | 回答待处理问题（多子题用 `1:1;2:文字`） |
| `/approve` / `/deny` | 批准（一次性）/ 拒绝审批 |
| `/unbind` | 解除绑定（保留 DSH 历史） |
| `/help` | 显示帮助 |

命令接受中文别名（如 `/新建`、`/会话`、`/切换`、`/批准`）。普通文本在当前会话排队；
图片/文件与文字可作为同一 prompt 的有序内容块。

## 面板 API

均注册在宿主 `ctx.connection.fetch`（GUI 认证 + owner-only），只做 7 条 exact route：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/feishu/status` | 连接态、扫码步骤、脱敏绑定、最近失败、非秘密配置 |
| POST | `/api/feishu/provision` | `start` / `cancel` / `apply` / `publish`（publish 需页面二次确认） |
| POST | `/api/feishu/bind-code` | 生成一次性绑定码 |
| POST | `/api/feishu/bindings/revoke` | 按 opaque `bindingKey`（sha256 前 16 hex；面板使用）或真实 `openId`（兼容）撤销绑定，不删 DSH 历史 |
| POST | `/api/feishu/reconnect` | 停旧 WS 并用当前凭据重连 |
| POST | `/api/feishu/config` | 默认 cwd、文件上限等非秘密配置 |
| POST | `/api/feishu/outbox/retry` | 重试指定失败投递 |

`status.connection` 的语义：只有 `_started && inbound.connected`（真实 socket 已打开）才是
`connected`；有凭据但 WS 正在重连/未运行是 `disconnected`；无凭据是 `provision-needed`
（不会仅凭「曾经启动过」或「重连循环仍在跑」伪报已连接）。

## 持久化

业务状态放 `ctx.storageDomain` 的 **`dsh_feishu`** 域（代码常量 `FEISHU_STORE_DOMAIN`；
宿主 `UNIT_NAME_RE` 禁止连字符，故不是包名里的 `dsh-feishu`），version `1`，三张表
`bindings` / `inbox` / `outbox` + global 配置：

- `bindings[open_id]`：自有 sessionIds、currentSessionId、各会话文档 ID、更新时间。
- `inbox[message_id]`：发送者、原始事件、状态、attempts、nextAttemptAt、错误分类。
- `outbox[request_id]`：open_id、sid、交付类型、摘要/正文或文档 ID、状态、attempts、nextAttemptAt。
- `globals`：默认 cwd、文件大小上限等非秘密配置；扫码临时状态与绑定码仅存内存并限时。

## 云文档出站

- 短答复（≤280 码点且非结构化）直接私聊；长/结构化 Markdown 才建/追加 docx。
- 文档标题 `DSH-<主题>-<yyyyMMdd_HHmm>`，时间按 **Asia/Shanghai**（可注入 IANA 时区，不依赖进程时区）。
- 同一会话复用 `bindings[open_id].docs[sessionId]`；已有文档时追加新小节，不重建第二份。
- 授权缺一不可：链接权限设为「组织内可阅读」+ 把 open_id 加成协作者，两步都成功才返回 URL；
  缺权限业务码统一转成 `missing_scopes` 并引导重新扫码。
- **已知边界（at-least-once）**：建文档后、append 之前的失败重试不会重复正文；但 append
  之后（含摘要发送、URL 落盘）失败时重试会把同一小节再写一遍，不承诺内容幂等。

## 测试

```bash
npm test          # 等价于 node --test
```

`node --test` 自动发现 `test/*.test.mjs`：协议底座（`device/ws/rest`）、存储、扫码、绑定/
入站、附件、答复、会话、文档、交互、路由、客户端面板、总装与 bundle 接线，共 17 个测试文件。
全离线，假飞书端与假 Host 服务；`npm pack --dry-run` 不包含 `test/`。

## 依赖

- **无运行时 npm 依赖**。二维码随包 vendor（`lib/vendor/qrcode/`，MIT），
  `deploy-to-dsh.sh` 排除 `node_modules`，也不在 profile 内安装依赖。
- `@deepseek-ai/dsh-storage-domain`、`zod` 为 **optional peer**（由 DSH 宿主提供）。
- 纯 ESM、无构建步骤；换行一律 LF。

## 已知限制

- 真实飞书扫码、文本/图片/文件、提问与审批全链仍需按计划做真实联调；在那之前不得宣称上线成功。
- 群聊、用户 OAuth、任意既有会话接管、DSH 附件回传飞书均不在范围内。
- 飞书先答时插件只能逻辑取消原生 lane（`next()` 的返回值被丢弃，插件没有公开的 cancel API）；
  **GUI 卡片能随之消失依赖宿主补丁**：DSH 0.2.1-rc.2 的 `UserQuestionService.ask()` 与
  `ApprovalService.decide()` 结算后都不 abort `request.signal`，未打补丁时提问会残留「待回答」卡片、
  审批卡片同样不消失。补丁脚本见 `scripts/patch-dsh-user-questions-settle.mjs`（仓库根，含提问 + 审批
  两处，自带 `--check` / `--verify`），契约见 `doc_ai/spec/toolchain/deploy-and-verify.md`；dsh 升级后需重跑。

## 许可

MIT
