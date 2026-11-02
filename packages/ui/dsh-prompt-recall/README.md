# @gavinc-cn/dsh-prompt-recall

在 DSH Web GUI **当前会话**的输入框为空时，按键盘 `ArrowUp`，把上一条真人提问的完整文本填回草稿；召回后按 `ArrowDown` 恢复召回前的草稿（空输入框就恢复为空）。

## 行为

- 只恢复文本，**不自动发送、不恢复附件、不跨会话共享历史**。
- `ArrowDown` 只撤销最近一次成功召回，且草稿仍原样等于召回文本、编辑器 revision 未变时才生效；用户修改过草稿后保持原生方向键行为，不会清空输入。
- 保留多行文本与多个文本块之间的换行；纯图片消息会继续向前寻找最近一条有文本的提问。
- 跳过 `source.kind !== "user"` 的插件注入消息（AGENTS、记忆等）。
- 非空草稿、IME 组字、修饰键、长按重复及非 `plain` 输入阶段不拦截按键。
- 历史请求期间如果用户已经输入新内容，过期的召回结果不会覆盖它。

## 实现约束

主输入框是 Lexical `contenteditable`，不能直接修改 DOM。插件挂在 `conversation.composer.dock`，通过官方 `useInput` / `inputActions` 读取草稿并写入：

1. 空草稿按 `ArrowUp` 时调用 `captureInsertion()` 保存带 `draftRev` 的位置；
2. 从当前 Session 的 `binding.eventSource` 事件窗口倒序查找最近的真人文本；窗口里没有且 `hasMore` 为真时调用官方 `binding.session.loadOlder()` 扩页（最多 20 页）；
3. 用 `insertText(text, span)` 写回，revision 已变化时官方接口拒绝过期插入；成功后记录召回文本与召回前草稿；
4. `ArrowDown` 时只有当前草稿仍等于记录的召回文本、且实时 `captureInsertion().draftRev` 与记录一致，才调用 `setDraft(原草稿)` 并清除记录；用户编辑、发送或清空草稿后记录失效。

`turnOutline.prompt` 只有折叠空白后的 50 字摘要，不能用来还原完整提问。

## 安装与生效

本包随 `@gavinc-cn/dsh-plugins-ui` 下发，在 Plugins 面板对应「上一条提问召回」行独立开关。新增 bundle 行需要重启宿主一次；之后仅修改 `lib/client.bundle.js` 可走客户端热替换。

## 测试

```bash
node --test test/prompt-recall.spec.mjs
# 或在仓库根目录
bash scripts/test-all.sh dsh-prompt-recall
```

单测用桩 React、DOM 和 Session 事件窗口加载真实 `lib/client.bundle.js`，覆盖完整原文、消息过滤、loadOlder 翻页、键盘守卫、ArrowDown 恢复、异步草稿保护、失败降级与卸载清理。

## 已知边界

- 只支持召回**一条**上一条提问：不连续向上翻阅更早历史，也不在多次提问之间上下遍历。
- `ArrowDown` 只能恢复本次召回前的草稿；召回文本被编辑后不会自动覆盖或清空（通过草稿文本与 revision 双重校验）。
- 依赖 DSH 的 `conversation.composer.dock`、`[data-composer-input]`、`inputActions`（含 `setDraft`）、`ctx.sessions.binding(...).eventSource` 与 `loadOlder()` 契约；升级 DSH 后需复核。
- 历史不可用或找不到文本时保持原状，只在控制台记录警告。
- 本包不持久化自己的历史副本，刷新后仍从当前会话日志读取。
