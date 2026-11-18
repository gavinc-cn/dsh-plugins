// dsh-patch-unsent-session 的纯函数部分：只做字符串处理，不碰文件系统，方便单测。
//
// 要解决的问题：DSH 的 blank Session（从未发送过消息的新会话）在侧栏里**只有当前选中的那一个**
// 可见 —— @deepseek-ai/dsh-client-ui-workspace 的 sessionVisible() 里写着
// `if (session.blank && session.id !== current) return false`。于是用户在新会话里写了一段草稿、
// 切到别的会话后，这一行连同草稿一起从侧栏消失；草稿其实还在 localStorage
// （`dsh.conversation.<sessionId>`），但界面上没有任何入口能回到它。
//
// 做法：给官方 client bundle 打一个幂等文本补丁：
//   1. sessionVisible()：blank 会话只要 localStorage 里有非空草稿，就继续显示（不再要求是当前会话）；
//   2. displayTitle()：这类行的标题用草稿首行，而不是一律显示「新会话」，便于区分和找回。
// 两处都只读侧栏已有的数据，不改 Session、不改草稿存储格式、不新增网络请求。
//
// 已知边界：
//   * 纯附件草稿的可见性依赖 @gavinc-cn/dsh-patch-draft-attachment：它把附件索引写到
//     `dsh.draft.attachments.<sessionId>`，本补丁读同一个键才会为纯图片草稿保留行；没装那个
//     组件时，纯附件草稿仍按官方行为不进 localStorage，这里也就看不见；
//   * 标题是渲染时读 localStorage 的快照：在当前 blank 里继续输入不会实时刷新侧栏标题，
//     切走再切回（侧栏重渲染）后才是最新首行；
//   * 官方升级后 bundle 被压缩/改写，锚点会失配 —— applyPatch 整体拒绝并记日志，不会半打补丁。
//
// 移除方式：在 Plugins 面板关闭本行（只停止后续重打），再把 `lib/client.js.orig` 覆盖回
// `lib/client.js`（或重装 dsh-client-ui-workspace），刷新页面。

/** 补丁目标包的 client bundle 相对其包根目录的路径。 */
export const BUNDLE_RELATIVE_PATH = 'lib/client.js'

/** 补丁标记：幂等判定与"是否需要重打"都看它（只出现在本补丁插入的注释里）。 */
export const MARKER = 'dsh-unsent-session'

/**
 * 插入 sessionVisible() 之前的草稿读取工具。
 *
 * 数据结构与官方 conversation store 的持久化镜像一致：
 * `{ draft: { text, references, command? }, view, viewRequest }`；旧版可能把 draft 存成裸字符串。
 * 读取失败（无 key / JSON 坏 / localStorage 不可用）一律按"没有草稿"处理，绝不让侧栏渲染抛错。
 */
export const DRAFT_HELPERS = '\t\t/* ' + MARKER + ': 读未发送会话的草稿；侧栏据此保留 blank 行并生成标题 */\n'
  + '\t\tconst DSH_UNSENT_DRAFT_KEY_PREFIX = "dsh.conversation.";\n'
  + '\t\t/** 与 @gavinc-cn/dsh-patch-draft-attachment 共用的附件索引键前缀（改键名必须两边一起改）。 */\n'
  + '\t\tconst DSH_UNSENT_ATTACH_KEY_PREFIX = "dsh.draft.attachments.";\n'
  + '\t\t/** 读草稿附件的索引（只有 id/kind/name/type，字节在 IndexedDB）；坏数据按空表处理。 */\n'
  + '\t\tfunction readUnsentAttachments(sessionId) {\n'
  + '\t\t\ttry {\n'
  + '\t\t\t\tconst raw = localStorage.getItem(DSH_UNSENT_ATTACH_KEY_PREFIX + sessionId);\n'
  + '\t\t\t\tif (raw === null) return [];\n'
  + '\t\t\t\tconst rows = JSON.parse(raw);\n'
  + '\t\t\t\tif (!Array.isArray(rows)) return [];\n'
  + '\t\t\t\treturn rows.filter((row) => row !== null && typeof row === "object" && typeof row.id === "string");\n'
  + '\t\t\t} catch (_error) {\n'
  + '\t\t\t\treturn [];\n'
  + '\t\t\t}\n'
  + '\t\t}\n'
  + '\t\tfunction readUnsentDraft(sessionId) {\n'
  + '\t\t\tconst attachments = readUnsentAttachments(sessionId);\n'
  + '\t\t\tlet text = "";\n'
  + '\t\t\tlet references = [];\n'
  + '\t\t\ttry {\n'
  + '\t\t\t\tconst raw = localStorage.getItem(DSH_UNSENT_DRAFT_KEY_PREFIX + sessionId);\n'
  + '\t\t\t\tif (raw !== null) {\n'
  + '\t\t\t\t\tconst stored = JSON.parse(raw);\n'
  + '\t\t\t\t\tconst draft = stored?.draft;\n'
  + '\t\t\t\t\ttext = typeof draft === "string" ? draft : typeof draft?.text === "string" ? draft.text : "";\n'
  + '\t\t\t\t\treferences = Array.isArray(draft?.references) ? draft.references : [];\n'
  + '\t\t\t\t}\n'
  + '\t\t\t} catch (_error) {\n'
  + '\t\t\t\ttext = "";\n'
  + '\t\t\t\treferences = [];\n'
  + '\t\t\t}\n'
  + '\t\t\tif (text.trim() === "" && references.length === 0 && attachments.length === 0) return null;\n'
  + '\t\t\treturn { text, references, attachments };\n'
  + '\t\t}\n'
  + '\t\tfunction hasUnsentDraft(sessionId) {\n'
  + '\t\t\treturn readUnsentDraft(sessionId) !== null;\n'
  + '\t\t}\n'
  + '\t\tfunction unsentDraftPreview(sessionId) {\n'
  + '\t\t\tconst draft = readUnsentDraft(sessionId);\n'
  + '\t\t\tif (draft === null) return "";\n'
  + '\t\t\tfor (const line of draft.text.split(/\\r?\\n/u)) {\n'
  + '\t\t\t\tconst text = line.trim();\n'
  + '\t\t\t\tif (text !== "") return text.length > 48 ? text.slice(0, 48) + "…" : text;\n'
  + '\t\t\t}\n'
  + '\t\t\tif (draft.attachments.length > 0) {\n'
  + '\t\t\t\tconst name = typeof draft.attachments[0].name === "string" ? draft.attachments[0].name.trim() : "";\n'
  + '\t\t\t\tif (name !== "") return name.length > 48 ? name.slice(0, 48) + "…" : name;\n'
  + '\t\t\t}\n'
  + '\t\t\treturn draft.references.length > 0 || draft.attachments.length > 0 ? "…" : "";\n'
  + '\t\t}\n'

/** sessionVisible 的锚点：函数头 + 两条前置过滤（第三行就是要改的 blank 判定）。 */
const VISIBLE_ANCHOR = '\t\tfunction sessionVisible(session, current, archived, archivedFilter) {\n'
  + '\t\t\tif (session.origin === "subagent") return false;\n'
  + '\t\t\tif (session.blank && session.id !== current) return false;\n'

/** displayTitle 的锚点：blank 行一律显示「新会话」。 */
const TITLE_ANCHOR = '\t\t/** Row display title: blank rows show the localized New Session label. */\n'
  + '\t\tfunction displayTitle(node, t) {\n'
  + '\t\t\treturn node.blank ? t("session.new") : node.title || t("session.untitled");\n'
  + '\t\t}\n'

/**
 * 改写规则表：每条 find 必须在整份 bundle 里**唯一**，否则拒绝打补丁。
 */
export const RULES = [
  {
    id: 'keep-draft-blank-visible',
    find: VISIBLE_ANCHOR,
    replace: DRAFT_HELPERS
      + '\t\tfunction sessionVisible(session, current, archived, archivedFilter) {\n'
      + '\t\t\tif (session.origin === "subagent") return false;\n'
      + '\t\t\tif (session.blank && session.id !== current && !hasUnsentDraft(session.id)) return false;\n',
  },
  {
    id: 'draft-title-preview',
    find: TITLE_ANCHOR,
    replace: '\t\t/** Row display title: blank rows show the localized New Session label. */\n'
      + '\t\tfunction displayTitle(node, t) {\n'
      + '\t\t\tif (node.blank) {\n'
      + '\t\t\t\tconst preview = unsentDraftPreview(node.id);\n'
      + '\t\t\t\treturn preview === "" ? t("session.new") : preview;\n'
      + '\t\t\t}\n'
      + '\t\t\treturn node.title || t("session.untitled");\n'
      + '\t\t}\n',
  },
]

/** 统计子串出现次数。 */
function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

/**
 * 对一份 bundle 源码应用补丁。
 * @param {string} source - bundle 文本。
 * @returns {{code: string, changed: boolean, reason: string, applied: string[]}} 结果码、是否需要写盘、判定原因。
 *          reason ∈ already-patched | patched | anchor-missing:<rule> | anchor-ambiguous:<rule>。
 */
export function applyPatch(source) {
  if (typeof source !== 'string') throw new TypeError('applyPatch: source must be a string')
  if (source.includes(MARKER)) return { code: source, changed: false, reason: 'already-patched', applied: [] }
  // 逐条校验锚点唯一性：任何一条对不上就整体放弃，绝不半打补丁。
  for (const rule of RULES) {
    const hits = count(source, rule.find)
    if (hits === 0) return { code: source, changed: false, reason: `anchor-missing:${rule.id}`, applied: [] }
    if (hits > 1) return { code: source, changed: false, reason: `anchor-ambiguous:${rule.id}`, applied: [] }
  }
  let code = source
  for (const rule of RULES) code = code.replace(rule.find, rule.replace)
  if (!code.includes(MARKER)) throw new Error('applyPatch: 补丁后仍未出现标记，规则表损坏')
  return { code, changed: true, reason: 'patched', applied: RULES.map((rule) => rule.id) }
}

/** 已打过补丁的 bundle 是否仍带着补丁（包升级/重装会把它覆盖掉）。 */
export function isPatched(source) {
  return typeof source === 'string' && source.includes(MARKER)
}

/**
 * 尽力反推出「补丁前的官方内容」——回滚备份 .orig 的兜底来源。
 *
 * 与 dsh-patch-ask-expand 同样的备份语义：只有读到官方原文时才敢把它复制成 .orig；
 * 若线上文件已经是补丁态（例如上一版补丁迁移），就逆向本规则表还原，还原不出来则保留旧备份。
 * @param {string} source - 任意版本的 bundle 文本。
 * @returns {string|null} 反推出的官方内容；认不出时返回 null。
 */
export function restoreOriginal(source) {
  if (typeof source !== 'string') throw new TypeError('restoreOriginal: source must be a string')
  if (!source.includes(MARKER)) return source
  let code = source
  for (const rule of RULES) {
    if (count(code, rule.replace) !== 1) return null
    code = code.replace(rule.replace, rule.find)
  }
  return code.includes(MARKER) ? null : code
}
