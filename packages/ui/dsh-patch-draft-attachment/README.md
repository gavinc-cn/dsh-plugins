# @gavinc-cn/dsh-patch-draft-attachment

让输入框草稿里的**截图 / 图片 / 文件**在切换会话、刷新页面后还在。

## 问题

官方 `@deepseek-ai/dsh-client-ui-conversation` 只把草稿的**文字与引用**持久化：

```js
// localStorage["dsh.conversation.<sessionId>"]
{ draft: { text, references }, view, viewRequest }
```

附件是纯运行时的（源码注释 `Create runtime-only draft attachments`）：字节只存在于
`ConversationController.draftAttachments`（File + 对象 URL）里。会话输入 shell 一销毁
（切到别的会话），`releaseDraftAttachment()` 就把描述符和对象 URL 一起回收；切回来时文字从
`localStorage` 恢复，**图片却没了**（刷新页面同理）。真机复现步骤与证据见
`doc_ai/spec/ui/patch-draft-attachment.md`。

## 做法

宿主侧 Cordis 插件，不注册任何客户端 slot；启动时对 webserver 实际服务的
`@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 打一个幂等文本补丁，把附件额外落一份到浏览器：

1. `localStorage["dsh.draft.attachments.<sessionId>"]`：索引（`id / kind / name / type`，只有几十字节），
   同一份索引也供 `@gavinc-cn/dsh-patch-unsent-session` 判断「纯图片草稿」要不要留在侧栏；
2. `IndexedDB["dsh-draft-attachments"]["files"]`：按附件 id 存 Blob（File 可直接结构化克隆）；
3. 输入 shell 建好时（`shellFor`）按索引还原 File、重新登记进 `draftAttachments`，并走官方
   `rebindDraftFiles()` 重发上传 —— 之后与正常粘贴的附件完全一致；
4. 点 × / 提交成功时删掉持久化副本；**会话切走**导致的 release 保留副本
   （`releaseDraftAttachment(id, keepDraftFile=true)`）。

官方文件内容一变，dsh web 的 HMR 会自动让浏览器重新拉取，无需重启。

## 配置

profile patch 的覆盖行里可选：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `disable` | `false` | 只停止后续重打补丁，不撤销已经写入的内容 |
| `bundlePath` | `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` | 补丁目标 |
| `logPath` | `~/.kimi-code/hooks/logs/patch_draft_attachment.log` | 结果日志 |
| `reapply` | `false` | 定时兜底重打（成品包被重装覆盖时） |
| `reapplyMs` | `5000` | 兜底间隔（≥1000） |

## 已知边界

- 单文件 > 24 MB 不持久化（本次会话内照常可发，只是跨会话/刷新后不恢复）。
- IndexedDB 不可用或配额不足时静默降级成官方行为（文字草稿仍然正常）。
- 会话被删除/归档后残留的索引与 Blob 不主动清理（量级很小，浏览器清理站点数据时一并清掉）。
- 恢复时会给每个附件重发一次上传（拿到新的 receipt），与首次粘贴的行为一致。
- 官方升级后 bundle 被压缩/改写时锚点会失配：补丁整体拒绝并写日志，不会半打补丁；需要按新写法更新 `lib/patch.mjs` 的锚点。

## 验证

- 单测：`node --test packages/ui/dsh-patch-draft-attachment/test/patch.spec.mjs`（10/10，含真实 bundle 字节上的
  锚点/幂等/回滚/语法检查 + 假 localStorage/IndexedDB 上的索引与恢复语义）。
- 真机（Playwright，`verify/shots/`）：`01-attached.png` 贴图后 chip 在 → 切走 → `02-switch-away-row-kept.png`
  侧栏草稿行保留 → 切回 `03-back-with-image.png` 文字 + 图片都在 → `04-after-reload.png` 刷新后仍在 →
  `05-image-only-row.png` 纯图片草稿的行标题=文件名 → `06-image-only-back.png` 切回仍恢复 →
  `07-after-remove.png` 点 × 后索引清空；`08-after-submit.png` 发送后索引同样清空（重启页面切回该会话，
  composer 不会复活已发送的图片）。
- 面板里的新行要**重启 dsh web** 才出现（新增 bundle 行不热加载）；补丁本身由 HMR 立即生效。

## 移除

在 Plugins 面板关闭本行（只停止重打），再把 `lib/client.js.orig` 覆盖回 `lib/client.js`
（或重装 `@deepseek-ai/dsh-client-ui-conversation`），刷新页面。
