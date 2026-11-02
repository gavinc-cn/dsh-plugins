/**
 * dsh-prompt-recall —— 当前会话空输入框按 ArrowUp 召回上一条真人提问，
 * 再按 ArrowDown 恢复召回前的草稿。
 *
 * 目的：只把完整问题文本填回草稿，不自动发送、不恢复附件、不跨会话共享历史；
 * 向下键仅撤销这次召回，草稿被用户修改后交还原生行为。
 * 设计约束：输入区由 Lexical 管理，禁止直接改 DOM；异步历史返回后用 inputActions 的
 * draftRev 防护插入，避免覆盖等待期间的新输入；整体恢复用官方 setDraft。
 * 已知边界：只恢复文本块；读取不到历史时保持原状并记录警告，不影响原生输入。
 * 生效链路：UI bundle 行 → 浏览器 client 模块 → conversation.composer.dock 会话组件。
 * 移除方式：在 Plugins 面板关闭本行，或从 UI bundle 删除对应 insert/dependency。
 */
window.__ModuleLoader__.load({
  id: '@gavinc-cn/dsh-prompt-recall',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const MAX_HISTORY_PAGES = 20

    /** 只认真正由用户发出的事件，排除 AGENTS、记忆等插件注入消息。 */
    function isRealUserInput(event) {
      return event?.type === 'user/message' && event?.data?.source?.kind === 'user'
    }

    /** 拼接一条用户消息的全部文本块，保留原始换行与块间空行。 */
    function fullTextOf(event) {
      const content = event?.data?.content
      if (!Array.isArray(content)) return ''
      return content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text.replace(/\r\n/g, '\n'))
        .filter((text) => text.trim() !== '')
        .join('\n\n')
    }

    /** 在一页历史中倒序找最近一条有文本的真人提问；纯图片消息继续向前找。 */
    function latestPromptFromEvents(entries) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const event = entries[index]?.event
        if (!isRealUserInput(event)) continue
        const text = fullTextOf(event)
        if (text.trim() !== '') return text
      }
      return null
    }

    /**
     * 从当前 Session 已打开的事件窗口取最近一条完整提问。
     * 窗口没有真人文本时用官方 loadOlder 向前扩页；revision 不变表示没有取得新历史，
     * 立即停下，避免加载失败或并发加载时死循环。
     */
    async function fetchLatestPrompt(ctx, sessionId) {
      const binding = ctx.sessions.binding(sessionId)
      if (binding?.eventSource?.getSnapshot === undefined || binding?.session?.loadOlder === undefined) return null
      for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
        const before = binding.eventSource.getSnapshot()
        if (!Array.isArray(before.entries)) throw new Error('eventSource 返回形状异常')
        const beforeRevision = before.revision
        const beforeHasMore = before.hasMore
        const prompt = latestPromptFromEvents(before.entries)
        if (prompt !== null) return prompt
        if (beforeHasMore !== true) return null

        await binding.session.loadOlder()
        const after = binding.eventSource.getSnapshot()
        if (after.revision === beforeRevision && after.hasMore === beforeHasMore) return null
      }
      return null
    }

    /**
     * 无可见界面的会话组件：监听官方 contenteditable。
     * ArrowUp 只在空白纯文本阶段召回；ArrowDown 只在草稿仍是召回文本时恢复原草稿。
     * 捕获带 draftRev 的插入点后再 await 历史；effect 清理会使未完成的旧请求失效。
     */
    function PromptRecall({ useInput, inputActions, recallPreviousPrompt }) {
      const draft = useInput((state) => state.draft)
      const phase = useInput((state) => state.phase)
      const inFlight = React.useRef(false)
      const recalled = React.useRef(null)

      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof recallPreviousPrompt !== 'function') return undefined
        const input = document.querySelector('[data-composer-input]')
        if (input === null) return undefined
        let active = true

        // 用户编辑、发送或清空草稿后，旧的召回记录不再能代表当前内容。
        if (recalled.current !== null && draft !== recalled.current.text) recalled.current = null

        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.repeat) return
          if (event.isComposing || event.keyCode === 229) return
          if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
          if (phase !== 'plain') return

          if (event.key === 'ArrowDown') {
            const entry = recalled.current
            if (entry === null || draft !== entry.text || typeof inputActions.setDraft !== 'function') return
            // 闭包里的 draft 可能落后于 Lexical：再用实时 revision 排除等待重渲染期间的编辑。
            if (inputActions.captureInsertion().draftRev !== entry.draftRev) return
            event.preventDefault()
            recalled.current = null
            inputActions.setDraft(entry.originalDraft)
            return
          }

          if (event.key !== 'ArrowUp') return
          if (draft !== '') return

          event.preventDefault()
          if (inFlight.current) return
          const span = inputActions.captureInsertion()
          inFlight.current = true
          Promise.resolve()
            .then(() => recallPreviousPrompt())
            .then((text) => {
              if (!active || typeof text !== 'string' || text.trim() === '') return
              if (!inputActions.insertText(text, span)) return
              // 只记录本次成功写回的文本；用户一旦改动，ArrowDown 不再干预。
              recalled.current = {
                text,
                originalDraft: draft,
                draftRev: inputActions.captureInsertion().draftRev,
              }
            })
            .catch((error) => {
              if (active) console.warn('[dsh-prompt-recall] 读取上一条提问失败:', error)
            })
            .finally(() => {
              inFlight.current = false
            })
        }

        input.addEventListener('keydown', onKeyDown)
        return () => {
          active = false
          input.removeEventListener('keydown', onKeyDown)
        }
      }, [draft, phase, inputActions, recallPreviousPrompt])

      return null
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'dsh-prompt-recall',
        inject: (sessionId) => ({
          recallPreviousPrompt: () => fetchLatestPrompt(ctx, sessionId),
        }),
      }, PromptRecall))
    }

    exports.inject = ['slots', 'sessions']
    exports.apply = apply
    return module.exports
  },
})
