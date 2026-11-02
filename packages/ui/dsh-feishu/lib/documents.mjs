// @gavinc-cn/dsh-feishu —— 长/结构化答复的飞书云文档交付
//
// 目的：Task 7 在 turn/end 收口答复后把 outbox 记录交给本模块；短答复直接私聊，
// 长/结构化 Markdown 建成飞书 docx（或追加到本会话已有文档），私聊只回摘要 + 链接。
//
// 设计约束（与 task-9-brief / doc_ai/spec/feishu/dsh-feishu.md 对齐）：
//   1. 判定与投放分流：`isStructuredMarkdown` 只看结构（标题/表格/清单/多段/代码/
//      引用/分隔线）或超过短文本阈值；短答复原样返回、不触碰 docx/drive REST。
//   2. 文档归属按会话：`binding.docs[sessionId] = {documentId, url}`；已有 documentId
//      时追加新小节（index = 根 children 长度），绝不因重试再建第二份。
//   3. 重试安全：建文档成功后立刻 read-modify-write 绑定，先落 documentId 与空 url；
//      链接权限、协作者授权、元数据全部成功后才 append 正文并落最终 url。权限/授权/
//      元数据失败时正文尚未写入，重试不会重复；append 之后（含摘要发送、URL 落盘）
//      的失败是 **at-least-once**：重试会把同一小节再写一遍，不承诺内容幂等。
//   4. 授权缺一不可：PATCH 公开链接为「组织内可阅读」，POST 把 open_id 加成协作者；
//      两步都成功才允许调用元数据并返回 URL。飞书缺权限业务码统一转成
//      `missing_scopes` 错误，并给出重新扫码授权的指引。
//   5. 正文转换：标题/项目符号/有序列表/代码/引用/分隔线映射为 docx block；表格
//      转成「表头：值 ｜ 表头：值」的列表行（该 mapper 不生成表格块）。段落按
//      1800 码点切块，正文最多 20000 码点/500 块，每次 children 请求 <=50 块。
//   6. 正文不落日志/摘要/绑定：日志只留 requestId/documentId/块数，返回与私聊只
//      留短预览 + URL；错误经 redactError 后截断。
//   7. 时间口径：标题与小节时间戳走可注入的 IANA `timeZone`（默认 Asia/Shanghai），
//      用 Intl.DateTimeFormat 计算，不依赖进程时区或 epoch 位移。
//
// 已知边界：
//   - 绑定写入只在本类内部按 openId 串行；**不宣称**一般 binding 更新的原子性。
//     Task 11 必须把 sessions 与 documents 的绑定写操作收口到同一处，或给 Store
//     增加 updateBinding/事务能力，否则并发两侧仍可能互相覆盖。
//   - 建文档/append/落 URL 之后失败时没有可回滚的 REST：文档可能保留孤儿内容，
//     重试会在同一文档重复追加，属于显式接受的 at-least-once 语义。
//
// 生效链路：Task 11 总装创建 `new FeishuDocuments({store, rest, cfg, now, timeZone, log})`，
// 作为 `FeishuReplies` 的 `deliver` 注入；Task 7 负责 outbox 状态、退避与重试。
import { redactError } from './utils.mjs'

/** 短文本判定阈值（按 Unicode 码点计）：超过即视为长答复。 */
export const SHORT_TEXT_MAX_CODE_POINTS = 280

/** 单次 docx children 请求最多块数（飞书实测上限 50）。 */
export const MAX_BLOCKS_PER_REQUEST = 50

/** 单段落块最多码点数（对齐 Touchstone `MD_BLOCK_MAX`）。 */
export const MAX_CODEPOINTS_PER_BLOCK = 1800

/** 单次交付最多解析的正文码点数，超出截断。 */
export const MAX_DOC_CODE_POINTS = 20_000

/** 单次交付最多写入的块数，超出截断。 */
export const MAX_DOC_BLOCKS = 500

/** 默认展示时区：文档标题与小节时间戳按用户所在时区（Asia/Shanghai）。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/** 绑定 docs 条目 schema 只接受这两个字段。 */
const DOC_ENTRY_KEYS = Object.freeze(['documentId', 'url'])

/**
 * 飞书缺权限业务码。与 `provision.mjs` 的 `PATCH_SCOPE_CODES` 同集；这里保留本地
 * 副本（并非共享导入），因为 provision 模块在加载期还会拉入二维码 vendor 依赖。
 * 若两份取值漂移，以 provision 的常量为准（报告已登记此重复）。
 */
const MISSING_SCOPE_CODES = Object.freeze([99991640, 99991672, 99991679])

/** 缺权限时的用户指引（包含字面量 missing_scopes，便于面板/日志检索）。 */
export const MISSING_SCOPES_MESSAGE = 'missing_scopes: 缺少云文档权限，请在 DSH 飞书桥面板'
  + '重新扫码授权（docx:document、docs:doc、docs:permission.member:create、'
  + 'drive:drive.metadata:readonly）。'

/** 错误文本上限，避免把堆栈/响应体带进 outbox。 */
const MAX_ERROR_LENGTH = 500

/**
 * 文档交付失败。`code` 是稳定分类（面板/重试可判定），`documentId` 在已建文档后
 * 一定带上，供 Task 7 重试；`url` 只在真正拿到规范链接时存在。
 */
export class FeishuDocumentError extends Error {
  /**
   * @param {string} message 脱敏后的错误文本
   * @param {{code: string, documentId?: string, url?: string, cause?: unknown}} [options]
   */
  constructor(message, { code, documentId, url, cause } = {}) {
    super(message)
    this.name = 'FeishuDocumentError'
    this.code = code
    this.documentId = documentId
    this.url = url
    if (cause !== undefined) this.cause = cause
  }
}

/** 普通对象判断（null/数组不算）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 按 Unicode 码点截断，保证 emoji 等代理对不被切开。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clipCodePoints(text, max) {
  const points = Array.from(String(text))
  return points.length > max ? points.slice(0, max).join('') : String(text)
}

/**
 * 把文本按码点切成 <=max 的片段；空串返回空数组。
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
function splitCodePoints(text, max = MAX_CODEPOINTS_PER_BLOCK) {
  const points = Array.from(text)
  if (points.length === 0) return []
  const chunks = []
  for (let index = 0; index < points.length; index += max) {
    chunks.push(points.slice(index, index + max).join(''))
  }
  return chunks
}

/**
 * 清洗正文：统一 LF、去掉除 \n\t 外的控制字符并 trim。
 * @param {string} text
 * @returns {string}
 */
function sanitizeMarkdown(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
}

/**
 * 清掉 docx 纯文本块中不会渲染的行内 Markdown 记号（对齐 Touchstone `mdPlain`），
 * 并把链接降级成「文字 (URL)」、图片降级成 alt 文本。
 * @param {string} value
 * @returns {string}
 */
function mdPlain(value) {
  let out = String(value)
  out = out.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1')
  out = out.replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_match, label, url) => {
    const target = String(url).trim()
    return target.length === 0 ? label : `${label} (${target})`
  })
  out = out.replace(/\*\*([^\n]+?)\*\*/g, '$1')
  out = out.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '$1')
  out = out.replace(/~~([^\n]+?)~~/g, '$1')
  out = out.replace(/`/g, '')
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1')
  return out.replace(/[ \t]+$/g, '')
}

/**
 * `isStructuredMarkdown` 的核心判定：标题、表格行、列表、引用、代码围栏、分隔线、
 * 多段（空行分隔）或超过短文本阈值。普通两句话/普通换行仍走直发。
 * @param {string} text
 * @returns {boolean}
 */
export function isStructuredMarkdown(text) {
  if (typeof text !== 'string') return false
  const value = text.trim()
  if (value.length === 0) return false
  if (Array.from(value).length > SHORT_TEXT_MAX_CODE_POINTS) return true
  if (/\n[ \t]*\n/.test(value)) return true
  if (/^[ \t]{0,3}#{1,6}[ \t]+\S/m.test(value)) return true
  if (/^[ \t]*```/m.test(value)) return true
  if (/^[ \t]*\|.*\|[ \t]*$/m.test(value)) return true
  if (/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/m.test(value)) return true
  if (/^[ \t]*>[ \t]+\S/m.test(value)) return true
  if (/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/m.test(value)) return true
  return false
}

/**
 * 生成一个 docx 文本类块。block_type 与字段名对齐飞书 docx schema：
 * 2=text、3/4/5=heading1/2/3、12=bullet、13=ordered、14=code、15=quote。
 * @param {number} blockType
 * @param {string} key
 * @param {string} content
 * @param {boolean} [bold]
 * @returns {object}
 */
function makeTextBlock(blockType, key, content, bold = false) {
  return {
    block_type: blockType,
    [key]: {
      elements: [{
        text_run: {
          content,
          text_element_style: { bold },
        },
      }],
      style: {},
    },
  }
}

/** 分隔线块。 */
function makeDividerBlock() {
  return { block_type: 22, divider: {} }
}

/**
 * 表格行拆单元格：去掉首尾竖线后按 `|` 拆分并做行内 Markdown 清洗。
 * @param {string} line
 * @returns {string[] | null} 非表格行返回 null
 */
function tableCells(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || trimmed.length < 2) return null
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => mdPlain(cell.trim()).trim())
}

/** 表格分隔行（`| --- | :---: |`）。 */
function isTableSeparator(cells) {
  if (!Array.isArray(cells) || cells.length === 0) return false
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

/**
 * Markdown → 飞书 docx blocks。
 *
 * 支持：ATX 标题（h4+ 降级为 heading3）、项目符号、有序列表、代码围栏、引用、
 * 分隔线、普通段落；表格分隔行丢弃，数据行按「表头：值 ｜ 表头：值」转项目符号。
 * 超长段落按 1800 码点切块；总块数超过 MAX_DOC_BLOCKS 时截断并补提示块。
 * @param {string} text
 * @returns {object[]}
 */
export function markdownToBlocks(text) {
  const normalized = sanitizeMarkdown(text)
  if (normalized.length === 0) return []
  const clipped = clipCodePoints(normalized, MAX_DOC_CODE_POINTS)
  const source = clipped.length < normalized.length
    ? `${clipped}\n\n……（内容过长，已截断）`
    : clipped
  const lines = source.split('\n')
  const blocks = []
  let truncated = false

  /** 追加一个块；达到上限后标记截断并停止。 */
  const addBlock = (block) => {
    if (blocks.length >= MAX_DOC_BLOCKS) {
      truncated = true
      return false
    }
    blocks.push(block)
    return true
  }

  /** 追加文本类块：清洗、trim、按码点切分。 */
  const addText = (blockType, key, raw, bold = false) => {
    const content = mdPlain(raw).trim()
    if (content.length === 0) return
    for (const piece of splitCodePoints(content)) {
      if (!addBlock(makeTextBlock(blockType, key, piece, bold))) return
    }
  }

  for (let index = 0; index < lines.length;) {
    const raw = lines[index]
    const line = raw.trim()

    if (line.length === 0) {
      index += 1
      continue
    }

    // 代码围栏：内部原样保留（不剥 Markdown 记号），整体按码点切块。
    if (/^```/.test(line)) {
      index += 1
      const buffer = []
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        buffer.push(lines[index].replace(/[ \t]+$/g, ''))
        index += 1
      }
      if (index < lines.length) index += 1
      if (buffer.length > 0) {
        for (const piece of splitCodePoints(buffer.join('\n'))) {
          if (!addBlock(makeTextBlock(14, 'code', piece))) break
        }
      }
      continue
    }

    // 表格：连续表格行成组解析，分隔行只用于识别表头，不生成正文块。
    if (line.startsWith('|') && line.endsWith('|')) {
      const rows = []
      while (index < lines.length) {
        const cells = tableCells(lines[index])
        if (cells === null) break
        rows.push(cells)
        index += 1
      }
      const separatorIndex = rows.findIndex((cells) => isTableSeparator(cells))
      const header = separatorIndex > 0 ? rows[separatorIndex - 1] : null
      const dataRows = separatorIndex >= 0 ? rows.slice(separatorIndex + 1) : rows
      for (const cells of dataRows) {
        if (cells.every((cell) => cell.length === 0)) continue
        const content = header !== null && cells.length === header.length
          ? cells.map((cell, cellIndex) => `${header[cellIndex] || `列${cellIndex + 1}`}：${cell}`)
            .join(' ｜ ')
          : cells.filter((cell) => cell.length > 0).join(' ｜ ')
        if (content.length > 0) addText(12, 'bullet', content)
      }
      continue
    }

    const heading = line.match(/^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/)
    if (heading !== null) {
      const level = Math.min(heading[1].length, 3)
      addText(level + 2, `heading${level}`, heading[2], true)
      index += 1
      continue
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      addBlock(makeDividerBlock())
      index += 1
      continue
    }

    const quote = line.match(/^>[ \t]?(.*)$/)
    if (quote !== null) {
      addText(15, 'quote', quote[1])
      index += 1
      continue
    }

    const bullet = raw.match(/^[ \t]*[-*+][ \t]+(.*)$/)
    if (bullet !== null) {
      let content = bullet[1]
      content = content.replace(/^\[[ xX]\][ \t]+/, (marker) => (
        marker.trim().toLowerCase() === '[x]' ? '☑ ' : '☐ '
      ))
      addText(12, 'bullet', content)
      index += 1
      continue
    }

    const ordered = raw.match(/^[ \t]*\d+[.)][ \t]+(.*)$/)
    if (ordered !== null) {
      addText(13, 'ordered', ordered[1])
      index += 1
      continue
    }

    addText(2, 'text', line)
    index += 1
  }

  if (truncated && blocks.length > 0) {
    blocks.pop()
    blocks.push(makeTextBlock(2, 'text', '……（内容过长，已截断）'))
  }
  return blocks
}

/**
 * 从正文提取文档主题：优先首个标题，否则首个非空行；去掉 Markdown 记号后
 * 清洗非法文件名字符并截到 40 码点。绝不返回正文全文。
 * @param {string} text
 * @returns {string}
 */
export function documentTopic(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (/^```/.test(line)) return '代码'
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) continue
    const cells = tableCells(line)
    const candidate = cells === null ? line : cells.filter(Boolean).join(' ')
    const cleaned = mdPlain(candidate
      .replace(/^#{1,6}[ \t]+/, '')
      .replace(/^[-*+][ \t]+/, '')
      .replace(/^\d+[.)][ \t]+/, '')
      .replace(/^>[ \t]?/, ''))
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^-+|-+$/g, '')
    if (cleaned.length > 0) return clipCodePoints(cleaned, 40)
  }
  return '答复'
}

/**
 * 构造 IANA 时区的标题/小节时间格式化器。`en-CA` 只用于稳定取数字段，最终字符串
 * 由 formatToParts 拼装，不依赖 locale 的分隔符或进程时区。
 * @param {string} timeZone IANA 时区（默认 Asia/Shanghai）
 * @returns {Intl.DateTimeFormat}
 */
function createStampFormatter(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0) {
    throw new TypeError('FeishuDocuments: timeZone 必须是非空 IANA 时区字符串')
  }
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
  } catch {
    throw new RangeError(`FeishuDocuments: 无效 timeZone ${timeZone}`)
  }
}

/** 取出格式化器的年/月/日/时/分数字段（已补零）。 */
function stampFields(formatter, now) {
  const fields = {}
  for (const part of formatter.formatToParts(new Date(now))) {
    if (part.type !== 'literal') fields[part.type] = part.value
  }
  return fields
}

/** `yyyyMMdd_HHmm` 紧凑时间戳（标题用）。 */
function compactStamp(formatter, now) {
  const fields = stampFields(formatter, now)
  return `${fields.year}${fields.month}${fields.day}_${fields.hour}${fields.minute}`
}

/** `yyyy-MM-dd HH:mm` 可读时间戳（小节标题用）。 */
function readableStamp(formatter, now) {
  const fields = stampFields(formatter, now)
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}`
}

/**
 * 文档标题：`DSH-<主题>-<yyyyMMdd_HHmm>`；默认按 Asia/Shanghai 计算。
 * @param {string} topic
 * @param {number} [now]
 * @param {string} [timeZone]
 * @returns {string}
 */
export function documentTitle(topic, now = Date.now(), timeZone = DEFAULT_TIME_ZONE) {
  const stamp = compactStamp(createStampFormatter(timeZone), now)
  return clipCodePoints(`DSH-${topic}-${stamp}`, 80)
}

/**
 * 从正文抽取短预览：跳过标题/代码围栏/表格分隔行，最多取两个普通行、两句，
 * 再按 180 码点截断。用于私聊与返回值，绝不包含正文全文。
 * @param {string} text
 * @returns {string}
 */
function previewText(text) {
  const lines = sanitizeMarkdown(text).split('\n')
  const parts = []
  let inCode = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^```/.test(line)) {
      inCode = !inCode
      continue
    }
    if (inCode || line.length === 0) continue
    if (/^#{1,6}[ \t]+/.test(line)) continue
    const cells = tableCells(line)
    if (cells !== null && isTableSeparator(cells)) continue
    const plain = mdPlain(cells === null ? line : cells.filter(Boolean).join(' ｜ '))
      .replace(/^[-*+][ \t]+/, '')
      .replace(/^\d+[.)][ \t]+/, '')
      .replace(/^>[ \t]?/, '')
      .trim()
    if (plain.length > 0) parts.push(plain)
    if (parts.length >= 2) break
  }
  const joined = parts.join(' ')
  const sentences = joined.match(/[^。！？.!?]+[。！？.!?]?/g) ?? []
  const preview = sentences.slice(0, 2).join('').trim()
  return clipCodePoints(preview, 180)
}

/**
 * 私聊摘要：标题/预览/链接三段；结构化答复不把正文全文发进聊天。
 * 新建与追加使用不同文案（“已生成” vs “已更新”），便于用户分辨文档动作。
 * @param {string} topic
 * @param {string} markdown
 * @param {string} url
 * @param {{created?: boolean}} [options]
 * @returns {string}
 */
function buildSummary(topic, markdown, url, { created = true } = {}) {
  const preview = previewText(markdown)
  const head = created ? `已生成云文档《${topic}》` : `已更新云文档《${topic}》`
  const message = preview.length > 0
    ? `${head}：${preview}`
    : `${head}，点击链接查看完整内容。`
  return `${clipCodePoints(message, 260)}\n${url}`
}

/** 从绑定 docs 表里取出某会话的条目；损坏值按不存在处理。 */
function sessionDoc(docs, sessionId) {
  if (!isPlainObject(docs)) return undefined
  const entry = docs[sessionId]
  if (!isPlainObject(entry)) return undefined
  if (typeof entry.documentId !== 'string' || entry.documentId.length === 0) return undefined
  return entry
}

/**
 * 云文档交付器。所有外部依赖可注入；测试不触网、不读真实凭据。
 */
export class FeishuDocuments {
  /**
   * @param {object} options
   * @param {object} options.store Task 3 Store（getBinding/putBinding）
   * @param {Function|object} options.rest Task 2 REST：可直接是 `rest(method,path,opts)`
   *   函数，也可传带 `rest` 方法的命名空间对象
   * @param {object|Function} [options.cfg] 应用凭据；函数形式支持运行时重新读取
   * @param {(openId:string,text:string,opts:object)=>Promise<void>} [options.sendText]
   *   已绑定凭据的私聊发送适配器；缺省走 Task 2 `restSendText` 或通用 REST
   * @param {() => number} [options.now] 时钟（测试注入）
   * @param {string} [options.timeZone] 标题/小节时间戳的 IANA 时区，默认 Asia/Shanghai
   * @param {(level:string,message:string)=>void} [options.log] 脱敏日志出口
   */
  constructor({
    store,
    rest,
    cfg,
    sendText,
    now = Date.now,
    timeZone = DEFAULT_TIME_ZONE,
    log = () => {},
  } = {}) {
    if (store === null || store === undefined) {
      throw new TypeError('FeishuDocuments: 必须提供 store')
    }
    if (typeof store.getBinding !== 'function' || typeof store.putBinding !== 'function') {
      throw new TypeError('FeishuDocuments: store 需要 getBinding/putBinding')
    }
    if (typeof rest !== 'function' && !(isPlainObject(rest) && typeof rest.rest === 'function')) {
      throw new TypeError('FeishuDocuments: rest 必须是函数或带 rest() 的客户端')
    }
    if (sendText !== undefined && typeof sendText !== 'function') {
      throw new TypeError('FeishuDocuments: sendText 必须是函数')
    }
    if (typeof now !== 'function') throw new TypeError('FeishuDocuments: now 必须是函数')

    this._store = store
    this._rest = rest
    this._cfg = cfg
    this._sendTextFn = sendText
    this._now = now
    this._timeZone = timeZone
    // 构造期即校验 IANA 时区，避免交付中途才暴露配置错误。
    this._stampFormatter = createStampFormatter(timeZone)
    this._logFn = typeof log === 'function' ? log : () => {}
    /** openId → 绑定读改写串行链（同用户多会话也不互相覆盖字段）。 */
    this._bindingChains = new Map()
  }

  /**
   * 交付一条 outbox 记录：
   *   - 空文本：返回 {kind:'text', text:''}，不发消息；
   *   - 短文本：私聊直发，返回 {kind:'text', text}；
   *   - 结构化/长文本：建/追加云文档、授权、取链接，私聊摘要，返回
   *     {kind:'document', text:summary, documentId, url}。
   * 文档路径的失败统一抛 FeishuDocumentError（已建文档时带 documentId），由 Task 7
   * 记录 attempts/退避，重试时按绑定里的 documentId 追加而非重建。
   *
   * 绑定闸门：交付任何内容（包括短文本/空文本/恢复重试）前都重新读取 Store 绑定；
   * 已撤销（记录不存在）时抛 binding_missing，绝不向旧 open_id 发送任何 REST 请求。
   * @param {object} outboxRecord Task 7 OutboxRecord
   * @returns {Promise<{kind:'text'|'document', text:string, documentId?:string, url?:string}>}
   */
  async deliver(outboxRecord) {
    if (!isPlainObject(outboxRecord)) {
      throw new TypeError('FeishuDocuments.deliver: 参数必须是 OutboxRecord')
    }
    const openId = outboxRecord.openId
    if (typeof openId !== 'string' || openId.length === 0) {
      throw new TypeError('FeishuDocuments.deliver: openId 必须是非空字符串')
    }
    // 先过绑定闸门：撤销/过期的 pending 记录在这里失败，短文本也不会漏发。
    await this._requireBinding(openId)
    const text = typeof outboxRecord.text === 'string' ? outboxRecord.text : ''
    if (text.trim().length === 0) return { kind: 'text', text }
    if (!isStructuredMarkdown(text)) {
      await this._send(openId, text, outboxRecord.requestId, undefined)
      return { kind: 'text', text }
    }
    const sessionId = outboxRecord.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('FeishuDocuments.deliver: 结构化答复需要 sessionId')
    }
    return this._deliverDocument(outboxRecord, text)
  }

  /**
   * 读取并校验当前绑定；记录不存在（已撤销）时抛分类错误 binding_missing。
   * @param {string} openId
   * @returns {Promise<object>} BindingRecord
   */
  async _requireBinding(openId) {
    const binding = await this._readBinding(openId)
    if (binding === undefined) {
      throw new FeishuDocumentError('云文档交付失败：该 open_id 的绑定已撤销或不存在。', {
        code: 'binding_missing',
      })
    }
    return binding
  }

  // ── 内部：文档主流程 ──────────────────────────────────────────────────────

  /** 结构化答复的完整交付；整段按 openId 串行，避免并发创建/覆盖绑定。 */
  async _deliverDocument(record, text) {
    return this._withBinding(record.openId, async () => {
      // 串行区内再读一次，覆盖“入口校验后、写文档前被撤销”的窗口。
      const binding = await this._requireBinding(record.openId)
      const existing = sessionDoc(binding.docs, record.sessionId)
      let documentId
      let rootCount = 0
      let created = false
      if (existing === undefined) {
        const topic = documentTopic(text)
        const title = documentTitle(topic, this._now(), this._timeZone)
        documentId = await this._createDocument(title)
        // 先落 documentId（url 为空）再做任何会失败的后续步骤：进程崩溃/权限失败后
        // 重试仍能找到同一份文档。
        await this._persistBindingDoc(record, documentId, '')
        created = true
      } else {
        documentId = existing.documentId
        rootCount = await this._rootChildrenCount(documentId)
      }

      // 先完成链接权限、协作者与元数据，再写正文：这三步失败时文档保持原样，
      // 重试不会产生重复内容。append 之后的失败才进入 at-least-once 重复语义。
      await this._grantLinkPermission(documentId)
      await this._grantMember(documentId, record.openId)
      const url = await this._fetchUrl(documentId)

      const blocks = markdownToBlocks(text)
      if (!created) {
        // 同会话追加：分隔线 + 时间小标题，形成新的答复小节；已有文档标题不变。
        blocks.unshift(
          makeDividerBlock(),
          makeTextBlock(4, 'heading2', `答复 ${this._formatStamp(this._now())}`),
        )
      }
      if (blocks.length === 0) blocks.push(makeTextBlock(2, 'text', '（空答复）'))
      await this._appendBlocks(documentId, blocks, rootCount)

      await this._persistBindingDoc(record, documentId, url)

      const topic = documentTopic(text)
      const summary = buildSummary(topic, text, url, { created })
      await this._send(record.openId, summary, record.requestId, documentId)

      this._log('info', `云文档交付成功 request=${record.requestId} document=${documentId}`
        + ` blocks=${blocks.length} created=${created}`)
      return { kind: 'document', text: summary, documentId, url }
    })
  }

  /**
   * 持久化绑定 docs，并把存储错误分类成 binding_write_failed（带 documentId）。
   * 建文档后写入失败会留下孤儿文档：日志留 requestId/documentId，绝不静默。
   */
  async _persistBindingDoc(record, documentId, url) {
    try {
      await this._writeBindingDoc(record.openId, record.sessionId, documentId, url)
    } catch (error) {
      this._log('error', `云文档绑定写入失败 request=${record.requestId} document=${documentId}`)
      throw this._classified(error, 'binding_write_failed', '写入绑定', documentId)
    }
  }

  /** 同用户绑定读改写串行化：前一个任务失败不阻塞后续任务。 */
  _withBinding(openId, task) {
    const previous = this._bindingChains.get(openId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(task)
    const settled = run.catch(() => {})
    this._bindingChains.set(openId, settled)
    return run.finally(() => {
      if (this._bindingChains.get(openId) === settled) this._bindingChains.delete(openId)
    })
  }

  /** 读取绑定；Store v1 同步 getBinding 也用 await 兼容 Promise 实现。 */
  async _readBinding(openId) {
    return this._store.getBinding(openId)
  }

  /**
   * read-modify-write 绑定 docs：保留 sessionIds/currentSessionId 与其它会话文档，
   * 只覆盖本会话条目。url 按调用方传入值落盘（建文档后首次写入显式写空串）。
   *
   * 并发安全：优先走 `store.updateBinding`（domain 写链 + 共享 per-openId 锁），
   * 与 `/new`、`/use` 等会话切换并发时不会用旧快照覆盖 sessionIds；旧替身退回
   * get+put。绑定在写链槽位上已消失时抛 binding_missing。
   * @returns {Promise<object>} 持久后的绑定
   */
  async _writeBindingDoc(openId, sessionId, documentId, url) {
    // schema strict：只写 documentId/url 两个字段；url 按调用方给的值落盘，
    // 建文档后的首次写入必须显式写空串（不能继承旧条目的链接）。
    const next = { documentId, url }
    const entry = Object.fromEntries(
      DOC_ENTRY_KEYS.map((key) => [key, next[key]]),
    )
    const transform = (binding) => {
      if (binding === undefined || binding === null) {
        throw new FeishuDocumentError('云文档交付失败：绑定记录已不存在。', {
          code: 'binding_missing',
          documentId,
        })
      }
      const docs = isPlainObject(binding.docs) ? { ...binding.docs } : {}
      docs[sessionId] = entry
      return {
        sessionIds: Array.isArray(binding.sessionIds) ? [...binding.sessionIds] : [],
        currentSessionId: typeof binding.currentSessionId === 'string'
          ? binding.currentSessionId
          : '',
        docs,
        updatedAt: this._now(),
      }
    }

    if (typeof this._store.updateBinding === 'function') {
      return this._store.updateBinding(openId, transform)
    }

    const binding = await this._readBinding(openId)
    const record = transform(binding)
    await this._store.putBinding(openId, record)
    return record
  }

  /** 建文档并取 document_id。 */
  async _createDocument(title) {
    try {
      const out = await this._call('POST', '/open-apis/docx/v1/documents', {
        jsonBody: { title },
      })
      const documentId = out?.data?.document?.document_id
      if (typeof documentId !== 'string' || documentId.length === 0) {
        throw new Error('建文档成功但没拿到 document_id')
      }
      return documentId
    } catch (error) {
      throw this._classified(error, 'document_create_failed', '建文档')
    }
  }

  /** 读取根 children 总数，作为追加块的起始 index。 */
  async _rootChildrenCount(documentId) {
    const path = `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`
      + `/blocks/${encodeURIComponent(documentId)}/children`
    let total = 0
    let pageToken
    try {
      for (let loop = 0; loop < 100; loop += 1) {
        const out = await this._call('GET', path, {
          params: {
            page_size: 500,
            document_revision_id: -1,
            ...(pageToken === undefined ? {} : { page_token: pageToken }),
          },
        })
        const data = out?.data ?? {}
        const items = Array.isArray(data.items) ? data.items : []
        total += items.length
        if (data.has_more !== true) break
        if (typeof data.page_token !== 'string' || data.page_token.length === 0
          || data.page_token === pageToken) break
        pageToken = data.page_token
      }
      return total
    } catch (error) {
      throw this._classified(error, 'append_failed', '读取文档结构', documentId)
    }
  }

  /** 按 <=50 块一批追加正文；index 从根 children 长度开始递增。 */
  async _appendBlocks(documentId, blocks, rootCount) {
    const path = `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`
      + `/blocks/${encodeURIComponent(documentId)}/children`
    try {
      for (let offset = 0; offset < blocks.length; offset += MAX_BLOCKS_PER_REQUEST) {
        const batch = blocks.slice(offset, offset + MAX_BLOCKS_PER_REQUEST)
        await this._call('POST', path, {
          jsonBody: { children: batch, index: rootCount + offset },
        })
      }
    } catch (error) {
      throw this._classified(error, 'append_failed', '写入文档正文', documentId)
    }
  }

  /** PATCH 链接分享为组织内可阅读（必做；文档默认归应用所有）。 */
  async _grantLinkPermission(documentId) {
    try {
      await this._call(
        'PATCH',
        `/open-apis/drive/v1/permissions/${encodeURIComponent(documentId)}/public`,
        {
          params: { type: 'docx' },
          jsonBody: { link_share_entity: 'tenant_readable' },
        },
      )
    } catch (error) {
      throw this._classified(error, 'permission_failed', '设置文档链接权限', documentId)
    }
  }

  /** POST 把绑定 open_id 加成协作者（必做；失败不得伪报授权完成）。 */
  async _grantMember(documentId, openId) {
    try {
      await this._call(
        'POST',
        `/open-apis/drive/v1/permissions/${encodeURIComponent(documentId)}/members`,
        {
          params: { type: 'docx', need_notification: 'false' },
          jsonBody: { member_type: 'openid', member_id: openId, perm: 'full_access' },
        },
      )
    } catch (error) {
      throw this._classified(error, 'permission_failed', '添加文档协作者', documentId)
    }
  }

  /** 取规范链接；官方 URL 缺失时才用 feishu.cn/docx 兜底（调用失败绝不兜底）。 */
  async _fetchUrl(documentId) {
    let out
    try {
      out = await this._call('POST', '/open-apis/drive/v1/metas/batch_query', {
        params: { user_id_type: 'open_id' },
        jsonBody: {
          request_docs: [{ doc_token: documentId, doc_type: 'docx' }],
          with_url: true,
        },
      })
    } catch (error) {
      throw this._classified(error, 'meta_failed', '查询文档链接', documentId)
    }
    const metas = Array.isArray(out?.data?.metas) ? out.data.metas : []
    const official = metas.length > 0 && typeof metas[0]?.url === 'string' ? metas[0].url : ''
    if (/^https?:\/\//.test(official)) return official
    // 官方链接缺失（code=0 但 url 空）时的兜底；域名由飞书重定向到租户域。
    return `https://feishu.cn/docx/${documentId}`
  }

  /** 发送私聊文本；失败按 message_failed 分类（已建文档时带 documentId）。 */
  async _send(openId, text, uuid, documentId) {
    try {
      if (this._sendTextFn !== undefined) {
        await this._sendTextFn(openId, text, { uuid })
        return
      }
      const rest = this._rest
      if (rest !== null && typeof rest === 'object' && typeof rest.sendText === 'function') {
        await rest.sendText(openId, text, { uuid })
        return
      }
      if (rest !== null && typeof rest === 'object'
        && typeof rest.restSendText === 'function') {
        await rest.restSendText(openId, text, this._cfgValue(), {
          uuid,
          ...(rest.fetch === undefined ? {} : { fetch: rest.fetch }),
        })
        return
      }
      await this._call('POST', '/open-apis/im/v1/messages', {
        params: { receive_id_type: 'open_id' },
        jsonBody: {
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
          ...(typeof uuid === 'string' && uuid.length > 0 ? { uuid } : {}),
        },
      })
    } catch (error) {
      throw this._classified(error, 'message_failed', '发送私聊消息', documentId)
    }
  }

  // ── 内部：REST/错误/日志 ─────────────────────────────────────────────────

  /** 解析当前应用凭据：显式 cfg 优先，其次 REST 客户端自带的 credentials/cfg。 */
  _cfgValue() {
    const configured = typeof this._cfg === 'function' ? this._cfg() : this._cfg
    if (configured !== undefined && configured !== null) return configured
    const rest = this._rest
    if (rest !== null && typeof rest === 'object') {
      return rest.credentials ?? rest.cfg ?? rest.config
    }
    return undefined
  }

  /** 统一 REST 调用：兼容函数注入与 Task 2 命名空间注入。 */
  _call(method, path, { params, jsonBody } = {}) {
    const rest = this._rest
    if (typeof rest === 'function') {
      return rest(method, path, { params, jsonBody, cfg: this._cfgValue() })
    }
    return rest.rest(method, path, {
      params,
      jsonBody,
      cfg: this._cfgValue(),
      ...(rest.fetch === undefined ? {} : { fetch: rest.fetch }),
    })
  }

  /**
   * 把任意 REST/实现错误转成分类错误：缺权限业务码统一 missing_scopes；其余按调用
   * 阶段分类。错误文本脱敏并截断，绝不携带正文。
   */
  _classified(error, code, action, documentId) {
    if (error instanceof FeishuDocumentError) {
      if (error.documentId === undefined && documentId !== undefined) {
        error.documentId = documentId
      }
      return error
    }
    const detail = redactError(error)
    const missingScope = MISSING_SCOPE_CODES.includes(error?.code)
    const message = missingScope
      ? clipCodePoints(`${MISSING_SCOPES_MESSAGE} 原因：${detail}`, MAX_ERROR_LENGTH)
      : clipCodePoints(`${action}失败：${detail}`, MAX_ERROR_LENGTH)
    return new FeishuDocumentError(message, {
      code: missingScope ? 'missing_scopes' : code,
      documentId,
      cause: error,
    })
  }

  /** 脱敏日志出口；日志自身故障不得影响交付。 */
  _log(level, message) {
    try {
      this._logFn(level, redactError(String(message)))
    } catch {
      // 日志出口故障忽略。
    }
  }

  /** 追加小节的标题时间：与文档标题同一 IANA 时区（默认 Asia/Shanghai）。 */
  _formatStamp(now) {
    return readableStamp(this._stampFormatter, now)
  }
}
