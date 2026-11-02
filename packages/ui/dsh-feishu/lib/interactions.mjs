// @gavinc-cn/dsh-feishu —— 提问与审批双通道、飞书交互卡片与答案归一
//
// 目的：把 DSH 的 `user-questions/request` 与 `approval/request` 瀑布同时接到飞书
// 私聊卡片与原生 GUI：两边都能作答，**先成功作答的一方兑现**，迟到/重复的答案
// 一律忽略；飞书侧支持单选、多选、自定义文字、多子题，以及 `/answer /approve
// /deny` 文本命令（Task 8 把命令转交给本模块）。
//
// 设计约束：
//   - 只认领 `owns(sessionId)` 且能在 Store bindings 中找到唯一 open_id 的会话；
//     其余会话必须原样 `next()`，不得发卡、不得改变下游行为。
//   - 认领后先调用 `next()` 打原生 GUI lane，再发飞书卡片并竞速。飞书先答时把
//     原生 lane 的逻辑取消标记置位（AbortController），迟到结果被 tagged Promise
//     吸收；GUI 先答时清空 pending 并给飞书发一条「卡片已失效」短提示。两个 lane
//     都有处理器，绝不留下未观察的 rejection。
//   - 待处理 ID 由注入的 idFactory（默认 randomUUID）生成，卡片动作只带这个随机
//     ID 与题号/选项号；回调用真实载荷的 `event.operator.open_id`、`event.action.value`
//     与 `form_value`，并重新校验 open_id、binding 归属、会话归属与 pending 状态。
//   - 问题答案严格映射 DSH `AskUserQuestionAnswer { answers: [{id, selected, custom?}] }`：
//     `selected` 只放选项**原始 label**（按选项顺序），`custom` 只在非空时出现。
//   - 审批只有 `allowed-once` 与 `rejected` 两个动作，绝不提供会话级/永久批准；
//     卡片展示工具名、理由与脱敏后的参数摘要。
//   - 卡片遵循飞书 schema 2.0（与既有 Touchstone 构建器同形），但本包**不 import
//     Touchstone**；form 元素按飞书 1000 字符硬限逐个校验，整卡另有字节上限，
//     装不下就退化成「只用 /answer 文字作答」的卡片。
//   - 日志只写固定短语与 `redactError` 后的错误，不写问题正文、选项、答案、审批
//     参数或 open_id；参数摘要先按键名/值模式脱敏再截断。
//   - `close()` 幂等：注销监听、停收卡片、清空 TTL 计时器、让所有瀑布 Promise
//     恰好 settle 一次（问题以 AbortError 拒绝，审批返回 `cancelled`），并等待
//     在途的 listener 收口。
//
// 生效链路：Task 11 总装创建 `FeishuInteractions`，注入 ctx/owns/store/rest；并把
// `handleText` 交给 FeishuSessions，把 `handleCard` 交给 FeishuInbound.onCard。
//
// 已知边界：
//   - `next()` 没有取消参数，也没有公开的 native-lane cancel API；飞书先答时只能
//     逻辑取消（标记 + 忽略迟到结果），无法保证立刻收起 GUI 里的原生弹窗。GUI 的
//     原生 lane 仍会在用户作答/回合取消时自然收口。
//   - 文本 `/answer` 对多子题使用 `1:1;2:文字` 的分号语法；单个问题可直接写
//     `1`、`1,3` 或自定义文字。未知的 ASCII `前缀:` 视为格式错误而不是自定义文字，
//     避免把写错的题号静默当成答案。
//   - 同一 open_id 同时存在多个待处理问题时，文本命令必须带 `#<ID前缀>` 指定目标，
//     否则拒绝猜测（卡片不受影响，动作里自带 pending ID）。
import { createHash, randomUUID } from 'node:crypto'

import { redactError } from './utils.mjs'

/** 默认卡片有效期：10 分钟。 */
export const DEFAULT_TTL_MS = 10 * 60 * 1000

/** 单张交互卡片允许的最大 UTF-8 字节数（飞书整卡上限约 30KB，留出余量）。 */
export const MAX_CARD_BYTES = 28_000

/**
 * 飞书 form 元素的字节预算。
 *
 * 同族真实实现按 950 字节（UTF-8）留出余量：超过预算的 form 会被飞书
 * 230099/11310 整卡拒收，且客户端没有任何回执，卡片会静默丢失（评审 I2 终轮）。
 * 这里统一用 `Buffer.byteLength(JSON.stringify(form), 'utf8')` 计量，绝不使用
 * UTF-16 `.length`——中文 label 的 `.length` 可能仍 <1000 但字节数已远超预算。
 */
export const MAX_FORM_BYTES = 950

/** 同时保留的待处理交互上限；超出时先作废最旧的一条。 */
export const MAX_PENDING = 100

/** 在途 listener 上限；超过后新请求直接交给原生 lane，避免无限增长。 */
export const MAX_INFLIGHT = 200

/** 卡片事件去重集合上限（只保留最近 N 个 event_id）。 */
export const MAX_SEEN_EVENTS = 200

/** 自定义答案最大字符数（飞书输入框上限 1000，放宽到 2000 以兼容文本命令）。 */
export const MAX_CUSTOM_CHARS = 2_000

/** 单题最多渲染的选项按钮数；超过则整卡退化为文字作答。 */
export const MAX_RENDER_OPTIONS = 20

/** 单题最多显示的问题数（再多也只在卡片里列前 N 题，其余用文字补答）。 */
export const MAX_RENDER_QUESTIONS = 8

/** 卡片正文里 header/question/detail/选项 label 的截断上限。 */
const CLIP_HEADER = 100
const CLIP_QUESTION = 1_000
const CLIP_DETAIL = 1_000
const CLIP_OPTION = 200
const CLIP_SUMMARY = 240
const CLIP_REASON = 400

/** 审批参数里不应出现在卡片上的“正文类”键：只保留结构摘要。 */
const BODY_KEY = /^(?:content|body|text|data|messages?|prompt|source|code|diff|patch|file_?content|input_?text)$/i

/** 通用秘密键（比 utils 的 SECRET_PAIR 更宽；只用于卡片/日志展示，不当作安全边界）。 */
const SECRET_KEY = /(?:secret|token|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i

/** 形如 `token=xxx` / `"appSecret": "xxx"` 的键值对。 */
const GENERIC_SECRET_PAIR = /((?:["']?(?:token|secret|password|passwd|api[_-]?key|authorization|credential)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;}]+)/gi

/** 判断普通对象（排除 null/数组/Buffer）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object'
    && !Array.isArray(value) && !Buffer.isBuffer(value)
}

/** 截断文本，保留代理对（按码点迭代）。 */
function clip(value, max) {
  if (typeof value !== 'string') return ''
  if (value.length <= max) return value
  let out = ''
  for (const codePoint of value) {
    if (out.length + codePoint.length > max) break
    out += codePoint
  }
  return `${out}…`
}

/** 去掉控制字符（保留换行），压缩连续空白。 */
function cleanText(value, { singleLine = false } = {}) {
  if (typeof value !== 'string') return ''
  let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  text = singleLine ? text.replace(/\s+/g, ' ').trim() : text.trim()
  return text
}

/** 判断是否已经是一个 AbortError。 */
function abortError(reason, fallbackMessage) {
  const message = reason instanceof Error && typeof reason.message === 'string' && reason.message !== ''
    ? reason.message
    : fallbackMessage
  const error = new Error(message)
  error.name = 'AbortError'
  if (reason !== undefined) error.cause = reason
  return error
}

/** `Promise.withResolvers` 的兼容写法（宿主 Node 24 有，但保持测试替身简单）。 */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * 参数摘要脱敏：键名命中秘密/正文类直接替换，值再走 redactError 兜底，最后单行截断。
 * 不抛出：循环引用/含 BigInt 的对象退回 String()。
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeArgumentSummary(value) {
  if (value === undefined || value === null || value === '') return ''
  let raw
  try {
    if (typeof value === 'string') {
      raw = value
    } else {
      raw = JSON.stringify(value, (key, item) => {
        if (typeof key === 'string' && key !== '') {
          if (SECRET_KEY.test(key)) return '[已脱敏]'
          if (BODY_KEY.test(key)) return '[已省略]'
        }
        return item
      })
      if (typeof raw !== 'string') raw = String(value)
    }
  } catch {
    try {
      raw = String(value)
    } catch {
      raw = '[无法序列化]'
    }
  }
  raw = redactError(raw)
  raw = raw.replace(GENERIC_SECRET_PAIR, (_match, prefix) => `${prefix}[REDACTED]`)
  raw = cleanText(raw, { singleLine: true })
  return clip(raw, CLIP_SUMMARY)
}

/**
 * 校验并归一问题数组。
 *
 * 只接受结构完整的请求：非空数组、question.id 非空且唯一、question 文案/header 至少
 * 一个非空、options 数组里每个 label 都非空。任何不合法都返回 null，让调用方原样
 * `next()`，绝不把半截请求接管过来。
 * @param {unknown} raw
 * @returns {Array<{
 *   id: string, header: string, question: string, detail: string,
 *   multiSelect: boolean,
 *   options: Array<{label: string, displayLabel: string, description: string}>
 * }> | null}
 */
export function normalizeQuestions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const seen = new Set()
  const questions = []
  for (const item of raw) {
    if (!isPlainObject(item)) return null
    if (typeof item.id !== 'string' || item.id === '') return null
    if (seen.has(item.id)) return null
    seen.add(item.id)

    const question = cleanText(item.question)
    const header = cleanText(item.header)
    if (question === '' && header === '') return null

    const options = []
    if (item.options !== undefined) {
      if (!Array.isArray(item.options)) return null
      for (const option of item.options) {
        if (!isPlainObject(option)) return null
        if (typeof option.label !== 'string') return null
        // DSH 要求答案里的 selected 与调用方 label 逐字一致：原始 label 原样保留，
        // 只把清理后的版本用于卡片显示（I5）。
        const displayLabel = cleanText(option.label, { singleLine: true })
        if (displayLabel === '') return null
        options.push({
          label: option.label,
          displayLabel,
          description: cleanText(option.description, { singleLine: true }),
        })
      }
    }

    questions.push({
      id: item.id,
      header,
      question,
      detail: cleanText(item.detail),
      multiSelect: item.multiSelect === true,
      options,
    })
  }
  return questions
}

// ---------------------------------------------------------------- 卡片构建

/** 当前卡片 JSON 的 UTF-8 字节数。 */
function cardBytes(card) {
  return Buffer.byteLength(JSON.stringify(card), 'utf8')
}

/** form 元素的 UTF-8 字节数（飞书 950 字节预算口径）。 */
function formBytes(form) {
  return Buffer.byteLength(JSON.stringify(form), 'utf8')
}

/** schema 2.0 的纯 markdown 卡片。 */
function markdownCard(title, template, elements) {
  return {
    schema: '2.0',
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    body: { elements },
  }
}

/** 问题标题行。 */
function questionTitle(question, index, total) {
  const head = question.header || question.question || `第 ${index} 题`
  return `**${index}/${total} ${clip(head, CLIP_HEADER)}**`
}

/** 问题只读 markdown（含 header/question/detail/选项与能力标注）。 */
function questionMarkdown(question, index, total) {
  const lines = [questionTitle(question, index, total)]
  // header 缺席时标题已经用 question 正文，避免同一句话出现两遍。
  if (question.header !== '' && question.question !== '') {
    lines.push(clip(question.question, CLIP_QUESTION))
  }
  if (question.detail !== '') lines.push(clip(question.detail, CLIP_DETAIL))
  question.options.forEach((option, position) => {
    lines.push(`${position + 1}) ${clip(option.displayLabel, CLIP_OPTION)}`)
    if (option.description !== '') lines.push(`　　${clip(option.description, CLIP_OPTION)}`)
  })
  const caps = []
  if (question.multiSelect) caps.push('多选')
  if (question.options.length === 0) caps.push('可自定义文字')
  if (caps.length > 0) lines.push(`（${caps.join(' · ')}）`)
  return lines.join('\n')
}

/**
 * 多选 + 自定义的**合并** mini 表单。
 *
 * multi_select_static 与 input 都只能内嵌 form；若分两个 form，先提交多选就会立即
 * 兑现，自定义文字再也无法补上（评审 I4）。因此这里把两者放进同一个 form，只留一个
 * 提交按钮，回调同时读取 `form_value[sel]` 与 `form_value[custom]`。
 */
export function buildMultiSelectForm(pendingId, question, questionNo) {
  const value = { t: 'fq', p: pendingId, q: questionNo, k: 'multi' }
  return {
    tag: 'form',
    name: `fq${questionNo}_combo_form`,
    elements: [
      {
        tag: 'multi_select_static',
        name: `fq${questionNo}_sel`,
        placeholder: { tag: 'plain_text', content: '请选择（可多选，可留空）' },
        options: question.options.map((option, position) => ({
          text: { tag: 'plain_text', content: clip(option.displayLabel, CLIP_OPTION) },
          value: String(position + 1),
        })),
        // 飞书表单提交帧只读取提交按钮的 behaviors.value；组件上不再重复挂动作，
        // 既避免整卡丢失歧义，也把宝贵的 950 字节 form 预算留给 label（I2 终轮）。
      },
      {
        tag: 'input',
        name: `fq${questionNo}_custom`,
        placeholder: { tag: 'plain_text', content: '可补充自定义回答（选填）' },
        max_length: 1_000,
      },
      {
        tag: 'button',
        name: `fq${questionNo}_submit`,
        form_action_type: 'submit',
        type: 'primary',
        text: { tag: 'plain_text', content: `提交第 ${questionNo} 题` },
        behaviors: [{ type: 'callback', value }],
      },
    ],
  }
}

/** 自定义文字 mini 表单（input 必须内嵌 form 才能和按钮配合）。 */
function customInputForm(pendingId, questionNo) {
  const value = { t: 'fq', p: pendingId, q: questionNo, k: 'custom' }
  return {
    tag: 'form',
    name: `fq${questionNo}_custom_form`,
    elements: [
      {
        tag: 'input',
        name: `fq${questionNo}_custom`,
        placeholder: { tag: 'plain_text', content: '输入自定义回答' },
        max_length: 1_000,
      },
      {
        tag: 'button',
        name: `fq${questionNo}_custom_submit`,
        form_action_type: 'submit',
        type: 'primary',
        text: { tag: 'plain_text', content: `提交第 ${questionNo} 题自定义回答` },
        behaviors: [{ type: 'callback', value }],
      },
    ],
  }
}

/** 单选按钮。 */
function optionButton(pendingId, questionNo, option, position) {
  return {
    tag: 'button',
    name: `fq${questionNo}_opt${position + 1}`,
    type: position === 0 ? 'primary' : 'default',
    text: {
      tag: 'plain_text',
      content: `${position + 1}) ${clip(option.displayLabel, CLIP_OPTION)}`,
    },
    behaviors: [{
      type: 'callback',
      value: { t: 'fq', p: pendingId, q: questionNo, k: 'option', o: position + 1 },
    }],
  }
}

/**
 * 卡片过大时的纯文字指引（不含任何可点控件）。
 *
 * 逐级压缩问题数/选项数/截断长度，每级都重新量 UTF-8 字节数，确保最终卡
 * <= MAX_CARD_BYTES；pending ID 用完整值（绝不带省略号），否则多条待答时
 * `#前缀` 无法唯一定位。极端情况下仍返回最小可用的纯文字卡。
 */
function questionFallbackCard(pendingId, questions) {
  const levels = [
    { questionCount: 8, optionCount: 20, questionChars: 160, optionChars: 60 },
    { questionCount: 8, optionCount: 10, questionChars: 120, optionChars: 40 },
    { questionCount: 6, optionCount: 6, questionChars: 90, optionChars: 32 },
    { questionCount: 5, optionCount: 4, questionChars: 70, optionChars: 24 },
    { questionCount: 4, optionCount: 2, questionChars: 60, optionChars: 20 },
    { questionCount: 3, optionCount: 0, questionChars: 50, optionChars: 0 },
  ]
  const total = questions.length
  for (const level of levels) {
    const elements = []
    questions.slice(0, level.questionCount).forEach((question, index) => {
      const lines = [
        `**${index + 1}/${total} ${clip(question.header || question.question, level.questionChars)}**`,
      ]
      if (question.header !== '' && question.question !== '') {
        lines.push(clip(question.question, level.questionChars))
      }
      question.options.slice(0, level.optionCount).forEach((option, position) => {
        lines.push(`${position + 1}) ${clip(option.displayLabel, level.optionChars)}`)
      })
      if (question.options.length > level.optionCount && level.optionCount > 0) {
        lines.push('（选项过多，已省略）')
      }
      elements.push({ tag: 'markdown', content: lines.join('\n') })
    })
    elements.push({
      tag: 'markdown',
      content: [
        '卡片内容较大，已切换为**文字作答**。',
        `单选：\`/answer #${pendingId} 1\`；多选：\`/answer #${pendingId} 1,3\`。`,
        `自定义：\`/answer #${pendingId} 文字\`；多子题：\`/answer #${pendingId} 1:1;2:文字\`。`,
      ].join('\n'),
    })
    const card = markdownCard(`🤔 DSH 提问（共 ${total} 题）`, 'orange', elements)
    if (cardBytes(card) <= MAX_CARD_BYTES) return card
  }
  // 最小兜底：只有一行指引，仍带完整 pending ID。
  return markdownCard('🤔 DSH 提问（卡片过大）', 'orange', [{
    tag: 'markdown',
    content: `请回复 \`/answer #${pendingId} 1\` 或 \`/answer #${pendingId} 你的文字\` 作答。`,
  }])
}

/**
 * 构建问题卡片。
 * @param {string} pendingId 随机待处理 ID
 * @param {Array<object>} questions normalizeQuestions 的输出
 * @returns {object} 飞书 schema 2.0 卡片
 */
export function buildQuestionCard(pendingId, questions) {
  if (questions.length > MAX_RENDER_QUESTIONS
    || questions.some((question) => question.options.length > MAX_RENDER_OPTIONS)) {
    return questionFallbackCard(pendingId, questions)
  }

  const elements = []
  questions.forEach((question, index) => {
    const questionNo = index + 1
    elements.push({ tag: 'markdown', content: questionMarkdown(question, questionNo, questions.length) })

    let controls = 0
    if (question.options.length > 0 && question.multiSelect) {
      // 多选 + 自定义共用一个 form：一次提交同时带回 selected/custom（I4）。
      const form = buildMultiSelectForm(pendingId, question, questionNo)
      if (formBytes(form) <= MAX_FORM_BYTES) {
        elements.push(form)
        controls += 1
      } else {
        elements.push({
          tag: 'markdown',
          content: `该题多选控件过大，请回复 \`/answer #${pendingId} ${questionNo}:1,3\` 作答。`,
        })
      }
    } else if (question.options.length > 0) {
      for (const [position, option] of question.options.entries()) {
        elements.push(optionButton(pendingId, questionNo, option, position))
        controls += 1
      }
      const custom = customInputForm(pendingId, questionNo)
      if (formBytes(custom) <= MAX_FORM_BYTES) {
        elements.push(custom)
        controls += 1
      }
    } else {
      const custom = customInputForm(pendingId, questionNo)
      if (formBytes(custom) <= MAX_FORM_BYTES) {
        elements.push(custom)
        controls += 1
      }
    }

    if (controls === 0) {
      elements.push({
        tag: 'markdown',
        content: `请回复 \`/answer #${pendingId} ${questionNo}:你的答案\` 作答。`,
      })
    }
  })

  elements.push({
    tag: 'markdown',
    content: [
      '也可直接回复文本命令：单选 `/answer 1`，多选 `/answer 1,3`，',
      '自定义 `/answer 文字`；多子题用 `/answer 1:1;2:文字`。',
    ].join(''),
  })

  const card = markdownCard(`🤔 DSH 提问（共 ${questions.length} 题）`, 'orange', elements)
  return cardBytes(card) <= MAX_CARD_BYTES ? card : questionFallbackCard(pendingId, questions)
}

/**
 * 构建审批卡片：只有「批准一次」与「拒绝」两个按钮。
 *
 * 真实 ApprovalRequestEvent 只有 toolName/reason/displayReason；没有参数对象，
 * 因此这里只展示工具名与脱敏后的理由，不伪造“参数摘要”（评审 I3）。
 * @param {string} pendingId
 * @param {{toolName: string, reason: string}} approval
 * @returns {object}
 */
export function buildApprovalCard(pendingId, approval) {
  const lines = [`**工具**：${clip(approval.toolName, CLIP_HEADER)}`]
  lines.push(`**理由**：${approval.reason === '' ? '（未提供）' : clip(approval.reason, CLIP_REASON)}`)
  lines.push('只允许本次批准；不存在会话级自动批准。')
  const elements = [{ tag: 'markdown', content: lines.join('\n') }]
  elements.push({
    tag: 'button',
    name: 'approval_once',
    type: 'primary',
    text: { tag: 'plain_text', content: '批准一次' },
    behaviors: [{ type: 'callback', value: { t: 'fp', p: pendingId, d: 'once' } }],
  })
  elements.push({
    tag: 'button',
    name: 'approval_reject',
    type: 'danger',
    text: { tag: 'plain_text', content: '拒绝' },
    behaviors: [{ type: 'callback', value: { t: 'fp', p: pendingId, d: 'deny' } }],
  })
  return markdownCard('🔐 DSH 审批请求', 'red', elements)
}

/** 飞书 uuid 上限 50 字符；用稳定 hash 避免把长 pending ID 直接拼进去（C1）。 */
function interactionUuid(pendingId) {
  const digest = createHash('sha256').update(String(pendingId)).digest('hex').slice(0, 32)
  return `feishu-int:${digest}`
}

/** 网络错误只记录类别/业务码，绝不带任意异常正文（可能含卡片/正文）。 */
function errorLabel(error) {
  try {
    const name = error !== null && typeof error === 'object' && typeof error.name === 'string'
      ? error.name
      : typeof error
    const code = error !== null && typeof error === 'object' && error.code !== undefined
      ? String(error.code)
      : ''
    return code === '' ? name : `${name}(${code})`
  } catch {
    return 'Error'
  }
}

// ---------------------------------------------------------------- 载荷解析

/**
 * 解析真实飞书卡片回调（Buffer/JSON 字符串/普通对象）。
 * 只读取需要的字段，未知字段忽略；任何结构不对返回 null。
 * @param {unknown} payload
 * @returns {{
 *   eventId: string, openId: string, value: object,
 *   formValue: object | string | undefined, action: object
 * } | null}
 */
export function parseCardPayload(payload) {
  let root = payload
  if (Buffer.isBuffer(root)) {
    try {
      root = JSON.parse(root.toString('utf8'))
    } catch {
      return null
    }
  } else if (typeof root === 'string') {
    try {
      root = JSON.parse(root)
    } catch {
      return null
    }
  }
  if (!isPlainObject(root)) return null

  const header = isPlainObject(root.header) ? root.header : {}
  const event = isPlainObject(root.event) ? root.event : null
  if (event === null) return null
  const operator = isPlainObject(event.operator) ? event.operator : {}
  const action = isPlainObject(event.action) ? event.action : null
  if (action === null) return null

  let value = action.value
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!isPlainObject(value)) return null

  let formValue = action.form_value
  if (typeof formValue === 'string') {
    try {
      formValue = JSON.parse(formValue)
    } catch {
      formValue = undefined
    }
  }
  if (formValue !== undefined && !isPlainObject(formValue) && typeof formValue !== 'string') {
    formValue = undefined
  }

  const openId = typeof operator.open_id === 'string' ? operator.open_id
    : (typeof operator.openId === 'string' ? operator.openId : '')
  const eventId = typeof header.event_id === 'string' ? header.event_id
    : (typeof root.event_id === 'string' ? root.event_id : '')

  return { eventId, openId, value, formValue, action }
}

/** 从 form_value 里取多选数组。 */
function readMultiValues(formValue, questionNo, action) {
  const preferred = `fq${questionNo}_sel`
  if (isPlainObject(formValue) && Array.isArray(formValue[preferred])) return formValue[preferred]
  if (isPlainObject(formValue)) {
    for (const [key, value] of Object.entries(formValue)) {
      if (Array.isArray(value) && /sel|multi|option/i.test(key)) return value
    }
    for (const value of Object.values(formValue)) {
      if (Array.isArray(value)) return value
    }
  }
  if (Array.isArray(action.options)) return action.options
  if (Array.isArray(action.option)) return action.option
  return null
}

/** 从 form_value / action 里取自定义文字。 */
function readCustomText(formValue, questionNo, action) {
  const preferred = `fq${questionNo}_custom`
  if (isPlainObject(formValue)) {
    if (typeof formValue[preferred] === 'string') return formValue[preferred]
    for (const [key, value] of Object.entries(formValue)) {
      if (typeof value === 'string' && /custom|input|text/i.test(key)) return value
    }
    for (const value of Object.values(formValue)) {
      if (typeof value === 'string') return value
    }
  }
  if (typeof formValue === 'string') return formValue
  if (typeof action.input_value === 'string') return action.input_value
  if (typeof action.inputValue === 'string') return action.inputValue
  return null
}

/** 解析正整数（1 起）。 */
function positiveInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const number = Number.parseInt(value.trim(), 10)
    return number > 0 ? number : null
  }
  return null
}

/** 把选项引用（1 起下标或 label）归一为下标（0 起）。 */
function optionIndex(question, raw) {
  const number = positiveInteger(raw)
  if (number !== null) return number <= question.options.length ? number - 1 : null
  if (typeof raw === 'string') {
    const needle = raw.trim()
    const index = question.options.findIndex((option) => option.label === raw
      || option.label === needle
      || option.displayLabel === needle)
    return index >= 0 ? index : null
  }
  return null
}

/** 去重并按选项顺序排序的 selected label 数组。 */
function selectedLabels(question, indexes) {
  const unique = [...new Set(indexes)].sort((a, b) => a - b)
  return unique.map((index) => question.options[index].label)
}

// ---------------------------------------------------------------- 交互处理器

/**
 * 飞书提问/审批双通道处理器。所有依赖可注入，测试不触网、不写真实存储。
 */
export class FeishuInteractions {
  /**
   * @param {object} options
   * @param {object} options.ctx Cordis 上下文（只使用 `ctx.on`）
   * @param {(sessionId: string) => boolean} options.owns 会话归属判定
   * @param {object} options.store Task 3 Store（bindings）
   * @param {object} options.rest REST 车道（提供 `sendCard(openId, card, {uuid})`；
   *   也兼容 Task 2 的 `restSendCard(openId, card, cfg, {uuid})` + `rest.cfg`）
   * @param {(openId: string, text: string) => Promise<void>} [options.sendText]
   *   可选的短提示发送器（优先于 rest.sendText）
   * @param {() => number} [options.now]
   * @param {number} [options.ttlMs]
   * @param {(level: string, message: string) => void} [options.log]
   * @param {() => string} [options.idFactory]
   */
  constructor({
    ctx,
    owns,
    store,
    rest,
    sendText,
    now = Date.now,
    ttlMs = DEFAULT_TTL_MS,
    log = () => {},
    idFactory,
  } = {}) {
    if (ctx === null || ctx === undefined || typeof ctx.on !== 'function') {
      throw new TypeError('FeishuInteractions: ctx 必须提供 on()')
    }
    if (typeof owns !== 'function') {
      throw new TypeError('FeishuInteractions: owns 必须是函数')
    }
    if (store === null || store === undefined || typeof store !== 'object') {
      throw new TypeError('FeishuInteractions: store 必须是对象')
    }
    if (rest === null || rest === undefined || typeof rest !== 'object') {
      throw new TypeError('FeishuInteractions: rest 必须是对象')
    }
    if (typeof rest.sendCard !== 'function' && typeof rest.restSendCard !== 'function') {
      throw new TypeError('FeishuInteractions: rest 必须提供 sendCard 或 restSendCard')
    }
    if (sendText !== undefined && typeof sendText !== 'function') {
      throw new TypeError('FeishuInteractions: sendText 必须是函数')
    }
    if (typeof now !== 'function') throw new TypeError('FeishuInteractions: now 必须是函数')
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 2_147_483_647) {
      throw new TypeError('FeishuInteractions: ttlMs 必须是合法的正整数定时器值')
    }
    if (idFactory !== undefined && typeof idFactory !== 'function') {
      throw new TypeError('FeishuInteractions: idFactory 必须是函数')
    }
    if (typeof log !== 'function') throw new TypeError('FeishuInteractions: log 必须是函数')

    this._ctx = ctx
    this._owns = owns
    this._store = store
    this._rest = rest
    this._restCfg = rest.cfg ?? rest.config
    this._sendTextFn = sendText
    this._now = now
    this._ttlMs = ttlMs
    this._logFn = log
    this._idFactory = idFactory ?? (() => randomUUID())

    /** pendingId → 待处理记录 */
    this._pending = new Map()
    /** 在途 listener 记录（含已过期但仍在等原生 lane 的） */
    this._inflight = new Set()
    /** 最近 event_id（有界） */
    this._seenEvents = new Set()
    this._seenOrder = []
    /** 在途卡片发送 Promise；close 会等待它们收口。 */
    this._cardSends = new Set()
    this._closed = false
    this._closePromise = null
    this._disposers = []

    const questionListener = (request, next) => this._onQuestion(request, next)
    const approvalListener = (request, next) => this._onApproval(request, next)
    this._disposers.push(ctx.on('user-questions/request', questionListener, { prepend: true }))
    this._disposers.push(ctx.on('approval/request', approvalListener, { prepend: true }))
  }

  // ── 公开接口 ─────────────────────────────────────────────────────────────

  /**
   * 会话归属判定（透传注入的 owns；异常按 false 处理）。
   * @param {string} sessionId
   * @returns {boolean}
   */
  owns(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    try {
      return this._owns(sessionId) === true
    } catch {
      return false
    }
  }

  /**
   * 处理 `/answer`、`/approve`、`/deny`；绝不 prompt。
   * @param {string} openId
   * @param {string} command 含 `/`（也接受中文别名与外层已拆分的 args）
   * @param {string} args
   * @returns {Promise<{handled: boolean, response?: string}>}
   */
  async handleText(openId, command, args) {
    if (typeof openId !== 'string' || openId === '') {
      throw new TypeError('FeishuInteractions.handleText: openId 必须是非空字符串')
    }
    try {
      const parsed = normalizeCommand(command)
      if (parsed === null) return { handled: false }
      let rest = typeof args === 'string' ? args : ''
      if (rest === '') rest = parsed.args

      if (this._closed) {
        return {
          handled: true,
          response: parsed.name === 'answer'
            ? '当前没有待处理的问题（交互已停止）。'
            : '当前没有待处理的审批（交互已停止）。',
        }
      }

      if (parsed.name === 'approve' || parsed.name === 'deny') {
        return this._textApproval(openId, parsed.name, rest)
      }
      return this._textAnswer(openId, rest)
    } catch (error) {
      this._log('warn', `交互文本命令失败: ${redactError(error)}`)
      return { handled: true, response: '操作失败，请稍后重试。' }
    }
  }

  /**
   * 分派一张飞书交互卡片。Task 2 的 onCard 不 await 本方法；这里只做同步状态
   * 变换，网络回执全部 best-effort 异步发出，任何异常都不向 WS 抛出。
   * @param {unknown} payload
   * @returns {Promise<void>}
   */
  async handleCard(payload) {
    if (this._closed) return
    try {
      const parsed = parseCardPayload(payload)
      if (parsed === null) return
      // 先查重但不记录：只有动作真正生效后才把 event_id 放进去重集合，
      // 避免一次失败（如非法选项）把后续同事件的重试也吞掉。
      if (parsed.eventId !== '' && this._seenEvents.has(parsed.eventId)) return

      const { value, openId, formValue, action } = parsed
      const type = value.t
      if (type !== 'fq' && type !== 'fp') return
      const pendingId = value.p
      if (typeof pendingId !== 'string' || pendingId === '') return

      const entry = this._pending.get(pendingId)
      if (entry === undefined || entry.settled === true || entry.expired === true) return
      // 跨 open_id / 绑定被撤销 / 会话不再自有：零状态变更。
      if (openId === '' || openId !== entry.openId) {
        this._log('warn', '卡片回调归属校验失败，已忽略')
        return
      }
      if (!this._sessionOwnedBy(openId, entry.sessionId)) {
        this._log('warn', '卡片回调会话归属失效，已忽略')
        return
      }

      let applied = false
      if (type === 'fq') {
        if (entry.kind !== 'question') return
        applied = this._onQuestionAction(entry, value, formValue, action)
      } else {
        if (entry.kind !== 'approval') return
        applied = this._onApprovalAction(entry, value)
      }
      if (applied === true && parsed.eventId !== '') this._rememberEvent(parsed.eventId)
    } catch (error) {
      this._log('warn', `卡片回调处理失败: ${redactError(error)}`)
    }
  }

  /**
   * 关闭：注销监听、作废全部 pending、收口原生/飞书两个 lane、停收卡片。
   * 幂等；重复调用共享同一个 Promise。
   * @returns {Promise<void>}
   */
  close() {
    if (this._closePromise !== null) return this._closePromise
    this._closed = true
    this._closePromise = (async () => {
      for (const dispose of this._disposers.splice(0)) {
        try {
          if (typeof dispose === 'function') await dispose()
        } catch (error) {
          this._log('warn', `注销交互监听失败: ${redactError(error)}`)
        }
      }
      const entries = [...this._inflight]
      for (const entry of entries) {
        this._clearTimer(entry)
        this._pending.delete(entry.id)
        this._settleFeishu(entry, { lane: 'feishu', expired: true })
        if (entry.closeDeferred !== null) entry.closeDeferred.resolve({ lane: 'close' })
      }
      await Promise.allSettled(entries.map((entry) => entry.run).filter(Boolean))
      // 已发出的卡片等它落定；close 后回调仍会被 _closed 拦截。
      await Promise.allSettled([...this._cardSends])
      this._pending.clear()
      this._seenEvents.clear()
      this._seenOrder.length = 0
    })()
    return this._closePromise
  }

  // ── waterfall 监听 ───────────────────────────────────────────────────────

  /** `user-questions/request` 的 prepend 监听器。 */
  _onQuestion(request, next) {
    try {
      if (this._closed) return next()
      if (!isPlainObject(request)) return next()
      if (request.signal?.aborted === true) return next()
      const sessionId = sessionIdOf(request)
      if (sessionId === '') return next()
      if (this.owns(sessionId) !== true) return next()
      const openId = this._findOpenId(sessionId)
      if (openId === '') return next()
      const questions = normalizeQuestions(request.questions)
      if (questions === null) return next()
      return this._claim({
        kind: 'question',
        sessionId,
        openId,
        questions,
        next,
        signal: request.signal,
      })
    } catch (error) {
      this._log('warn', `提问监听校验失败: ${redactError(error)}`)
      return next()
    }
  }

  /** `approval/request` 的 prepend 监听器。 */
  _onApproval(request, next) {
    try {
      if (this._closed) return next()
      if (!isPlainObject(request)) return next()
      if (request.signal?.aborted === true) return next()
      const sessionId = sessionIdOf(request)
      if (sessionId === '') return next()
      if (this.owns(sessionId) !== true) return next()
      const openId = this._findOpenId(sessionId)
      if (openId === '') return next()
      if (typeof request.toolName !== 'string' || request.toolName.trim() === '') return next()

      // 只读取真实契约：displayReason.zh 优先，其次 en，最后 reason；
      // 非契约字段（args/input/...）不读取、不展示（I3）。
      const display = isPlainObject(request.displayReason) ? request.displayReason : {}
      const zh = typeof display.zh === 'string' ? display.zh.trim() : ''
      const en = typeof display.en === 'string' ? display.en.trim() : ''
      const rawReason = zh !== '' ? zh : (en !== '' ? en : (typeof request.reason === 'string' ? request.reason : ''))
      const reason = sanitizeArgumentSummary(rawReason)
      return this._claim({
        kind: 'approval',
        sessionId,
        openId,
        approval: {
          toolName: cleanText(request.toolName, { singleLine: true }),
          reason: clip(reason, CLIP_REASON),
        },
        next,
        signal: request.signal,
      })
    } catch (error) {
      this._log('warn', `审批监听校验失败: ${redactError(error)}`)
      return next()
    }
  }

  /**
   * 认领一次请求：生成随机 pending ID、登记状态、打开原生 lane 并竞速。
   * @param {object} params
   * @returns {Promise<unknown>}
   */
  _claim(params) {
    if (this._pending.size >= MAX_PENDING) {
      this._expireOldest()
      if (this._pending.size >= MAX_PENDING) return params.next()
    }
    // 原生 lane 长期不 settle 时也不能让在途记录无限增长。
    if (this._inflight.size >= MAX_INFLIGHT) return params.next()
    const pendingId = this._newPendingId()
    if (pendingId === '') return params.next()

    const entry = {
      id: pendingId,
      kind: params.kind,
      sessionId: params.sessionId,
      openId: params.openId,
      questions: params.questions ?? [],
      approval: params.approval ?? null,
      /** 问题答案：questionId → {selected: string[], custom: string} */
      answers: new Map(),
      expiresAt: this._now() + this._ttlMs,
      expired: false,
      settled: false,
      settledBy: '',
      signal: params.signal,
      abortListener: null,
      timer: null,
      feishuSettled: false,
      feishuDeferred: deferred(),
      abortDeferred: params.signal === undefined || params.signal === null || params.signal.aborted === true
        ? null
        : deferred(),
      closeDeferred: deferred(),
      nativeController: new AbortController(),
      card: null,
      run: null,
    }
    // 宿主 signal 的 abort 是第三个竞速 lane；已 abort 的情况在监听入口就 next() 了。
    if (entry.abortDeferred !== null) {
      entry.abortListener = () => {
        const reason = params.signal?.reason
        entry.abortDeferred.resolve({ lane: 'abort', reason })
      }
      params.signal.addEventListener('abort', entry.abortListener, { once: true })
    }

    this._pending.set(pendingId, entry)
    this._inflight.add(entry)
    entry.timer = setTimeout(() => this._expire(entry), this._ttlMs)
    if (typeof entry.timer.unref === 'function') entry.timer.unref()

    const run = this._start(entry, params.next)
    entry.run = run
    return run
  }

  /** 启动竞速：同步打开原生 lane、同步发卡，再等待第一个胜者。 */
  async _start(entry, next) {
    const nativeLane = this._callNext(next)
    entry.nativeLane = nativeLane
    entry.cardPromise = this._sendCardFor(entry)

    try {
      const feishuLane = entry.feishuDeferred.promise.then((value) => ({ ...value, lane: 'feishu' }))
      const lanes = [
        feishuLane,
        nativeLane,
        entry.closeDeferred.promise,
      ]
      if (entry.abortDeferred !== null) lanes.push(entry.abortDeferred.promise)

      let winner = await Promise.race(lanes)
      if (winner.lane === 'feishu' && winner.expired === true) {
        // 卡片过期：飞书 lane 作废，继续等原生 GUI / 宿主 abort / close。
        const remaining = [nativeLane, entry.closeDeferred.promise]
        if (entry.abortDeferred !== null) remaining.push(entry.abortDeferred.promise)
        winner = await Promise.race(remaining)
      }

      if (winner.lane === 'feishu') {
        // 卡片动作/文本命令可能已经提前 deliver（settled=true）；否则在这里收口。
        if (entry.settled === true) return entry.delivered
        return this._finishFeishu(entry, winner.value)
      }
      if (winner.lane === 'native' || winner.lane === 'native-error') {
        return this._finishNative(entry, winner)
      }
      return this._finishCancelled(entry, winner)
    } finally {
      this._cleanup(entry)
      this._inflight.delete(entry)
    }
  }

  /** 调用原生 next()：同步异常也包成 tagged Promise，避免未处理 rejection。 */
  _callNext(next) {
    let promise
    try {
      promise = Promise.resolve(next())
    } catch (error) {
      promise = Promise.reject(error)
    }
    return promise.then(
      (value) => ({ lane: 'native', value }),
      (error) => ({ lane: 'native-error', error }),
    )
  }

  // ── 两个 lane 的收口 ─────────────────────────────────────────────────────

  /** 飞书先答：清 pending、逻辑取消原生 lane、把答案交给瀑布。 */
  _finishFeishu(entry, value, { notify = true } = {}) {
    if (entry.settled === true) return entry.delivered
    entry.settled = true
    entry.settledBy = 'feishu'
    entry.delivered = value
    this._pending.delete(entry.id)
    this._clearTimer(entry)
    this._abortNative(entry)
    // 让仍在 await feishuDeferred 的 _start 立刻拿到真实答案（而不是过期哨兵）。
    this._settleFeishu(entry, { lane: 'feishu', value })

    if (notify) {
      this._followUp(entry.openId, entry.kind === 'question'
        ? '已收到飞书回答，DSH 继续处理。'
        : (value === 'allowed-once' ? '已在飞书批准（仅本次）。' : '已在飞书拒绝。'))
    }
    return value
  }

  /** 原生 GUI 先答：清 pending、作废飞书卡片，返回原生结果。 */
  _finishNative(entry, winner) {
    // 飞书 lane 已经先兑现（理论上 race 不会走到这里）：保持首个结果。
    if (entry.settled === true) return entry.delivered
    entry.settled = true
    entry.settledBy = 'native'
    entry.delivered = winner.lane === 'native' ? winner.value : undefined
    this._pending.delete(entry.id)
    this._clearTimer(entry)
    this._settleFeishu(entry, { lane: 'feishu', expired: true })
    this._abortNative(entry)
    this._followUp(entry.openId, entry.kind === 'question'
      ? '该提问已在 GUI 作答，飞书卡片已失效。'
      : '该审批已在 GUI 处理，飞书卡片已失效。')
    if (winner.lane === 'native-error') throw winner.error
    return winner.value
  }

  /** 宿主 abort / close：问题拒绝（AbortError），审批返回 cancelled。 */
  _finishCancelled(entry, winner) {
    if (entry.settled === true) return entry.delivered
    entry.settled = true
    entry.settledBy = winner.lane
    this._pending.delete(entry.id)
    this._clearTimer(entry)
    this._settleFeishu(entry, { lane: 'feishu', expired: true })
    this._abortNative(entry)
    if (entry.kind === 'approval') return 'cancelled'
    if (winner.lane === 'close') {
      throw abortError(undefined, '飞书交互已关闭')
    }
    throw abortError(winner.reason, '飞书交互已取消')
  }

  /** 逻辑取消原生 lane：标记 + 清监听；迟到结果由 tagged Promise 吸收。 */
  _abortNative(entry) {
    try {
      entry.nativeController.abort(abortError(undefined, '飞书已作答'))
    } catch {
      // AbortController 已 abort 或环境不支持：忽略。
    }
  }

  /** 飞书 lane 只允许 settle 一次。 */
  _settleFeishu(entry, value) {
    if (entry.feishuSettled === true) return
    entry.feishuSettled = true
    entry.feishuDeferred.resolve(value)
  }

  /** 清理计时器与 signal 监听；保留 pending 记录由 finish 函数负责。 */
  _cleanup(entry) {
    this._clearTimer(entry)
    if (entry.signal !== null && entry.signal !== undefined && entry.abortListener !== null) {
      try {
        entry.signal.removeEventListener('abort', entry.abortListener)
      } catch {
        // 忽略：signal 已失效。
      }
      entry.abortListener = null
    }
    if (this._pending.get(entry.id) === entry) this._pending.delete(entry.id)
  }

  /** 清 TTL 计时器。 */
  _clearTimer(entry) {
    if (entry.timer === null) return
    clearTimeout(entry.timer)
    entry.timer = null
  }

  // ── 问题卡片动作 / 文本答案 ──────────────────────────────────────────────

  /**
   * 卡片动作：单选、多选、自定义。非法值一律零状态变更。
   * @returns {boolean} true 表示至少写入了一部分答案（用于 event_id 去重记录）
   */
  _onQuestionAction(entry, value, formValue, action) {
    const questionNo = positiveInteger(value.q)
    if (questionNo === null || questionNo > entry.questions.length) return false
    const question = entry.questions[questionNo - 1]

    if (value.k === 'option') {
      const position = positiveInteger(value.o)
      if (position === null || position > question.options.length) return false
      this._applySelected(entry, questionNo, [position - 1])
    } else if (value.k === 'multi') {
      // 合并表单一次带回 selected 与 custom；两者至少有一个非空才算有效提交。
      const rawValues = readMultiValues(formValue, questionNo, action)
      const rawCustom = readCustomText(formValue, questionNo, action)
      const hasSelection = Array.isArray(rawValues) && rawValues.length > 0
      const hasCustom = typeof rawCustom === 'string' && cleanText(rawCustom) !== ''
      if (!hasSelection && !hasCustom) return false

      let indexes = []
      if (hasSelection) {
        for (const raw of rawValues) {
          const index = optionIndex(question, raw)
          if (index === null) return false
          indexes.push(index)
        }
        if (!question.multiSelect && indexes.length > 1) return false
      }
      if (hasSelection) this._applySelected(entry, questionNo, indexes)
      if (hasCustom) this._applyCustom(entry, questionNo, rawCustom)
    } else if (value.k === 'custom') {
      const text = readCustomText(formValue, questionNo, action)
      if (text === null || cleanText(text) === '') return false
      this._applyCustom(entry, questionNo, text)
    } else {
      return false
    }
    this._afterQuestionUpdate(entry, questionNo)
    return true
  }

  /** 应用单选/多选：selected 按选项顺序、清空 custom（单选）。 */
  _applySelected(entry, questionNo, indexes) {
    const question = entry.questions[questionNo - 1]
    const current = this._ensureAnswer(entry, question.id)
    current.selected = selectedLabels(question, indexes)
    if (!question.multiSelect) current.custom = ''
  }

  /** 应用自定义文字：非空、截断；单选时清空 selected。 */
  _applyCustom(entry, questionNo, rawText) {
    const question = entry.questions[questionNo - 1]
    const text = cleanText(rawText).slice(0, MAX_CUSTOM_CHARS)
    if (text === '') return
    const current = this._ensureAnswer(entry, question.id)
    current.custom = text
    if (!question.multiSelect) current.selected = []
  }

  /** 取/建某题的答案状态。 */
  _ensureAnswer(entry, questionId) {
    let answer = entry.answers.get(questionId)
    if (answer === undefined) {
      answer = { selected: [], custom: '' }
      entry.answers.set(questionId, answer)
    }
    return answer
  }

  /** 卡片部分更新后：答满则兑现，否则回一条进度提示。 */
  _afterQuestionUpdate(entry, questionNo) {
    if (this._allAnswered(entry)) {
      this._finishFeishu(entry, { answers: this._buildAnswers(entry) })
      return
    }
    const remaining = entry.questions.length - this._answeredCount(entry)
    this._followUp(entry.openId, `已记录第 ${questionNo} 题，还差 ${remaining} 题。`)
  }

  /** 是否所有问题都已有 selected 或 custom。 */
  _allAnswered(entry) {
    return entry.questions.every((question) => {
      const answer = entry.answers.get(question.id)
      return answer !== undefined
        && (answer.selected.length > 0 || answer.custom !== '')
    })
  }

  /** 已作答的题数。 */
  _answeredCount(entry) {
    return entry.questions.filter((question) => {
      const answer = entry.answers.get(question.id)
      return answer !== undefined && (answer.selected.length > 0 || answer.custom !== '')
    }).length
  }

  /** 按请求顺序输出 DSH AskUserQuestionAnswer.answers。 */
  _buildAnswers(entry) {
    return entry.questions.map((question) => {
      const answer = entry.answers.get(question.id) ?? { selected: [], custom: '' }
      const item = { id: question.id, selected: [...answer.selected] }
      if (answer.custom !== '') item.custom = answer.custom
      return item
    })
  }

  /** 卡片动作：审批只接受 once/deny。 */
  _onApprovalAction(entry, value) {
    const decision = value.d
    if (decision !== 'once' && decision !== 'deny') return false
    this._finishFeishu(entry, decision === 'once' ? 'allowed-once' : 'rejected')
    return true
  }

  // ── 文本命令 ─────────────────────────────────────────────────────────────

  /** `/approve` / `/deny`。 */
  _textApproval(openId, name, args) {
    if (args.trim() !== '') {
      return { handled: true, response: '该命令不接受参数。' }
    }
    const pending = this._pendingFor(openId, 'approval')
    if (pending.length === 0) {
      return { handled: true, response: '当前没有待处理的审批。' }
    }
    if (pending.length > 1) {
      return { handled: true, response: '当前有多个待处理审批，请在飞书卡片或 GUI 中操作。' }
    }
    const entry = pending[0]
    if (!this._sessionOwnedBy(openId, entry.sessionId)) {
      return { handled: true, response: '当前没有待处理的审批。' }
    }
    const value = name === 'approve' ? 'allowed-once' : 'rejected'
    this._finishFeishu(entry, value, { notify: false })
    return {
      handled: true,
      response: name === 'approve' ? '已批准（仅本次）。' : '已拒绝。',
    }
  }

  /** `/answer`：卡片同一套 validator 的文本形式。 */
  _textAnswer(openId, rawArgs) {
    const pending = this._pendingFor(openId, 'question')
    if (pending.length === 0) {
      return { handled: true, response: '当前没有待处理的问题。' }
    }

    let args = rawArgs.trim()
    let entry = null
    if (args.startsWith('#')) {
      const match = /^#(\S+)(?:\s+([\s\S]*))?$/.exec(args)
      if (match === null) return { handled: true, response: '答案格式无效。' }
      const prefix = match[1]
      args = (match[2] ?? '').trim()
      const matched = pending.filter((item) => item.id.startsWith(prefix))
      if (matched.length !== 1) {
        return { handled: true, response: '未找到可回答的提问。' }
      }
      entry = matched[0]
    } else if (pending.length === 1) {
      entry = pending[0]
    } else {
      return {
        handled: true,
        response: '当前有多个待处理问题，请使用卡片，或在 /answer 后加 #<待处理ID前缀>。',
      }
    }

    if (args === '') return { handled: true, response: '答案不能为空。' }
    if (!this._sessionOwnedBy(openId, entry.sessionId)) {
      return { handled: true, response: '未找到可回答的提问。' }
    }

    const parsed = parseTextAnswer(entry.questions, args, entry.answers)
    if (parsed === null) {
      return { handled: true, response: '答案格式无效，请使用卡片或 /answer 1 或 /answer 文字。' }
    }
    // 先完整解析再落状态：非法输入绝不留下半截答案。
    for (const [questionId, answer] of parsed) entry.answers.set(questionId, answer)

    if (this._allAnswered(entry)) {
      this._finishFeishu(entry, { answers: this._buildAnswers(entry) }, { notify: false })
      return { handled: true, response: '已收到回答，DSH 继续处理。' }
    }
    const remaining = entry.questions.length - this._answeredCount(entry)
    return { handled: true, response: `已记录，还差 ${remaining} 题。` }
  }

  /** 某 open_id 的未失效待处理项（保持插入顺序）。 */
  _pendingFor(openId, kind) {
    const list = []
    for (const entry of this._pending.values()) {
      if (entry.openId !== openId) continue
      if (entry.kind !== kind) continue
      if (entry.settled === true || entry.expired === true) continue
      if (entry.expiresAt <= this._now()) {
        this._expire(entry)
        continue
      }
      list.push(entry)
    }
    return list
  }

  // ── 卡片送达 / 短提示 ────────────────────────────────────────────────────

  /** 构建并投递卡片；失败只记脱敏日志，不阻断 `/answer` 文本通道。 */
  _sendCardFor(entry) {
    const card = entry.kind === 'question'
      ? buildQuestionCard(entry.id, entry.questions)
      : buildApprovalCard(entry.id, entry.approval)
    entry.card = card
    const uuid = interactionUuid(entry.id)
    let promise
    try {
      if (typeof this._rest.sendCard === 'function') {
        promise = Promise.resolve(this._rest.sendCard(entry.openId, card, { uuid }))
      } else {
        promise = Promise.resolve(this._rest.restSendCard(
          entry.openId,
          card,
          this._restCfg,
          { uuid },
        ))
      }
    } catch (error) {
      promise = Promise.reject(error)
    }
    const tracked = promise.catch((error) => {
      // 只写错误类别/码：异常正文可能夹带卡片 JSON 或用户内容。
      this._log('warn', `交互卡片发送失败: ${errorLabel(error)}`)
    })
    this._cardSends.add(tracked)
    const remove = () => { this._cardSends.delete(tracked) }
    tracked.then(remove, remove)
    return tracked
  }

  /** best-effort 短提示；只在构造注入了 sendText 或 rest 提供文本发送时生效。 */
  _followUp(openId, text) {
    if (this._closed || typeof text !== 'string' || text === '') return
    let promise
    try {
      if (typeof this._sendTextFn === 'function') {
        promise = Promise.resolve(this._sendTextFn(openId, text))
      } else if (typeof this._rest.sendText === 'function') {
        promise = Promise.resolve(this._rest.sendText(openId, text))
      } else if (typeof this._rest.restSendText === 'function') {
        promise = Promise.resolve(this._rest.restSendText(openId, text, this._restCfg))
      } else {
        return
      }
    } catch (error) {
      this._log('warn', `交互提示发送失败: ${redactError(error)}`)
      return
    }
    promise.catch((error) => {
      this._log('warn', `交互提示发送失败: ${redactError(error)}`)
    })
  }

  // ── 查找 / 过期 / 去重 / 日志 ────────────────────────────────────────────

  /** 从 store bindings 找拥有该 session 的 open_id；找不到返回空串。 */
  _findOpenId(sessionId) {
    if (typeof this._store.bindingEntries !== 'function') return ''
    let entries
    try {
      entries = this._store.bindingEntries()
    } catch {
      return ''
    }
    if (!Array.isArray(entries)) return ''
    for (const pair of entries) {
      if (!Array.isArray(pair) || pair.length < 2) continue
      const [openId, binding] = pair
      if (typeof openId !== 'string' || openId === '') continue
      if (!isPlainObject(binding)) continue
      if (Array.isArray(binding.sessionIds) && binding.sessionIds.includes(sessionId)) return openId
    }
    return ''
  }

  /** 回调时重新校验：binding 仍包含该 session 且 owns 仍为 true。 */
  _sessionOwnedBy(openId, sessionId) {
    let binding
    try {
      if (typeof this._store.getBinding === 'function') {
        binding = this._store.getBinding(openId)
      } else {
        return this.owns(sessionId)
      }
    } catch {
      return false
    }
    if (!isPlainObject(binding)) return false
    if (!Array.isArray(binding.sessionIds) || !binding.sessionIds.includes(sessionId)) return false
    return this.owns(sessionId)
  }

  /** TTL 到期：pending 作废（卡片失效），但仍继续等原生 GUI。 */
  _expire(entry) {
    if (entry.settled === true || entry.expired === true) return
    if (this._pending.get(entry.id) !== entry) return
    entry.expired = true
    this._pending.delete(entry.id)
    this._clearTimer(entry)
    this._settleFeishu(entry, { lane: 'feishu', expired: true })
    this._followUp(entry.openId, entry.kind === 'question'
      ? '该提问已过期，请在 DSH GUI 继续回答。'
      : '该审批已过期，请在 DSH GUI 继续处理。')
  }

  /** 待处理过多时作废最旧的一条（保持内存有界）。 */
  _expireOldest() {
    const oldest = this._pending.values().next().value
    if (oldest !== undefined) this._expire(oldest)
  }

  /** 生成唯一随机 pending ID；idFactory 异常/碰撞时最多重试 5 次。 */
  _newPendingId() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let value
      try {
        value = this._idFactory()
      } catch (error) {
        this._log('warn', `待处理 ID 生成失败: ${redactError(error)}`)
        return ''
      }
      if (typeof value !== 'string' || value.length < 6 || value.length > 64) continue
      if (this._pending.has(value)) continue
      return value
    }
    return ''
  }

  /** 记录 event_id（有界 FIFO）。 */
  _rememberEvent(eventId) {
    this._seenEvents.add(eventId)
    this._seenOrder.push(eventId)
    while (this._seenOrder.length > MAX_SEEN_EVENTS) {
      const oldest = this._seenOrder.shift()
      if (oldest !== undefined) this._seenEvents.delete(oldest)
    }
  }

  /** 脱敏日志出口；日志出口自身失败不影响主流程。 */
  _log(level, message) {
    try {
      this._logFn(level, clip(redactError(String(message)), 400))
    } catch {
      // 忽略日志出口异常。
    }
  }
}

// ---------------------------------------------------------------- 文本解析

/** 命令别名（大小写不敏感；Task 8 也接受中文命令名）。 */
const COMMAND_ALIASES = new Map([
  ['answer', 'answer'], ['回答', 'answer'], ['作答', 'answer'],
  ['approve', 'approve'], ['批准', 'approve'], ['同意', 'approve'],
  ['deny', 'deny'], ['reject', 'deny'], ['拒绝', 'deny'],
])

/**
 * 归一命令：支持 `/answer`、`/回答`、`answer`，以及外层已拆出的 args。
 * @param {unknown} raw
 * @returns {{name: 'answer'|'approve'|'deny', args: string} | null}
 */
function normalizeCommand(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null
  const withoutSlash = text.startsWith('/') || text.startsWith('／') ? text.slice(1) : text
  const match = /^([^\s]+)(?:\s+([\s\S]*))?$/.exec(withoutSlash)
  if (match === null) return null
  const name = COMMAND_ALIASES.get(match[1].toLowerCase())
  if (name === undefined) return null
  return { name, args: (match[2] ?? '').trim() }
}

/** 从 request 的 Agent 取 session.id（没有则空串）。 */
function sessionIdOf(request) {
  const agent = request?.agent
  const session = agent?.session
  return typeof session?.id === 'string' ? session.id : ''
}

/** 克隆已积累的答案（文本解析先合并到副本，成功后再写回）。 */
function cloneAnswers(entryAnswers) {
  const copy = new Map()
  for (const [questionId, answer] of entryAnswers) {
    copy.set(questionId, { selected: [...answer.selected], custom: answer.custom })
  }
  return copy
}

/**
 * 解析 `/answer` 文本。
 *
 * 语法：
 *   - 单题：`1`、`1,3`（多选）、`文字`、`custom=文字`、`选项原始 label`；
 *   - 多题：`1:1;2:文字` 或 `qid:1;other:文字`（分号/换行分隔）；
 *   - 合并：同一题可先 `1:1,3` 再 `1:custom=补充`（解析完一次性落状态）。
 *
 * 返回 null 表示格式非法；此时不得改变任何状态。
 * @param {Array<object>} questions
 * @param {string} args
 * @param {Map<string, {selected: string[], custom: string}>} existing
 * @returns {Map<string, {selected: string[], custom: string}> | null}
 */
export function parseTextAnswerInput(questions, args, existing = new Map()) {
  if (typeof args !== 'string') return null
  const text = args.trim()
  if (text === '') return null

  const result = cloneAnswers(existing)
  const segments = text.split(/[;\n]+/).map((segment) => segment.trim()).filter((segment) => segment !== '')
  if (segments.length === 0) return null

  for (const segment of segments) {
    let questionIndex = questions.length === 1 ? 0 : -1
    let value = segment
    let forceCustom = false

    const prefixed = /^([^\s:：=]+?)\s*[:：=]\s*([\s\S]*)$/.exec(segment)
    if (prefixed !== null) {
      const token = prefixed[1].trim()
      const lower = token.toLowerCase()
      let index = questions.findIndex((question) => question.id === token)
      if (index < 0) {
        const number = positiveInteger(token)
        if (number !== null && number <= questions.length) index = number - 1
      }
      if (index >= 0) {
        questionIndex = index
        value = prefixed[2].trim()
        if (lower === 'custom' || lower === 'text' || token === '自定义') {
          // `custom=文字` 不会走到这里（token 不是题号）；保留分支防御。
          forceCustom = true
        }
      } else if (lower === 'custom' || lower === 'text' || token === '自定义') {
        if (questions.length !== 1) return null
        questionIndex = 0
        value = prefixed[2].trim()
        forceCustom = true
      } else if (/^[A-Za-z_][\w-]*$/.test(token)) {
        // 未知的 ASCII 前缀：视为格式错误，避免 `x:1` 被当成自定义答案。
        return null
      }
      // 非 ASCII 前缀（如中文冒号）按普通自定义文字处理。
    }

    if (questionIndex < 0) return null
    const question = questions[questionIndex]
    if (question === undefined) return null
    if (value === '') return null

    const answer = result.get(question.id) ?? { selected: [], custom: '' }
    if (!forceCustom && /^custom\s*=/i.test(value)) {
      answer.custom = cleanText(value.replace(/^custom\s*=/i, '')).slice(0, MAX_CUSTOM_CHARS)
      if (answer.custom === '') return null
      if (!question.multiSelect) answer.selected = []
    } else if (!forceCustom && /^\d+(?:\s*[,，]\s*\d+)*$/.test(value)) {
      const indexes = value.split(/[,，]/).map((item) => positiveInteger(item.trim()))
      if (indexes.some((index) => index === null || index > question.options.length)) return null
      if (!question.multiSelect && indexes.length > 1) return null
      answer.selected = selectedLabels(question, indexes.map((index) => index - 1))
      if (!question.multiSelect) answer.custom = ''
    } else if (!forceCustom) {
      const byLabel = value.split(/[,，]/).map((item) => item.trim())
      const labelIndexes = []
      let allLabels = byLabel.length > 0
      for (const label of byLabel) {
        const index = question.options.findIndex((option) => option.label === label
          || option.label === label.trim()
          || option.displayLabel === label.trim())
        if (index < 0) { allLabels = false; break }
        labelIndexes.push(index)
      }
      if (allLabels) {
        if (!question.multiSelect && labelIndexes.length > 1) return null
        answer.selected = selectedLabels(question, labelIndexes)
        if (!question.multiSelect) answer.custom = ''
      } else {
        answer.custom = cleanText(value).slice(0, MAX_CUSTOM_CHARS)
        if (answer.custom === '') return null
        if (!question.multiSelect) answer.selected = []
      }
    } else {
      answer.custom = cleanText(value).slice(0, MAX_CUSTOM_CHARS)
      if (answer.custom === '') return null
      if (!question.multiSelect) answer.selected = []
    }
    result.set(question.id, answer)
  }
  return result
}

/** 内部别名，保持导出名与实现解耦。 */
const parseTextAnswer = (questions, args, existing) => parseTextAnswerInput(questions, args, existing)
