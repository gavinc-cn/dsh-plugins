// dsh-patch-draft-attachment 的纯函数部分：只做字符串处理，不碰文件系统，方便单测。
//
// 要解决的问题：官方 composer 的草稿里，文字/引用由 `dsh.conversation.<sessionId>` 持久化，
// 切换会话、刷新页面都能恢复；**附件（截图、粘贴的图片、`+` 选的文件）却是纯运行时的** ——
// @deepseek-ai/dsh-client-ui-conversation 的注释写着 "Create runtime-only draft attachments"，
// 字节只存在 ConversationController.draftAttachments（内存 + 对象 URL）。会话输入 shell 一销毁
// （切到别的会话），releaseDraftAttachment 就把描述符和对象 URL 一起回收；切回来时只有文字
// 从 localStorage 恢复，图片不见了。
//
// 做法：给官方 client bundle 打一个幂等文本补丁，把"附件字节"额外落一份到浏览器：
//   1. localStorage `dsh.draft.attachments.<sessionId>` 存索引（id / kind / name / type，很小）——
//      @gavinc-cn/dsh-patch-unsent-session 的侧栏补丁读同一个键，纯图片草稿也能留在侧栏；
//   2. IndexedDB `dsh-draft-attachments/files` 按附件 id 存 Blob（File 本身可直接结构化克隆）；
//   3. 输入 shell 建好时（会话切回、页面刷新、换工作区）按索引把 Blob 还原成 File、重新登记进
//      draftAttachments 并重发上传，之后与正常粘贴的附件完全一致；
//   4. 附件被真正移除（点 ×、提交成功）时删掉持久化副本；会话切走导致的 release 保留副本
//      （releaseDraftAttachment 的第二个参数 keepDraftFile）。
//
// 已知边界：
//   * 单文件 > 24 MB 不持久化（只影响跨会话恢复，本次会话内照常可用）；
//   * 持久化失败（IndexedDB 不可用 / 配额不足）静默降级成官方行为；
//   * 会话被删除/归档后残留的索引与 Blob 不主动清理（量级很小）；
//   * 官方升级后 bundle 被压缩/改写，锚点会失配 —— applyPatch 整体拒绝并记日志，不会半打补丁。
//
// 移除方式：在 Plugins 面板关闭本行（只停止后续重打），再把 `lib/client.js.orig` 覆盖回
// `lib/client.js`（或重装 dsh-client-ui-conversation），刷新页面。

/** 补丁目标包的 client bundle 相对其包根目录的路径。 */
export const BUNDLE_RELATIVE_PATH = 'lib/client.js'

/** 补丁标记：幂等判定与"是否需要重打"都看它（只出现在本补丁插入的注释里）。 */
export const MARKER = 'dsh-draft-attachment'

/**
 * 草稿附件的浏览器侧持久化工具（插入到 `ConversationController` 之前，与它同一模块作用域）。
 *
 * 与官方数据结构的关系：
 *   * `conversation.draftAttachments` 是官方 registry（Map<id, descriptor>），这里只往里补
 *     "恢复出来的"描述符 —— 形状与 browserDraftAttachment() 完全一致；
 *   * `conversation.rebindDraftFiles()` 是官方"把已有草稿附件挂到某个 Session 上"的入口，
 *     恢复后走它重发上传，避免自己再实现一遍上传排队。
 *
 * 源码按"无缩进"书写，注入时统一加两个 tab，保证与 bundle 其余代码同层。
 */
const HELPER_SOURCE = String.raw`/* dsh-draft-attachment: 把 composer 草稿里的附件（截图/图片/文件）落一份到 localStorage + IndexedDB，
   会话切走时保留、切回/刷新时按索引还原。索引键 dsh.draft.attachments.<sessionId> 同时供
   dsh-patch-unsent-session 的侧栏补丁读取（纯附件草稿也要能在侧栏被找回）。 */
const DSH_DRAFT_ATTACH_INDEX_PREFIX = "dsh.draft.attachments.";
const DSH_DRAFT_ATTACH_DB = "dsh-draft-attachments";
const DSH_DRAFT_ATTACH_STORE = "files";
const DSH_DRAFT_ATTACH_MAX_BYTES = 24 * 1024 * 1024;
let dshDraftAttachDbPromise;
/** 某个 Session 的草稿附件索引键。 */
function dshDraftAttachKey(sessionId) {
	return DSH_DRAFT_ATTACH_INDEX_PREFIX + sessionId;
}
/** 读索引；坏 JSON / 无键 / localStorage 不可用一律当空表。 */
function dshReadDraftAttachIndex(sessionId) {
	try {
		const raw = localStorage.getItem(dshDraftAttachKey(sessionId));
		if (raw === null) return [];
		const rows = JSON.parse(raw);
		if (!Array.isArray(rows)) return [];
		return rows.filter((row) => row !== null && typeof row === "object" && typeof row.id === "string");
	} catch (_error) {
		return [];
	}
}
/** 覆盖写索引；空表删键，避免留下空草稿的痕迹。 */
function dshWriteDraftAttachIndex(sessionId, rows) {
	try {
		if (rows.length === 0) localStorage.removeItem(dshDraftAttachKey(sessionId));
		else localStorage.setItem(dshDraftAttachKey(sessionId), JSON.stringify(rows));
	} catch (_error) {}
}
/** 打开 IndexedDB（首次创建 object store）；不可用时返回 rejected promise，持久化静默降级。 */
function dshDraftAttachDb() {
	if (dshDraftAttachDbPromise !== void 0) return dshDraftAttachDbPromise;
	dshDraftAttachDbPromise = new Promise((resolve, reject) => {
		if (typeof indexedDB === "undefined") {
			reject(new Error("indexedDB unavailable"));
			return;
		}
		const request = indexedDB.open(DSH_DRAFT_ATTACH_DB, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(DSH_DRAFT_ATTACH_STORE, { keyPath: "id" });
		};
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => db.close();
			resolve(db);
		};
		request.onerror = () => reject(request.error ?? new Error("draft attachment db open failed"));
	});
	return dshDraftAttachDbPromise;
}
/** 在一个短事务里执行一次 store 操作，事务提交后带着 request.result 结算。 */
function dshDraftAttachRun(mode, op) {
	return dshDraftAttachDb().then((db) => new Promise((resolve, reject) => {
		const tx = db.transaction(DSH_DRAFT_ATTACH_STORE, mode);
		const request = op(tx.objectStore(DSH_DRAFT_ATTACH_STORE));
		let result;
		request.onsuccess = () => {
			result = request.result;
		};
		tx.oncomplete = () => resolve(result);
		tx.onerror = () => reject(tx.error ?? new Error("draft attachment tx failed"));
		tx.onabort = () => reject(tx.error ?? new Error("draft attachment tx aborted"));
	}));
}
/**
* 刚创建的草稿附件落盘：索引先写 localStorage（侧栏据此保留未发送会话），字节再进 IndexedDB。
* 超过体积上限的附件只放弃持久化，不影响本次会话内的附件。
*/
function dshPersistDraftFiles(sessionId, drafts) {
	if (sessionId === void 0 || drafts.length === 0) return;
	const rows = dshReadDraftAttachIndex(sessionId).filter((row) => !drafts.some((draft) => draft.id === row.id));
	for (const draft of drafts) rows.push({
		id: draft.id,
		kind: draft.kind,
		name: typeof draft.file?.name === "string" ? draft.file.name : "",
		type: typeof draft.file?.type === "string" ? draft.file.type : ""
	});
	dshWriteDraftAttachIndex(sessionId, rows);
	for (const draft of drafts) {
		const file = draft.file;
		if (file === void 0 || file.size > DSH_DRAFT_ATTACH_MAX_BYTES) continue;
		dshDraftAttachRun("readwrite", (store) => store.put({
			id: draft.id,
			sessionId,
			kind: draft.kind,
			name: file.name ?? "",
			type: file.type ?? "",
			blob: file
		})).catch(() => {});
	}
}
/** 附件被真正移除（点 ×、提交成功、发送被拒）时删掉持久化副本；调用方拿不到 Session 就全表扫一遍。 */
function dshForgetDraftFile(id) {
	try {
		const keys = [];
		for (let index = 0; index < localStorage.length; index += 1) {
			const key = localStorage.key(index);
			if (key !== null && key.startsWith(DSH_DRAFT_ATTACH_INDEX_PREFIX)) keys.push(key);
		}
		for (const key of keys) {
			const raw = localStorage.getItem(key);
			if (raw === null) continue;
			let rows;
			try {
				rows = JSON.parse(raw);
			} catch (_error) {
				localStorage.removeItem(key);
				continue;
			}
			if (!Array.isArray(rows)) continue;
			const next = rows.filter((row) => row?.id !== id);
			if (next.length === rows.length) continue;
			if (next.length === 0) localStorage.removeItem(key);
			else localStorage.setItem(key, JSON.stringify(next));
		}
	} catch (_error) {}
	dshDraftAttachRun("readwrite", (store) => store.delete(id)).catch(() => {});
}
/** 工作区切换把草稿附件带到另一个 Session：索引跟着搬（Blob 以附件 id 为键，不用动）。 */
function dshMoveDraftFiles(fromSessionId, toSessionId, ids) {
	if (ids.length === 0) return;
	const moving = new Set(ids);
	const rows = dshReadDraftAttachIndex(fromSessionId);
	const moved = rows.filter((row) => moving.has(row.id));
	if (moved.length === 0) return;
	dshWriteDraftAttachIndex(fromSessionId, rows.filter((row) => !moving.has(row.id)));
	dshWriteDraftAttachIndex(toSessionId, dshReadDraftAttachIndex(toSessionId).filter((row) => !moving.has(row.id)).concat(moved));
}
/**
* 给刚建好的输入 shell 接上持久化的草稿附件（切回会话、刷新页面、换工作区都走这里）。
* 还原出的附件重新登记进 registry 并走官方 rebindDraftFiles 重发上传，之后与正常粘贴的附件一致。
*/
function dshRestoreDraftFiles(hub, shell, binding) {
	const sessionId = binding.sessionId;
	if (shell.dshDraftFilesRestored === true) return;
	shell.dshDraftFilesRestored = true;
	const index = dshReadDraftAttachIndex(sessionId);
	if (index.length === 0) return;
	Promise.all(index.map((row) => dshDraftAttachRun("readonly", (store) => store.get(row.id)).catch(() => void 0))).then((stored) => {
		if (shell.disposed === true) return;
		const conversation = hub.rootCtx.get("conversation");
		if (conversation === void 0) return;
		const rows = [];
		const ids = [];
		for (const record of stored) {
			if (record === void 0 || record === null || record.blob === void 0) continue;
			const file = new File([record.blob], typeof record.name === "string" ? record.name : "", { type: typeof record.type === "string" ? record.type : "" });
			const attachment = record.kind === "image" ? {
				kind: "image",
				id: record.id,
				previewUrl: URL.createObjectURL(file),
				file
			} : {
				kind: "file",
				id: record.id,
				file
			};
			conversation.draftAttachments.set(attachment.id, attachment);
			if (attachment.kind === "image") probeDimensions(attachment);
			ids.push(attachment.id);
			rows.push({
				id: attachment.id,
				kind: attachment.kind,
				name: file.name ?? "",
				type: file.type ?? ""
			});
		}
		if (ids.length === 0) {
			dshWriteDraftAttachIndex(sessionId, []);
			return;
		}
		dshWriteDraftAttachIndex(sessionId, rows);
		if (!shell.addAttachments(ids)) return;
		const ordinary = binding.session?.getSnapshot()?.subagent === null;
		conversation.rebindDraftFiles(sessionId, ids, ordinary);
	}).catch(() => {});
}
`

/** 注入到 bundle 的辅助代码：统一两个 tab 缩进（与 ConversationController 同层）。 */
export const DRAFT_HELPERS = HELPER_SOURCE.split('\n')
  .map((line) => (line === '' ? '' : `\t\t${line}`))
  .join('\n')

/** 注入点：ConversationController 之前（辅助函数用到的 probeDimensions 已在其上方定义）。 */
const CONTROLLER_ANCHOR = '\t\t/** Scope-addressed conversation service (root singleton, provided as `conversation`). */\n'
  + '\t\tvar ConversationController = class extends _deepseek_ai_cordis.Service {\n'

/** 附件创建点：composer 的 addFiles() 把新文件变成草稿附件之后。 */
const CREATE_ANCHOR = '\t\t\t\t\t\t\t\tconst drafts = conversation.createDrafts(sessionId, uploads, ordinary);\n'
  + '\t\t\t\t\t\t\t\tif (!shell.addFiles(references, drafts.map((draft) => draft.id))) {\n'

/** 释放点：所有"真正移除附件"的路径最终都汇到 releaseDraftAttachment()。 */
const RELEASE_ANCHOR = '\t\t\treleaseDraftAttachment(id) {\n'
  + '\t\t\t\tconst attachment = this.draftAttachments.get(id);\n'
  + '\t\t\t\tif (attachment === void 0) return;\n'
  + '\t\t\t\tthis.draftAttachments.delete(id);\n'
  + '\t\t\t\tif (attachment.kind === "image") revokePreview(attachment.previewUrl);\n'
  + '\t\t\t\tthis.dropUpload(id);\n'
  + '\t\t\t}\n'

/** 会话切走：输入 shell 销毁时官方会把还在草稿里的附件全部 release —— 这里改成"保留持久化副本"。 */
const DISPOSE_ANCHOR = '\t\t\t\t\t\tconst drafts = shell.dispose();\n'
  + '\t\t\t\t\t\tthis.shells.delete(binding);\n'
  + '\t\t\t\t\t\tconst conversation = this.rootCtx.get("conversation");\n'
  + '\t\t\t\t\t\tfor (const attachmentId of drafts) conversation?.releaseDraftAttachment(attachmentId);\n'

/** 会话建 shell：官方在这里把文字草稿读回来，附件恢复紧挨着它。 */
const RESTORE_ANCHOR = '\t\t\t\tshell.setDraft(readConversationDraft(binding.sessionId));\n'
  + '\t\t\t\treturn shell;\n'

/** 提交成功：图片附件的描述符在 settle 里被直接 delete，不经 releaseDraftAttachment。 */
const SETTLE_ANCHOR = '\t\t\t\t\tthis.draftAttachments.delete(attachment.id);\n'
  + '\t\t\t\t\tthis.forgetUpload(attachment.id);\n'

/** 换工作区：草稿附件会被搬到目标 Session，索引要跟着搬。 */
const MOVE_ANCHOR = '\t\t\t\t\t\t\t\tconcreteConversation(ctx).rebindDraftFiles(nextId, attachmentIds, ordinary);\n'

/**
 * 改写规则表：每条 find 必须在整份 bundle 里**唯一**，否则拒绝打补丁。
 */
export const RULES = [
  {
    id: 'inject-draft-file-helpers',
    find: CONTROLLER_ANCHOR,
    replace: DRAFT_HELPERS + '\n' + CONTROLLER_ANCHOR,
  },
  {
    id: 'persist-created-draft-files',
    find: CREATE_ANCHOR,
    replace: '\t\t\t\t\t\t\t\tconst drafts = conversation.createDrafts(sessionId, uploads, ordinary);\n'
      + '\t\t\t\t\t\t\t\tdshPersistDraftFiles(sessionId, drafts);\n'
      + '\t\t\t\t\t\t\t\tif (!shell.addFiles(references, drafts.map((draft) => draft.id))) {\n',
  },
  {
    id: 'keep-persisted-on-release',
    find: RELEASE_ANCHOR,
    replace: '\t\t\treleaseDraftAttachment(id, keepDraftFile) {\n'
      + '\t\t\t\tconst attachment = this.draftAttachments.get(id);\n'
      + '\t\t\t\tif (attachment === void 0) return;\n'
      + '\t\t\t\tthis.draftAttachments.delete(id);\n'
      + '\t\t\t\tif (attachment.kind === "image") revokePreview(attachment.previewUrl);\n'
      + '\t\t\t\tthis.dropUpload(id);\n'
      + '\t\t\t\tif (keepDraftFile !== true) dshForgetDraftFile(id);\n'
      + '\t\t\t}\n',
  },
  {
    id: 'keep-persisted-on-session-switch',
    find: DISPOSE_ANCHOR,
    replace: '\t\t\t\t\t\tconst drafts = shell.dispose();\n'
      + '\t\t\t\t\t\tthis.shells.delete(binding);\n'
      + '\t\t\t\t\t\tconst conversation = this.rootCtx.get("conversation");\n'
      + '\t\t\t\t\t\t/* dsh-draft-attachment: 切走时保留持久化副本，切回来由 dshRestoreDraftFiles 还原 */\n'
      + '\t\t\t\t\t\tfor (const attachmentId of drafts) conversation?.releaseDraftAttachment(attachmentId, true);\n',
  },
  {
    id: 'restore-on-shell-create',
    find: RESTORE_ANCHOR,
    replace: '\t\t\t\tshell.setDraft(readConversationDraft(binding.sessionId));\n'
      + '\t\t\t\tdshRestoreDraftFiles(this, shell, binding);\n'
      + '\t\t\t\treturn shell;\n',
  },
  {
    id: 'forget-on-submit',
    find: SETTLE_ANCHOR,
    replace: '\t\t\t\t\tthis.draftAttachments.delete(attachment.id);\n'
      + '\t\t\t\t\tthis.forgetUpload(attachment.id);\n'
      + '\t\t\t\t\tdshForgetDraftFile(attachment.id);\n',
  },
  {
    id: 'move-on-workspace-switch',
    find: MOVE_ANCHOR,
    replace: MOVE_ANCHOR
      + '\t\t\t\t\t\t\t\tdshMoveDraftFiles(sessionId, nextId, attachmentIds);\n',
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
 * 与 dsh-patch-ask-expand / dsh-patch-unsent-session 同样的备份语义：只有读到官方原文时才敢把它
 * 复制成 .orig；若线上文件已经是补丁态（例如上一版补丁迁移），就逆向本规则表还原，
 * 还原不出来则保留旧备份。
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
