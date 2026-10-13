window.__ModuleLoader__.load({
	// 模块 id 必须等于包名: DSH 客户端 boot 清单的行 id 取自解析出的包名
	// (dsh-client-modules: graphRow(packageName, ...)), 加载器用 factories.has(row.id)
	// 判定 "loaded without registering"。包名收进 scope 后这里必须同步改,
	// 否则 web 启动时报 "2 entries did not activate"。
	id: "@gavinc-cn/kanban-board",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
// 任务看板插件 — 浏览器半 (cordis_define 的 code.client, 纯 JS 函数体)
// 参数符号面: React, console, styles, host   (无 JSX / TS / import)
// 职责:
//  1. 看板 UI: sidebar.footer.action 开关 + shell.overlay 全屏看板
//  2. 拖入"正在开发" → session.create + session.prompt 让 agent 执行
//  3. 监听 events.host (running 状态翻转 + 工作区增删改) 与 events.mux (提问/审批帧):
//     - 执行完毕 → 自动移入"待审核"
//     - agent 提问/请求审批 → 自动移入"阻塞", 卡片可直接回答
//     - 问题被回答 → 自动回到"正在开发"
//     - 主界面增删改工作区 → 左侧工作区栏实时同步
//  4. 看板状态持久化: 动态版经包内 RPC (kanban/load|save);
//     静态版(路线 B)由 _build.js 转成 localStorage (见 kanban-board/_build.js)

// ── 会话工作目录解析 (不再硬编码机器路径) ──────────────────────────────────
// 以前这里是一个写死的常量 TASK_CWD (某个开发机的绝对路径), 换机器/换用户就错,
// 打包发布还会把私人路径带出去。改为运行时按下面顺序解析:
//   ① 看板对应的工作区目录 (ws.path)         —— 最准, 会话也挂在该工作区下
//   ② 看板自己记录的 cwd                     —— 工作区被删后保留的最后一次目录
//   ③ 宿主工作区列表里的第一个目录           —— 未分组看板"跟着宿主走"
//   ④ 都没有 → 返回 null: 调用方**不传 cwd**, 由宿主回退到自己的默认目录
// 注意: 不能用 '~' 当兜底 —— 宿主 session.create 不对 cwd 做 ~ 展开
// (dsh-api-session-controller: cwd = workspace?.path ?? request.cwd ?? defaultCwd,
//  随后 mkdir(cwd)), 传 '~' 会真的建出一个名为 ~ 的目录。
function workspaceOf(boardKey) {
  return (data.workspaces || []).find((w) => w.workspaceId === boardKey) || null;
}

function firstWorkspacePath() {
  for (const w of data.workspaces || []) if (w && w.path) return w.path;
  return null;
}

// 看板自身的兜底目录: 无记录时跟随宿主工作区列表的第一个
function boardFallbackCwd(board) {
  return (board && board.cwd) || firstWorkspacePath() || null;
}

// 解析某看板下新建会话要用的工作目录; null = 不指定, 交给宿主
function resolveCwd(boardKey) {
  const ws = workspaceOf(boardKey);
  if (ws && ws.path) return ws.path;
  return boardFallbackCwd(boardOf(store.state, boardKey));
}

const COLUMNS = [
  { key: 'todo', label: '待开发' },
  { key: 'doing', label: '正在开发' },
  { key: 'blocked', label: '阻塞' },
  { key: 'review', label: '待审核' },
  { key: 'done', label: '已完成' },
];
const COLUMN_LABEL = {};
for (const c of COLUMNS) COLUMN_LABEL[c.key] = c.label;

// ── 多工作区看板 ───────────────────────────────────────────────────────────
// 状态 v2: { version, boards: { <key>: { cwd, tasks } }, activeBoard, sizes }
// board key = 工作区 workspaceId; 'default' 是未分组工作区的兜底看板。
const DEFAULT_BOARD_KEY = 'default';

// ── DSH 主界面设计令牌 (语义别名, 缺失时退回暗色值, 仅作兜底) ─────────────
// 看板视觉尽量与主界面一致: 只消费 --dsw-alias-* / --dsw-specific-* 令牌,
// 不写死颜色, 明暗主题自动跟随。
const TK = {
  font: "var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif)",
  text: 'var(--dsw-alias-label-primary, #f2f3f5)',
  text2: 'var(--dsw-alias-label-secondary, #cfd3d6)',
  text3: 'var(--dsw-alias-label-tertiary, #adb2b8)',
  border: 'var(--dsw-alias-border-l2, rgba(255,255,255,.12))',
  bgBase: 'var(--dsw-alias-bg-base, #151517)',
  bgL1: 'var(--dsw-alias-bg-layer-1, #232324)',
  bgL2: 'var(--dsw-alias-bg-layer-2, #2c2c2d)',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))',
  sidebar: 'var(--dsw-specific-sidebar-fill, #232324)',
  navActive: 'var(--dsw-specific-sidebar-nav-item-active, rgba(255,255,255,.12))',
  business: 'var(--dsw-alias-state-business-primary, #679efe)',
  businessTert: 'var(--dsw-alias-state-business-tertiary, rgba(103,158,254,.2))',
  warn: 'var(--dsw-alias-state-warn-primary, #f5a20b)',
  warnLabel: 'var(--dsw-alias-state-warn-label, #dd8629)',
  warnTert: 'var(--dsw-alias-state-warn-tertiary, rgba(245,162,11,.2))',
  success: 'var(--dsw-alias-state-success-primary, #22c55e)',
  successTert: 'var(--dsw-alias-state-success-tertiary, rgba(34,197,94,.2))',
  error: 'var(--dsw-alias-state-error-primary, #f25a5a)',
};
// 每列的卡片左侧状态色条
const COLUMN_ACCENT = {
  todo: 'var(--dsw-alias-label-tertiary, #adb2b8)',
  doing: TK.business,
  blocked: TK.warn,
  review: TK.success,
  done: 'var(--dsw-alias-label-tertiary, #adb2b8)',
};

function clamp(n, min, max) {
  n = Number(n);
  if (!isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// debug-14: 右侧任务详情栏上限 = 屏幕宽度的 75% (浏览器实时值; 非浏览器环境兜底 1080)
function rightMax() {
  if (typeof window !== 'undefined' && window && window.innerWidth > 0) {
    return Math.max(560, Math.round(window.innerWidth * 0.75));
  }
  return 1080;
}

function migrateTask(t) {
  return {
    ...t,
    sessions: Array.isArray(t.sessions) ? t.sessions : (t.sessionId ? [t.sessionId] : []),
    comments: Array.isArray(t.comments) ? t.comments : [],
  };
}

// 把任意旧版状态规整成 v2 (v1 的顶层 tasks 迁移到默认看板)
function normalizeState(raw) {
  const base = {
    version: 2,
    boards: { [DEFAULT_BOARD_KEY]: { cwd: '', tasks: [] } },
    activeBoard: DEFAULT_BOARD_KEY,
    sizes: { left: 220, right: 460 },
  };
  if (!raw || typeof raw !== 'object') return base;
  if (Array.isArray(raw.tasks)) {
    return {
      ...base,
      boards: { [DEFAULT_BOARD_KEY]: { cwd: '', tasks: raw.tasks.map(migrateTask) } },
    };
  }
  const boards = {};
  for (const key of Object.keys(raw.boards || {})) {
    const b = raw.boards[key] || {};
    boards[key] = {
      cwd: b.cwd || '',
      tasks: Array.isArray(b.tasks) ? b.tasks.map(migrateTask) : [],
    };
  }
  if (!boards[DEFAULT_BOARD_KEY]) boards[DEFAULT_BOARD_KEY] = { cwd: '', tasks: [] };
  const activeBoard = raw.activeBoard && boards[raw.activeBoard] ? raw.activeBoard : DEFAULT_BOARD_KEY;
  const sizes = raw.sizes || {};
  const right = clamp(sizes.right, 240, rightMax());
  return {
    version: 2,
    boards,
    activeBoard,
    sizes: {
      left: clamp(sizes.left, 160, 480),
      // debug-9: 右侧详情栏默认加宽 340→460、上限 640→900; 恰为老默认(从未拖动过)的一次性迁移到新默认
      // debug-14: 上限改为屏幕宽度 75% (rightMax())
      right: right === 340 ? 460 : right,
    },
  };
}

function boardOf(state, key) {
  return (state.boards && state.boards[key]) || (state.boards && state.boards[DEFAULT_BOARD_KEY]);
}
function activeBoardKey() {
  return store.state.activeBoard || DEFAULT_BOARD_KEY;
}
function activeBoard(state) {
  return boardOf(state, activeBoardKey());
}
function findTask(state, taskId) {
  for (const key of Object.keys(state.boards || {})) {
    const t = (state.boards[key].tasks || []).find((x) => x.id === taskId);
    if (t) return { task: t, boardKey: key };
  }
  return null;
}
function mapAllTasks(state, fn) {
  const boards = {};
  let changed = false;
  for (const key of Object.keys(state.boards || {})) {
    const b = state.boards[key];
    const tasks = (b.tasks || []).map((t) => {
      const r = fn(t, key);
      if (r !== t) changed = true;
      return r;
    });
    boards[key] = { ...b, tasks };
  }
  return changed ? { ...state, boards } : state;
}

// ── 模块级内存 store (唯一渲染真源; 变更即持久化) ─────────────────────────
// 关键教训: useSyncExternalStore 会**裸调用** subscribe/getSnapshot (无接收者),
// 所以 store 方法绝不能用 this (this 会是 window/undefined)。全部走闭包 data。
// 快照必须包含"打开状态", 否则点击开关时快照引用不变, React 跳过重渲染。
const data = {
  state: normalizeState(null),
  open: false,            // 看板开关 (UI 状态)
  selected: null,         // 当前详情面板选中的任务 id
  workspaces: [],         // 宿主工作区列表 [{workspaceId, path, title, sessionIds}]
  // sid -> { title, lastPromptText, context } 会话信息表 (sessions.list + session.history 尾部)
  sessionInfo: {},
  sizes: { left: 220, right: 460 }, // 左右侧栏宽度 (拖动实时值; 松手时写回 state.sizes)
  snap: null,             // 供 useSyncExternalStore 的稳定快照
  listeners: new Set(),
  saveWarn: null,         // 持久化失败提示
  // debug-13: 会话详情弹层 (大号会话视图) 与完整历史缓存
  detailSid: null,        // 打开中的会话详情 sid (null = 关闭)
  histories: {},          // sid -> { entries, error, loadedAt } 会话完整历史缓存 (最多保留 5 个)
  createDialog: { open: false, title: '' }, // 待开发列「完整创建框」状态
  // debug-16: 评论区草稿记忆 (taskId -> 文本; 独立 localStorage 键)
  commentDrafts: {},
  // debug-21: 看板设置 (localStorage 持久化) / 设置弹窗开关 / 轻提示
  settings: { jira: { url: '', user: '', token: '' } },
  settingsOpen: false,
  toast: null,
};
const store = {
  get state() { return data.state; },
  get open() { return data.open; },
  get selected() { return data.selected; },
  get workspaces() { return data.workspaces; },
  get sessionInfo() { return data.sessionInfo; },
  get sizes() { return data.sizes; },
  get saveWarn() { return data.saveWarn; },
  set saveWarn(v) { data.saveWarn = v; },
  get detailSid() { return data.detailSid; },
  get histories() { return data.histories; },
  get createDialog() { return data.createDialog; },
  get settings() { return data.settings; },
  get settingsOpen() { return data.settingsOpen; },
  get toast() { return data.toast; },
  setDetailSid(v) { data.detailSid = v || null; store.emit(); },
  setCreateDialog(v) { data.createDialog = v || { open: false, title: '' }; store.emit(); },
  setSettings(next) { saveSettings(next); store.emit(); },
  setSettingsOpen(v) { data.settingsOpen = !!v; store.emit(); },
  // debug-21: 轻提示 (自动 4.5s 消退; 裸 setTimeout 浏览器/冒烟通用)
  toast(text) {
    const id = (data.toast ? data.toast.id : 0) + 1;
    data.toast = { id, text: String(text == null ? '' : text) };
    store.emit();
    setTimeout(() => { if (data.toast && data.toast.id === id) { data.toast = null; store.emit(); } }, 4500);
  },
  setHistory(sid, val) {
    const next = { ...data.histories, [sid]: val };
    const keys = Object.keys(next);
    if (keys.length > 5) {
      for (const k of keys.slice(0, keys.length - 5)) delete next[k];
    }
    data.histories = next;
    store.emit();
  },
  sessionMeta: new Map(), // sessionId -> { running, pending: {kind, rpcId, questionId, text} | null }
  set(next) {
    data.state = next;
    if (next && next.sizes) data.sizes = { ...next.sizes };
    store.emit();
  },
  setOpen(v) {
    v = !!v;
    // 每次打开看板都拉一次工作区基线, 保证与主界面一致 (覆盖事件流重连期间漏掉的变更)
    if (v && !data.open) { try { fetchWorkspaces(); fetchSessionInfo(); } catch (e) {} }
    data.open = v;
    store.emit();
  },
  setSelected(v) { data.selected = v || null; store.emit(); },
  setWorkspaces(list) { data.workspaces = list || []; store.emit(); },
  setSessionInfo(map) { data.sessionInfo = map || {}; store.emit(); },
  patchSessionInfo(sid, partial) {
    const prev = data.sessionInfo[sid] || {};
    data.sessionInfo = { ...data.sessionInfo, [sid]: { ...prev, ...partial } };
    store.emit();
  },
  setSizes(v) { data.sizes = v; store.emit(); },
  emit() { for (const fn of [...data.listeners]) { try { fn(); } catch (e) {} } },
  subscribe(fn) { data.listeners.add(fn); return () => { data.listeners.delete(fn); }; },
  getSnapshot() {
    if (!data.snap || data.snap.state !== data.state || data.snap.open !== data.open
      || data.snap.selected !== data.selected || data.snap.workspaces !== data.workspaces
      || data.snap.sessionInfo !== data.sessionInfo || data.snap.sizes !== data.sizes
      || data.snap.detailSid !== data.detailSid || data.snap.histories !== data.histories
      || data.snap.createDialog !== data.createDialog
      || data.snap.settings !== data.settings || data.snap.settingsOpen !== data.settingsOpen
      || data.snap.toast !== data.toast) {
      data.snap = {
        state: data.state, open: data.open, selected: data.selected, workspaces: data.workspaces,
        sessionInfo: data.sessionInfo, sizes: data.sizes, detailSid: data.detailSid,
        histories: data.histories, createDialog: data.createDialog,
        settings: data.settings, settingsOpen: data.settingsOpen, toast: data.toast,
      };
    }
    return data.snap;
  },
};
let ctxRef = null;
let dragId = null;
let dragJustEnded = false;   // 拖拽刚结束时抑制一次 click, 避免松手误开详情
// debug-18: 最近一次鼠标按下的目标 — 按下/释放跨元素时 click 落在公共祖先上, 判断"点击外面"必须用按下目标
let lastPressTarget = null;

const short = (s) => (s && s.length > 14 ? s.slice(0, 14) + '…' : s || '');

function persist() {
  try {
    window.localStorage.setItem('kanban-board-state', JSON.stringify(store.state));
    store.saveWarn = null;
  } catch (e) {
    store.saveWarn = String((e && e.message) || e);
  }
  store.emit();
}

function loadState() {
  try {
    const raw = window.localStorage.getItem('kanban-board-state');
    if (raw) {
      const parsed = JSON.parse(raw);
      store.set(normalizeState(parsed));
      return;
    }
  } catch (e) { /* 损坏则重建 */ }
  store.saveWarn = null;
  store.emit();
}

// ── debug-21: 看板设置 (独立 localStorage 键; 与看板状态/评论草稿分开) ──────
const SETTINGS_KEY = 'kanban-board-settings';

function normalizeSettings(raw) {
  const j = (raw && raw.jira && typeof raw.jira === 'object') ? raw.jira : {};
  return { jira: { url: String(j.url || '').trim().replace(/\/+$/, ''), user: String(j.user || '').trim(), token: String(j.token || '') } };
}

function loadSettings() {
  try {
    const raw = (typeof window !== 'undefined' && window && window.localStorage)
      ? window.localStorage.getItem(SETTINGS_KEY) : null;
    data.settings = raw ? normalizeSettings(JSON.parse(raw)) : normalizeSettings(null);
  } catch (e) {
    data.settings = normalizeSettings(null);
  }
}

function saveSettings(next) {
  data.settings = normalizeSettings(next || data.settings);
  try {
    if (typeof window !== 'undefined' && window && window.localStorage) {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(data.settings));
    }
  } catch (e) { /* 写入失败不致命 */ }
}

// ── 任务操作 ────────────────────────────────────────────────────────────────
function addTask(title, description) {
  const key = activeBoardKey();
  const b = activeBoard(store.state);
  const task = {
    id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: (title || '').trim(),
    description: (description || '').trim(),
    column: 'todo',
    sessionId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    blockKind: null, blockText: null, pendingRpcId: null, pendingQuestionId: null,
    result: null,
    sessions: [],        // 该任务关联的所有会话 id (每次执行/打回都会新建一个)
    comments: [],        // 任务评论区 [{id, text, createdAt}]
    boardKey: key,       // 任务所属看板 (工作区 key)
  };
  if (!task.title) return null;
  store.set({
    ...store.state,
    boards: { ...store.state.boards, [key]: { ...b, tasks: [...b.tasks, task] } },
  });
  persist();
  return task;
}

function deleteTask(taskId) {
  const state = store.state;
  const hit = findTask(state, taskId);
  if (!hit) return;
  const b = state.boards[hit.boardKey];
  store.set({
    ...state,
    boards: { ...state.boards, [hit.boardKey]: { ...b, tasks: b.tasks.filter((t) => t.id !== taskId) } },
  });
  persist();
}

function patchTask(taskId, patch) {
  const state = store.state;
  const hit = findTask(state, taskId);
  if (!hit) return null;
  const b = state.boards[hit.boardKey];
  const next = {
    ...state,
    boards: {
      ...state.boards,
      [hit.boardKey]: { ...b, tasks: b.tasks.map((t) => (t.id === taskId ? { ...t, ...patch, updatedAt: Date.now() } : t)) },
    },
  };
  store.set(next);
  const after = findTask(next, taskId);
  return after ? after.task : null;
}

// 移动任务。fromTodo: 需要启动会话的列迁移
function moveTask(taskId, toColumn, feedback) {
  const state = store.state;
  const hit = findTask(state, taskId);
  if (!hit) return;
  const task = hit.task;
  const fromColumn = task.column;
  if (toColumn === fromColumn) return;
  // 正在开发的会话不能直接拖回待开发
  if (toColumn === 'todo' && fromColumn === 'doing') { store.saveWarn = '正在开发中的任务请先移到待审核'; store.emit(); return; }
  const cleared = toColumn !== 'blocked' && fromColumn === 'blocked'
    ? { blockKind: null, blockText: null, pendingRpcId: null, pendingQuestionId: null }
    : {};
  patchTask(taskId, { column: toColumn, ...cleared });
  persist();
  if (toColumn === 'doing') {
    if (fromColumn === 'todo') resumeOrStartSession(taskId, null);
    else if (fromColumn === 'review') resumeOrStartSession(taskId, feedback || '用户要求修改, 请根据审核意见调整后重新总结。');
  }
}

// 任务执行提示词 (resume=false 新建会话全量提示; resume=true 在已有会话里继续)
// cwd 为空 (宿主未给出工作目录) 时不输出【工作目录】行 —— 写空串会让 agent 去猜
function cwdText(cwd) {
  return cwd ? '\n【工作目录】' + cwd : '';
}

function buildTaskPrompt(task, cwd, feedback, resume) {
  if (!resume) {
    return '你是 DeepSeek Harness 中的任务执行智能体。请完成以下任务。\n\n【任务标题】' + task.title
      + '\n【任务描述】' + (task.description || '(无)')
      + cwdText(cwd) + (cwd ? '\n所有文件操作都在该目录下进行, 不要改动目录以外的内容。' : '')
      + '\n\n要求:\n1. 自主完成, 使用可用的工具(文件、命令、搜索等)。\n2. 如果缺少完成任务所必需的信息, 使用 ask_user_question 提出明确的问题并等待回答, 不要猜测。\n3. 完成后, 用一句话总结你做了什么、结果如何。'
      + (feedback ? '\n\n【用户审核反馈】' + feedback + '\n请根据以上反馈修改成果, 完成后重新总结。' : '');
  }
  return '继续执行以下任务 (接着本会话上次的进度工作):\n\n【任务标题】' + task.title
    + '\n【任务描述】' + (task.description || '(无)')
    + cwdText(cwd)
    + (feedback ? '\n\n【用户审核反馈】' + feedback : '')
    + '\n\n如果任务已经完成, 请总结成果; 如果尚未完成, 请继续执行。';
}

function taskCwd(taskId, hit) {
  const task = hit && hit.task;
  const boardKey = task.boardKey || (hit && hit.boardKey) || activeBoardKey();
  return resolveCwd(boardKey);
}

// 开始/继续执行: 任务已绑定会话则**接着主会话**工作 (不新建; debug-16 起按显式主会话, 之前按最新一个), 否则新建会话
async function resumeOrStartSession(taskId, feedback) {
  const hit = findTask(store.state, taskId);
  const task = hit && hit.task;
  const conn = ctxRef && ctxRef.get('connection');
  if (!task || !conn) return;
  // 每次开始执行先清掉旧错误, 避免把上次的报错当成这次的
  if (task.lastError) patchTask(taskId, { lastError: null, lastErrorAt: null });
  const sessions = Array.isArray(task.sessions) ? task.sessions : [];
  if (sessions.length) {
    // debug-16: 复用主会话 (task.sessionId); 主会话缺失/不在绑定列表时退回最新一个
    const target = sessions.includes(task.sessionId) ? task.sessionId : sessions[sessions.length - 1];
    if (target !== task.sessionId) patchTask(taskId, { sessionId: target });
    try {
      const taskNowHit = findTask(store.state, taskId);
      const taskNow = taskNowHit && taskNowHit.task;
      // debug-21: 任务级模型选择 — 每次开始/继续执行都应用到目标会话
      const m = taskNow && taskNow.model;
      if (m && m.provider && m.model) await selectSessionModel(target, m.provider, m.model);
      const text = buildTaskPrompt(taskNow, taskCwd(taskId, taskNowHit), feedback, true);
      await conn.api.sessions.prompt({ sessionId: target, mode: 'queue', content: [{ type: 'text', text }] });
      console.log('[kanban] 复用主会话继续执行 (debug-16): ' + target);
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.log('[kanban] 继续执行失败 (debug-16): ' + msg);
      patchTask(taskId, { lastError: msg, lastErrorAt: Date.now() });
    }
    return;
  }
  return startSession(taskId, feedback);
}

// 创建任务会话并投递任务提示词 (无绑定会话时的全新会话路径)
async function startSession(taskId, feedback) {
  const hit = findTask(store.state, taskId);
  const task = hit && hit.task;
  const conn = ctxRef && ctxRef.get('connection');
  if (!task || !conn) return;
  const sessionId = await createSessionForTask(taskId, true);
  if (!sessionId) return;
  try {
    const taskNowHit = findTask(store.state, taskId);
    const taskNow = taskNowHit && taskNowHit.task;
    // debug-21: 任务级模型选择 — 新建会话后先应用模型, 再投递任务提示词
    const m = taskNow && taskNow.model;
    if (m && m.provider && m.model) await selectSessionModel(sessionId, m.provider, m.model);
    const text = buildTaskPrompt(taskNow, taskCwd(taskId, taskNowHit), feedback, false);
    await conn.api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] });
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('[kanban] startSession 失败 (debug-14): ' + msg);
    patchTask(taskId, { lastError: msg, lastErrorAt: Date.now() });
  }
}

// 在任务所属工作区创建新会话并绑定到任务 (不投递任务提示词), 返回 sessionId
// makePrimary: debug-16 起默认 true — 新创建的会话默认兼作任务主会话 (后续默认在该会话继续工作)
async function createSessionForTask(taskId, makePrimary) {
  if (makePrimary === undefined) makePrimary = true;
  const hit = findTask(store.state, taskId);
  const task = hit && hit.task;
  const conn = ctxRef && ctxRef.get('connection');
  if (!task || !conn) return null;
  const boardKey = task.boardKey || (hit && hit.boardKey) || activeBoardKey();
  const ws = workspaceOf(boardKey);
  // 无匹配工作区时只借用解析出的目录 (裸 cwd), 不把会话挂到别人的工作区上;
  // 连目录都解析不出来就**不传 cwd** —— 宿主 session.create 会回退到它自己的默认目录
  // (dsh-api-session-controller: cwd = workspace?.path ?? request.cwd ?? defaultCwd)
  const cwd = resolveCwd(boardKey);
  const createPayload = ws ? { workspaceId: ws.workspaceId } : (cwd ? { cwd } : {});
  try {
    // 注意: unary RPC 返回完整信封 { rpcId, result: { ok, value } }, 不是裸 value!
    const created = await conn.api.sessions.create(createPayload);
    let result = created && created.result;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch (e) { result = null; } }
    if (!result) throw new Error('session.create 异常响应: ' + JSON.stringify(created));
    if (!result.ok) {
      const err = result.error || {};
      throw new Error('session.create 失败: ' + (err.code || '?') + ': ' + (err.message || JSON.stringify(created)));
    }
    const sessionId = result.value && result.value.sessionId;
    if (!sessionId) throw new Error('session.create 未返回 sessionId: ' + JSON.stringify(created));
    bindSession(taskId, sessionId);
    if (makePrimary) patchTask(taskId, { sessionId });
    return sessionId;
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('[kanban] 创建会话失败 (debug-14): ' + msg);
    patchTask(taskId, { lastError: msg, lastErrorAt: Date.now() });
    return null;
  }
}

// 创建任务会话并投递任务提示词 (无绑定会话时的全新会话路径)
async function startSession(taskId, feedback) {
  const hit = findTask(store.state, taskId);
  const task = hit && hit.task;
  const conn = ctxRef && ctxRef.get('connection');
  if (!task || !conn) return;
  const sessionId = await createSessionForTask(taskId, true);
  if (!sessionId) return;
  try {
    const taskNowHit = findTask(store.state, taskId);
    const taskNow = taskNowHit && taskNowHit.task;
    // debug-21: 任务级模型选择 — 新建会话后先应用模型, 再投递任务提示词
    const m = taskNow && taskNow.model;
    if (m && m.provider && m.model) await selectSessionModel(sessionId, m.provider, m.model);
    const text = buildTaskPrompt(taskNow, taskCwd(taskId, taskNowHit), feedback, false);
    await conn.api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] });
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('[kanban] startSession 失败 (debug-14): ' + msg);
    patchTask(taskId, { lastError: msg, lastErrorAt: Date.now() });
  }
}

// 手动压缩一个会话: 走宿主命令面 /compact (remote.commands.execute, 与主界面斜杠命令同路径)
async function compactSession(sid) {
  if (!sid) return 'no session id';
  try {
    const remote = ctxRef && ctxRef.get('remote');
    if (!remote || !remote.commands || typeof remote.commands.execute !== 'function') {
      return '当前环境没有命令通道 (remote.commands), 无法压缩';
    }
    const result = await remote.commands.execute(sid, '/compact');
    if (result && result.ok === false && result.error) {
      return '压缩失败: ' + (result.error.message || result.error.code || JSON.stringify(result.error));
    }
    return null; // null = 成功
  } catch (e) {
    return '压缩失败: ' + String((e && e.message) || e);
  }
}

// ── debug-15: 会话详情底部工具条 (状态栏 / 模型选择 / 启停 / 指令) ────────────
// 全部走与主界面相同的通道: session.cancel / session.models / session.selectModel /
// remote.commands.list|execute。静态客户端没有主界面的槽位/投影, 只能直接调 wire API。

// 延时辅助: 优先裸 setTimeout (浏览器/vm 通用), 否则 window.setTimeout, 都没有则立即 resolve
function delay(ms) {
  return new Promise((resolve) => {
    const t = (typeof setTimeout === 'function' && setTimeout)
      || ((typeof window !== 'undefined' && window && typeof window.setTimeout === 'function')
        ? window.setTimeout.bind(window)
        : null);
    if (t) t(resolve, ms); else resolve();
  });
}

// 停止当前会话的生成 (与主界面启停按钮同路径: session.cancel), 返回错误串或 null
async function cancelSession(sid) {
  const conn = ctxRef && ctxRef.get('connection');
  if (!conn || !sid) return '无连接';
  try {
    const res = await conn.api.sessions.cancel({ sessionId: sid });
    const result = unwrapResult(res);
    if (!result || !result.ok) throw new Error('session.cancel 异常: ' + JSON.stringify(res));
    return null;
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('[kanban] 停止会话失败 (debug-15): ' + msg);
    return msg;
  }
}

// 会话模型目录 (与主界面模型选择同源: session.models) → { current, routable, groups, failures } 或 null
async function fetchSessionModels(sid) {
  const conn = ctxRef && ctxRef.get('connection');
  if (!conn || !sid) return null;
  try {
    const res = await conn.api.sessions.models({ sessionId: sid });
    const result = unwrapResult(res);
    if (!result || !result.ok || !result.value) throw new Error('session.models 异常: ' + JSON.stringify(res));
    return result.value;
  } catch (e) {
    console.log('[kanban] session.models 失败 (debug-15): ' + String((e && e.message) || e));
    return null;
  }
}

// 选择模型 (与主界面同路径: session.selectModel), 返回 { ok, selected } 或 { ok:false, error }
async function selectSessionModel(sid, provider, model, reasoningEffort) {
  const conn = ctxRef && ctxRef.get('connection');
  if (!conn || !sid) return { ok: false, error: '无连接' };
  try {
    const payload = { sessionId: sid, provider, model };
    if (reasoningEffort != null) payload.reasoningEffort = reasoningEffort;
    const res = await conn.api.sessions.selectModel(payload);
    const result = unwrapResult(res);
    if (!result || !result.ok || !result.value) throw new Error('session.selectModel 异常: ' + JSON.stringify(res));
    return { ok: true, selected: result.value.selected };
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('[kanban] 选择模型失败 (debug-15): ' + msg);
    return { ok: false, error: msg };
  }
}

// 会话斜杠命令目录 (与主界面 ⊕ 菜单同源: remote.commands.list) → [{ name, description, input? }]
async function fetchSessionCommands(sid) {
  if (!sid) return [];
  try {
    const remote = ctxRef && ctxRef.get('remote');
    if (!remote || !remote.commands || typeof remote.commands.list !== 'function') return [];
    const result = await remote.commands.list(sid);
    if (result && result.ok && Array.isArray(result.value)) return result.value;
    return [];
  } catch (e) {
    console.log('[kanban] commands.list 失败 (debug-15): ' + String((e && e.message) || e));
    return [];
  }
}

// 执行斜杠命令 (bare 命令立即执行, 与主界面 ⊕ 菜单同语义), 返回错误串或 null
async function runSessionCommand(sid, line) {
  if (!sid) return 'no session id';
  try {
    const remote = ctxRef && ctxRef.get('remote');
    if (!remote || !remote.commands || typeof remote.commands.execute !== 'function') {
      return '当前环境没有命令通道 (remote.commands), 无法执行指令';
    }
    const result = await remote.commands.execute(sid, line);
    if (result && result.ok === false && result.error) {
      return result.error.message || result.error.code || JSON.stringify(result.error);
    }
    if (result && result.ok === true && result.value === undefined) {
      return '未知或格式错误的指令: ' + line;
    }
    return null;
  } catch (e) {
    return '指令执行失败: ' + String((e && e.message) || e);
  }
}

// 刷新会话上下文占用 (sessions.list 投影) 与完整历史; 压缩后 / 点刷新都走这里
async function refreshSessionContext(sid) {
  await fetchSessionInfo();
  if (sid) await fetchSessionHistory(sid);
}

// 压缩一个会话并随后刷新上下文大小与历史 (相关会话行 / 会话详情弹层共用)
async function compactSessionAndRefresh(sid) {
  const err = await compactSession(sid);
  if (err) return err;
  // 压缩会改写会话日志与投影: 稍等宿主提交, 再拉最新的上下文占用与历史
  await delay(800);
  await refreshSessionContext(sid);
  return null;
}

// 注入的系统指令 (system-reminder: AGENTS.md 等插件注入的上下文) 是否为应隐藏项
function isInjectedInstruction(event) {
  return !!event && event.type === 'user/message' && !isRealUserInput(event);
}

// ── 会话状态监听: 完成 → 待审核; 提问/审批 → 阻塞 ─────────────────────────
// debug-16: 任务与所有绑定会话 (主会话 + sessions 数组) 联动, 不只主会话 —
//   评论追加/弹层发消息等对任一绑定会话的指示都会驱动卡片位置。
function taskUsesSession(t, sessionId) {
  return t.sessionId === sessionId || (Array.isArray(t.sessions) && t.sessions.includes(sessionId));
}

// debug-21: 一个会话只允许绑定一个任务 — 查找已绑定该会话的其他任务 (排除 exceptTaskId)
function findTaskBoundToSession(sid, exceptTaskId) {
  if (!sid) return null;
  for (const key of Object.keys(store.state.boards || {})) {
    for (const t of store.state.boards[key].tasks || []) {
      if (t.id !== exceptTaskId && taskUsesSession(t, sid)) return t;
    }
  }
  return null;
}

function setPending(sessionId, kind, rpcId, questionId, text) {
  const meta = store.sessionMeta.get(sessionId) || { running: false, pending: null };
  meta.pending = { kind, rpcId, questionId, text };
  store.sessionMeta.set(sessionId, meta);
  const state = store.state;
  const next = mapAllTasks(state, (t) => {
    if (!taskUsesSession(t, sessionId) || (t.column !== 'doing' && t.column !== 'review' && t.column !== 'blocked')) return t;
    return { ...t, column: 'blocked', blockKind: kind, blockText: text, pendingRpcId: rpcId, pendingQuestionId: questionId || null, updatedAt: Date.now() };
  });
  if (next !== state) { store.set(next); persist(); }
}

function clearPending(sessionId, rpcId) {
  const meta = store.sessionMeta.get(sessionId);
  if (meta && meta.pending) meta.pending = null;
  const state = store.state;
  const next = mapAllTasks(state, (t) => {
    if (!taskUsesSession(t, sessionId) || t.pendingRpcId !== rpcId) return t;
    return { ...t, column: 'doing', blockKind: null, blockText: null, pendingRpcId: null, pendingQuestionId: null, updatedAt: Date.now() };
  });
  if (next !== state) { store.set(next); persist(); }
}

function onSessionStatus(sessionId, running) {
  const meta = store.sessionMeta.get(sessionId) || { running: false, pending: null, everRan: false };
  const prevRunning = meta.running;
  if (running) meta.everRan = true;
  meta.running = running;
  store.sessionMeta.set(sessionId, meta);
  const pending = meta.pending;
  const state = store.state;
  const next = mapAllTasks(state, (t) => {
    if (!taskUsesSession(t, sessionId)) return t;
    // 完成判定: 观察到 running 从 true → false, 且无未决提问/审批, 才进"待审核"
    // (要求 everRan, 避免会话刚创建、turn 尚未开始时的初始 false 误判为完成)
    if (!running && prevRunning && !pending && (t.column === 'doing' || t.column === 'blocked')) {
      return { ...t, column: 'review', blockKind: null, blockText: null, pendingRpcId: null, pendingQuestionId: null, updatedAt: Date.now() };
    }
    if (running && t.column === 'blocked' && !pending) {
      return { ...t, column: 'doing', blockKind: null, blockText: null, pendingRpcId: null, pendingQuestionId: null, updatedAt: Date.now() };
    }
    // debug-16: 待审核/已完成/待开发的任务, 绑定会话因新评论或新指示开始工作 → 自动移入「正在开发」
    if (running && (t.column === 'review' || t.column === 'done' || t.column === 'todo')) {
      return { ...t, column: 'doing', blockKind: null, blockText: null, pendingRpcId: null, pendingQuestionId: null, updatedAt: Date.now() };
    }
    return t;
  });
  if (next !== state) { store.set(next); persist(); }
}

// ── 工作区实时同步 (左侧工作区栏 = 主界面工作区) ──────────────────────────
// 事件语义 (宿主 events.host 流):
//   host/workspace-changed      → 工作区创建/改名/挂会话后推送完整快照, 就地 upsert
//   host/workspace-removed      → 工作区删除, 从列表移除
//   host/workspace-order-changed→ 工作区顺序变化, 按主界面顺序重排
// 看板数据在删除时保留 (任务不丢), 只是不再出现在左侧栏。

function upsertWorkspace(w) {
  if (!w || typeof w.workspaceId !== 'string') return;
  const ws = {
    workspaceId: w.workspaceId,
    path: w.path || '',
    title: w.title || '未命名工作区',
    sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : [],
  };
  const list = (data.workspaces || []).slice();
  const i = list.findIndex((x) => x.workspaceId === ws.workspaceId);
  if (i >= 0) list[i] = ws; else list.push(ws);
  store.setWorkspaces(list);
  // 每个工作区补一个看板 (cwd 跟随工作区目录), 已存在则同步 cwd
  const state = store.state;
  const b = state.boards[ws.workspaceId];
  if (!b) {
    store.set({ ...state, boards: { ...state.boards, [ws.workspaceId]: { cwd: ws.path, tasks: [] } } });
    persist();
  } else if (b.cwd !== ws.path) {
    store.set({ ...state, boards: { ...state.boards, [ws.workspaceId]: { ...b, cwd: ws.path } } });
    persist();
  }
}

function removeWorkspace(workspaceId) {
  if (typeof workspaceId !== 'string') return;
  store.setWorkspaces((data.workspaces || []).filter((x) => x.workspaceId !== workspaceId));
  // 被删工作区若是当前看板, 切回默认看板 (其看板数据仍保留在状态里)
  if (store.state.activeBoard === workspaceId) switchBoard(DEFAULT_BOARD_KEY);
}

function reorderWorkspaces(ids) {
  if (!Array.isArray(ids)) return;
  const byId = new Map((data.workspaces || []).map((w) => [w.workspaceId, w]));
  const next = [];
  for (const id of ids) {
    const w = byId.get(id);
    if (w) { next.push(w); byId.delete(id); }
  }
  for (const w of (data.workspaces || [])) if (byId.has(w.workspaceId)) next.push(w);
  store.setWorkspaces(next);
}

// events.host 流: running 状态翻转 (完成信号) + 工作区增删改 (左侧栏同步)
// 注意: 必须传真实 AbortSignal (shell 的 readWebSocket 会对 signal.addEventListener,
// 传 undefined 会立即崩溃且泄漏未关闭的 WebSocket); finally 里 abort 关闭 socket。
async function watchHost(conn) {
  const ac = new AbortController();
  try {
    const iter = conn.api.events.host({}, ac.signal);
    for await (const frame of iter) {
      const f = frame && frame.payload !== undefined ? frame.payload : frame;
      if (!f || typeof f.type !== 'string') continue;
      if (f.type === 'host/session-status') onSessionStatus(f.sessionId, f.running === true);
      else if (f.type === 'host/workspace-changed') upsertWorkspace(f.workspace);
      else if (f.type === 'host/workspace-removed') removeWorkspace(f.workspaceId);
      else if (f.type === 'host/workspace-order-changed') reorderWorkspaces(f.workspaceIds);
    }
  } catch (e) {
    console.log('[kanban] host stream ended: ' + String((e && e.message) || e));
  } finally {
    ac.abort();
  }
  scheduleReconnect(watchHost);
}

// events.mux 流: 提问 / 审批帧 (阻塞检测)
async function watchMux(conn) {
  const ac = new AbortController();
  try {
    const iter = conn.api.events.mux({}, ac.signal);
    for await (const frame of iter) {
      // 流产出的是窄形 RpcRequest<MuxFrame>: { rpcId, payload }; rpcId 在信封上
      const rpcId = frame && frame.rpcId;
      const f = frame && frame.payload !== undefined ? frame.payload : frame;
      if (!f || typeof f.type !== 'string') continue;
      if (f.type === 'question/requested') {
        const q = (f.questions && f.questions[0]) || {};
        const options = (q.options && q.options.length)
          ? '  选项: ' + q.options.map((o) => o.label).join(' / ') : '';
        setPending(f.sessionId, 'question', rpcId, q.id || null, (q.question || '(无问题文本)') + options);
      } else if (f.type === 'question/resolved') {
        clearPending(f.sessionId, f.questionRpcId);
      } else if (f.type === 'approval/requested') {
        setPending(f.sessionId, 'approval', f.approvalId, null,
          (f.toolName ? '工具 ' + f.toolName + ' 请求审批' : '请求审批') + (f.reason ? ': ' + f.reason : ''));
      } else if (f.type === 'approval/resolved') {
        clearPending(f.sessionId, f.approvalId);
      }
    }
  } catch (e) {
    console.log('[kanban] mux stream ended: ' + String((e && e.message) || e));
  } finally {
    ac.abort();
  }
  scheduleReconnect(watchMux);
}

function scheduleReconnect(fn) {
  try {
    window.setTimeout(() => {
      const conn = ctxRef && ctxRef.get('connection');
      if (conn) fn(conn);
    }, 3000);
  } catch (e) { /* 放弃重连 */ }
}

// 在卡片上直接回答 agent 的提问 (client-response → /api/respond)
async function answerQuestion(task, text) {
  const conn = ctxRef && ctxRef.get('connection');
  if (!conn || !task.pendingRpcId || !text.trim()) return;
  try {
    await conn.api.respond({
      type: 'client-response',
      rpcId: task.pendingRpcId,
      result: {
        ok: true,
        value: {
          sessionId: task.sessionId,
          answer: { answers: [{ id: task.pendingQuestionId || 'q', selected: [], custom: text.trim() }] },
        },
      },
    });
  } catch (e) {
    patchTask(task.id, { lastError: '回答失败: ' + String((e && e.message) || e) + ' (请到该任务会话中回答)' });
  }
}

// ── 工作区列表 ─────────────────────────────────────────────────────────────
function unwrapResult(res) {
  let result = res && res.result;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch (e) { result = null; } }
  return result || null;
}

async function fetchWorkspaces() {
  const conn = ctxRef && ctxRef.get('connection');
  if (!conn) return;
  try {
    // 注意: 真实客户端 api 是单数 workspace (IApiClient.workspace, RPC 'workspace.list'),
    // 不是 workspaces; 冒烟 mock 必须照真实面镜像, 否则会掩盖这类调用名错误。
    const res = await conn.api.workspace.list({});
    const result = unwrapResult(res);
    if (!result || !result.ok || !Array.isArray(result.value.items)) {
      throw new Error('workspace.list 异常: ' + JSON.stringify(res));
    }
    // 全量基线: 左侧栏与宿主工作区集合完全对齐 (多删少补), 保持宿主顺序。
    // 事件流处理两次基线之间的增量 (增/删/改名/排序)。
    const list = result.value.items.map((w) => ({
      workspaceId: w.workspaceId, path: w.path, title: w.title, sessionIds: w.sessionIds || [],
    }));
    store.setWorkspaces(list);
    const state = store.state;
    const boards = { ...state.boards };
    let changed = false;
    for (const w of list) {
      const b = boards[w.workspaceId];
      if (!b) {
        boards[w.workspaceId] = { cwd: w.path, tasks: [] };
        changed = true;
      } else if (b.cwd !== w.path) {
        boards[w.workspaceId] = { ...b, cwd: w.path };
        changed = true;
      }
    }
    if (changed) { store.set({ ...state, boards }); persist(); }
  } catch (e) {
    console.log('[kanban] workspace.list 失败: ' + String((e && e.message) || e));
  }
}

// ── 会话信息表 (相关会话行: 标题 + 最新提问 + 上下文大小) ──────────────────
// 标题与上下文占用来自 sessions.list 每行的 projections 基线 (title / contextPressure);
// 最新提问文本来自 session.history 尾页的最后一个真人 user/message。
function fmtTokens(n) {
  const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  if (n < 1000) return String(n);
  if (n < 1e6) return scaled(n / 1000) + 'K';
  return scaled(n / 1e6) + 'M';
}

async function fetchSessionInfo() {
  const conn = ctxRef && ctxRef.get('connection');
  if (!conn) return;
  try {
    const res = await conn.api.sessions.list({});
    const result = unwrapResult(res);
    if (!result || !result.ok || !Array.isArray(result.value.items)) {
      throw new Error('sessions.list 异常: ' + JSON.stringify(res));
    }
    const map = {};
    // debug-19: 列表投影的 running 字段 (sid -> boolean, 含 false — 完成方向也要对账)
    const listRunning = {};
    for (const s of result.value.items) {
      if (!s || typeof s.sessionId !== 'string') continue;
      listRunning[s.sessionId] = s.running === true;
      const values = s.projections && s.projections.values;
      const title = values && typeof values.title === 'string' && values.title !== '' ? values.title : null;
      const pressure = values && values.contextPressure;
      const used = pressure && (pressure.projectedTokens != null ? pressure.projectedTokens : pressure.pressureTokens);
      const context = used == null ? null : { used, window: pressure.contextWindow == null ? null : pressure.contextWindow };
      // 重建基线时保留已经拉到的提问文本 (history 尾页)
      const prev = store.sessionInfo[s.sessionId];
      map[s.sessionId] = {
        title,
        context,
        ...(prev && 'lastPromptText' in prev ? { lastPromptText: prev.lastPromptText } : {}),
      };
    }
    store.setSessionInfo(map);
    // debug-19: 用列表的 running 与本地 meta 对账, 把宿主流漏掉的开始/完成翻转补回来
    reconcileSessionStatuses(listRunning);
  } catch (e) {
    console.log('[kanban] sessions.list (会话信息) 失败: ' + String((e && e.message) || e));
  }
}

// debug-19: sessions.list 基线对账 — 宿主流断线/看板关闭期间由主界面驱动的工作, 靠列表投影的
// running 字段把漏掉的翻转补回来: 主会话完成 → 自动移入「待审核」。
// 空闲且从未见过运行的会话只记基线不推卡片 (无法证明它"刚完成", 防止误判)。
function reconcileSessionStatuses(listRunning) {
  for (const sid of Object.keys(listRunning || {})) {
    const running = listRunning[sid] === true;
    const meta = store.sessionMeta.get(sid);
    if (!meta) {
      if (running) {
        // 首次见到就在跑: 记基线, 并按 debug-16 语义把卡片移入「正在开发」
        onSessionStatus(sid, true);
      } else {
        store.sessionMeta.set(sid, { running: false, pending: null, everRan: false });
      }
      continue;
    }
    if (meta.running !== running) onSessionStatus(sid, running);
  }
}

// 折叠空白: 用于单行展示 (行内裁剪、侧栏标签), 不用于发送内容本身
function collapseText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// 拉一个会话的最新提问文本 (session.history 尾页 → 最后一个真人 user/message)
async function fetchPromptText(sid) {
  const conn = ctxRef && ctxRef.get('connection');
  if (!conn || !sid) return;
  const info = store.sessionInfo[sid];
  if (info && 'lastPromptText' in info) return; // 已拉过, 不重复请求
  try {
    const res = await conn.api.sessions.history({ sessionId: sid });
    const result = unwrapResult(res);
    if (!result || !result.ok || !Array.isArray(result.value.events)) {
      throw new Error('session.history 异常: ' + JSON.stringify(res));
    }
    let text = null;
    for (let i = result.value.events.length - 1; i >= 0; i--) {
      const entry = result.value.events[i];
      const event = entry && entry.event;
      if (!event || event.type !== 'user/message') continue;
      if (!(event.data && event.data.source && event.data.source.kind === 'user')) continue;
      text = firstTextOf(event);
      if (text != null) text = text.length > 240 ? text.slice(0, 240) : text;
      break;
    }
    store.patchSessionInfo(sid, { lastPromptText: text });
  } catch (e) {
    console.log('[kanban] session.history (最新提问) 失败: ' + String((e && e.message) || e));
  }
}

// 拉一个会话的完整历史 (session.history 向后翻页直到 hasMore=false), 升序去重后写入缓存
async function fetchSessionHistory(sid) {
  const conn = ctxRef && ctxRef.get('connection');
  if (!conn || !sid) return { entries: null, error: '无连接' };
  try {
    const pages = [];
    let beforeSeq = null;
    for (let i = 0; i < 20; i++) {
      const payload = { sessionId: sid, maxMessages: 200 };
      if (beforeSeq != null) payload.beforeSeq = beforeSeq;
      const res = await conn.api.sessions.history(payload);
      const result = unwrapResult(res);
      if (!result || !result.ok || !Array.isArray(result.value.events)) {
        throw new Error('session.history 异常: ' + JSON.stringify(res));
      }
      const page = result.value.events;
      pages.push(page);
      if (!result.value.hasMore) break;
      let min = Infinity;
      for (const entry of page) {
        const e = entry && entry.event;
        if (e && typeof e.seq === 'number' && e.seq < min) min = e.seq;
      }
      if (!isFinite(min)) break;
      beforeSeq = min;
    }
    const seen = new Set();
    const entries = [];
    for (let i = pages.length - 1; i >= 0; i--) {
      for (const entry of pages[i]) {
        const e = entry && entry.event;
        const seq = e && typeof e.seq === 'number' ? e.seq : null;
        const key = seq != null ? '#' + seq : JSON.stringify(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
    }
    store.setHistory(sid, { entries, error: null, loadedAt: Date.now() });
    return { entries, error: null };
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('[kanban] session.history (完整历史) 失败 (debug-14): ' + msg);
    store.setHistory(sid, { entries: null, error: msg, loadedAt: Date.now() });
    return { entries: null, error: msg };
  }
}

// 向会话发送一条用户消息 (与主界面输入框同路径: session.prompt mode=queue), 返回错误串或 null
async function sendPrompt(sid, text) {
  const conn = ctxRef && ctxRef.get('connection');
  if (!conn || !sid) return '无连接';
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return '内容为空';
  try {
    const res = await conn.api.sessions.prompt({ sessionId: sid, mode: 'queue', content: [{ type: 'text', text: raw }] });
    const result = unwrapResult(res);
    if (!result || !result.ok) throw new Error('session.prompt 异常: ' + JSON.stringify(res));
    // 同步更新相关会话行上的「最新提问」(仅行内展示用裁剪版, 发送内容保持原文)
    const folded = collapseText(raw);
    store.patchSessionInfo(sid, { lastPromptText: folded.length > 240 ? folded.slice(0, 240) : folded });
    return null;
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('[kanban] 发送消息失败 (debug-14): ' + msg);
    return msg;
  }
}

function switchBoard(key) {
  const state = store.state;
  const boards = { ...state.boards };
  const ws = (data.workspaces || []).find((w) => w.workspaceId === key);
  if (ws) {
    boards[key] = { cwd: ws.path, tasks: (boards[key] && boards[key].tasks) || [] };
  } else if (!boards[key]) {
    // 未分组看板: 目录跟随宿主工作区列表的第一个 (没有则不记, 交宿主决定)
    boards[key] = { cwd: firstWorkspacePath() || '', tasks: [] };
  }
  store.set({ ...state, boards, activeBoard: key });
  store.setSelected(null);
  persist();
}

// ── 相关会话绑定/解绑 (详情面板) ─────────────────────────────────────────────
// 候选会话: 任务所属工作区的会话优先, 其余工作区会话兜底 (默认看板没有对应工作区)。
function candidateSessions(boardKey) {
  const wsList = store.workspaces || [];
  const own = wsList.find((w) => w.workspaceId === boardKey);
  const out = [];
  const seen = new Set();
  const push = (list) => {
    for (const sid of Array.isArray(list) ? list : []) {
      if (typeof sid === 'string' && !seen.has(sid)) { seen.add(sid); out.push(sid); }
    }
  };
  if (own) push(own.sessionIds);
  for (const w of wsList) push(w.sessionIds);
  // debug-21: 已被其他任务绑定的会话不可再绑定 (候选列表直接排除)
  return out.filter((sid) => !findTaskBoundToSession(sid, null));
}

// 把工作区里的会话绑定到任务 (纯关联, 不改变会话本身); 任务无主会话时兼作主会话
// debug-21: 一个会话只允许绑定一个任务 — 已被其他任务绑定则拒绝并提示
function bindSession(taskId, sid) {
  sid = (sid || '').trim();
  const hit = findTask(store.state, taskId);
  if (!hit || !sid) return { ok: false, reason: 'no-task-or-sid' };
  const t = hit.task;
  const sessions = Array.isArray(t.sessions) ? t.sessions : [];
  if (sessions.includes(sid)) return { ok: true, duplicate: true };
  const other = findTaskBoundToSession(sid, taskId);
  if (other) {
    store.toast('会话已绑定到任务「' + other.title + '」, 不能重复绑定 (一个会话只能绑定一个任务)');
    return { ok: false, reason: 'bound-to-other', otherTitle: other.title };
  }
  const patch = { sessions: [...sessions, sid] };
  if (!t.sessionId) patch.sessionId = sid;
  patchTask(taskId, patch);
  persist();
  return { ok: true };
}

// 解绑: 只移除关联; 主会话被解绑时让位给最新一个剩余会话 (没有则清空)
function unbindSession(taskId, sid) {
  const hit = findTask(store.state, taskId);
  if (!hit) return;
  const t = hit.task;
  const sessions = (Array.isArray(t.sessions) ? t.sessions : []).filter((s) => s !== sid);
  const patch = { sessions };
  if (t.sessionId === sid) patch.sessionId = sessions.length ? sessions[sessions.length - 1] : null;
  patchTask(taskId, patch);
  persist();
}

// debug-16: 设为主会话 — 后续「开始开发/打回修改/评论」都默认在这个会话上继续
function makeMainSession(taskId, sid) {
  sid = (sid || '').trim();
  const hit = findTask(store.state, taskId);
  if (!hit || !sid) return;
  const t = hit.task;
  if (t.sessionId === sid) return;
  if (!(Array.isArray(t.sessions) && t.sessions.includes(sid))) return; // 只允许把已绑定会话设为主
  patchTask(taskId, { sessionId: sid });
  persist();
}

// debug-16: 关闭看板并在主界面跳转到该会话 (走客户端运行时 sessions.open, 与主界面选中会话同一路径)
function jumpToSession(sid) {
  try {
    const sessions = ctxRef && ctxRef.get('sessions');
    if (sessions && typeof sessions.open === 'function') sessions.open(sid);
  } catch (e) {
    console.log('[kanban] 跳转会话失败 (debug-16): ' + String((e && e.message) || e));
  }
  store.setOpen(false);
}

// debug-16: 把评论追加到任务主会话并开始工作 (session.prompt queue); 无主会话时评论只留在本地
async function appendCommentToSession(taskId, text) {
  const hit = findTask(store.state, taskId);
  const task = hit && hit.task;
  const conn = ctxRef && ctxRef.get('connection');
  if (!task || !conn) return null;
  const sessions = Array.isArray(task.sessions) ? task.sessions : [];
  const main = task.sessionId || (sessions.length ? sessions[sessions.length - 1] : null);
  if (!main) return 'no-main-session'; // debug-21: 无绑定会话 → 调用方只留本地记录
  try {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return '内容为空';
    const payload = {
      sessionId: main,
      mode: 'queue',
      content: [{ type: 'text', text: '【看板评论】任务「' + task.title + '」: ' + raw }],
    };
    await conn.api.sessions.prompt(payload);
    // 同步相关会话行上的「最新提问」(裁剪版)
    const folded = collapseText(raw);
    store.patchSessionInfo(main, { lastPromptText: folded.length > 240 ? folded.slice(0, 240) : folded });
    return null;
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('[kanban] 评论追加到主会话失败 (debug-16): ' + msg);
    patchTask(taskId, { lastError: msg, lastErrorAt: Date.now() });
    return msg;
  }
}

// debug-20: 添加一条本地评论 (不投递主会话; 追加由调用方决定), 返回新评论 id
// debug-21: 评论带 sent 标记 — 已追加到主会话的评论显示「已发送」徽章
function addLocalComment(taskId, text, sent) {
  const hit = findTask(store.state, taskId);
  const t = hit && hit.task;
  if (!t) return null;
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const list = (Array.isArray(t.comments) ? t.comments : []).concat([{ id, text: raw, createdAt: Date.now(), sent: !!sent }]);
  patchTask(taskId, { comments: list });
  persist();
  return id;
}

// debug-21: 评论成功追加到主会话后打上「已发送」标记 (追加失败保持仅保存)
function markCommentSent(taskId, commentId) {
  const hit = findTask(store.state, taskId);
  const t = hit && hit.task;
  if (!t || !commentId) return;
  const comments = Array.isArray(t.comments) ? t.comments : [];
  if (!comments.some((c) => c.id === commentId)) return;
  patchTask(taskId, { comments: comments.map((c) => (c.id === commentId ? { ...c, sent: true } : c)) });
  persist();
}

// debug-20: 删除一条历史评论 (只删本地记录; 已追加到主会话的提示词不回撤)
function deleteComment(taskId, commentId) {
  const hit = findTask(store.state, taskId);
  const t = hit && hit.task;
  if (!t || !commentId) return;
  const comments = Array.isArray(t.comments) ? t.comments : [];
  if (!comments.some((c) => c.id === commentId)) return;
  patchTask(taskId, { comments: comments.filter((c) => c.id !== commentId) });
  persist();
}

// ── 评论区草稿记忆 (debug-16): 独立 localStorage 键, 关看板/刷新页面都不丢 ────
const COMMENT_DRAFTS_KEY = 'kanban-board-comment-drafts';

function loadCommentDrafts() {
  try {
    const raw = typeof window !== 'undefined' && window && window.localStorage
      ? window.localStorage.getItem(COMMENT_DRAFTS_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : null;
    data.commentDrafts = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    data.commentDrafts = {};
  }
}

function saveCommentDrafts() {
  try {
    if (typeof window !== 'undefined' && window && window.localStorage) {
      window.localStorage.setItem(COMMENT_DRAFTS_KEY, JSON.stringify(data.commentDrafts));
    }
  } catch (e) { /* 写入失败不致命 */ }
}

function saveCommentDraft(taskId, text) {
  data.commentDrafts[taskId] = String(text == null ? '' : text);
  saveCommentDrafts();
}

function commentDraftOf(taskId) {
  return (data.commentDrafts && data.commentDrafts[taskId]) || '';
}

function clearCommentDraft(taskId) {
  delete data.commentDrafts[taskId];
  saveCommentDrafts();
}

// ── debug-21: 图文粘贴 / 卡片纯文本 / Jira / 任务模型 / 定时 ─────────────────
// 剪贴板图片 → Markdown 图片语法 (dataURL 内联, 直接持久化进描述/评论)
function imageMarkdown(dataUrl) {
  return '![粘贴的图片](' + String(dataUrl || '') + ')';
}

// textarea onPaste: 剪贴板里的图片读成 dataURL, 追加 `![粘贴的图片](dataURL)` 到文本末尾
function pasteImageInto(e, getText, setText) {
  const items = e && e.clipboardData && e.clipboardData.items;
  if (!items || typeof FileReader === 'undefined') return;
  const files = [];
  for (const it of items) {
    if (it && it.kind === 'file' && typeof it.getAsFile === 'function') {
      const f = it.getAsFile();
      if (f && /^image\//.test(f.type)) files.push(f);
    }
  }
  if (!files.length) return;
  e.preventDefault();
  let pending = files.length;
  const parts = [];
  files.forEach((f, i) => {
    const r = new FileReader();
    r.onload = () => {
      parts[i] = imageMarkdown(r.result);
      pending -= 1;
      if (pending === 0) {
        const md = parts.join('\n');
        const before = String(getText() || '');
        setText(before ? before.replace(/\n?$/, '\n') + md + '\n' : md + '\n');
      }
    };
    r.readAsDataURL(f);
  });
}

// 卡片上的描述展示: 去掉 Markdown 符号后的单行纯文本 (完整 Markdown 渲染在详情面板)
function mdPlain(s) {
  return String(s == null ? '' : s)
    .replace(/```[\s\S]*?```/g, (m) => ' 代码 ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '• ')
    .replace(/^\d+[.)]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 极简 base64 (Basic Auth 头): 优先 window.btoa, 兜底纯 JS (unicode 安全)
function b64(s) {
  const raw = String(s == null ? '' : s);
  try {
    if (typeof window !== 'undefined' && window && typeof window.btoa === 'function') {
      return window.btoa(unescape(encodeURIComponent(raw)));
    }
  } catch (e) { /* 落入纯 JS 实现 */ }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = unescape(encodeURIComponent(raw));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes.charCodeAt(i);
    const b = i + 1 < bytes.length ? bytes.charCodeAt(i + 1) : 0;
    const c = i + 2 < bytes.length ? bytes.charCodeAt(i + 2) : 0;
    out += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)]
      + (i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '=')
      + (i + 2 < bytes.length ? chars[c & 63] : '=');
  }
  return out;
}

// ── Jira 集成 (设置页保存 url/账户/密码, Basic Auth 直连 REST API) ─────────
function jiraConfig() {
  const j = (data.settings && data.settings.jira) || {};
  return { url: String(j.url || '').replace(/\/+$/, ''), user: String(j.user || ''), token: String(j.token || '') };
}

async function jiraRequest(path) {
  const cfg = jiraConfig();
  if (!cfg.url) return { ok: false, error: '请先在 Jira 配置页填写 Jira URL' };
  if (typeof fetch !== 'function') return { ok: false, error: '当前环境不支持网络请求' };
  try {
    const res = await fetch(cfg.url + path, {
      headers: { Authorization: 'Basic ' + b64(cfg.user + ':' + cfg.token), Accept: 'application/json' },
    });
    let body = null;
    try { body = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
    if (!res.ok) {
      const detail = body && body.errorMessages && body.errorMessages.length ? ': ' + body.errorMessages.join('; ') : '';
      return { ok: false, error: 'HTTP ' + res.status + detail };
    }
    return { ok: true, data: body };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/fetch|Failed to fetch|NetworkError|CORS/i.test(msg)) {
      return { ok: false, error: msg + ' — 浏览器 CORS 可能拦截了直接访问 Jira, 需要 Jira 允许跨域或走代理' };
    }
    return { ok: false, error: msg };
  }
}

async function testJiraConnection() {
  const r = await jiraRequest('/rest/api/3/myself');
  if (!r.ok) return r;
  const name = r.data && (r.data.displayName || r.data.emailAddress) || '连接成功';
  return { ok: true, name: String(name) };
}

// 导入当前用户未完成的 Jira 任务到「待开发」; jiraKey 去重 (同 key 不重复导入)
async function importJiraIssues() {
  const r = await jiraRequest('/rest/api/3/search?jql=assignee=currentUser() AND resolution=Unresolved ORDER BY updated DESC&maxResults=50');
  if (!r.ok) return r;
  const issues = (r.data && Array.isArray(r.data.issues)) ? r.data.issues : [];
  const cfg = jiraConfig();
  const key = activeBoardKey();
  const b = activeBoard(store.state);
  const existing = new Set();
  for (const bk of Object.keys(store.state.boards || {})) {
    for (const t of store.state.boards[bk].tasks || []) if (t.jiraKey) existing.add(t.jiraKey);
  }
  const newTasks = [];
  let added = 0;
  let skipped = 0;
  for (const issue of issues) {
    const jk = issue && issue.key;
    if (!jk) continue;
    if (existing.has(jk)) { skipped += 1; continue; }
    existing.add(jk);
    const f = issue.fields || {};
    const link = cfg.url + '/browse/' + jk;
    const desc = [
      '- 状态: ' + (f.status && f.status.name ? f.status.name : '未知'),
      f.priority && f.priority.name ? '- 优先级: ' + f.priority.name : '',
      f.assignee && f.assignee.displayName ? '- 经办人: ' + f.assignee.displayName : '',
      '- 链接: [' + jk + '](' + link + ')',
    ].filter(Boolean).join('\n') + (f.description ? '\n\n' + String(f.description) : '');
    newTasks.push({
      id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 4),
      title: '[' + jk + '] ' + (f.summary || '(无标题)'),
      description: desc,
      column: 'todo',
      sessionId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      blockKind: null, blockText: null, pendingRpcId: null, pendingQuestionId: null,
      result: null,
      sessions: [],
      comments: [],
      boardKey: key,
      jiraKey: jk,
      jiraUrl: cfg.url,
    });
    added += 1;
  }
  if (newTasks.length) {
    store.set({ ...store.state, boards: { ...store.state.boards, [key]: { ...b, tasks: [...b.tasks, ...newTasks] } } });
    persist();
  }
  return { ok: true, added, skipped };
}

// ── 任务级模型选择 ───────────────────────────────────────────────────────────
// 保存任务模型偏好; 已有主会话则立即切换, 否则记录并在创建/开始会话时应用
async function applyTaskModel(taskId, provider, model) {
  patchTask(taskId, { model: { provider, model } });
  persist();
  const hit = findTask(store.state, taskId);
  const task = hit && hit.task;
  const sessions = (task && Array.isArray(task.sessions)) ? task.sessions : [];
  const main = (task && task.sessionId) || (sessions.length ? sessions[sessions.length - 1] : null);
  if (!main) {
    store.toast('模型已记录, 创建/开始会话时自动应用');
    return { ok: true, applied: false };
  }
  const r = await selectSessionModel(main, provider, model);
  if (r && r.ok) {
    store.toast('已为主会话切换模型: ' + model);
    return { ok: true, applied: true };
  }
  store.toast('模型已记录, 但主会话切换失败: ' + ((r && r.error) || '?'));
  return { ok: false, error: r && r.error };
}

// ── 定时进入「正在开发」 ──────────────────────────────────────────────────────
function toLocalInputValue(ts) {
  const d = new Date(Number(ts));
  if (!isFinite(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtSchedule(ts) {
  const d = new Date(Number(ts));
  if (!isFinite(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 到点的「待开发」任务自动移入「正在开发」并开始执行 (看板打开期间每 5s 检查一次)
function runScheduledTasks() {
  const now = Date.now();
  const state = store.state;
  const due = [];
  for (const key of Object.keys(state.boards || {})) {
    for (const t of state.boards[key].tasks || []) {
      if (t.column === 'todo' && t.scheduledAt && Number(t.scheduledAt) <= now) due.push(t.id);
    }
  }
  for (const id of due) {
    patchTask(id, { scheduledAt: null });
    moveTask(id, 'doing', null);
    store.toast('⏰ 定时到点: 已移入「正在开发」');
  }
  return due;
}

// ── UI ──────────────────────────────────────────────────────────────────────
const h = React.createElement;

// ── 会话消息渲染 (debug-13) ──────────────────────────────────────────────────
// 事件内容块: 兼容两种 wire 形状 —
//   user/message: data.content 直接持有内容块
//   assistant/message / tool/result (现行日志): 内容块嵌套在 data.message.content
// (debug-16 修复: 只读 data.content 会让 AI 回答永远取不到文本, 详情页看不到助手消息)
function contentBlocksOf(event) {
  const data = event && event.data;
  if (!data) return [];
  if (Array.isArray(data.content)) return data.content;
  if (data.message && Array.isArray(data.message.content)) return data.message.content;
  return [];
}

// 事件第一个文本块 (折叠空白, 用于侧栏标签等单行场景); 无文本时返回 null
function firstTextOf(event) {
  const blocks = contentBlocksOf(event);
  const texts = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => collapseText(b.text)).filter((t) => t !== '');
  return texts.length ? texts.join(' ') : null;
}

// 事件全部文本块 (保留空白与换行, 供 Markdown 渲染; 折叠版会毁掉代码块等块级语法)
function fullTextOf(event) {
  const blocks = contentBlocksOf(event);
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => String(b.text).replace(/\r\n/g, '\n'))
    .filter((t) => t.trim() !== '')
    .join('\n\n');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeUrl(u) {
  return /^https?:\/\//i.test(u) ? u.replace(/"/g, '%22') : null;
}

// debug-21: 图片 URL 额外允许 data:image (剪贴板粘贴的图片以 dataURL 内联)
function safeImgUrl(u) {
  return /^(https?:\/\/|data:image\/)/i.test(u) ? u.replace(/"/g, '%22') : null;
}

function inlineMd(s) {
  return String(s == null ? '' : s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/!\[([^\]]*)\]\((\S+?)\)/g, (m, alt, url) => { const u = safeImgUrl(url); return u ? '<img alt="' + alt + '" src="' + u + '"/>' : m; })
    .replace(/\[([^\]]+)\]\((\S+?)\)/g, (m, label, url) => { const u = safeUrl(url); return u ? '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : m; });
}

// 极简 Markdown → HTML (会话消息渲染, 风格与主界面一致):
// 先摘出代码块/行内代码, 转义其余文本, 再做块级 (标题/列表/引用/分割线) 与行内转换, 最后还原占位符。
// 所有用户内容先转义再套样式, 链接/图片 URL 只允许 http(s), 无脚本注入面。
function mdToHtml(md) {
  const src = String(md == null ? '' : md).replace(/\r\n/g, '\n');
  if (!src.trim()) return '';
  const fences = [];
  const codes = [];
  let text = src;
  text = text.replace(/```([^\n]*)\n([\s\S]*?)(```|$)/g, (m, info, code) => {
    fences.push('<pre class="kb-md-code"><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>');
    return '\u0000F' + (fences.length - 1) + '\u0000';
  });
  text = text.replace(/`([^`\n]+)`/g, (m, c) => {
    codes.push('<code class="kb-md-inline">' + escapeHtml(c) + '</code>');
    return '\u0000C' + (codes.length - 1) + '\u0000';
  });
  text = escapeHtml(text);
  const out = [];
  let list = null;
  const para = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + inlineMd(para.join(' ')) + '</p>'); para.length = 0; } };
  const flushList = () => {
    if (!list) return;
    out.push('<' + list.tag + '>' + list.items.map((it) => '<li>' + it + '</li>').join('') + '</' + list.tag + '>');
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    // 独占一行的代码块占位符按块级处理 (避免 <pre> 落进 <p>)
    if (/^\u0000F\d+\u0000$/.test(line)) { flushPara(); flushList(); out.push(line); continue; }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) { flushPara(); flushList(); out.push('<h' + head[1].length + '>' + inlineMd(head[2]) + '</h' + head[1].length + '>'); continue; }
    if (/^([-*_])\s*(\1\s*){2,}$/.test(line)) { flushPara(); flushList(); out.push('<hr/>'); continue; }
    if (line.startsWith('&gt;')) { flushPara(); flushList(); out.push('<blockquote>' + inlineMd(line.replace(/^&gt;\s?/, '')) + '</blockquote>'); continue; }
    const ul = line.match(/^[-*+]\s+(.*)$/);
    if (ul) { flushPara(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(inlineMd(ul[1])); continue; }
    const ol = line.match(/^(\d+)[.)]\s+(.*)$/);
    if (ol) { flushPara(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(inlineMd(ol[2])); continue; }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join('').replace(/\u0000([FC])(\d+)\u0000/g, (m, kind, i) => (kind === 'F' ? fences[+i] : codes[+i]) || '');
}

function scrollToMsg(seq) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('kb-msg-' + seq);
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 判断事件是否为真正的用户输入 (user/message 且 source.kind === 'user')
// 注入的上下文 (AGENTS.md 指令/目录/快照等) 的 source.kind === 'plugin', 不算用户输入
function isRealUserInput(event) {
  return !!event && event.type === 'user/message'
    && !!(event.data && event.data.source && event.data.source.kind === 'user');
}

// user/message 的来源标签: 真用户 → 👤 用户; 插件注入 → 按 form 给语义标签 + 插件名
function userMessageLabel(event) {
  const source = event && event.data && event.data.source;
  if (!source || source.kind === 'user') return null;
  if (source.kind === 'plugin') {
    const forms = {
      instructions: '📄 指令', catalog: '📚 目录', snapshot: '📸 快照',
      notice: '🔔 通知', relay: '🔁 转发', recall: '🧠 回溯',
    };
    const base = (source.form && forms[source.form]) || '⚙️ 注入';
    return base + (source.plugin ? ' · ' + source.plugin : '');
  }
  return '⚙️ ' + String(source.kind);
}

// 单条会话事件 → 消息块 (仅渲染带文本的消息/思考事件; 工具等事件跳过)
function renderSessionEvent(event, index) {
  if (!event) return null;
  const seq = typeof event.seq === 'number' ? event.seq : 'i' + index;
  const text = fullTextOf(event);
  if (!text) return null;
  const isUser = event.type === 'user/message';
  const isThought = event.type === 'assistant/thought';
  const isAssistant = event.type === 'assistant/message';
  if (!isUser && !isAssistant && !isThought) return null;
  const realUser = isRealUserInput(event);
  const injectedLabel = isUser && !realUser ? userMessageLabel(event) : null;
  const label = isUser ? (realUser ? '👤 用户' : injectedLabel || '⚙️ 注入') : isThought ? '💭 思考' : '🤖 助手';
  const labelColor = realUser ? TK.business : isUser ? TK.text3 : isThought ? TK.text3 : TK.success;
  // 注入的上下文消息置灰, 与真正的用户/助手消息区分
  const dim = isThought || (isUser && !realUser);
  return h('div', { key: String(seq), id: 'kb-msg-' + seq, style: msgBlockStyle(dim) },
    h('div', { style: { fontSize: 11, fontWeight: 600, color: labelColor } }, label),
    h('div', { className: 'kb-md', dangerouslySetInnerHTML: { __html: mdToHtml(text) } }),
  );
}

function msgBlockStyle(dim) {
  return {
    border: '1px solid ' + TK.border, background: TK.bgL2, borderRadius: 10,
    padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
    ...(dim ? { opacity: 0.88 } : {}),
  };
}

function useStore() {
  // 第三个参数 getServerSnapshot 仅用于 SSR/水合, 浏览器端不会被调用; 加上它便于
  // react-dom/server 渲染测试 (无它 SSR 会直接报错)。
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function KanbanToggle(props) {
  const wide = props && props.wide;
  const snap = useStore();
  return h('button', {
    className: 'kb-row',
    style: kanbanBtnStyle(wide),
    onClick: () => {
      console.log('[kanban] toggle click → open=' + store.open);
      store.setOpen(!store.open);
    },
    title: '任务看板',
  }, wide ? (snap.open ? '📋 关闭看板' : '📋 任务看板') : '📋');
}

function kanbanBtnStyle() {
  return {
    display: 'flex', alignItems: 'center', gap: 6, width: '100%', boxSizing: 'border-box',
    padding: '6px 12px', margin: '2px 0', borderRadius: 8, cursor: 'pointer',
    border: 'none', color: TK.text,
    fontSize: 13, textAlign: 'left',
  };
}

// debug-18: 按下目标是否在"保护区" (详情栏/卡片/分隔条) 内 — 在保护区内按下就不算外部点击,
// 拖到外面释放也不关闭详情栏; 只有按下发生在保护区之外才算"点击外面"
function shouldCloseOnPress(target) {
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest('.kb-detail') || target.closest('.kb-card') || target.closest('.kb-resizer')) return false;
  return true;
}

function KanbanBoard() {
  const snap = useStore();
  // debug-19: 看板打开期间每 5s 用 sessions.list 对账 running 状态 —
  // 宿主流断线漏掉完成帧时, 主会话完成照样自动移入「待审核」(裸 setTimeout 与弹层轮询同款;
  // SSR 冒烟不执行 effect, 生产环境随组件卸载自动清理)。effect 必须在 early return 之前, 保证 hook 顺序稳定。
  React.useEffect(() => {
    if (!snap.open) return;
    let alive = true;
    let timer = null;
    // debug-21: 打开即检查一次定时任务 (关看板期间到点的任务补移), 之后每 5s 随对账一起检查
    runScheduledTasks();
    const tick = () => {
      if (!alive) return;
      fetchSessionInfo().then(() => {
        runScheduledTasks();
        if (alive) timer = setTimeout(tick, 5000);
      });
    };
    timer = setTimeout(tick, 5000);
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // snap.open 变化时重建轮询 (看板关闭即停止)
  }, [snap.open]);
  if (!snap.open) return null;
  const state = snap.state;
  const tasks = activeBoard(state).tasks;
  const byColumn = {};
  for (const c of COLUMNS) byColumn[c.key] = [];
  for (const t of tasks) (byColumn[t.column] || byColumn.todo).push(t);
  const warn = store.saveWarn;
  const selHit = snap.selected ? findTask(state, snap.selected) : null;
  const selectedTask = selHit ? selHit.task : null;
  const sizes = snap.sizes;
  return h('div', { className: 'kb-board', style: boardStyle() },
    h('div', { style: headerStyle() },
      h('span', { style: { fontWeight: 600, fontSize: 15, color: TK.text } }, '📋 任务看板'),
      h('span', { style: { fontSize: 12, color: TK.text3, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        '拖到「正在开发」即启动 agent; 完成自动进「待审核」; 提问自动进「阻塞」; 点卡片看详情'),
      h('button', { className: 'kb-ghost', style: closeBtnStyle(), onClick: () => { store.setOpen(false); } }, '✕ 关闭'),
    ),
    warn ? h('div', { style: warnStyle() }, '⚠ ' + warn) : null,
    // debug-21: 轻提示 (绑定冲突 / 设置保存 / Jira 结果 / 定时到点 等)
    snap.toast ? h('div', { className: 'kb-toast', style: toastStyle() }, snap.toast.text) : null,
    h('div', {
      style: boardBodyStyle(),
      // debug-18: 记录按下目标 (capture) — 按下/释放跨元素时 click 会落在公共祖先上,
      // 必须按"按下发生在哪里"判断是否外部点击, 否则在详情栏内按下拖到外面释放会误关详情栏
      onMouseDownCapture: (e) => { lastPressTarget = e && e.target ? e.target : null; },
      // debug-14: 点击右侧详情栏以外的区域自动关闭详情栏 (卡片点击由卡片自己的处理器接管选择)
      onClick: (e) => {
        const target = lastPressTarget || (e && e.target);
        lastPressTarget = null;
        if (!shouldCloseOnPress(target)) return;
        store.setSelected(null);
        store.setDetailSid(null);
      },
    },
      h('div', { style: { ...leftSidebarStyle(), width: sizes.left } },
        h(WorkspaceSidebar, {}),
      ),
      h(ResizeHandle, { side: 'left', min: 160, max: 480 }),
      h('div', { style: columnsRowStyle() },
        COLUMNS.map((c) => h(KanbanColumn, { key: c.key, column: c, tasks: byColumn[c.key] })),
      ),
      selectedTask ? h(ResizeHandle, { side: 'right', min: 240, max: rightMax() }) : null,
      selectedTask ? h(TaskDetail, { key: selectedTask.id, task: selectedTask, width: sizes.right }) : null,
    ),
    // 新建任务完整创建框 (打开状态渲染在最高层)
    snap.createDialog && snap.createDialog.open ? h(TaskCreateDialog, {}) : null,
    // debug-21: 看板设置弹窗 (左下角 ⚙ 设置 打开)
    snap.settingsOpen ? h(SettingsDialog, {}) : null,
  );
}

function leftSidebarStyle() {
  return {
    flex: 'none', height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    borderRadius: 12, background: TK.sidebar,
    border: '1px solid ' + TK.border, padding: 8,
    display: 'flex', flexDirection: 'column', gap: 4,
  };
}

// 拖拽手柄: 按住拖动调整相邻侧栏宽度, 松手持久化 (带记忆)
function ResizeHandle(props) {
  return h('div', {
    className: 'kb-resizer',
    onMouseDown: (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startSize = props.side === 'left' ? data.sizes.left : data.sizes.right;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const next = props.side === 'left' ? startSize + dx : startSize - dx;
        store.setSizes({ ...data.sizes, [props.side]: clamp(next, props.min, props.max) });
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        store.set({ ...store.state, sizes: { ...data.sizes } });
        persist();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    title: '拖动调整宽度',
    style: {
      width: 4, flex: 'none', cursor: 'col-resize', alignSelf: 'stretch',
      background: 'var(--dsw-alias-border-l3, rgba(255,255,255,.16))', borderRadius: 2,
    },
  });
}

// 左侧工作区栏: 默认看板 + 宿主全部工作区 (与主界面侧栏一致)
// 行样式对齐主界面 workspace row: 34px 高 / 圆角 8 / hover 填充 / 14px 标题。
// 注意: hover 背景走 CSS (.kb-row:hover), 行内 background 会压过 CSS hover,
// 所以只有 active 行才写行内背景。
function workspaceRowStyle(active) {
  return {
    display: 'flex', alignItems: 'center', gap: 6, height: 34, boxSizing: 'border-box',
    padding: '0 8px', borderRadius: 8, cursor: 'pointer', userSelect: 'none',
    color: TK.text,
    ...(active ? { background: TK.navActive } : {}),
  };
}

function WorkspaceSidebar() {
  const snap = useStore();
  const workspaces = snap.workspaces || [];
  const active = snap.state.activeBoard || DEFAULT_BOARD_KEY;
  const defaultBoard = boardOf(snap.state, DEFAULT_BOARD_KEY);
  const rows = [
    { key: DEFAULT_BOARD_KEY, icon: '🗂', title: '默认 (未分组)', path: boardFallbackCwd(defaultBoard) || '未指定 (由宿主决定)' },
    ...workspaces.map((w) => ({ key: w.workspaceId, icon: '📁', title: w.title || '未命名工作区', path: w.path })),
  ];
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0, flex: 1 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, height: 36, padding: '0 4px', boxSizing: 'border-box' } },
      h('span', { style: { flex: 1, fontSize: 12, fontWeight: 600, color: TK.text3 } }, '工作区'),
      h('button', { className: 'kb-iconbtn', style: iconBtnStyle(), onClick: fetchWorkspaces, title: '刷新工作区列表 (与主界面同步)' }, '↻'),
    ),
    rows.map((r) => h('div', {
      key: r.key,
      className: 'kb-row',
      onClick: () => switchBoard(r.key),
      title: r.path,
      style: workspaceRowStyle(active === r.key),
    },
      h('span', { style: { flex: 'none', width: 16, textAlign: 'center', fontSize: 13, lineHeight: '20px', color: active === r.key ? TK.business : TK.text3 } }, r.icon),
      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, lineHeight: '20px', fontWeight: active === r.key ? 600 : 400 } }, r.title),
    )),
    // debug-21: 工作区左下角设置按钮 (固定钉在侧栏底部)
    h('div', { style: { marginTop: 'auto', paddingTop: 6, borderTop: '1px solid ' + TK.border } },
      h('div', {
        className: 'kb-row',
        style: workspaceRowStyle(false),
        title: '看板设置 (Jira 配置等)',
        onClick: () => store.setSettingsOpen(true),
      },
        h('span', { style: { flex: 'none', width: 16, textAlign: 'center', fontSize: 13, lineHeight: '20px', color: TK.text3 } }, '⚙'),
        h('span', { style: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: '20px' } }, '设置'),
      ),
    ),
  );
}

function iconBtnStyle() {
  return {
    flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, border: 'none', borderRadius: '50%', padding: 0,
    cursor: 'pointer', color: TK.text2, fontSize: 13,
  };
}

function boardBodyStyle() {
  return { display: 'flex', gap: 12, padding: 12, flex: 'auto', minHeight: 0, alignItems: 'stretch' };
}

function boardStyle() {
  return {
    position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', flexDirection: 'column',
    background: TK.bgBase, color: TK.text, fontFamily: TK.font, overflow: 'hidden',
    // 看板是高程表面, 滚动条换用 l2 色阶 (与主界面菜单/弹层一致)
    '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2, var(--dsw-alias-scrollbar-bg-l1))',
    '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2, var(--dsw-alias-scrollbar-hover-l1))',
  };
}
function headerStyle() {
  return {
    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', flex: 'none',
    borderBottom: '1px solid ' + TK.border,
  };
}
function closeBtnStyle() {
  return {
    marginLeft: 'auto', padding: '4px 12px', borderRadius: 8, cursor: 'pointer',
    border: '1px solid ' + TK.border,
    color: TK.text, fontSize: 13,
  };
}
function warnStyle() {
  return { padding: '4px 16px', fontSize: 12, color: TK.warnLabel, background: TK.warnTert, flex: 'none' };
}
// debug-21: 轻提示 (顶部居中浮动, 不挡操作, 自动消退)
function toastStyle() {
  return {
    position: 'fixed', top: 58, left: '50%', transform: 'translateX(-50%)', zIndex: 10006,
    maxWidth: '72vw', boxSizing: 'border-box', padding: '8px 16px', borderRadius: 10,
    background: TK.bgL2, border: '1px solid ' + TK.border, color: TK.text, fontSize: 13, lineHeight: '18px',
    boxShadow: '0 10px 28px rgba(0,0,0,.45)', wordBreak: 'break-word',
  };
}
function columnsRowStyle() {
  return { display: 'flex', gap: 12, flex: 'auto', minWidth: 0, overflowX: 'auto', alignItems: 'flex-start' };
}

function KanbanColumn(props) {
  const column = props.column;
  const tasks = props.tasks;
  const [hover, setHover] = React.useState(false);
  const [title, setTitle] = React.useState('');
  // debug-21: 点「＋ 添加」(或回车) 直接创建任务并打开右侧详情面板 (不再弹创建框)
  const openCreate = () => {
    const created = addTask((title || '').trim() || '新建任务', '');
    if (created) store.setSelected(created.id);
    setTitle('');
  };
  const addForm = column.key === 'todo' ? h('div', { style: addFormStyle() },
    h('input', {
      style: inputStyle(), placeholder: '任务标题 (回车或点 ＋ 添加, 直接打开详情)',
      value: title, onChange: (e) => setTitle(e.target.value),
      onKeyDown: (e) => { if (e.key === 'Enter') openCreate(); },
    }),
    h('button', { className: 'kb-primary', style: addBtnStyle(), onClick: openCreate }, '＋ 添加'),
  ) : null;
  return h('div', {
    style: columnStyle(hover),
    onDragOver: (e) => { e.preventDefault(); setHover(true); },
    onDragLeave: () => setHover(false),
    onDrop: (e) => {
      e.preventDefault(); setHover(false);
      const id = dragId;
      dragId = null;
      if (!id) return;
      handleDrop(id, column.key);
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 2px 8px' } },
      h('span', { style: { fontWeight: 600, fontSize: 13, color: TK.text2 } }, COLUMN_LABEL[column.key]),
      h('span', { style: { fontSize: 11, lineHeight: '16px', padding: '0 6px', borderRadius: 8, background: TK.hover, color: TK.text3 } }, String(tasks.length)),
    ),
    addForm,
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      tasks.map((t) => h(KanbanCard, { key: t.id, task: t, column: column.key })),
    ),
  );
}

function handleDrop(taskId, toColumn) {
  const hit = findTask(store.state, taskId);
  if (!hit) return;
  if (toColumn === hit.task.column) return;
  moveTask(taskId, toColumn, null);
}

function columnStyle(hover) {
  return {
    flex: 'none', width: 280, maxHeight: '100%', overflowY: 'auto',
    background: TK.bgL1,
    border: hover ? '1px solid ' + TK.business : '1px solid ' + TK.border,
    borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
  };
}
function addFormStyle() {
  return { display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 8, borderBottom: '1px solid ' + TK.border, marginBottom: 4 };
}
function inputStyle() {
  return { padding: '7px 10px', borderRadius: 8, border: '1px solid ' + TK.border, background: 'transparent', color: 'inherit', fontSize: 13, lineHeight: '18px' };
}
function textareaStyle() {
  return { padding: '7px 10px', borderRadius: 8, border: '1px solid ' + TK.border, background: 'transparent', color: 'inherit', fontSize: 12, lineHeight: '18px', minHeight: 48, resize: 'vertical', fontFamily: 'inherit' };
}
function addBtnStyle() {
  return { padding: '5px 12px', borderRadius: 8, cursor: 'pointer', border: 'none', color: '#fff', fontSize: 13, lineHeight: '18px' };
}

function KanbanCard(props) {
  const task = props.task;
  const column = props.column;
  const [feedback, setFeedback] = React.useState('');
  const [showFeedback, setShowFeedback] = React.useState(false);
  const [answer, setAnswer] = React.useState('');

  const actions = cardActions(task, column, {
    setShowFeedback, setFeedback, feedback, answer, setAnswer,
  });

  const badge = task.sessionId
    ? h('div', { style: { fontSize: 11, color: TK.text3 } },
        '会话: ' + short(task.sessionId))
    : null;

  const block = task.blockKind
    ? h('div', { style: blockStyle(task.blockKind) },
        h('div', { style: { fontSize: 12, fontWeight: 600 } },
          task.blockKind === 'question' ? '❓ 等待你的回答' : '🛡 等待审批'),
        h('div', { style: { fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, task.blockText || ''),
        task.blockKind === 'question' ? h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
          h('input', { style: { ...inputStyle(), flex: 1 }, placeholder: '在这里回答…', value: answer, onChange: (e) => setAnswer(e.target.value) }),
          h('button', { className: 'kb-primary', style: addBtnStyle(), onClick: () => { answerQuestion(task, answer); setAnswer(''); } }, '回答')) : null,
        task.blockKind === 'approval' ? h('div', { style: { fontSize: 11, color: TK.text3, marginTop: 6 } },
          '请到该任务会话中批准') : null,
      )
    : null;

  const lastError = task.lastError
    ? h('div', { style: { fontSize: 11, color: TK.error, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } },
        '⚠ ' + (task.lastErrorAt ? new Date(task.lastErrorAt).toLocaleTimeString() + ' ' : '')
        + (task.lastError.length > 220 ? task.lastError.slice(0, 220) + '…' : task.lastError))
    : null;

  const feedbackForm = showFeedback ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } },
    h('textarea', { style: textareaStyle(), placeholder: '修改意见(可选)', value: feedback, onChange: (e) => setFeedback(e.target.value) }),
    h('button', { className: 'kb-primary', style: addBtnStyle(), onClick: () => { moveTask(task.id, 'doing', feedback); setShowFeedback(false); setFeedback(''); } }, '打回修改'),
  ) : null;

  return h('div', {
    className: 'kb-card',
    draggable: true,
    onDragStart: () => { dragId = task.id; dragJustEnded = false; },
    onDragEnd: () => { dragId = null; dragJustEnded = true; setTimeout(() => { dragJustEnded = false; }, 50); },
    onClick: () => { if (!dragJustEnded) store.setSelected(task.id); },
    title: '点击查看详情, 拖动移动列',
    style: cardStyle(column),
  },
    // 左侧状态色条 (列颜色)
    h('div', { style: { position: 'absolute', left: 0, top: 10, bottom: 10, width: 3, borderRadius: 2, background: COLUMN_ACCENT[column] || TK.text3 } }),
    h('div', { style: { fontWeight: 600, fontSize: 14, lineHeight: '20px', wordBreak: 'break-word' } }, task.title),
    // debug-21: 卡片描述去掉 Markdown 符号显示纯文本 (完整 Markdown 渲染在详情面板)
    (function () {
      const plain = mdPlain(task.description);
      return plain ? h('div', { style: { fontSize: 12, lineHeight: '18px', color: TK.text2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, truncate(plain, 200)) : null;
    })(),
    task.scheduledAt ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: TK.warnLabel } }, '⏰ 定时 ' + fmtSchedule(task.scheduledAt)) : null,
    badge, block, lastError, feedbackForm,
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 } }, actions),
  );
}

function cardActions(task, column, ui) {
  const items = [];
  if (column === 'todo') {
    items.push(btn('▶ 开始开发', () => moveTask(task.id, 'doing', null)));
  } else if (column === 'doing') {
    items.push(btn('→ 移到待审核', () => moveTask(task.id, 'review', null)));
  } else if (column === 'blocked') {
    items.push(btn('→ 移到待审核', () => moveTask(task.id, 'review', null)));
  } else if (column === 'review') {
    items.push(btn('✔ 通过', () => moveTask(task.id, 'done', null)));
    items.push(btn('↩ 打回', () => ui.setShowFeedback(!ui.showFeedback)));
  } else if (column === 'done') {
    items.push(btn('↩ 重新打开', () => moveTask(task.id, 'todo', null)));
  }
  // 删除按钮任何列都有, 卡住的旧卡随时能清掉
  items.push(btn('🗑 删除', () => deleteTask(task.id), true));
  return items;
}

function btn(label, onClick, danger) {
  return h('button', {
    key: label,
    className: danger ? 'kb-danger' : 'kb-ghost',
    style: {
      padding: '3px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12, lineHeight: '18px',
      border: '1px solid ' + TK.border,
      color: danger ? TK.error : TK.text,
    },
    onClick,
  }, label);
}

function cardStyle() {
  return {
    position: 'relative', background: TK.bgL2, borderRadius: 10,
    padding: '10px 10px 10px 15px', cursor: 'grab',
    border: '1px solid ' + TK.border,
    display: 'flex', flexDirection: 'column', gap: 6,
  };
}
function blockStyle(kind) {
  const q = kind === 'question';
  return {
    borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 4,
    background: q ? TK.businessTert : TK.warnTert,
    border: '1px solid ' + (q ? TK.business : TK.warn),
  };
}

// ── 任务详情面板 (右侧) ─────────────────────────────────────────────────────
function detailPanelStyle(width) {
  return {
    flex: 'none', width: width || 460, height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    borderRadius: 12, border: '1px solid ' + TK.border,
    background: TK.bgL1, padding: 12,
    display: 'flex', flexDirection: 'column', gap: 8,
  };
}
function descReadStyle() {
  return {
    fontSize: 12, lineHeight: '18px', color: TK.text2, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    background: TK.hover, borderRadius: 8, padding: '8px 10px', minHeight: 40,
  };
}
function bindPanelStyle() {
  return {
    display: 'flex', flexDirection: 'column', gap: 6, padding: 8,
    background: TK.bgL2, border: '1px solid ' + TK.border, borderRadius: 8,
  };
}
function sectionTitleStyle() {
  return { fontSize: 12, fontWeight: 600, color: TK.text2, marginTop: 6 };
}
function emptyHintStyle() {
  return { fontSize: 12, color: TK.text3 };
}
function sessionRowStyle() {
  return { display: 'flex', alignItems: 'center', gap: 6, background: TK.hover, borderRadius: 8, padding: '5px 10px' };
}
function badgeStyle(running) {
  return {
    flex: 'none', fontSize: 10, lineHeight: '14px', padding: '1px 6px', borderRadius: 8,
    background: running ? TK.businessTert : TK.successTert,
    color: running ? TK.business : TK.success,
  };
}
function miniBtnStyle() {
  return {
    flex: 'none', fontSize: 11, padding: '2px 8px', borderRadius: 8, cursor: 'pointer',
    border: '1px solid ' + TK.border,
    color: TK.text,
  };
}
function commentStyle() {
  return { background: TK.hover, borderRadius: 8, padding: '8px 10px' };
}

// 相关会话行: 第一行 = 标题 + 状态徽章 + 操作; 第二行 = 最新提问 (裁剪) + 上下文大小
function SessionRow(props) {
  const meta = store.sessionMeta.get(props.sid);
  const running = !!(meta && meta.running);
  const info = props.info || {};
  const title = info.title || short(props.sid);
  const lastPrompt = info.lastPromptText || null;
  const context = info.context && info.context.used != null
    ? '~' + fmtTokens(info.context.used)
      + (info.context.window != null ? ' / ' + fmtTokens(info.context.window) : '')
    : null;
  const [compacting, setCompacting] = React.useState(false);
  const [compactError, setCompactError] = React.useState(null);
  const doCompact = () => {
    if (compacting) return;
    setCompacting(true);
    setCompactError(null);
    // debug-15: 压缩成功后自动重拉上下文占用 (sessions.list 投影)
    compactSessionAndRefresh(props.sid).then((err) => {
      setCompacting(false);
      if (err) setCompactError(err);
    });
  };
  const showBottom = lastPrompt !== null || context !== null;
  return h('div', {
    className: 'kb-row',
    style: { ...sessionRowStyle(), flexDirection: 'column', alignItems: 'stretch' },
    title: '单击查看会话详情, 双击在主界面打开',
    onClick: () => { if (typeof props.onDetail === 'function') props.onDetail(props.sid); },
    // debug-21: 双击 = 「🔗 打开」按钮 (关闭看板并跳转主界面该会话)
    onDoubleClick: () => { if (typeof props.onJump === 'function') props.onJump(props.sid); },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 600 } }, title),
      running ? h('span', { style: badgeStyle(true) }, '运行中') : null,
      props.isMain ? h('span', { style: badgeStyle(false) }, '主') : null,
      h('button', { className: 'kb-ghost', style: miniBtnStyle(), title: '压缩该会话上下文 (/compact)', onClick: (e) => { e.stopPropagation(); doCompact(); }, disabled: compacting }, compacting ? '压缩中…' : '压缩'),
      props.isMain
        ? null
        : (typeof props.onMakeMain === 'function'
            ? h('button', { className: 'kb-ghost', style: miniBtnStyle(), title: '设为主会话 (后续默认在这个会话上继续工作)', onClick: (e) => { e.stopPropagation(); props.onMakeMain(props.sid); } }, '设为主')
            : null),
      h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: (e) => { e.stopPropagation(); try { navigator.clipboard && navigator.clipboard.writeText(props.sid); } catch (err) {} } }, '复制'),
      typeof props.onJump === 'function'
        ? h('button', { className: 'kb-ghost', style: miniBtnStyle(), title: '关闭看板并在主界面打开该会话', onClick: (e) => { e.stopPropagation(); props.onJump(props.sid); } }, '🔗 打开')
        : null,
      typeof props.onUnbind === 'function'
        ? h('button', { className: 'kb-ghost', style: { ...miniBtnStyle(), color: TK.error }, title: '解绑会话 (不影响会话本身)', onClick: (e) => { e.stopPropagation(); props.onUnbind(props.sid); } }, '解绑')
        : null,
    ),
    showBottom ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, marginTop: 2 } },
      lastPrompt !== null
        ? h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, lineHeight: '16px', color: TK.text3 } }, lastPrompt)
        : h('span', { style: { flex: 1 } }),
      context !== null
        ? h('span', { style: { flex: 'none', fontSize: 11, lineHeight: '16px', color: TK.text3, fontVariantNumeric: 'tabular-nums' } }, context)
        : null,
    ) : null,
    compactError
      ? h('span', { style: { fontSize: 11, color: TK.error, wordBreak: 'break-all' } }, '⚠ ' + compactError)
      : null,
  );
}

// ── 会话详情弹层 (debug-13): 大号会话视图, 尽量与主界面风格一致 ─────────────
// 头部: 标题 / 运行状态 / 压缩·复制 id·解绑·刷新·关闭
// 左侧: 用户问题标签栏 (点击滚动到右侧对应消息)
// 右侧: 完整消息历史, Markdown 渲染 (用户/助手/思考; debug-15 起隐藏系统注入的指令)
// 底部: 与主界面 composer 一致 — 状态栏 + 自适应输入框 + 工具条 (⊕ 指令 / 模型选择 / 启停)
function sessionPopupStyle() {
  return {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
    // debug-14: 占屏幕 75%
    zIndex: 10001, width: '75vw', height: '75vh',
    background: TK.bgL1, border: '1px solid ' + TK.border, borderRadius: 14,
    boxShadow: '0 16px 48px rgba(0,0,0,.45)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  };
}
// debug-16: 弹层下方全屏透明遮罩 (点击弹层以外关闭; 弹层 zIndex 10001 在遮罩之上)
function popMaskStyle() {
  return { position: 'fixed', inset: 0, zIndex: 10000, background: 'transparent' };
}
function sessionPopupHeaderStyle() {
  return { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', flex: 'none', borderBottom: '1px solid ' + TK.border };
}
function sessionPopupBodyStyle() {
  return { display: 'flex', flex: 'auto', minHeight: 0, alignItems: 'stretch' };
}
function sessionPopupSidebarStyle() {
  return {
    flex: 'none', width: 236, overflowY: 'auto', boxSizing: 'border-box', padding: 10,
    background: TK.sidebar, borderRight: '1px solid ' + TK.border,
    display: 'flex', flexDirection: 'column', gap: 4,
  };
}
function sessionPopupContentStyle() {
  return { flex: 1, minWidth: 0, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 };
}
function sessionPopupFooterStyle() {
  return { display: 'flex', alignItems: 'flex-end', gap: 8, padding: '10px 14px', flex: 'none', borderTop: '1px solid ' + TK.border };
}
function questionTabStyle(active) {
  return {
    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 8,
    cursor: 'pointer', userSelect: 'none', fontSize: 12, lineHeight: '17px', color: TK.text,
    ...(active ? { background: TK.navActive } : {}),
  };
}

// ── debug-15: 底部工具条样式 (状态栏 / ⊕ 指令 / 模型选择 / 弹出菜单) ──────────
function statusBarStyle() {
  return {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 14px',
    fontSize: 11, lineHeight: '16px', color: TK.text2, padding: '2px 2px 0', minWidth: 0,
  };
}
function toolBtnStyle() {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none',
    padding: '4px 10px', borderRadius: 8, cursor: 'pointer',
    fontSize: 12, lineHeight: '18px', border: '1px solid ' + TK.border, color: TK.text2,
  };
}
function popMenuStyle() {
  return {
    position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 10005,
    minWidth: 260, maxWidth: 400, maxHeight: 300, overflowY: 'auto', boxSizing: 'border-box',
    background: TK.bgL2, border: '1px solid ' + TK.border, borderRadius: 10,
    boxShadow: '0 10px 28px rgba(0,0,0,.45)', padding: 6,
    display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left',
  };
}
function menuTitleStyle() {
  return { fontSize: 11, fontWeight: 600, color: TK.text3, padding: '2px 8px 4px' };
}
function menuGroupStyle() {
  return { fontSize: 11, color: TK.text3, padding: '6px 8px 2px' };
}
function menuItemStyle(selected) {
  return {
    display: 'flex', alignItems: 'center', gap: 4, width: '100%', boxSizing: 'border-box',
    padding: '5px 8px', borderRadius: 7, cursor: 'pointer', border: 'none',
    color: selected ? TK.business : TK.text, fontSize: 12, lineHeight: '17px', textAlign: 'left',
    ...(selected ? { background: TK.businessTert } : {}),
  };
}

function SessionDetailPopup(props) {
  const snap = useStore();
  const info = snap.sessionInfo[props.sid] || {};
  const history = snap.histories[props.sid] || null;
  const meta = store.sessionMeta.get(props.sid);
  const running = !!(meta && meta.running);
  const [activeSeq, setActiveSeq] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState(null);
  const [compacting, setCompacting] = React.useState(false);
  const [compactError, setCompactError] = React.useState(null);
  // debug-15: 底部工具条状态 (模型目录 / 指令菜单 / 停止 / 工具条错误)
  const [modelState, setModelState] = React.useState({ status: 'idle', current: null, groups: [], failures: [], error: null });
  const [modelOpen, setModelOpen] = React.useState(false);
  const [commands, setCommands] = React.useState([]);
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [cmdStatus, setCmdStatus] = React.useState(null);
  const [stopping, setStopping] = React.useState(false);
  const [toolError, setToolError] = React.useState(null);
  const refreshRef = React.useRef(null);
  const inputRef = React.useRef(null);

  // 底部输入框随内容自适应高度 (上限 180px), 清空/发送后回落
  const growInput = (el) => {
    if (!el || !el.style) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  };
  React.useEffect(() => { growInput(inputRef.current); }, [draft]);

  // 打开即拉全量历史; 会话运行中每 2s 轮询 (上限 45 次) 直到停止
  React.useEffect(() => {
    let alive = true;
    let timer = null;
    let polls = 0;
    const refresh = () => {
      if (!alive) return;
      fetchSessionHistory(props.sid).then(() => {
        if (!alive) return;
        const m = store.sessionMeta.get(props.sid);
        if (m && m.running && polls < 45) {
          polls += 1;
          timer = setTimeout(refresh, 2000);
        }
      });
    };
    refreshRef.current = refresh;
    refresh();
    return () => { alive = false; if (timer) clearTimeout(timer); refreshRef.current = null; };
  }, [props.sid]);

  // debug-15: 打开即拉模型目录 (与主界面模型选择同源: session.models)
  React.useEffect(() => {
    let alive = true;
    fetchSessionModels(props.sid).then((dir) => {
      if (!alive) return;
      if (dir) {
        setModelState({
          status: 'ready',
          current: dir.current || null,
          groups: Array.isArray(dir.groups) ? dir.groups : [],
          failures: Array.isArray(dir.failures) ? dir.failures : [],
          error: null,
        });
      } else {
        setModelState((s) => ({ ...s, status: 'error', error: '无法加载模型目录' }));
      }
    });
    return () => { alive = false; };
  }, [props.sid]);

  const doCompact = () => {
    if (compacting) return;
    setCompacting(true);
    setCompactError(null);
    // debug-15: 压缩成功后自动重拉上下文占用 (sessions.list 投影) 与历史
    compactSessionAndRefresh(props.sid).then((err) => {
      setCompacting(false);
      if (err) setCompactError(err);
    });
  };

  const doSend = () => {
    const text = (draft || '').trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    sendPrompt(props.sid, text).then((err) => {
      setSending(false);
      if (err) { setSendError(err); return; }
      setDraft('');
      if (refreshRef.current) refreshRef.current();
      delay(2500).then(() => { if (refreshRef.current) refreshRef.current(); });
    });
  };

  // debug-15: 停止生成 (与主界面启停按钮同路径: session.cancel)
  const doStop = () => {
    if (stopping) return;
    setStopping(true);
    setToolError(null);
    cancelSession(props.sid).then((err) => {
      setStopping(false);
      if (err) { setToolError(err); return; }
      delay(1200).then(() => { if (refreshRef.current) refreshRef.current(); });
    });
  };

  // debug-15: 模型目录菜单 (触发即重拉, 与主界面行为一致; 失败项不可选)
  const openModels = () => {
    setCmdOpen(false);
    setModelOpen(!modelOpen);
    fetchSessionModels(props.sid).then((dir) => {
      if (!dir) return;
      setModelState({
        status: 'ready',
        current: dir.current || null,
        groups: Array.isArray(dir.groups) ? dir.groups : [],
        failures: Array.isArray(dir.failures) ? dir.failures : [],
        error: null,
      });
    });
  };
  const chooseModel = (g, m) => {
    setModelOpen(false);
    setToolError(null);
    selectSessionModel(props.sid, g.id, m.id).then((r) => {
      if (r && r.ok) setModelState((s) => ({ ...s, current: r.selected || { provider: g.id, model: m.id } }));
      else setToolError((r && r.error) || '模型切换失败');
    });
  };

  // debug-15: 指令菜单 (与主界面 ⊕ 同语义: 带参数的指令补全到输入框, bare 指令立即执行)
  const openCommands = () => {
    setModelOpen(false);
    setCmdOpen(!cmdOpen);
    if (!cmdOpen && commands.length === 0) {
      fetchSessionCommands(props.sid).then((list) => setCommands(Array.isArray(list) ? list : []));
    }
  };
  const pickCommand = (c) => {
    setCmdOpen(false);
    if (!c) return;
    if (c.input && typeof c.input.hint === 'string') {
      // 带参数指令: 把 /name  补全进输入框, 由用户补参数后发送
      const token = '/' + c.name + ' ';
      const next = draft + (draft && !/\s$/.test(draft) ? ' ' : '') + token;
      setDraft(next);
      delay(0).then(() => { if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus(); });
    } else {
      // bare 指令: 立即执行, 完成后刷新历史
      setCmdStatus('执行 /' + c.name + ' …');
      setToolError(null);
      runSessionCommand(props.sid, '/' + c.name).then((err) => {
        if (err) { setCmdStatus('⚠ ' + err); return; }
        setCmdStatus(null);
        delay(800).then(() => { if (refreshRef.current) refreshRef.current(); });
      });
    }
  };

  const title = info.title || short(props.sid);
  const context = info.context && info.context.used != null ? info.context : null;
  const percent = context && context.window != null
    ? Math.min(100, Math.round(context.used / context.window * 100))
    : null;

  // 左侧问题标签: 只列**真正的用户输入** (source.kind==='user'; 插件注入的上下文不算)
  const entries = history && Array.isArray(history.entries) ? history.entries : null;
  // debug-15: 主区域不显示系统注入的指令 (system-reminder, AGENTS.md 等), AI 回答不受影响
  const visibleEntries = entries
    ? entries.filter((entry) => !isInjectedInstruction(entry && entry.event))
    : null;
  const hiddenInjected = entries ? entries.length - visibleEntries.length : 0;
  const assistantCount = entries
    ? entries.filter((entry) => entry && entry.event && entry.event.type === 'assistant/message').length
    : 0;
  const questions = [];
  if (entries) {
    for (const entry of entries) {
      const e = entry && entry.event;
      if (!isRealUserInput(e)) continue;
      const text = firstTextOf(e);
      if (text == null) continue;
      questions.push({ seq: typeof e.seq === 'number' ? e.seq : null, text });
    }
  }

  const content = visibleEntries === null
    ? (history && history.error
        ? h('div', { style: emptyHintStyle() }, '⚠ 历史加载失败: ' + history.error
            + ' — 点「刷新」重试')
        : h('div', { style: emptyHintStyle() }, '⏳ 正在加载会话历史…'))
    : (visibleEntries.length
        ? visibleEntries.map((entry, i) => renderSessionEvent(entry.event, i))
        : h('div', { style: emptyHintStyle() }, '暂无消息 — 在下方输入框发送第一条消息'));

  // debug-15: 模型触发器标签 (current → 目录里的展示名; 未加载时兜底)
  const modelLabel = (() => {
    const cur = modelState.current;
    if (cur) {
      for (const g of modelState.groups || []) {
        for (const m of g.models || []) {
          if (g.id === cur.provider && m.id === cur.model) return m.name;
        }
      }
      return cur.model;
    }
    return '选择模型';
  })();

  // debug-15: 模型菜单内容 (按提供方分组; 失败项不可选)
  const modelMenuContent = [
    h('div', { key: 't', style: menuTitleStyle() }, '模型'),
    ...(modelState.groups || []).map((g) => h('div', { key: g.id, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      h('div', { style: menuGroupStyle() }, g.name),
      ...(g.models || []).map((m) => h('button', {
        key: g.id + '/' + m.id,
        className: 'kb-row',
        style: menuItemStyle(!!(modelState.current && modelState.current.provider === g.id && modelState.current.model === m.id)),
        onClick: () => chooseModel(g, m),
      },
        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, m.name),
        m.description ? h('span', { style: { flex: 'none', fontSize: 10, color: TK.text3, marginLeft: 6 } }, m.description) : null,
      )),
    )),
    ...(modelState.failures || []).map((f) => h('div', { key: 'fail-' + f.id, style: { fontSize: 11, color: TK.error, padding: '2px 8px', wordBreak: 'break-all' } },
      '⚠ ' + f.name + ': ' + f.message)),
    (modelState.groups || []).length === 0 && modelState.status === 'ready'
      ? h('div', { key: 'empty', style: { fontSize: 11, color: TK.text3, padding: '4px 8px' } }, '没有可用模型')
      : null,
  ];

  // debug-15: 指令菜单内容 (带参数的指令补全进输入框, bare 指令立即执行)
  const commandMenuContent = [
    h('div', { key: 't', style: menuTitleStyle() }, '指令 (斜杠命令)'),
    commands.length
      ? commands.map((c) => h('button', {
          key: c.name,
          className: 'kb-row',
          style: menuItemStyle(false),
          title: (c.description || '') + (c.input && typeof c.input.hint === 'string' ? ' — ' + c.input.hint : ''),
          onClick: () => pickCommand(c),
        },
          h('span', { style: { flex: 'none', fontFamily: 'var(--dsw-font-mono, ui-monospace, Consolas, monospace)', color: TK.business, fontSize: 11 } }, '/' + c.name),
          h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 8 } }, c.description || ''),
          c.input && typeof c.input.hint === 'string'
            ? h('span', { style: { flex: 'none', fontSize: 10, color: TK.text3, marginLeft: 6 } }, c.input.hint)
            : null,
        ))
      : h('div', { key: 'loading', style: { fontSize: 11, color: TK.text3, padding: '4px 8px' } }, '加载指令列表…'),
  ];

  return h('div', { style: sessionPopupStyle() },
    h('div', { style: sessionPopupHeaderStyle() },
      h('span', { style: { fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
      running ? h('span', { style: badgeStyle(true) }, '运行中') : null,
      h('button', { className: 'kb-primary', style: miniBtnStyle(), onClick: doCompact, disabled: compacting, title: '压缩该会话上下文 (/compact)' }, compacting ? '压缩中…' : '压缩'),
      h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: () => { refreshSessionContext(props.sid); }, title: '刷新会话历史与上下文占用' }, '刷新'),
      h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: () => { try { navigator.clipboard && navigator.clipboard.writeText(props.sid); } catch (e) {} } }, '复制 id'),
      // debug-17: 弹层头部也有「🔗 打开」— 与任务详情页 session 行同一函数 (sessions.open + 关闭看板)
      h('button', { className: 'kb-ghost', style: miniBtnStyle(), title: '关闭看板并在主界面打开该会话', onClick: () => jumpToSession(props.sid) }, '🔗 打开'),
      typeof props.onUnbind === 'function'
        ? h('button', { className: 'kb-ghost', style: { ...miniBtnStyle(), color: TK.error }, onClick: props.onUnbind, title: '解绑会话 (不影响会话本身)' }, '解绑')
        : null,
      h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: props.onClose }, '✕ 关闭'),
    ),
    compactError ? h('div', { style: { ...warnStyle(), padding: '4px 14px' } }, '⚠ ' + compactError) : null,
    h('div', { style: sessionPopupBodyStyle() },
      h('div', { style: sessionPopupSidebarStyle() },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: TK.text3, padding: '0 4px 4px' } }, '❓ 用户问题 (' + questions.length + ')'),
        h('div', { style: { fontSize: 11, color: TK.text3, wordBreak: 'break-all', padding: '0 4px 6px' } }, props.sid),
        questions.length
          ? questions.map((q, i) => h('div', {
              key: 'q' + i,
              className: 'kb-row',
              style: questionTabStyle(activeSeq === q.seq),
              title: q.text,
              onClick: () => { setActiveSeq(q.seq); if (q.seq != null) scrollToMsg(q.seq); },
            },
              h('span', { style: { flex: 'none', fontSize: 11, color: TK.text3, fontVariantNumeric: 'tabular-nums' } }, String(i + 1)),
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, truncate(q.text, 18)),
            ))
          : h('div', { style: emptyHintStyle() }, '暂无用户提问'),
        h('div', { style: { fontSize: 11, color: TK.text3, padding: '8px 4px 0', borderTop: '1px solid ' + TK.border, marginTop: 6 } },
          '点击标签跳转到对应提问'),
      ),
      h('div', { style: sessionPopupContentStyle() }, content),
    ),
    // debug-15: 底部 = 状态栏 + 输入框 + 工具条 (⊕ 指令 / 模型选择 / 启停, 与主界面 composer 一致)
    h('div', { style: { ...sessionPopupFooterStyle(), flexDirection: 'column', alignItems: 'stretch', gap: 6 } },
      h('div', { style: statusBarStyle() },
        h('span', { style: { flex: 'none', fontWeight: 600, color: running ? TK.business : TK.success } }, running ? '● 运行中' : '○ 空闲'),
        h('span', { style: { flex: 'none', color: TK.text3 } }, '💬 消息 ' + (visibleEntries ? visibleEntries.length : 0)),
        h('span', { style: { flex: 'none', color: TK.text3 } }, '🤖 回答 ' + assistantCount),
        context ? h('span', { style: { flex: 'none', color: TK.text3, fontVariantNumeric: 'tabular-nums' } },
          '📊 ~' + fmtTokens(context.used) + (context.window != null ? ' / ' + fmtTokens(context.window) + (percent != null ? ' (' + percent + '%)' : '') : '')) : null,
        hiddenInjected > 0
          ? h('span', { style: { flex: 'none', color: TK.text3 }, title: '插件注入的系统指令 (AGENTS.md 等 system-reminder) 已隐藏' },
              '🙈 隐藏 ' + hiddenInjected + ' 条系统注入')
          : null,
        cmdStatus ? h('span', { style: { flex: 'none', color: TK.warnLabel } }, cmdStatus) : null,
      ),
      h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 8 } },
        h('textarea', {
          ref: (el) => { inputRef.current = el; growInput(el); },
          style: { ...textareaStyle(), flex: 1, minHeight: 42, maxHeight: 180, resize: 'none', width: 'auto', overflowY: 'auto' },
          placeholder: '给这个会话发送消息 (Enter 发送, Shift+Enter 换行)…',
          value: draft,
          onChange: (e) => { setDraft(e.target.value); growInput(e.target); },
          onKeyDown: (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
          },
        }),
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, position: 'relative' } },
        h('button', { className: 'kb-ghost', style: toolBtnStyle(), title: '指令 (斜杠命令)', onClick: openCommands }, '⊕ 指令'),
        h('button', {
          className: 'kb-ghost',
          style: { ...toolBtnStyle(), maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: '选择模型',
          onClick: openModels,
        }, modelLabel + ' ▾'),
        h('span', { style: { flex: 1 } }),
        h('button', {
          className: 'kb-primary',
          style: { ...addBtnStyle(), flex: 'none', padding: '6px 16px' },
          title: running ? '停止生成' : '发送消息',
          disabled: running ? stopping : (sending || !(draft || '').trim()),
          onClick: running ? doStop : doSend,
        }, running ? (stopping ? '停止中…' : '■ 停止') : (sending ? '发送中…' : '➤ 发送')),
        modelOpen ? h('div', { style: popMenuStyle() }, modelMenuContent) : null,
        cmdOpen ? h('div', { style: popMenuStyle() }, commandMenuContent) : null,
      ),
    ),
    sendError ? h('div', { style: { ...warnStyle(), padding: '4px 14px' } }, '⚠ ' + sendError) : null,
    toolError ? h('div', { style: { ...warnStyle(), padding: '4px 14px' } }, '⚠ ' + toolError) : null,
  );
}

// ── 新建任务完整创建框 (debug-13): 待开发列只填标题, 点击后弹出完整表单 ──────
function createDialogMaskStyle() {
  return {
    position: 'fixed', inset: 0, zIndex: 10002, background: 'rgba(0,0,0,.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}
function createDialogStyle() {
  return {
    width: 'min(520px, 92vw)', maxHeight: '86vh', overflowY: 'auto', boxSizing: 'border-box',
    background: TK.bgL2, border: '1px solid ' + TK.border, borderRadius: 14,
    boxShadow: '0 16px 48px rgba(0,0,0,.45)',
    padding: 16, display: 'flex', flexDirection: 'column', gap: 8,
  };
}

function TaskCreateDialog() {
  const snap = useStore();
  const dlg = snap.createDialog || {};
  const [title, setTitle] = React.useState(dlg.title || '');
  const [content, setContent] = React.useState('');
  const close = () => store.setCreateDialog({ open: false, title: '' });
  const submit = () => {
    const t = (title || '').trim();
    if (!t) return;
    addTask(t, content);
    close();
  };
  return h('div', { style: createDialogMaskStyle() },
    h('div', { style: createDialogStyle() },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('span', { style: { flex: 1, fontWeight: 600, fontSize: 14 } }, '🆕 新建任务'),
        h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: close }, '✕'),
      ),
      h('div', { style: sectionTitleStyle() }, '标题'),
      h('input', {
        style: { ...inputStyle(), width: '100%' }, placeholder: '任务标题', value: title, autoFocus: true,
        onChange: (e) => setTitle(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') submit(); },
      }),
      h('div', { style: sectionTitleStyle() }, '内容 (可选, 支持 Markdown, 可直接粘贴图片)'),
      h('textarea', {
        style: { ...textareaStyle(), width: '100%', minHeight: 140 },
        placeholder: '任务内容, 可选。支持 Markdown 格式, 剪贴板图片可直接粘贴…', value: content,
        onChange: (e) => setContent(e.target.value),
        onPaste: (e) => pasteImageInto(e, () => content, setContent),
      }),
      h('div', { style: { fontSize: 11, color: TK.text3 } },
        '创建后任务进入「待开发」; 拖到「正在开发」即会交给 agent 执行'),
      h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
        h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: close }, '取消'),
        h('button', { className: 'kb-primary', style: addBtnStyle(), onClick: submit, disabled: !(title || '').trim() }, '创建任务'),
      ),
    ),
  );
}

// ── debug-21: 看板设置弹窗 (左侧标签栏 + 右侧选项区) ────────────────────────
function settingsMaskStyle() {
  return {
    position: 'fixed', inset: 0, zIndex: 10003, background: 'rgba(0,0,0,.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}
function settingsPanelStyle() {
  return {
    width: 'min(760px, 92vw)', height: 'min(520px, 82vh)', boxSizing: 'border-box',
    background: TK.bgL1, border: '1px solid ' + TK.border, borderRadius: 14,
    boxShadow: '0 16px 48px rgba(0,0,0,.45)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  };
}
function settingsTabStyle(active) {
  return {
    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8,
    cursor: 'pointer', userSelect: 'none', fontSize: 13, lineHeight: '18px', color: TK.text,
    ...(active ? { background: TK.navActive } : {}),
  };
}

function SettingsDialog() {
  const snap = useStore();
  const [tab, setTab] = React.useState('jira');
  const j = (snap.settings && snap.settings.jira) || {};
  const [url, setUrl] = React.useState(j.url || '');
  const [user, setUser] = React.useState(j.user || '');
  const [token, setToken] = React.useState(j.token || '');
  const [status, setStatus] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const save = () => {
    store.setSettings({ jira: { url: (url || '').trim(), user: (user || '').trim(), token: token || '' } });
    store.toast('Jira 配置已保存');
    setStatus('✓ 已保存到浏览器本地存储');
  };
  const test = () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    testJiraConnection().then((r) => {
      setBusy(false);
      setStatus(r && r.ok ? ('✓ 连接成功: ' + r.name) : ('⚠ ' + ((r && r.error) || '失败')));
    });
  };
  const importAll = () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    importJiraIssues().then((r) => {
      setBusy(false);
      if (r && r.ok) {
        setStatus('✓ 导入完成: 新增 ' + r.added + ' 个, 跳过 ' + r.skipped + ' 个 (重复)');
        store.toast('Jira 导入: 新增 ' + r.added + ' 个任务到「待开发」');
      } else {
        setStatus('⚠ ' + ((r && r.error) || '导入失败'));
      }
    });
  };

  const generalTab = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', { style: sectionTitleStyle() }, '关于任务看板'),
    h('div', { style: { fontSize: 12, color: TK.text2, lineHeight: '20px' } },
      '版本: debug-21 (window.__KANBAN__.version)'),
    h('div', { style: { fontSize: 12, color: TK.text2, lineHeight: '20px' } },
      '看板数据、评论草稿、设置分别保存在浏览器 localStorage (kanban-board-state / kanban-board-comment-drafts / kanban-board-settings)。'),
  );

  const jiraTab = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', { style: sectionTitleStyle() }, 'Jira URL'),
    h('input', {
      style: { ...inputStyle(), width: '100%' }, placeholder: 'https://your-domain.atlassian.net',
      value: url, onChange: (e) => setUrl(e.target.value),
    }),
    h('div', { style: sectionTitleStyle() }, '账户 (邮箱)'),
    h('input', {
      style: { ...inputStyle(), width: '100%' }, placeholder: 'you@example.com',
      value: user, onChange: (e) => setUser(e.target.value),
    }),
    h('div', { style: sectionTitleStyle() }, '密码 / API Token'),
    h('input', {
      style: { ...inputStyle(), width: '100%' }, type: 'password',
      placeholder: '建议使用 Jira API Token (账户设置 → 安全 → API 令牌)',
      value: token, onChange: (e) => setToken(e.target.value),
    }),
    h('div', { style: { fontSize: 11, color: TK.text3 } },
      '⚠ 账户密码保存在浏览器本地存储 (localStorage), 仅本机可读; 通过 Basic Auth 直连 Jira REST API (GET /rest/api/3/...)。'),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      h('button', { className: 'kb-primary', style: addBtnStyle(), onClick: save, title: '保存 Jira 配置' }, '💾 保存配置'),
      h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: test, disabled: busy }, busy ? '测试中…' : '🔌 测试连接'),
      h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: importAll, disabled: busy, title: '导入当前用户未解决的 Jira 任务到「待开发」' }, '📥 导入未完成任务到「待开发」'),
    ),
    status ? h('div', { style: { fontSize: 12, color: TK.text2, wordBreak: 'break-word', whiteSpace: 'pre-wrap' } }, status) : null,
  );

  return h('div', { style: settingsMaskStyle(), onClick: (e) => { if (e.target === e.currentTarget) store.setSettingsOpen(false); } },
    h('div', { style: settingsPanelStyle() },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', flex: 'none', borderBottom: '1px solid ' + TK.border } },
        h('span', { style: { flex: 1, fontWeight: 600, fontSize: 14 } }, '⚙ 设置'),
        h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: () => store.setSettingsOpen(false) }, '✕ 关闭'),
      ),
      h('div', { style: { display: 'flex', flex: 'auto', minHeight: 0, alignItems: 'stretch' } },
        h('div', { style: { flex: 'none', width: 170, boxSizing: 'border-box', padding: 10, background: TK.sidebar, borderRight: '1px solid ' + TK.border, display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { className: 'kb-row', style: settingsTabStyle(tab === 'general'), onClick: () => setTab('general') }, 'ℹ 通用'),
          h('div', { className: 'kb-row', style: settingsTabStyle(tab === 'jira'), onClick: () => setTab('jira') }, '🐛 Jira 配置'),
        ),
        h('div', { style: { flex: 1, minWidth: 0, overflowY: 'auto', boxSizing: 'border-box', padding: 14 } },
          tab === 'jira' ? jiraTab : generalTab,
        ),
      ),
    ),
  );
}

function TaskDetail(props) {
  const snap = useStore();
  const liveHit = findTask(snap.state, props.task.id);
  const liveTask = (liveHit && liveHit.task) || props.task;
  const boardKey = (liveHit && liveHit.boardKey) || liveTask.boardKey || activeBoardKey();
  // 任务描述: 默认阅读模式, 点「✏ 编辑」才进入编辑 (desc 状态只在编辑态使用)
  const [editing, setEditing] = React.useState(false);
  const [desc, setDesc] = React.useState(liveTask.description || '');
  const [savedHint, setSavedHint] = React.useState(false);
  // debug-16: 评论区输入框记忆 (localStorage 草稿, 关看板/刷新页面不丢)
  const [comment, setComment] = React.useState(() => commentDraftOf(liveTask.id));
  // 会话绑定面板
  const [bindOpen, setBindOpen] = React.useState(false);
  const [bindSel, setBindSel] = React.useState('');
  const [bindText, setBindText] = React.useState('');
  // 「＋ 创建」进行中
  const [creating, setCreating] = React.useState(false);
  // debug-21: 评论发送状态 / 模型目录 / 定时输入
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState(null);
  const [modelDir, setModelDir] = React.useState(null);
  const [schedValue, setSchedValue] = React.useState('');

  const sessions = Array.isArray(liveTask.sessions) ? [...liveTask.sessions].reverse() : [];
  const candidates = candidateSessions(boardKey).filter((sid) => !sessions.includes(sid));
  const comments = Array.isArray(liveTask.comments) ? liveTask.comments : [];
  const mainSid = liveTask.sessionId || sessions[0] || null;

  // debug-21: 定时输入框与任务 scheduledAt 同步
  React.useEffect(() => {
    setSchedValue(liveTask.scheduledAt ? toLocalInputValue(liveTask.scheduledAt) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTask.id, liveTask.scheduledAt]);

  // debug-21: 任务模型目录来自主会话 (session.models, 与主界面同源)
  React.useEffect(() => {
    let alive = true;
    if (!mainSid) { setModelDir(null); return undefined; }
    fetchSessionModels(mainSid).then((dir) => { if (alive) setModelDir(dir || null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTask.id, mainSid]);

  // 为相关会话补拉最新提问文本 (session.history 尾页, 每个会话只拉一次)
  React.useEffect(() => {
    for (const sid of sessions) {
      const info = store.sessionInfo[sid];
      if (!info || !('lastPromptText' in info)) fetchPromptText(sid);
    }
    // eslint 风格提示: sessions 由 liveTask 派生, 以 id 列表作依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTask.id, sessions.join(',')]);

  const startEdit = () => { setDesc(liveTask.description || ''); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setDesc(liveTask.description || ''); };
  const saveDesc = () => {
    patchTask(liveTask.id, { description: desc });
    persist();
    setEditing(false);
    setSavedHint(true);
    setTimeout(() => setSavedHint(false), 1200);
  };
  const doBind = () => {
    const sid = (bindSel || bindText || '').trim();
    if (!sid) return;
    // debug-21: 已被其他任务绑定的会话拒绝绑定 (toast 已提示), 面板保持打开
    const r = bindSession(liveTask.id, sid);
    if (!r || !r.ok) return;
    setBindOpen(false); setBindSel(''); setBindText('');
  };
  // 在任务工作区新建一个空会话并绑定 (不投递任务提示词, 不动主会话)
  const doCreate = () => {
    if (creating) return;
    setCreating(true);
    createSessionForTask(liveTask.id).then((sid) => {
      setCreating(false);
      if (sid) fetchSessionInfo();
    });
  };
  // debug-21: 发送评论 = 本地落库 + 追加到主会话并开始工作; 成功后打「已发送」标记
  const sendComment = () => {
    const text = (comment || '').trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    const id = addLocalComment(liveTask.id, text);
    // debug-16: 评论追加到主会话并开始工作 (会话开始运行后卡片自动移入「正在开发」)
    appendCommentToSession(liveTask.id, text).then((err) => {
      setSending(false);
      if (err) {
        // debug-21: 无绑定会话 → 只留本地记录并提示; 其余失败同样保留本地记录
        setSendError(err === 'no-main-session' ? '任务没有绑定会话 — 评论已保存, 未发送' : err);
        return;
      }
      if (id) markCommentSent(liveTask.id, id);
      clearCommentDraft(liveTask.id);
      setComment('');
    });
  };
  // debug-21: 仅保存 = 只落本地记录, 不追加到主会话 (Ctrl+Enter 同义)
  const saveCommentOnly = () => {
    const text = (comment || '').trim();
    if (!text) return;
    addLocalComment(liveTask.id, text, false);
    clearCommentDraft(liveTask.id);
    setComment('');
    store.toast('评论已保存 (仅本地, 未发送到主会话)');
  };

  return h('aside', { className: 'kb-detail', style: detailPanelStyle(props.width) },
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontWeight: 600, fontSize: 14, wordBreak: 'break-all' } }, liveTask.title),
        h('div', { style: { fontSize: 11, color: TK.text3, marginTop: 2 } },
          '当前列: ' + (COLUMN_LABEL[liveTask.column] || liveTask.column)),
      ),
      h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: () => { store.setSelected(null); store.setDetailSid(null); } }, '✕'),
    ),
    h('div', { style: sectionTitleStyle() }, '📝 任务描述'),
    editing
      ? h('textarea', {
          style: { ...textareaStyle(), minHeight: 90, width: '100%' },
          placeholder: '任务描述… (支持 Markdown, 剪贴板图片可直接粘贴)',
          value: desc, autoFocus: true,
          onChange: (e) => setDesc(e.target.value),
          onPaste: (e) => pasteImageInto(e, () => desc, setDesc),
        })
      : (liveTask.description
          // debug-21: 描述阅读模式渲染 Markdown (含剪贴板粘贴的 dataURL 图片)
          ? h('div', { className: 'kb-md', style: descReadStyle(), dangerouslySetInnerHTML: { __html: mdToHtml(liveTask.description) } })
          : h('div', { style: descReadStyle() }, h('span', { style: { color: TK.text3 } }, '(无描述)'))),
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
      editing
        ? [
            h('button', { key: 'save', className: 'kb-primary', style: addBtnStyle(), onClick: saveDesc }, savedHint ? '✓ 已保存' : '💾 保存'),
            h('button', { key: 'cancel', className: 'kb-ghost', style: miniBtnStyle(), onClick: cancelEdit }, '取消'),
          ]
        : h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: startEdit }, '✏ 编辑'),
    ),
    // debug-21: 任务模型选择 (目录来自主会话 session.models; 无会话时创建会话自动应用)
    h('div', { style: sectionTitleStyle() }, '🧠 模型'),
    (function () {
      const options = [];
      for (const g of ((modelDir && modelDir.groups) || [])) {
        for (const m of (g.models || [])) options.push({ value: g.id + '|' + m.id, label: m.name });
      }
      const cur = liveTask.model && liveTask.model.provider && liveTask.model.model
        ? liveTask.model.provider + '|' + liveTask.model.model : '';
      if (cur && !options.some((o) => o.value === cur)) options.unshift({ value: cur, label: liveTask.model.model });
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('select', {
          style: { ...inputStyle(), width: '100%' },
          value: cur,
          title: '任务执行模型 (有主会话时立即切换; 创建/开始会话时自动应用)',
          onChange: (e) => {
            const v = e.target.value;
            if (!v) { patchTask(liveTask.id, { model: null }); persist(); return; }
            const parts = v.split('|');
            applyTaskModel(liveTask.id, parts[0], parts[1]);
          },
        },
          [
            h('option', { key: '', value: '' }, liveTask.model && liveTask.model.model ? (liveTask.model.model + ' (清除)') : '默认 (跟随会话)'),
            ...options.map((o) => h('option', { key: o.value, value: o.value }, o.label)),
          ],
        ),
        h('div', { style: { fontSize: 11, color: TK.text3 } },
          mainSid ? '选择后立即应用到主会话' : '暂无绑定会话 — 选择后创建会话时自动应用'),
      );
    })(),
    // debug-21: 定时进入「正在开发」(到点自动移列并开始执行; 看板需打开)
    h('div', { style: sectionTitleStyle() }, '⏰ 定时进入「正在开发」'),
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
      h('input', {
        type: 'datetime-local',
        style: { ...inputStyle(), flex: 1 },
        value: schedValue,
        onChange: (e) => setSchedValue(e.target.value),
      }),
      h('button', {
        className: 'kb-primary', style: miniBtnStyle(),
        onClick: () => {
          const ts = schedValue ? new Date(schedValue).getTime() : NaN;
          if (!isFinite(ts)) { store.toast('请选择有效的时间'); return; }
          patchTask(liveTask.id, { scheduledAt: ts });
          persist();
          store.toast('已设定定时: ' + new Date(ts).toLocaleString());
        },
      }, '设定'),
      liveTask.scheduledAt
        ? h('button', {
            className: 'kb-ghost', style: miniBtnStyle(),
            onClick: () => { patchTask(liveTask.id, { scheduledAt: null }); persist(); store.toast('已清除定时'); },
          }, '清除')
        : null,
    ),
    h('div', { style: { fontSize: 11, color: TK.text3 } },
      liveTask.scheduledAt
        ? '已定时: ' + new Date(liveTask.scheduledAt).toLocaleString() + ' — 到点自动移入「正在开发」并开始执行 (看板需打开)'
        : '到点自动把任务从「待开发」移入「正在开发」并开始执行 (看板需打开)'),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
      h('div', { style: { ...sectionTitleStyle(), marginTop: 0, flex: 1 } }, '💬 相关会话 (' + sessions.length + ')'),
      h('button', { className: 'kb-primary', style: miniBtnStyle(), title: '在该任务工作区新建一个空会话并绑定', onClick: doCreate, disabled: creating }, creating ? '创建中…' : '＋ 创建'),
      h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: () => { if (!bindOpen) fetchSessionInfo(); setBindOpen(!bindOpen); } }, bindOpen ? '✕ 收起' : '＋ 绑定'),
    ),
    bindOpen ? h('div', { style: bindPanelStyle() },
      h('select', { style: { ...inputStyle(), width: '100%' }, value: bindSel, onChange: (e) => setBindSel(e.target.value), title: '从当前工作区选择一个会话绑定 (显示会话标题)' },
        [
          h('option', { key: '', value: '' }, candidates.length ? '选择工作区会话…' : '当前工作区无可用会话'),
          ...candidates.map((sid) => h('option', { key: sid, value: sid }, (store.sessionInfo[sid] && store.sessionInfo[sid].title) || short(sid))),
        ],
      ),
      h('input', { style: { ...inputStyle(), width: '100%' }, placeholder: '或直接输入会话 id 绑定', value: bindText, onChange: (e) => setBindText(e.target.value) }),
      h('div', { style: { display: 'flex', gap: 6 } },
        h('button', { className: 'kb-primary', style: addBtnStyle(), onClick: doBind }, '绑定'),
        h('button', { className: 'kb-ghost', style: miniBtnStyle(), onClick: () => setBindOpen(false) }, '取消'),
      ),
    ) : null,
    sessions.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      sessions.map((sid) => h(SessionRow, {
        key: sid, sid,
        info: store.sessionInfo[sid] || {},
        isMain: sid === liveTask.sessionId,
        onMakeMain: (s) => makeMainSession(liveTask.id, s),
        onUnbind: (s) => unbindSession(liveTask.id, s),
        onJump: (s) => jumpToSession(s),
        onDetail: (s) => { fetchPromptText(s); store.setDetailSid(s); },
      })),
    ) : h('div', { style: emptyHintStyle() }, '暂无会话 — 点「＋ 创建」新建, 或「＋ 绑定」关联已有会话'),
    h('div', { style: { fontSize: 11, color: TK.text3, marginTop: 4 } },
      '提示: 「主」会话是后续继续工作/评论的目标; 「🔗 打开」关闭看板并跳转主界面该会话; 解绑/压缩不影响会话本身'),
    h('div', { style: sectionTitleStyle() }, '💭 评论区 (' + comments.length + ')'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      h('textarea', {
        style: { ...textareaStyle(), width: '100%' },
        placeholder: '写一条评论… (Enter 换行, Ctrl+Enter 仅保存; 草稿自动记忆; 支持 Markdown, 剪贴板图片可直接粘贴)',
        value: comment,
        onChange: (e) => { setComment(e.target.value); saveCommentDraft(liveTask.id, e.target.value); },
        onKeyDown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveCommentOnly(); } },
        onPaste: (e) => pasteImageInto(e, () => comment, (v) => { setComment(v); saveCommentDraft(liveTask.id, v); }),
      }),
      h('div', { style: { display: 'flex', gap: 6 } },
        h('button', {
          className: 'kb-ghost', style: miniBtnStyle(),
          title: '只保存到本地评论区, 不发送到主会话 (Ctrl+Enter 同义)',
          onClick: saveCommentOnly,
        }, '💾 仅保存'),
        h('button', {
          className: 'kb-primary', style: addBtnStyle(), disabled: sending || !(comment || '').trim(),
          title: '保存到评论区并追加到主会话 (会话开始工作后卡片自动移入「正在开发」)',
          onClick: sendComment,
        }, sending ? '发送中…' : '➤ 发送'),
      ),
      sendError ? h('div', { style: { fontSize: 11, color: TK.error, wordBreak: 'break-all' } }, '⚠ ' + sendError + ' (评论已保存在本地)') : null,
    ),
    comments.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      comments.map((c) => h('div', { key: c.id, style: commentStyle() },
        // debug-20: 每条历史评论带删除按钮 (只删本地记录, 已追加到主会话的提示词不回撤)
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('div', { style: { flex: 1, fontSize: 10, color: TK.text3 } }, new Date(c.createdAt).toLocaleString()),
          // debug-21: 「已发送」标记 — 成功追加到主会话的评论才有
          c.sent
            ? h('span', { style: badgeStyle(false), title: '已追加到主会话' }, '✓ 已发送')
            : h('span', { style: { ...badgeStyle(false), background: TK.hover, color: TK.text3 }, title: '仅保存在本地, 未发送到主会话' }, '仅保存'),
          h('button', {
            className: 'kb-ghost',
            style: { ...miniBtnStyle(), flex: 'none', color: TK.text3 },
            title: '删除这条评论 (不影响已追加到主会话的提示词)',
            onClick: () => deleteComment(liveTask.id, c.id),
          }, '🗑 删除'),
        ),
        h('div', { className: 'kb-md', style: { fontSize: 12, wordBreak: 'break-word' }, dangerouslySetInnerHTML: { __html: mdToHtml(c.text) } }),
      )),
    ) : h('div', { style: emptyHintStyle() }, '暂无评论'),
    // 会话详情弹层: 只允许打开本任务关联列表里的会话 (解绑后自动关闭)
    // debug-16: 弹层下方加全屏透明遮罩 — 点击弹层以外的任何地方关闭弹层
    (function () {
      const popupSid = store.detailSid && sessions.includes(store.detailSid) ? store.detailSid : null;
      if (!popupSid) return null;
      return [
        h('div', { key: 'mask', className: 'kb-popmask', style: popMaskStyle(), onClick: () => store.setDetailSid(null) }),
        h(SessionDetailPopup, {
          key: popupSid,
          sid: popupSid,
          info: store.sessionInfo[popupSid] || {},
          onClose: () => store.setDetailSid(null),
          onUnbind: () => unbindSession(liveTask.id, popupSid),
        }),
      ];
    })(),
  );
}

// ── 插件本体 ────────────────────────────────────────────────────────────────
(function () {
  const tagId = 'kanban-board/base';
  if (typeof document !== 'undefined' && document.querySelector("style[data-plugin-css='" + tagId + "']") === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'kanban-board';
    tag.dataset.pluginCss = tagId;
    tag.textContent = [
      '.kb-board input, .kb-board select, .kb-board textarea { box-sizing: border-box; width: 100%; font-family: inherit; }',
      '.kb-board input:focus, .kb-board select:focus, .kb-board textarea:focus { border-color: var(--dsw-alias-state-business-primary); outline: none; }',
      '.kb-board input::placeholder, .kb-board textarea::placeholder { color: var(--dsw-alias-label-tertiary); }',
      '.kb-board select { background: transparent; color: inherit; }',
      '.kb-board select option { background: var(--dsw-alias-bg-layer-2, #2c2c2d); color: var(--dsw-alias-label-primary, #f2f3f5); }',
      'body[data-ds-dark-theme] .kb-board select { color-scheme: dark; }',
      '.kb-card input, .kb-card textarea { box-sizing: border-box; width: 100%; }',
      '.kb-row { background: transparent; }',
      '.kb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.kb-iconbtn { background: transparent; }',
      '.kb-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.kb-ghost { background: transparent; }',
      '.kb-ghost:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.kb-danger { background: transparent; }',
      '.kb-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }',
      '.kb-primary { background: var(--dsw-alias-button-info-fill); }',
      '.kb-primary:hover { background: var(--dsw-alias-button-info-hover); }',
      '.kb-md { font-size: 13px; line-height: 1.65; word-break: break-word; }',
      '.kb-md h1, .kb-md h2, .kb-md h3, .kb-md h4, .kb-md h5, .kb-md h6 { margin: 10px 0 6px; line-height: 1.3; }',
      '.kb-md h1 { font-size: 19px; } .kb-md h2 { font-size: 17px; } .kb-md h3 { font-size: 15px; }',
      '.kb-md h4, .kb-md h5, .kb-md h6 { font-size: 13px; }',
      '.kb-md p { margin: 4px 0; }',
      '.kb-md ul, .kb-md ol { margin: 4px 0; padding-left: 20px; }',
      '.kb-md li { margin: 2px 0; }',
      '.kb-md blockquote { margin: 6px 0; padding: 6px 10px; border-left: 3px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16)); color: var(--dsw-alias-label-secondary, #cfd3d6); }',
      '.kb-md code.kb-md-inline { font-family: var(--dsw-font-mono, ui-monospace, Consolas, monospace); font-size: 12px; background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); padding: 1px 5px; border-radius: 5px; }',
      '.kb-md pre.kb-md-code { margin: 6px 0; padding: 10px; border-radius: 8px; background: var(--dsw-alias-bg-base, #151517); border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); overflow-x: auto; }',
      '.kb-md pre.kb-md-code code { font-family: var(--dsw-font-mono, ui-monospace, Consolas, monospace); font-size: 12px; line-height: 1.5; }',
      '.kb-md a { color: var(--dsw-alias-state-business-primary, #679efe); text-decoration: none; }',
      '.kb-md a:hover { text-decoration: underline; }',
      '.kb-md hr { border: none; border-top: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); margin: 10px 0; }',
      '.kb-md img { max-width: 100%; }',
    ].join('\n');
    document.head.appendChild(tag);
  }
})();

return {
  inject: ['slots', 'timer', 'remote', 'remote.commands'],
  apply(ctx) {
    ctxRef = ctx;
    const slots = ctx.get('slots');
    console.log('[kanban] apply: slots=' + !!slots + ' connection=' + !!ctx.get('connection'));
    if (!slots) return;
    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: 'kanban-toggle' },
      (props) => h(KanbanToggle, { wide: props && props.wide }),
    ));
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'kanban-board' },
      () => h(KanbanBoard, {}),
    ));
    loadCommentDrafts();
    loadSettings();
    loadState();
    const conn = ctx.get('connection');
    if (conn) {
      watchHost(conn);
      watchMux(conn);
      fetchWorkspaces();
      fetchSessionInfo();
    } else {
      console.log('[kanban] connection 服务不可用, 无法监听会话状态');
    }
    // 调试句柄: 浏览器控制台输入 window.__KANBAN__.setOpen(true) 可直接开关看板
    if (typeof window !== 'undefined') {
      window.__KANBAN__ = {
        getOpen: () => store.open,
        setOpen: (v) => store.setOpen(!!v),
        state: () => store.state,
        workspaces: () => store.workspaces.slice(),
        addTask: (title, desc) => addTask(title, desc),
        startTask: (taskId) => startSession(taskId, null),
        // debug-14: 已绑定会话的任务 → 接着最新会话继续 (不新建)
        resumeTask: (taskId) => { resumeOrStartSession(taskId, null); return 'resuming'; },
        selectTask: (taskId) => { store.setSelected(taskId); return store.selected; },
        getSelected: () => store.selected,
        removeTask: (taskId) => { deleteTask(taskId); return 'deleted'; },
        clearAll: () => { store.set(normalizeState(null)); persist(); return 'cleared'; },
        list: () => {
          const out = [];
          for (const key of Object.keys(store.state.boards || {})) {
            for (const t of store.state.boards[key].tasks || []) {
              out.push({ id: t.id, title: t.title, column: t.column, sessionId: t.sessionId, boardKey: key });
            }
          }
          return out;
        },
        switchBoard: (key) => { switchBoard(key); return store.state.activeBoard; },
        refreshWorkspaces: () => fetchWorkspaces(),
        refreshSessionInfo: () => fetchSessionInfo().then(() => ({ ...store.sessionInfo })),
        refreshPrompt: (sid) => fetchPromptText(sid).then(() => ({ ...store.sessionInfo[sid] })),
        sessionInfo: () => ({ ...store.sessionInfo }),
        createSession: (taskId) => createSessionForTask(taskId),
        compactSession: (sid) => compactSession(sid),
        reload: () => { loadState(); return store.state; },
        bindSession: (taskId, sid) => { bindSession(taskId, sid); const hit = findTask(store.state, taskId); return hit ? hit.task.sessions.slice() : null; },
        unbindSession: (taskId, sid) => { unbindSession(taskId, sid); const hit = findTask(store.state, taskId); return hit ? { sessions: hit.task.sessions.slice(), sessionId: hit.task.sessionId } : null; },
        candidateSessions: (boardKey) => candidateSessions(boardKey),
        // debug-13: 新建任务创建框 + 会话详情弹层 (完整历史 / 发消息)
        openCreateDialog: (title) => { store.setCreateDialog({ open: true, title: title || '' }); return { ...store.createDialog }; },
        closeCreateDialog: () => { store.setCreateDialog({ open: false, title: '' }); return null; },
        openSessionDetail: (taskId, sid) => { store.setSelected(taskId); store.setDetailSid(sid); return { taskId, sid }; },
        closeSessionDetail: () => { store.setDetailSid(null); return null; },
        sessionHistory: (sid) => fetchSessionHistory(sid).then((r) => ({ count: r.entries ? r.entries.length : -1, error: r.error })),
        sendPrompt: (sid, text) => sendPrompt(sid, text),
        // debug-15: 会话详情工具条 (模型目录/切换、启停、指令、压缩后刷新上下文)
        cancelSession: (sid) => cancelSession(sid),
        sessionModels: (sid) => fetchSessionModels(sid),
        selectModel: (sid, provider, model) => selectSessionModel(sid, provider, model),
        sessionCommands: (sid) => fetchSessionCommands(sid),
        runCommand: (sid, line) => runSessionCommand(sid, line),
        compactSessionAndRefresh: (sid) => compactSessionAndRefresh(sid),
        refreshSessionContext: (sid) => refreshSessionContext(sid),
        // debug-16: 主会话 / 跳转 / 评论 / 草稿记忆; debug-17: 弹层头部 🔗 打开 复用 jumpToSession
        makeMain: (taskId, sid) => { makeMainSession(taskId, sid); const hit = findTask(store.state, taskId); return hit ? hit.task.sessionId : null; },
        jumpToSession: (sid) => { jumpToSession(sid); return store.open; },
        appendComment: (taskId, text) => appendCommentToSession(taskId, text),
        getCommentDraft: (taskId) => commentDraftOf(taskId),
        setCommentDraft: (taskId, text) => { saveCommentDraft(taskId, text); return commentDraftOf(taskId); },
        // debug-18: 外部点击判定 (按按下目标; 传入带 closest() 的对象即可在控制台自测)
        shouldCloseOnPress: (target) => shouldCloseOnPress(target),
        // debug-19: 直接移动卡片到指定列 (对账补帧测试/手动调列), 返回移动后的列
        moveTask: (taskId, toColumn) => { moveTask(taskId, toColumn); const hit = findTask(store.state, taskId); return hit ? hit.task.column : null; },
        // debug-20: 本地评论增删 (与评论区 UI 同一路径); debug-21: 成功后打「已发送」标记
        addComment: (taskId, text) => {
          const id = addLocalComment(taskId, text);
          if (id) {
            clearCommentDraft(taskId);
            return appendCommentToSession(taskId, text).then((err) => {
              if (!err) markCommentSent(taskId, id);
              const hit = findTask(store.state, taskId);
              return hit && hit.task ? { id, count: hit.task.comments.length, sent: !err } : { id: null, count: 0 };
            });
          }
          const hit = findTask(store.state, taskId);
          return Promise.resolve(hit && hit.task ? { id: null, count: hit.task.comments.length } : { id: null, count: 0 });
        },
        deleteComment: (taskId, commentId) => {
          deleteComment(taskId, commentId);
          const hit = findTask(store.state, taskId);
          return hit && hit.task ? hit.task.comments.length : 0;
        },
        // debug-21: 评论区「仅保存」(只落本地, 不发送), 返回 { id, count }
        saveComment: (taskId, text) => {
          const id = addLocalComment(taskId, text, false);
          if (id) clearCommentDraft(taskId);
          const hit = findTask(store.state, taskId);
          return Promise.resolve(hit && hit.task ? { id, count: hit.task.comments.length } : { id: null, count: 0 });
        },
        // debug-21: 图文/Markdown 辅助
        mdToHtml: (md) => mdToHtml(md),
        imageMarkdown: (dataUrl) => imageMarkdown(dataUrl),
        // debug-21: 待开发列快速添加 (创建任务并打开右侧详情面板)
        quickAdd: (title) => {
          const t = addTask((title || '').trim() || '新建任务', '');
          if (t) store.setSelected(t.id);
          return t ? t.id : null;
        },
        // debug-21: 任务模型选择 / 定时
        setTaskModel: (taskId, provider, model) => applyTaskModel(taskId, provider, model),
        setTaskSchedule: (taskId, ts) => {
          patchTask(taskId, { scheduledAt: Number(ts) || null });
          persist();
          const hit = findTask(store.state, taskId);
          return hit ? hit.task.scheduledAt : null;
        },
        clearTaskSchedule: (taskId) => {
          patchTask(taskId, { scheduledAt: null });
          persist();
          return null;
        },
        runSchedules: () => runScheduledTasks(),
        // debug-21: 设置弹窗 + Jira 配置
        openSettings: () => { store.setSettingsOpen(true); return true; },
        closeSettings: () => { store.setSettingsOpen(false); return true; },
        getSettings: () => ({ jira: { ...((data.settings && data.settings.jira) || {}) } }),
        saveJira: (cfg) => {
          saveSettings({ jira: { url: (cfg && cfg.url) || '', user: (cfg && cfg.user) || '', token: (cfg && cfg.token) || '' } });
          store.emit();
          return { ...data.settings.jira };
        },
        testJira: () => testJiraConnection(),
        importJira: () => importJiraIssues(),
        getToast: () => (data.toast ? data.toast.text : null),
        version: 'debug-21',
      };
      console.log('[kanban] debug handle ready: window.__KANBAN__');
    }
  },
};

	exports.inject = [];
	exports.apply = apply;
	return module.exports;
	}
});
