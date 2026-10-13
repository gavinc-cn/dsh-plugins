/**
 * 轮次文字轨插件 — 浏览器半 (DSH 客户端模块加载器的 CJS 工厂格式, 与 dsh-dim-text / kanban-board 一致)。
 *
 * 目标: 把聊天区右缘那条内置「轮次导航轨」(ui-chat 的 TurnNavigator: 固定 10px 间距的小横杠,
 * 文字只在 hover 预览卡里出现) 换成常驻文字 —— 每轮一行显示该轮用户提问, 当前轮高亮,
 * hover 出预览卡(提问 + 回答预览), 点击跳到该轮。
 *
 * 关键约束与做法:
 *  1. 模块注册 id 必须等于解析出的包名, 见 doc_ai/plan/202610/20261001_2255_自研插件收进scope后
 *     的迁移验证与client-id修复.md: 写成短名会让 boot 清单行与 bundle 对不上, 页面直接报
 *     "loaded without registering"。所以这里是 "@gavinc-cn/dsh-turn-labels"。
 *  2. 数据取自宿主已有的 turnOutline 投影 (dsh-session-turn-outline, web 组合里已挂载):
 *     每轮 {turn, seq, prompt(<=50字), response(<=120字)}。客户端经 ctx.uiSession.current
 *     (主视图会话) + ctx.sessions.binding(id).session.projections.faceOf('turnOutline') 订阅,
 *     不自己解析会话事件。
 *  3. 内置轨没有暴露扩展点(slot/配置项都没有), 所以只能: 只读它的 DOM(定位 <nav> 与
 *     <button data-index>)、量它的矩形、用 visibility:hidden 把它盖掉(保留布局与尺寸,
 *     虚拟滚动仍按原样挂可视 mark)、点击时把事件转发给对应 mark 按钮 —— 复用官方
 *     "未加载的轮先翻页再落点" 逻辑, 不复制一套滚动定位。
 *  4. 会话只有 1 轮时内置轨自己就不渲染(ui-chat 的 TurnNavigator 在 items.length < 2 时
 *     `return null`, 连 <nav> 都不在 DOM 里), 原来本插件跟着一起消失 ——
 *     现象即"只有一个用户提问时右侧列表不显示"。修法(0.4.0): 内置轨缺席时按它自己的 CSS
 *     公式算出等价几何(readRailFallbackGeometry), 高亮归到唯一那一轮, 点击退回直接滚动
 *     该轮宿主, 于是单轮会话照常有这一列文字。
 *  5. 内置轨在会话区可用宽 <=900px 时被容器查询置为 display:none, 我们跟着一起隐藏。
 *  6. 挂载点是 shell.overlay (ui-layout 声明的 list 槽, z-index 20 的整框覆盖层,
 *     直接子元素自动可点), 不碰全局安装包, 升级 dsh 不受影响。
 *  7. 小横杠的"跳到该轮 + 展开提问行"里, 展开是靠点 dsh 自己的折叠表头完成的, 而 dsh 的
 *     祖先链出了聊天区就是别的区域(聊天列的上一个兄弟是侧栏, 里面第一个按钮是"新建会话")。
 *     所以候选表头必须**限定在同一个会话滚动区内**、只认紧邻的上一个兄弟、且不点已展开的表头 ——
 *     详见 findRevealHeaders / isRevealable 的注释与
 *     doc_ai/plan/202610/20261003_1810_DSH小横杠偶发跳出新会话根因与修复.md。
 *  8. **列宽必须跟着正文栏宽度走, 不能有下限**(0.5.0)。正文宽度由会话区两侧沟槽的拖拽条实时改
 *     (`--dsh-chat-user-width`), 拖宽后"正文栏右缘 -> 轨道右缘"只剩几十像素; 旧实现有
 *     MIN_COLUMN_PX=120 的硬下限, 把列强撑到 120px 压住正文(实测重叠 45px+)。现在:
 *     列宽 = clamp(空白带, 0, 176), 无下限; 正文栏右缘在会话滚动区内取**最靠右**的
 *     `[data-chat-flow]`(该属性也挂在更窄的组内容盒上); 并对会话滚动区 + 正文栏挂
 *     ResizeObserver, 拖动正文时不靠 400ms 轮询也能当拍跟上。同时修掉 0.4.0 等价几何里
 *     `contentRight - flowRight` 漏减 frame 的 12px(`right:12px`)导致**恒定压住正文一条**
 *     的老 bug(真机实测 overlap 12~13px, 与正文宽度无关)。
 *     详见 doc_ai/plan/202610/20261006_0925_DSH右侧列表宽度不随正文自适应根因与修复.md。
 *
 * 卸载: 删 <profile>/cordis.patch.yml 里的 insert 条目(或改 disabled: true)即热卸载。
 * 调试: 控制台 window.__TURN_LABELS__ 可读投影条目、内置轨元素与几何
 *      (`.geometry()` / `.contentRight()` 用来核对列宽 = 轨道右缘 - 正文栏右缘)。
 */
window.__ModuleLoader__.load({
	id: "@gavinc-cn/dsh-turn-labels",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** 文字列每行高度(px): 够放 12px 字并留出行间呼吸, 比内置轨 10px 行距更适合读文字。 */
		const ROW_PX = 22;
		/** 文字列最大宽度(px): 实际上取"正文栏右缘 -> 内置轨右缘"这段空白带的宽度, 再夹在这个上限内。 */
		const COLUMN_PX = 176;
		/* 2026-10-06(0.5.0) 删掉原来的 MIN_COLUMN_PX = 120 下限。
		   起因: 正文宽度是可调的(会话区两侧沟槽的宽度拖拽条 -> 局部变量 --dsh-chat-user-width,
		   上限 920px, 存 localStorage dsh.conversation.contentWidth)。正文拉宽后"正文栏右缘 ->
		   轨道右缘"这条空白带会缩到几十像素, 而旧下限会把文字列强撑到 120px, 列左缘被钉在
		   "轨道右缘 - 120" 上, 直接压在正文文字上(2026-10-06 用户截图实测重叠 45px+)。
		   用户约定(2026-10-06): **列表一直在、不设最小宽度、文字截断即可**。
		   所以列宽 = 空白带宽度, 夹在 [0, COLUMN_PX]: 空白带窄了就跟着窄, 行内文字靠
		   textOverflow:ellipsis 截断 —— 宁可显示成一条, 也绝不越到正文上。 */
		/** 内置轨的固定行距(px), 用来把未挂载的 mark 先滚进可视区再点。 */
		const MARK_PITCH_PX = 10;
		/** 内置轨道 frame 的 max-height 兜底(px), 与 ui-chat 的 CSS 一致。 */
		const DEFAULT_MAX_HEIGHT_PX = 420;
		/** 内置轨 frame 的右缘偏移(px): ui-chat 的 `.frame{right:12px}`。 */
		const RAIL_RIGHT_PX = 12;
		/** 内置轨 slot 的左右内边距(px): 内层容器查询量的是它的 content-box(`.slot{padding-inline:...}`)。 */
		const RAIL_SLOT_PAD_PX = 32;
		/** 内置轨被容器查询藏起来的可用宽阈值(px): ui-chat 的 `@container (width<=900px)`。 */
		const RAIL_NARROW_WIDTH_PX = 900;
		/** 内置轨 max-height 公式里的上下留白(px): `min(max(0px, band - 64px), 420px)`。 */
		const RAIL_BAND_GAP_PX = 64;
		/** 定位轨道 / 同步当前轮 / 跟随重量的轮询间隔(ms); 只做 getBoundingClientRect, 开销可忽略。 */
		const PROBE_INTERVAL_MS = 400;
		/** 预览卡经验高度(px): 只用于把它夹在文字列可视范围内。 */
		const CARD_HEIGHT_PX = 108;
		/** 提问条目(小横杠)的行高(px): 比文字行矮, 紧贴在所属轮次文字行下面。 */
		const ASK_ROW_PX = 9;
		/** 小横杠尺寸与默认缩放, 与内置轨原版一致(20x2px, 右对齐, 默认 scaleX(.6))。 */
		const ASK_BAR_WIDTH_PX = 20;
		const ASK_BAR_HEIGHT_PX = 2;
		const ASK_BAR_SCALE = 0.6;
		/** 揭示提问行的重试节奏: 每次 240ms, 最多 12 次(跳轮 + 逐层展开 + 滚动都要等渲染)。 */
		const REVEAL_STEP_MS = 240;
		const REVEAL_MAX_STEPS = 12;
		/**
		 * 一次揭示里最多点几个表头: 折叠只有两层(整轮 / 组内), 第 4 下一定是选错了目标。
		 * 这是最后一道熔断 —— 线上的"点小横杠跑出新会话"就是点击次数没有上限导致的。
		 */
		const REVEAL_MAX_CLICKS = 3;
		/** 一层里最多容忍几个前置兄弟: 折叠容器的结构是 [表头][内容], 再多就说明已经走出折叠结构。 */
		const REVEAL_MAX_PRECEDING = 2;

		/** 文字与卡片统一走主界面设计令牌, 缺失时退回深色值。 */
		const TK = {
			text: "var(--dsw-alias-label-primary, #f2f3f5)",
			text2: "var(--dsw-alias-label-secondary, #cfd3d6)",
			text3: "var(--dsw-alias-label-tertiary, #adb2b8)",
			/** 小横杠: 平时用内置轨那支 border-l4, hover 时提亮成 tertiary(与内置轨 hover 语义一致)。 */
			bar: "var(--dsw-alias-border-l4, rgba(255,255,255,.24))",
			barHover: "var(--dsw-alias-label-tertiary, #adb2b8)",
			caption: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, #adb2b8))",
			hover: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))",
			cardBg: "var(--dsw-alias-bg-layer-1, #232324)",
			shadow: "var(--dsw-elevation-panel, 0 8px 24px rgba(0,0,0,.45))",
			radius: "var(--dsw-radius-lg, 12px)",
			font: "var(--dsw-font-xxs-12, 12px/18px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif)",
			fontStrong: "var(--dsw-font-xs-strong-13, 500 13px/18px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif)",
		};

		/**
		 * 定位内置轮次轨的 <nav>。
		 * 判定依据: 内置轨的刻度是 <button data-index>, 且唯一包在 <nav> 里的就是轨道本身
		 * (会话节点虚拟列表也用 data-index, 但那是 div, 且不在 nav 内)。
		 * @returns 轨道 nav 元素; 当前没渲染时返回 null。
		 */
		function findRailNav() {
			const buttons = document.querySelectorAll("button[data-index]");
			for (const button of buttons) {
				const nav = button.closest("nav");
				if (nav !== null) return nav;
			}
			return null;
		}

		/**
		 * 当前会话的 turnOutline 订阅源 (React useSyncExternalStore 的 store 形状)。
		 * 数据链路: ctx.uiSession.current(主视图会话 id) -> ctx.sessions.binding(id).session.projections
		 * -> faceOf('turnOutline')。会话切换时整体重绑, 投影推送时只在引用变化后通知订阅者。
		 * @param ctx - 客户端 cordis 上下文。
		 * @returns {{subscribe: Function, getSnapshot: Function, dispose: Function}} store。
		 */
		function createOutlineStore(ctx) {
			const EMPTY = [];
			const listeners = new Set();
			let stopFace = null;
			let sessionId;
			let face = null;
			let snapshot = EMPTY;

			/** 值引用变化才通知, 避免 useSyncExternalStore 反复重渲染。 */
			const publish = (value) => {
				if (value === snapshot) return;
				snapshot = value;
				for (const listener of [...listeners]) listener();
			};
			/** 读一次投影值; 投影缺失/形状不对时退化成空数组。 */
			const readFace = () => {
				if (face === null) return EMPTY;
				const value = face.getSnapshot();
				return Array.isArray(value) ? value : EMPTY;
			};
			/** 跟随主视图会话切换, 换绑投影面。 */
			const bindSession = () => {
				const next = ctx.uiSession.current.getSnapshot()?.key;
				if (next === sessionId) return;
				sessionId = next;
				if (stopFace !== null) {
					stopFace();
					stopFace = null;
				}
				face = null;
				const binding = next === undefined ? undefined : ctx.sessions.binding(next);
				const candidate = binding?.session?.projections?.faceOf?.("turnOutline");
				if (candidate !== undefined && candidate !== null && typeof candidate.subscribe === "function") {
					face = candidate;
					stopFace = candidate.subscribe(() => {
						publish(readFace());
					});
				}
				publish(readFace());
			};

			const stopCurrent = ctx.uiSession.current.subscribe(() => {
				bindSession();
				publish(readFace());
			});
			bindSession();

			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				getSnapshot() {
					return snapshot;
				},
				dispose() {
					stopCurrent();
					if (stopFace !== null) stopFace();
					listeners.clear();
				},
			};
		}

		/**
		 * 正文栏(聊天流)的右边界。文字列只占"正文栏右侧 -> 内置轨"这段空白带,
		 * 所以按它算宽度, 既不压正文也不浪费空间; 取不到时返回 null。
		 *
		 * 2026-10-06(0.5.0): `[data-chat-flow]` 不只挂在主聊天列(`ChatView.column`)上 ——
		 * 组内容盒(`ChatGroupSeat.content`, 同时带 `data-step-process-content`)也带这个属性,
		 * 而组内容盒可能比主列窄。取 document 里第一个匹配会量到更小的右缘, 空白带被算大,
		 * 文字列就顺势伸到正文上。改成**在会话滚动区内取最靠右的那个**(主列必然是最大的那个),
		 * 没有再退回全文档范围。
		 * @returns 正文栏右边界(视口坐标 px), 或 null。
		 */
		function readContentRight() {
			const scope = document.querySelector("[data-conversation-scroll]") ?? document;
			let right = null;
			for (const column of scope.querySelectorAll("[data-chat-flow]")) {
				const rect = column.getBoundingClientRect();
				if (rect.width <= 0) continue;
				if (right === null || rect.right > right) right = rect.right;
			}
			return right;
		}

		/**
		 * 两份轨道几何是否等价。轮询每 400ms 跑一次, 只有不等价才 setState,
		 * 免得每拍都触发一次重渲染。
		 * @param left - 上一次几何(可为 null)。
		 * @param right - 本次几何(可为 null)。
		 * @returns 是否等价。
		 */
		function sameRailGeometry(left, right) {
			if (left === null || right === null) return left === right;
			return (
				left.nav === right.nav &&
				left.available === right.available &&
				left.right === right.right &&
				left.centerY === right.centerY &&
				left.maxHeight === right.maxHeight &&
				left.width === right.width
			);
		}

		/**
		 * 内置轨缺席时的等价几何。
		 *
		 * 会话只有 1 轮时 ui-chat 的 TurnNavigator 直接 `return null`(守卫是 `items.length < 2`),
		 * DOM 里没有 <nav> 可量; 这里按内置轨自己的 CSS 公式在会话滚动区上算出同一块区域:
		 *   frame{ right:12px; top: band/2; transform: translateY(-50%);
		 *          max-height: min(max(0px, band - 64px), 420px) }
		 *   band = --dsh-conversation-viewport-height - --dsh-composer-height
		 * 它的包含块是滚动区里的 slot(sticky 在滚动区上缘, 宽 = 滚动区内容宽), 所以:
		 *   上缘 = 滚动区上缘; 右缘 = 滚动区右缘 - 滚动条宽 - 12px(frame 自己的 right:12px)。
		 * 读不到滚动区(或它没有尺寸)时返回 null —— 调用方退回"不渲染", 与旧行为一致。
		 * @returns {{nav: null, available: boolean, right: number, centerY: number, maxHeight: number, width: number}|null}
		 */
		function readRailFallbackGeometry() {
			const scroller = document.querySelector("[data-conversation-scroll]");
			if (scroller === null) return null;
			const rect = scroller.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return null;
			const style = getComputedStyle(scroller);
			// 与内置轨同源的两个 CSS 变量; 缺失时退回 ui-chat CSS 里的默认值(视口高 / 152px 输入框高)。
			const viewportHeight = Number.parseFloat(style.getPropertyValue("--dsh-conversation-viewport-height"));
			const composerHeight = Number.parseFloat(style.getPropertyValue("--dsh-composer-height"));
			const band = (Number.isFinite(viewportHeight) ? viewportHeight : rect.height) - (Number.isFinite(composerHeight) ? composerHeight : 152);
			// 滚动区右缘减掉滚动条宽度 = 内容区(即内置轨 slot)的右缘。
			const contentRight = rect.right - (scroller.offsetWidth - scroller.clientWidth);
			// 内置轨 frame 自己的右缘: 它在 slot 的 padding box 上 `right:12px`(RAIL_RIGHT_PX),
			// 所以"轨道右缘"比 contentRight 再靠左 12px —— 后面算列宽必须用这个值。
			const railRight = contentRight - RAIL_RIGHT_PX;
			const flowRight = readContentRight();
			return {
				nav: null,
				// 内置轨的容器查询量的是 slot 的 content-box 宽度(slot 左右各 32px padding)。
				available: scroller.clientWidth - 2 * RAIL_SLOT_PAD_PX > RAIL_NARROW_WIDTH_PX,
				right: Math.round(window.innerWidth - railRight),
				centerY: Math.round(rect.top + band / 2),
				maxHeight: Math.min(Math.max(0, band - RAIL_BAND_GAP_PX), DEFAULT_MAX_HEIGHT_PX),
				// 文字列宽度 = 轨道右缘 - 正文栏右缘(与内置轨在场时的同一口径), 夹在 [0, MAX] 内:
				// 没有下限(0.5.0) —— 正文拉宽到只剩几像素空白带时, 列就窄成一条, 也不压正文。
				// 2026-10-06(0.5.0) 修掉 0.4.0 的一处 12px 偏差: 旧式子是 `contentRight - flowRight`,
				// 漏了 frame 的 RAIL_RIGHT_PX —— 等价几何下文字列恒定比可用空白带宽 12px, 也就是
				// 恒定压住正文一条(真机实测 overlap 12~13px, 与正文宽度无关)。
				width: Math.max(0, Math.min(COLUMN_PX, flowRight === null ? COLUMN_PX : Math.floor(railRight - flowRight))),
			};
		}

		/**
		 * 跟踪内置轨的位置与尺寸。轨道位置由 CSS(视口高 - 输入框高 的中点)决定, 我们不复制这套
		 * 计算, 直接量它的矩形: 右缘偏移、垂直中心、max-height; 输入框变高/窗口缩放/侧栏开合
		 * 都会在下一次轮询里反映出来。内置轨缺席(会话只有 1 轮)时改用等价几何, 见
		 * readRailFallbackGeometry —— 这一步是"单轮会话也要显示这列文字"的关键。
		 *
		 * 2026-10-06(0.5.0): 正文宽度可以用会话区两侧沟槽里的拖拽条实时拖动
		 * (`--dsh-chat-user-width`), 而**拖拽不触发 window resize** —— 只靠 400ms 轮询,
		 * 拖动过程中文字列会持续压住正文。所以额外给"会话滚动区 + 最靠右的正文栏"挂
		 * ResizeObserver: 正文栏宽度一变就重量, 列宽当拍跟着变(观察目标每次 measure 重认,
		 * 会话切换/虚拟列表重建会换元素)。
		 * @returns {{nav: Element|null, available: boolean, right: number, centerY: number, maxHeight: number, width: number}|null}
		 */
		function useRailGeometry() {
			const [rail, setRail] = React.useState(null);
			React.useEffect(() => {
				let nav = null;
				let stopped = false;
				let observer = null;
				let watchedScroller = null;
				let watchedColumn = null;
				/** 取"最靠右的正文栏"(与 readContentRight 同一口径), 只用来订阅尺寸变化。 */
				const pickContentColumn = () => {
					const scope = document.querySelector("[data-conversation-scroll]") ?? document;
					let best = null;
					let bestRight = -Infinity;
					for (const column of scope.querySelectorAll("[data-chat-flow]")) {
						const rect = column.getBoundingClientRect();
						if (rect.width <= 0 || rect.right <= bestRight) continue;
						best = column;
						bestRight = rect.right;
					}
					return best;
				};
				/** 让 ResizeObserver 盯住"会话滚动区 + 正文栏"; 目标没换就什么都不做。 */
				const watch = () => {
					if (typeof ResizeObserver === "undefined") return;
					const scroller = document.querySelector("[data-conversation-scroll]");
					const column = pickContentColumn();
					if (scroller === watchedScroller && column === watchedColumn) return;
					if (observer !== null) observer.disconnect();
					observer = new ResizeObserver(() => measure());
					if (scroller !== null) observer.observe(scroller);
					if (column !== null && column !== scroller) observer.observe(column);
					watchedScroller = scroller;
					watchedColumn = column;
				};
				const measure = () => {
					if (stopped) return;
					watch();
					if (nav === null || !nav.isConnected) nav = findRailNav();
					if (nav === null) {
						// 没有内置轨: 用等价几何照常画文字列(取不到会话滚动区时 fallback 为 null, 即不渲染)。
						const fallback = readRailFallbackGeometry();
						lastRailGeometry = fallback;
						setRail((prev) => (sameRailGeometry(prev, fallback) ? prev : fallback));
						return;
					}
					const rect = nav.getBoundingClientRect();
					const style = getComputedStyle(nav);
					const maxHeight = Number.parseFloat(style.maxHeight);
					// 文字列宽度 = 轨道右缘 - 正文栏右缘(即那条空白带), 夹在 [0, MAX] 内(0.5.0 起无下限)。
					// 用 floor 不用 round: 宁可窄半像素, 也不让列左缘越过正文栏右缘(round 会向上取整出 1px 压字)。
					const contentRight = readContentRight();
					const band = contentRight === null ? COLUMN_PX : Math.floor(rect.right - contentRight);
					const next = {
						nav,
						// display:none 即容器查询判定"太窄", 此时内置轨自己藏了, 我们也该藏。
						available: style.display !== "none" && rect.width > 0,
						right: Math.round(window.innerWidth - rect.right),
						centerY: Math.round(rect.top + rect.height / 2),
						maxHeight: Number.isFinite(maxHeight) ? maxHeight : DEFAULT_MAX_HEIGHT_PX,
						width: Math.max(0, Math.min(COLUMN_PX, band)),
					};
					lastRailGeometry = next;
					setRail((prev) => (sameRailGeometry(prev, next) ? prev : next));
				};
				measure();
				const timer = setInterval(measure, PROBE_INTERVAL_MS);
				window.addEventListener("resize", measure);
				return () => {
					stopped = true;
					clearInterval(timer);
					window.removeEventListener("resize", measure);
					if (observer !== null) observer.disconnect();
				};
			}, []);
			return rail;
		}

		/**
		 * 盖掉内置刻度轨: 用 visibility:hidden 而不是 display:none —— 前者保留布局尺寸,
		 * 虚拟滚动仍按原样挂可视 mark(我们才能借它的按钮跳转), 同时不再参与命中测试,
		 * 那片区域完全交给我们的文字列。
		 * @param nav - 内置轨道 nav; null 时什么都不做。
		 */
		function useRailCover(nav) {
			React.useEffect(() => {
				if (nav === null || nav === undefined) return undefined;
				const previous = nav.style.visibility;
				nav.style.visibility = "hidden";
				return () => {
					nav.style.visibility = previous;
				};
			}, [nav]);
		}

		/**
		 * 读当前轮索引: 直接借内置轨自己算出的 active mark(aria-current="true"),
		 * 不重复实现一套"可见区中心落在哪一轮"的判定。
		 * @param nav - 内置轨道 nav。
		 * @returns 当前轮的索引; 读不到时 -1。
		 */
		function readActiveIndex(nav) {
			const mark = nav.querySelector('button[aria-current="true"]');
			const index = mark === null ? Number.NaN : Number(mark.dataset.index);
			return Number.isInteger(index) ? index : -1;
		}

		/**
		 * 跳到某轮: 把点击转发到内置轨对应索引的 mark 按钮, 复用官方的翻页与落点逻辑。
		 * mark 是虚拟滚动的, 目标不在可视区(未挂载)时先按固定行距把它滚进来, 下一帧再点。
		 * @param nav - 内置轨道 nav。
		 * @param index - 目标轮在轨道 items 里的索引(与投影条目顺序一致)。
		 */
		function jumpToTurn(nav, index) {
			const click = () => {
				const mark = nav.querySelector(`button[data-index="${index}"]`);
				if (mark === null) return false;
				mark.click();
				return true;
			};
			if (click()) return;
			const scroller = nav.firstElementChild;
			if (scroller === null) return;
			scroller.scrollTop = Math.max(0, index * MARK_PITCH_PX - scroller.clientHeight / 2);
			requestAnimationFrame(() => {
				requestAnimationFrame(click);
			});
		}

		/**
		 * 内置轨缺席时的跳轮兜底: 直接把该轮的宿主滚进会话滚动区。
		 * 官方 mark 按钮的本事是"未加载的轮先翻页再落点", 而缺席只发生在单轮会话
		 * (那一轮必然已加载), 所以这里只需要滚动; 选择器与 revealAskRow 保持一致,
		 * 且**限定在会话滚动区内**, 不碰会话外的任何元素。
		 * @param turn - 投影条目的轮次号。
		 */
		function scrollTurnIntoView(turn) {
			if (!Number.isInteger(turn)) return;
			const scope = document.querySelector("[data-conversation-scroll]");
			if (scope === null) return;
			// 该轮在会话流里的**第一个**节点(通常就是用户那条消息) —— 与内置 mark 的落点语义一致:
			// 落到这一轮的起点, 而不是"整轮过程摘要"那一行; 取不到才退回摘要行。
			const host =
				scope.querySelector(`[data-chat-turn="${turn}"]`) ??
				scope.querySelector(`[data-chat-flow-kind="turn-process"][data-chat-turn="${turn}"]`);
			if (host !== null) host.scrollIntoView({ block: "start", behavior: "smooth" });
		}

		/**
		 * 一行的显示文本: 提问为空(纯图片轮)时退回"第 N 轮", 便于辨认。
		 * @param entry - turnOutline 条目。
		 * @param index - 索引(0 基)。
		 * @returns 行文本。
		 */
		function rowText(entry, index) {
			const prompt = typeof entry?.prompt === "string" ? entry.prompt.trim() : "";
			return prompt === "" ? `第 ${index + 1} 轮` : prompt;
		}

		/**
		 * 边缘渐隐的宽度(px)。只在真的滚得动、且那一侧还有内容时才用, 否则会吃掉首/尾整行。
		 */
		const EDGE_FADE_PX = 10;

		/**
		 * 按滚动状态算上下渐隐的 mask。原则: 只在"那一侧还有内容"时才淡那一侧, 不滚就完全不淡。
		 *   - 已到顶(上方无内容) + 下方还有 → 只淡底边;
		 *   - 已到底(下方无内容) + 上方还有 → 只淡顶边;
		 *   - 两侧都还有内容 → 两侧都淡;
		 *   - 没溢出(或两侧都到底/到顶) → 不加 mask。
		 * @param state - { over: 是否溢出, top: 是否已到顶, bottom: 是否已到底 }。
		 * @returns CSS mask 值; 不需要渐隐时返回 undefined。
		 */
		function edgeMask(state) {
			if (!state.over || (state.top && state.bottom)) return undefined;
			const fade = `${EDGE_FADE_PX}px`;
			const fadeBottomOnly = `linear-gradient(#000 0 calc(100% - ${fade}), #0000 100%)`;
			const fadeTopOnly = `linear-gradient(#0000 0, #000 ${fade})`;
			if (state.top) return fadeBottomOnly;
			if (state.bottom) return fadeTopOnly;
			return `linear-gradient(#0000 0, #000 ${fade}, #000 calc(100% - ${fade}), #0000 100%)`;
		}

		/**
		 * 从 DOM 里找出当前已加载窗口内的所有「提问」行, 归到各自的轮次。
		 * 为什么用 DOM 而不是投影: 提问属于工具调用, `turnOutline` 投影里只有每轮的提问/回答文本,
	 * 没有工具调用信息; 而提问行自身带 `data-tool="ask_user_question"`, 外层 `ztWv_q_callRow`
	 * 带 `data-chat-call-id`(稳定 callId), 祖先带 `data-chat-turn`(轮次号), 直接够用。
		 * 注意: 折叠中的行仍然是 DOM 的一部分(`hidden="until-found"`), 虚拟化移出窗口的行则不在,
		 * 所以条目只覆盖"已加载窗口", 属预期行为。
		 * @returns {{callId: string, turn: number}[]} 按轮次升序的提问条目。
		 */
		function findAsksInDom() {
			const out = [];
			const seen = new Set();
			for (const row of document.querySelectorAll('[data-tool="ask_user_question"]')) {
				const holder = row.closest("[data-chat-call-id]");
				const callId = holder === null ? null : holder.getAttribute("data-chat-call-id");
				const turnHost = row.closest("[data-chat-turn]");
				const turn = turnHost === null ? Number.NaN : Number(turnHost.getAttribute("data-chat-turn"));
				if (callId === null || !Number.isInteger(turn) || seen.has(callId)) continue;
				seen.add(callId);
				out.push({ callId, turn });
			}
			out.sort((left, right) => left.turn - right.turn);
			return out;
		}

		/**
		 * 轮询 DOM 里的提问条目(与几何轮询同频), 内容不变时不触发重渲染。
		 * @returns {{callId: string, turn: number}[]} 提问条目。
		 */
		function useAskEntries() {
			const [asks, setAsks] = React.useState([]);
			React.useEffect(() => {
				let stopped = false;
				let lastKey = null;
				const scan = () => {
					if (stopped) return;
					const next = findAsksInDom();
					const key = next.map((ask) => `${ask.turn}:${ask.callId}`).join("|");
					if (key === lastKey) return;
					lastKey = key;
					setAsks(next);
				};
				scan();
				const timer = setInterval(scan, PROBE_INTERVAL_MS);
				return () => {
					stopped = true;
					clearInterval(timer);
				};
			}, []);
			return asks;
		}

		/** 揭示过程的轨迹(排障用): window.__TURN_LABELS__.revealTrace()。 */
		const revealTrace = [];

		/** 最近一次量到的轨道几何(排障用): window.__TURN_LABELS__.geometry()。 */
		let lastRailGeometry = null;

		/** 空数组常量: 让"这一轮没有提问"走恒等引用, 不产生无谓的重渲染。 */
		const EMPTY_ASKS = [];

		/**
		 * 按 callId 找提问行(可能还没进入渲染窗口, 所以要重试)。
		 * @param callId - 工具调用 id。
		 * @returns 提问行元素, 或 null。
		 */
		function findAskRow(callId) {
			const holder = document.querySelector(`[data-chat-call-id="${callId}"]`);
			const row = holder === null ? null : holder.querySelector('[data-tool="ask_user_question"]');
			if (row !== null) return row;
			return document.querySelector(`[data-tool="ask_user_question"][data-call-id="${callId}"]`);
		}

		/**
		 * 从一个元素(或其后代)里挑一个可点的折叠开关。
		 * @param root - 候选容器。
		 * @returns 可点元素, 或 null。
		 */
		function pickClickable(root) {
			if (root === null || root === undefined) return null;
			if (root.matches("button,[role=button],[data-disclosure-row]")) return root;
			return root.querySelector("button,[role=button],[data-disclosure-row]");
		}

		/**
		 * 这个元素现在能不能点来"展开"? 三个条件缺一不可:
		 *   1. 有可见的布局盒(折叠态的行仍在 DOM 里, 但零尺寸的元素点了也没意义);
		 *   2. 与提问行同处一个会话滚动区内 —— 越界就会点到别的区域去(线上事故的直接原因);
		 *   3. 不是已经展开的(`aria-expanded === "true"`) —— 点它只会把展开的折回去,
		 *      而这一折回去, 后面的候选就全成了乱点。
		 * @param element - 候选元素。
		 * @param scope - 提问行所在的会话滚动区; null 时不做范围校验。
		 * @returns 是否可点。
		 */
		function isRevealable(element, scope) {
			if (element === null || element === undefined) return false;
			if (element.getClientRects().length === 0) return false;
			if (element.getAttribute("aria-expanded") === "true") return false;
			if (scope !== null && !scope.contains(element)) return false;
			return true;
		}

		/**
		 * 列出"能展开这个隐藏体"的表头候选, **由外向内**排序。dsh 的折叠是两层的:
		 *   ① 整轮过程摘要按钮(`[data-chat-flow-kind=turn-process][data-chat-turn=N] > button`,
		 *      文案"已完成，用时 …") —— 它和提问行是同一列里的**兄弟**(不在祖先链上), 所以按选择器直找;
		 *   ② 组内表头 —— 隐藏在折叠容器的内容里, 表头就是它的**紧邻上一个兄弟**。
		 * 两层都没有稳定的选择器, 所以 ② 只能按结构找, 但结构遍历必须自带边界:
		 *   - 只取紧邻的上一个兄弟(文档序离隐藏体最近的那个), 不是文档序最靠前的那个;
		 *   - 走到"聊天列"(轮次过程宿主的父节点)就停 —— 再往上, 前一个兄弟就是侧栏;
		 *   - 一层里前置兄弟超过 REVEAL_MAX_PRECEDING 个也停(已走出折叠结构);
		 *   - 候选必须落在同一个会话滚动区内。
		 * 没有这几条边界时, 祖先链会一路爬到侧栏, 点到 `aria-label="新建会话"` 上 ——
		 * 那会 startSession() 出一个空白会话并把用户带过去(2026-10-03 线上 bug)。
		 * @param row - 提问行元素。
		 * @param hidden - 带 hidden 属性的祖先元素。
		 * @param turn - 该提问所属轮次号。
		 * @returns {Element[]} 候选(先外后内)。
		 */
		function findRevealHeaders(row, hidden, turn) {
			const out = [];
			const scope = row.closest("[data-conversation-scroll]");
			const host = document.querySelector(`[data-chat-flow-kind="turn-process"][data-chat-turn="${turn}"]`);
			const column = host === null ? null : host.parentElement;
			const turnToggle = host === null ? null : host.querySelector("button,[role=button]");
			if (isRevealable(turnToggle, scope)) out.push(turnToggle);
			for (let node = hidden; node !== null && node !== document.body; node = node.parentElement) {
				const parent = node.parentElement;
				if (parent === null) break;
				if (column !== null && parent === column) break;
				if (scope !== null && !scope.contains(parent)) break;
				const before = [];
				for (const sibling of parent.children) {
					if (sibling === node) break;
					before.push(sibling);
				}
				if (before.length > REVEAL_MAX_PRECEDING) break;
				// 由近到远: 离隐藏体最近的那个才可能是它的表头。
				for (let index = before.length - 1; index >= 0; index -= 1) {
					const candidate = pickClickable(before[index]);
					if (isRevealable(candidate, scope)) {
						out.push(candidate);
						break;
					}
				}
			}
			return out;
		}

		/**
		 * 跳到某个提问: 先由调用方完成"跳轮", 这里负责把该提问行**露出来并滚到视口中央**。
		 * 只点开不收: 每个表头在一次揭示里最多点一次, 且只点当前折叠的(见 isRevealable)。
		 * 合法候选用完就**只等不再升级** —— 绝不顺手点别处的按钮(那正是"点出新会话"的根因);
		 * 行的渲染窗口是异步的(跳轮之后才挂上), 所以整个过程是重试循环。
		 * @param callId - 工具调用 id。
		 * @param turn - 该提问所属轮次号。
		 * @returns {Promise<boolean>} 最终是否让该行可见。
		 */
		async function revealAskRow(callId, turn) {
			const clicked = new WeakSet();
			let clicks = 0;
			for (let step = 0; step < REVEAL_MAX_STEPS; step += 1) {
				const row = findAskRow(callId);
				if (row !== null) {
					const hidden = row.closest("[hidden]");
					if (hidden === null) {
						row.scrollIntoView({ block: "center", behavior: "smooth" });
						revealTrace.push({ step, ok: true, callId });
						return true;
					}
					const header =
						clicks >= REVEAL_MAX_CLICKS
							? undefined
							: findRevealHeaders(row, hidden, turn).find((candidate) => !clicked.has(candidate));
					if (header !== undefined) {
						clicked.add(header);
						clicks += 1;
						revealTrace.push({ step, click: (header.textContent ?? "").replace(/\s+/g, " ").slice(0, 30) });
						header.click();
					} else {
						revealTrace.push({ step, hold: (hidden.className || "").toString().slice(0, 24) });
					}
				} else {
					revealTrace.push({ step, wait: "row-not-mounted" });
				}
				await new Promise((resolve) => setTimeout(resolve, REVEAL_STEP_MS));
			}
			// 最后一搏: 行若已挂载(哪怕仍被折叠)也滚一下, 让用户看到它的位置。
			const last = findAskRow(callId);
			if (last !== null) last.scrollIntoView({ block: "center", behavior: "smooth" });
			revealTrace.push({ ok: false, callId });
			return false;
		}

		/**
		 * 构造文字轨组件(闭包持有 store, 不通过 props 传, 与 kanban-board 的注册方式一致)。
		 * @param store - turnOutline store。
		 * @returns 注册进 shell.overlay 的函数组件。
		 */
		function createTurnLabels(store) {
			return function TurnLabels() {
				const entries = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
				const rail = useRailGeometry();
				const nav = rail === null ? null : rail.nav;
				useRailCover(nav);

				const scrollerRef = React.useRef(null);
				const [hover, setHover] = React.useState(null);
				const [hoverAsk, setHoverAsk] = React.useState(null);
				const [activeIndex, setActiveIndex] = React.useState(-1);
				const [scrollState, setScrollState] = React.useState({ over: false, top: true, bottom: true });
				// 已加载窗口里的「提问」条目(每轮可能有多个), 与几何轮询同频刷新。
				const asks = useAskEntries();

				/** 量一次滚动状态: 是否溢出、是否已到顶/到底(决定要不要渐隐、淡哪一侧)。 */
				const measureScroll = React.useCallback(() => {
					const scroller = scrollerRef.current;
					if (scroller === null) return;
					const over = scroller.scrollHeight > scroller.clientHeight + 1;
					const top = scroller.scrollTop <= 1;
					const bottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
					setScrollState((prev) => (prev.over === over && prev.top === top && prev.bottom === bottom ? prev : { over, top, bottom }));
				}, []);

				// 行数/可用高度变化后重新判定是否溢出(否则短列表也会被渐隐吃掉首尾两行)。
				React.useEffect(() => {
					measureScroll();
				}, [measureScroll, entries.length, rail === null ? 0 : rail.maxHeight]);

				// 列自身尺寸变化(输入框变高、字号/缩放变化、可用高度被改)也要重新判定,
				// 否则可能停留在旧判断上: 该淡的不淡, 或短列表被误淡。
				React.useEffect(() => {
					const scroller = scrollerRef.current;
					if (scroller === null || typeof ResizeObserver === "undefined") return undefined;
					const observer = new ResizeObserver(() => {
						measureScroll();
					});
					observer.observe(scroller);
					return () => observer.disconnect();
				}, [measureScroll, entries.length, rail === null ? 0 : rail.maxHeight]);

				// 当前轮高亮: 内置轨跟随滚动更新 active mark, 这里用同频轮询同步过来。
				// 内置轨缺席 = 会话只有 1 轮(见 readRailFallbackGeometry), 那一轮就是当前轮。
				React.useEffect(() => {
					if (nav === null) {
						const only = entries.length === 1 ? 0 : -1;
						setActiveIndex((prev) => (prev === only ? prev : only));
						return undefined;
					}
					const sync = () => {
						const next = readActiveIndex(nav);
						setActiveIndex((prev) => (prev === next ? prev : next));
					};
					sync();
					const timer = setInterval(sync, PROBE_INTERVAL_MS);
					return () => clearInterval(timer);
				}, [nav, entries.length]);

				// 高亮行跟随: 当前轮变化时把它滚进可视区(手工算偏移, 不用 scrollIntoView,
				// 免得连带滚动外层祖先)。
				React.useEffect(() => {
					const scroller = scrollerRef.current;
					if (activeIndex < 0 || scroller === null) return;
					const row = scroller.children[activeIndex];
					if (row === undefined) return;
					const top = row.offsetTop;
					// 行高要按实际量: 带提问小横杠的轮次行比 ROW_PX 高。
					const height = row.offsetHeight > 0 ? row.offsetHeight : ROW_PX;
					if (top < scroller.scrollTop) scroller.scrollTop = top;
					else if (top + height > scroller.scrollTop + scroller.clientHeight) {
						scroller.scrollTop = top + height - scroller.clientHeight;
					}
				}, [activeIndex]);

				/** 按轮次分组的提问条目(轮次号 -> 该轮的提问列表)。 */
				const asksByTurn = new Map();
				for (const ask of asks) {
					const list = asksByTurn.get(ask.turn);
					if (list === undefined) asksByTurn.set(ask.turn, [ask]);
					else list.push(ask);
				}

				// rail === null 只剩"取不到会话滚动区"一种情形(单轮会话内置轨缺席时会走等价几何,
				// rail 仍然非 null); !available 是"会话区太窄, 内置轨自己也藏了"; 没有条目则无事可画。
				if (rail === null || !rail.available || entries.length === 0) return null;

				const nearby = (event) => ({
					index: event.currentTarget.dataset.labelIndex === undefined ? -1 : Number(event.currentTarget.dataset.labelIndex),
					top: event.currentTarget.offsetTop - (scrollerRef.current === null ? 0 : scrollerRef.current.scrollTop),
				});

				const rows = entries.map((entry, index) => {
					const active = index === activeIndex;
					// 这一轮的提问条目(可能多个), 画在该轮文字行下面。
					const turnAsks = asksByTurn.get(Number(entry?.turn)) ?? EMPTY_ASKS;
					const rowButton = h(
						"button",
						{
							key: String(entry?.turn ?? index),
							type: "button",
							"data-label-index": index,
							"aria-label": rowText(entry, index),
							"aria-current": active ? "true" : undefined,
							onMouseEnter: (event) => setHover(nearby(event)),
							onMouseLeave: () => setHover(null),
							onFocus: (event) => setHover(nearby(event)),
							onBlur: () => setHover(null),
							onClick: () => {
								if (nav !== null) jumpToTurn(nav, index);
								else scrollTurnIntoView(Number(entry?.turn));
							},
							style: {
								display: "flex",
								alignItems: "center",
								flex: "0 0 auto",
								width: "100%",
								height: `${ROW_PX}px`,
								boxSizing: "border-box",
								padding: "0 4px 0 0",
								border: 0,
								borderRadius: "4px",
								background: hover !== null && hover.index === index ? TK.hover : "transparent",
								color: active ? TK.text : TK.text3,
								font: TK.font,
								textAlign: "left",
								cursor: "pointer",
								overflow: "hidden",
								pointerEvents: "auto",
							},
						},
						h("span", {
							style: {
								flex: "0 0 auto",
								width: "2px",
								height: "10px",
								marginRight: "6px",
								borderRadius: "1px",
								background: active ? TK.text : "transparent",
							},
						}),
						h(
							"span",
							{
								style: {
									flex: "1 1 auto",
									minWidth: 0,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
									fontWeight: active ? 500 : 400,
								},
							},
							rowText(entry, index),
						),
					);
					if (turnAsks.length === 0) return rowButton;
					// 该轮有提问: 文字行下面紧挨着排小横杠(原版 20x2px, 右对齐, 默认 scaleX(.6)),
					// 每行 9px, 同一轮多个提问依次往下。点击 = 跳到该轮并把提问行露出来、滚到中央。
					return h(
						"div",
						{
							key: `turn-${entry?.turn ?? index}`,
							"data-turn-asks": turnAsks.length,
							style: {
								display: "flex",
								flexDirection: "column",
								flex: "0 0 auto",
								width: "100%",
								// 容器自身不吃指针, 空白处仍穿透到正文; 小横杠按钮自己开 pointerEvents。
								pointerEvents: "none",
							},
						},
						rowButton,
						turnAsks.map((ask) =>
							h(
								"button",
								{
									key: `ask-${ask.callId}`,
									type: "button",
									"data-ask-call-id": ask.callId,
									"aria-label": `跳转到第 ${ask.turn} 轮的提问`,
									onMouseEnter: () => setHoverAsk(ask.callId),
									onMouseLeave: () => setHoverAsk(null),
									onClick: () => {
										const turnIndex = entries.findIndex((candidate) => Number(candidate?.turn) === ask.turn);
										if (nav !== null && turnIndex >= 0) jumpToTurn(nav, turnIndex);
										void revealAskRow(ask.callId, ask.turn);
									},
									style: {
										display: "flex",
										alignItems: "center",
										justifyContent: "flex-end",
										flex: "0 0 auto",
										width: "100%",
										height: `${ASK_ROW_PX}px`,
										padding: "0 4px 0 0",
										border: 0,
										background: "transparent",
										cursor: "pointer",
										pointerEvents: "auto",
									},
								},
								h("span", {
									style: {
										width: `${ASK_BAR_WIDTH_PX}px`,
										height: `${ASK_BAR_HEIGHT_PX}px`,
										borderRadius: "2px",
										background: hoverAsk === ask.callId ? TK.barHover : TK.bar,
										transform: `scaleX(${hoverAsk === ask.callId ? 1 : ASK_BAR_SCALE})`,
										transformOrigin: "100% 50%",
										transition: "transform .14s, background-color .14s",
									},
								}),
							),
						),
					);
				});

				const hostHeight = Math.min(entries.length * ROW_PX + asks.length * ASK_ROW_PX, rail.maxHeight);
				const mask = edgeMask(scrollState);
				const hoveredEntry = hover === null ? undefined : entries[hover.index];
				const card =
					hoveredEntry === undefined
						? null
						: h(
								"div",
								{
									style: {
										position: "absolute",
										right: `calc(100% + 12px)`,
										top: `${Math.max(0, Math.min(hover.top - 6, hostHeight - CARD_HEIGHT_PX))}px`,
										width: "min(300px, 40vw)",
										boxSizing: "border-box",
										padding: "10px 12px",
										borderRadius: TK.radius,
										background: TK.cardBg,
										color: TK.text,
										boxShadow: TK.shadow,
										pointerEvents: "none",
										overflow: "hidden",
									},
								},
								h(
									"div",
									{
										style: {
											font: TK.fontStrong,
											display: "-webkit-box",
											WebkitLineClamp: 1,
											WebkitBoxOrient: "vertical",
											overflow: "hidden",
										},
									},
									rowText(hoveredEntry, hover.index),
								),
								typeof hoveredEntry.response === "string" && hoveredEntry.response !== ""
									? h(
											"div",
											{
												style: {
													marginTop: "4px",
													color: TK.caption,
													font: TK.font,
													display: "-webkit-box",
													WebkitLineClamp: 3,
													WebkitBoxOrient: "vertical",
													overflow: "hidden",
												},
											},
											hoveredEntry.response,
										)
									: null,
							);

				return h(
					"div",
					{
						style: {
							position: "fixed",
							right: `${rail.right}px`,
							top: `${rail.centerY}px`,
							transform: "translateY(-50%)",
							width: `${rail.width}px`,
							maxHeight: `${rail.maxHeight}px`,
							display: "flex",
							flexDirection: "column",
							// 只让行本身接管指针, 列内空白处仍然点击穿透到正文。
							pointerEvents: "none",
							zIndex: 21,
						},
					},
					h(
						"div",
						{
							ref: scrollerRef,
							style: {
								display: "flex",
								flexDirection: "column",
								overflowY: "auto",
								overflowX: "hidden",
								scrollbarWidth: "none",
								// 按需渐隐: 只有真溢出、且那一侧还有内容时才淡出, 短列表(不滚)完全不淡,
								// 免得首/尾两行被吃掉一部分。
								maskImage: mask,
								WebkitMaskImage: mask,
							},
							onScroll: measureScroll,
						},
						rows,
					),
					card,
				);
			};
		}

		/**
		 * 客户端插件体: 建一个 turnOutline 订阅源, 再把文字轨挂到 shell.overlay 槽。
		 * @param ctx - 客户端 cordis 上下文 (经 exports.inject 声明依赖 slots/sessions/uiSession)。
		 */
		function apply(ctx) {
			const store = createOutlineStore(ctx);
			ctx.effect(() => () => {
				store.dispose();
			});
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "dsh-turn-labels",
					},
					createTurnLabels(store),
				),
			);
			// 调试句柄: 控制台 window.__TURN_LABELS__.entries() / .rail() / .fallback() / .asks()
			//          / .revealTrace() / .geometry() / .contentRight()
			if (typeof window !== "undefined") {
				window.__TURN_LABELS__ = {
					version: "0.5.0",
					entries: () => store.getSnapshot(),
					rail: () => findRailNav(),
					/** 内置轨缺席时用的等价几何(单轮会话); 有内置轨时返回 null, 不影响它。 */
					fallback: () => readRailFallbackGeometry(),
					/** 最近一次量到的轨道几何(nav/available/right/centerY/maxHeight/width)。 */
					geometry: () => lastRailGeometry,
					/** 实时量的正文栏右缘(px, 视口坐标); 文字列宽度 = 轨道右缘 - 它。 */
					contentRight: () => readContentRight(),
					/** 当前已加载窗口里的提问条目(轮次 + callId)。 */
					asks: () => findAsksInDom(),
					/** 最近一次"点击小横杠 -> 揭示提问行"的过程轨迹。 */
					revealTrace: () => revealTrace.slice(-12),
					/** 手动触发一次揭示(排障用)。 */
					reveal: (callId, turn) => revealAskRow(callId, turn ?? findAsksInDom().find((ask) => ask.callId === callId)?.turn),
				};
			}
		}

		exports.apply = apply;
		exports.inject = ["slots", "sessions", "uiSession"];
		return module.exports;
	},
});
