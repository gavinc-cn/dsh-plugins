// dsh-patch-ask-expand 的纯函数部分：只做字符串处理，不碰文件系统，方便单测。
//
// 背景：Web GUI 里「提问」这一行（标题「提问」，概要「N/M 已回答」）由
// @deepseek-ai/dsh-client-ui-tool 渲染，而它有**两个**渲染分支：
//   1. AskQuestionRow 里 rowAction !== undefined（有可回看的回答记录）→ QuestionToolRow；
//   2. 否则（本机实测的常见情况：回答随工具结果文本回来，userQuestions 投影里没有 settled
//      记录）→ 直接落到通用 ToolRow。
// 两个分支都靠 `const { expanded, toggle } = useDisclosure()` 取展开态，官方默认都是收起的。
//
// 【第一版补丁为什么没生效】只改了 QuestionToolRow，而线上那一行是 ToolRow 渲染的 —— 用
// headless chromium 读该 DOM 节点的 React fiber 链得到确证：div → ToolRow → AskQuestionRow。
// 补丁命中率 0，所以「默认展开」从未发生。
//
// 【第二版做法】不再插 effect，而是把 open 的算法改成"提问行默认展开，用户第一次点击后
// 完全交还给组件自身的 expanded"：
//     const open = expandable && (expanded || askDefaultOpen && !askDismissed);
// 其中 askDefaultOpen 用「本行是否带问答记录」判定：
//   - ToolRow 里唯一标识是 askQuestionBody（只有 AskQuestionRow 会传 askQuestion）；
//   - QuestionToolRow 里就是 askQuestion。
// 好处：① 纯声明式，首帧就是展开的，不依赖 effect 时序；② 不碰共用的 useDisclosure，
// 通用工具行/推理行一行都不受影响；③ 用户在提问行上的第一次点击被解释为"我要收起"，
// 之后这一行的展开态完全归用户（再点就是正常展开/收起）。
//
// 【第三版：0.2.2-rc.5 锚点重写（2026-11-25）】DSH 0.2.2-rc.5 的 bundle 换了构建产物形态：
// 从「每行一条、\t 缩进、赋值号带空格、双引号」变成「整份压成一行、无空格、单引号与模板字符串」，
// 于是原锚点自 2026-11-20 起全部 anchor-missing（日志 ~/.kimi-code/hooks/logs/patch_ask_expand.log），
// 提问行又退回默认折叠，连带 dsh-turn-labels 的回答行退化成小横杠。现在的锚点是**当前 bundle
// 的逐字节原文**（含反引号模板字符串），规则 id 与插入的补丁语义不变，只换文本形态。
// ⚠ 每次 DSH 升级都要重新核对下面四条 find：命中数必须恰为 1，否则整体拒绝打补丁
//   （绝不留半打状态）。核对方法是直接 grep 线上 bundle：
//     const expandable=state!==`preparing`&&(inputRaw!==null||outputText!==null||card!==null);const open=expanded&&expandable;
//     const expandable=bodyRaw!=null||output!=null||askQuestion!=null;const open=expanded&&expandable;
//     onToggle:toggleExpand,   /   onToggle:toggle,
//
// ⚠ 历史教训（第一版补丁踩过的坑，务必不要回退）：
//   上一版是在 `const expandable = ...` 之前插 useEffect，依赖数组 [expandable, toggle] 在
//   "求实参"时就立即求值，落进该 const 的暂时性死区，实测每次渲染抛
//   `ReferenceError: Cannot access 'expandable' before initialization`，提问行直接渲染崩溃。
//   现在这版没有任何 effect，但仍然保持"所有插值都放在相关 const 之后"的写法。
//   组件级回归测试见 test/component-render.spec.mjs（真实 bundle 源码 + 桩 React 渲染期执行）。

/** 补丁目标包的 client bundle 相对其包根目录的路径。 */
export const BUNDLE_RELATIVE_PATH = 'lib/client.js'

/** 补丁标记：幂等判定与"是否需要重打"都看它（只出现在本补丁插入的注释里）。 */
export const MARKER = 'dsh-ask-expand'

/** ToolRow 的锚点：算出 expandable / open 的那两条语句（0.2.2-rc.5 压缩形态，逐字节一致）。 */
const TOOLROW_ANCHOR = 'const expandable=state!==`preparing`&&(inputRaw!==null||outputText!==null||card!==null);const open=expanded&&expandable;'

/** QuestionToolRow 的锚点：同样是 expandable / open 两条语句。 */
const QUESTIONROW_ANCHOR = 'const expandable=bodyRaw!=null||output!=null||askQuestion!=null;const open=expanded&&expandable;'

/** ToolRow 的插入片段：默认展开标记 + 一次性关闭标记（插在 expandable 之后、open 之前）。 */
const TOOLROW_OPEN_REPLACE = 'const expandable=state!==`preparing`&&(inputRaw!==null||outputText!==null||card!==null);'
  + '/* ' + MARKER + ': 提问行默认展开（askQuestionBody 只有提问行非空） */'
  + 'const askDefaultOpen=askQuestionBody!==null;const[askDismissed,setAskDismissed]=(0,react.useState)(false);'
  + 'const open=expandable&&(expanded||askDefaultOpen&&!askDismissed);'

/** QuestionToolRow 的插入片段：同上，判定换成 askQuestion。 */
const QUESTIONROW_OPEN_REPLACE = 'const expandable=bodyRaw!=null||output!=null||askQuestion!=null;'
  + '/* ' + MARKER + ': 提问行默认展开 */'
  + 'const askDefaultOpen=askQuestion!=null;const[askDismissed,setAskDismissed]=(0,react.useState)(false);'
  + 'const open=expandable&&(expanded||askDefaultOpen&&!askDismissed);'

/**
 * 改写规则表：每条 find 必须在整份 bundle 里**唯一**，否则拒绝打补丁。
 * 注意 `onToggle:toggle,` 是 `onToggle:toggleExpand,` 的前缀，靠先整段替换顺序无关
 * （替换后的文本里已不含 `onToggle:toggle,`），但**唯一性校验必须按原始文本**做，
 * 见 applyPatch 里先校验全部规则再统一替换。
 */
export const RULES = [
  {
    id: 'toolrow-open',
    find: TOOLROW_ANCHOR,
    replace: TOOLROW_OPEN_REPLACE,
  },
  {
    id: 'toolrow-toggle',
    find: 'onToggle:toggleExpand,',
    replace: 'onToggle:askDefaultOpen&&!askDismissed?()=>setAskDismissed(true):toggleExpand,',
  },
  {
    id: 'questionrow-open',
    find: QUESTIONROW_ANCHOR,
    replace: QUESTIONROW_OPEN_REPLACE,
  },
  {
    id: 'questionrow-toggle',
    find: 'onToggle:toggle,',
    replace: 'onToggle:askDefaultOpen&&!askDismissed?()=>setAskDismissed(true):toggle,',
  },
]

/**
 * 上一版（在 0.2.1 及更早 bundle 上生效、已失效）的残留片段：只插在 QuestionToolRow 里的自动
 * 展开 effect。新版不再需要它；applyPatch 会先把这段残留清掉再打新补丁。
 */
export const LEGACY_EFFECT = '\t\t\t(0, react.useEffect)(() => {\n'
  + '\t\t\t\tif (!expandable) return;\n'
  + '\t\t\t\tconst seen = globalThis.__dshAskRowAutoOpened ??= new WeakSet();\n'
  + '\t\t\t\tif (seen.has(toggle)) return;\n'
  + '\t\t\t\tseen.add(toggle);\n'
  + '\t\t\t\ttoggle();\n'
  + '\t\t\t}, [expandable, toggle]);\n'

/** 统计子串出现次数。 */
function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

/**
 * 对一份 bundle 源码应用补丁。
 * @param {string} source - bundle 文本。
 * @returns {{code: string, changed: boolean, reason: string, applied: string[]}} 结果码、是否需要写盘、判定原因。
 *          reason ∈ already-patched | patched | migrated-legacy | anchor-missing:<rule> | anchor-ambiguous:<rule>。
 *          注意 migrated-legacy 与 patched 都表示"成功"，区别只在补丁前的基线是不是旧版补丁态 ——
 *          备份策略依赖这个区别（旧版补丁态不能拿去当"官方原件"备份）。
 */
export function applyPatch(source) {
  if (typeof source !== 'string') throw new TypeError('applyPatch: source must be a string')
  // 先清掉上一版补丁的残留（清完仍是补丁态就没有别的活要干）。
  const legacyHits = count(source, LEGACY_EFFECT)
  let code = legacyHits > 0 ? source.split(LEGACY_EFFECT).join('') : source
  if (code.includes(MARKER)) {
    return legacyHits > 0
      ? { code, changed: true, reason: 'migrated-legacy', applied: [] }
      : { code: source, changed: false, reason: 'already-patched', applied: [] }
  }
  // 逐条校验锚点唯一性：任何一条对不上就整体放弃，绝不半打补丁。
  for (const rule of RULES) {
    const hits = count(code, rule.find)
    if (hits === 0) {
      return { code: legacyHits > 0 ? code : source, changed: false, reason: `anchor-missing:${rule.id}`, applied: [] }
    }
    if (hits > 1) {
      return { code: legacyHits > 0 ? code : source, changed: false, reason: `anchor-ambiguous:${rule.id}`, applied: [] }
    }
  }
  for (const rule of RULES) code = code.replace(rule.find, rule.replace)
  if (!code.includes(MARKER)) throw new Error('applyPatch: 补丁后仍未出现标记，规则表损坏')
  return { code, changed: true, reason: legacyHits > 0 ? 'migrated-legacy' : 'patched', applied: RULES.map((rule) => rule.id) }
}

/** 已打过补丁的 bundle 是否仍带着补丁（包升级/重装会把它覆盖掉）。 */
export function isPatched(source) {
  return typeof source === 'string' && source.includes(MARKER)
}

/**
 * 尽力反推出「补丁前的官方内容」——回滚备份 .orig 的兜底来源。
 *
 * 为什么需要它：只有"读到的是官方原文"时才能拿它当备份。若线上文件已经是某个补丁版本
 * （本次改版升级就撞上了这一点），直接把当前内容复制成 .orig，就会把回滚点从"官方原件"
 * 悄悄换成"上一版补丁"，回滚反而回不到官方。所以补丁版本迁移时改为逆向本补丁的规则表。
 * @param {string} source - 任意版本的 bundle 文本。
 * @returns {string|null} 反推出的官方内容；认不出（例如上游已改写法）时返回 null，调用方应保留旧备份。
 */
export function restoreOriginal(source) {
  if (typeof source !== 'string') throw new TypeError('restoreOriginal: source must be a string')
  let code = source.split(LEGACY_EFFECT).join('')
  if (!code.includes(MARKER)) return code
  for (const rule of RULES) {
    if (count(code, rule.replace) !== 1) return null
    code = code.replace(rule.replace, rule.find)
  }
  return code.includes(MARKER) ? null : code
}
