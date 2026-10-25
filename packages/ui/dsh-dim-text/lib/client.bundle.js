/**
 * 文字配色插件 — 浏览器半 (DSH 客户端模块加载器的 CJS 工厂格式, 与 ui-theme/kanban-board 一致)。
 *
 * 目的: 深色模式下正文 #f9fafb 对背景 #151517 的对比度是 17.45:1 (WCAG AAA 只要 7:1),
 * 过于刺眼。这里经官方扩展点 ctx.theme.overrideTokens(source, tokens) 在当前主题上叠一层
 * 令牌覆盖, 把整条文字梯度按 DSH 自带的「中性蓝灰」色板 (--dsw-static-neutral-bluish-*)
 * 整体下移, 层次关系保持不变。2026-10-24 起可选 3 档, 原来的调暗效果 = 最高档:
 *
 *   档位   --dsw-alias-label-*            色板来源        对 #151517 的对比度
 *   高     primary   #cfd3d6 (bluish-300) 300/400/500     12.11:1 (原来的效果)
 *          secondary #adb2b8 (bluish-400)                 8.54:1
 *          tertiary  #979da6 (bluish-500)                 6.68:1
 *   中     primary   #adb2b8 (bluish-400) 400/500/600      8.54:1
 *          secondary #979da6 (bluish-500)                 6.68:1
 *          tertiary  #81858c (bluish-600)                 4.92:1
 *   低     primary   #979da6 (bluish-500) 500/600/700      6.68:1
 *          secondary #81858c (bluish-600)                 4.92:1
 *          tertiary  #61666b (bluish-700)                 3.14:1
 *
 * 只做 3 档的理由: 每档 = 三个 token 沿色板整体下移一级; 再下一级 (600/700/750) 的三级文字
 * #43454a 对 #151517 只剩 ~1.9:1, 连 DSH 自己最暗的 caption 文字都不如, 没有可用性。
 *
 * 档位持久化: 浏览器 localStorage, 键 dsh.dim-text.level (JSON 字符串 high|medium|low)。
 * 与自研 UI 插件 dsh-sidebar-width-persist / dsh-session-unread-persist 同一套做法 ——
 * 只影响本浏览器 origin, 刷新不丢, 多标签页经 storage 事件同步。**不改宿主代码** ⇒
 * 浏览器半热重载/刷新即生效, 不需要重启 dsh web。
 *
 * 选项页面 (2026-10-24 新增): 侧边栏「插件」→ 已安装插件 @gavinc-cn/dsh-plugins-ui 卡片 →
 * 组件行「界面文字调暗」→ 点行标题进入该行的配置页。页面经官方 keyed slot
 * `plugins.row.config` 注册, key 必须等于 `<bundle 包名>#<行 id>`, 即
 * @gavinc-cn/dsh-plugins-ui#dsh-dim-text (行 id 由 bundle 的 cordis.patch.yml 声明)。
 * 本插件没有宿主侧 settings 命名空间, 也不依赖插件管理器的配置表单 (form 参数不用):
 * 页面自己读写 localStorage, 选中即生效 (三段 SegmentedControl, 无保存按钮)。
 *
 * light 值一律填原色, 所以浅色模式不受影响; 明暗两套值必须都给, 否则 overrideTokens 抛错。
 * 覆盖层只存在于内存, 插件停用/卸载时移除; 档位选择本身留在 localStorage 里。
 */

window.__ModuleLoader__.load({
  // 模块 id 必须等于包名 (@gavinc-cn/dsh-dim-text), 理由见 kanban-board/lib/client.bundle.js 同处注释:
  // boot 清单行 id 取自包名, 不一致会被加载器判为 "loaded without registering"。
  id: "@gavinc-cn/dsh-dim-text",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // 平台模块表 (window.__DSH_BOOT__ 的 seed table) 里的共享单例: React 与 UI 基础组件。
    // 两者都是 DSH 客户端基线模块, 不需在 package.json 的 dsh.client.external 里声明。
    const react = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    /** 覆盖层身份, 同时作为该层的 source 名 (同一 source 重复调用会整体替换并重新叠到最上层)。 */
    const SOURCE = "dsh-dim-text";

    /** 本插件在 locale 服务里的字典命名空间。 */
    const NS = "dim-text";

    /** 日志前缀 (出问题只 console.warn, 不能因为一个观感插件把 GUI 弄崩)。 */
    const LOG_PREFIX = "[dsh-dim-text]";

    /** 档位持久化的 localStorage 键 (JSON 字符串; 清掉它 = 回到默认「高」)。 */
    const STORAGE_KEY = "dsh.dim-text.level";

    /** 默认/最高档: 保持 2026-10-24 之前的既有观感。 */
    const DEFAULT_LEVEL = "high";

    /**
     * 行配置页在 `plugins.row.config` 槽里的 key: `<bundle 包名>#<行 id>`。
     * 行 id 由 @gavinc-cn/dsh-plugins-ui 的 cordis.patch.yml 声明为 dsh-dim-text;
     * 插件管理器据此把「配置」入口挂到那一行上。两者不一致 = 页面注册成功但不显示。
     */
    const ROW_CONFIG_KEY = "@gavinc-cn/dsh-plugins-ui#dsh-dim-text";

    /**
     * 深色主题下的三档取值。每档 = 三个 token 沿 DSH 中性蓝灰色板 (bluish-300..700)
     * 整体下移一级, 所以梯度的层级关系在每一档内部保持一致。数组顺序 = 选择控件的顺序
     * (从最亮到最暗)。
     */
    const LEVELS = [
      {
        id: "high",
        dark: { primary: "#cfd3d6", secondary: "#adb2b8", tertiary: "#979da6" },
      },
      {
        id: "medium",
        dark: { primary: "#adb2b8", secondary: "#979da6", tertiary: "#81858c" },
      },
      {
        id: "low",
        dark: { primary: "#979da6", secondary: "#81858c", tertiary: "#61666b" },
      },
    ];

    /** token 名 -> 角色。三个角色名同时决定深色档位表和浅色原值的结构。 */
    const TOKEN_NAMES = {
      primary: "--dsw-alias-label-primary",
      secondary: "--dsw-alias-label-secondary",
      tertiary: "--dsw-alias-label-tertiary",
    };

    /**
     * 浅色模式的原值 (DSH 浅色主题自己的 label 色, 与 2026-10-24 之前的插件一致)。
     * 浅色模式一律不调暗: 三个档位只在 dark 值上不同。
     */
    const LIGHT_VALUES = {
      primary: "#0f1115",
      secondary: "#61666b",
      tertiary: "#81858c",
    };

    // ─────────────────────────── 档位状态 (模块实例内) ───────────────────────────

    /**
     * 当前档位 id。工厂只在插件 materialize 时执行一次, 所以这里的模块级变量生命周期
     * 与插件实例一致; 插件被 HMR 替换时新工厂会拿到一份新状态 (并从 localStorage 重新播种)。
     */
    let levelId = readStoredLevel();

    /** 档位变化的订阅者: 覆盖层重绘 (apply 时注册) + React 的 useSyncExternalStore。 */
    const listeners = new Set();

    /** @returns 当前档位 id (字符串, 可直接给 useSyncExternalStore 当快照)。 */
    function getLevelId() {
      return levelId;
    }

    /**
     * 订阅档位变化。
     * @param listener - 变化回调。
     * @returns 取消订阅的函数。
     */
    function subscribeLevel(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    /** 通知所有订阅者 (React 重渲染 + 覆盖层重绘走同一条链)。 */
    function emitLevelChange() {
      for (const listener of [...listeners]) listener();
    }

    /**
     * 切换档位: 校验 -> 落盘 -> 通知。
     * 非法值、与当前档位相同 = 什么都不做 (storage 事件回放时不会反过来再写一次盘)。
     * @param next - 目标档位 id。
     * @param options.persist - false 表示只改内存 (采纳其他标签页的写入, 不回写)。
     */
    function setLevelId(next, options = {}) {
      if (!isLevelId(next) || next === levelId) return;
      levelId = next;
      if (options.persist !== false) writeStoredLevel(next);
      emitLevelChange();
    }

    /**
     * 从 localStorage 播种/刷新档位。
     * 取值非法与读失败都回落到默认档 (持久化只是锦上添花, 不能挡住插件本身生效)。
     * @returns 合法档位 id。
     */
    function readStoredLevel() {
      if (typeof localStorage === "undefined") return DEFAULT_LEVEL;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return DEFAULT_LEVEL;
        const stored = JSON.parse(raw);
        return isLevelId(stored) ? stored : DEFAULT_LEVEL;
      } catch (error) {
        console.warn(`${LOG_PREFIX} 读取 ${STORAGE_KEY} 失败, 按默认档位处理:`, error);
        return DEFAULT_LEVEL;
      }
    }

    /**
     * 把档位写入 localStorage。
     * 写失败 (隐私模式配额/被禁用) 只警告: 本次会话里档位照常生效, 刷新后回到旧档。
     * @param next - 要落盘的档位 id。
     */
    function writeStoredLevel(next) {
      if (typeof localStorage === "undefined") return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (error) {
        console.warn(`${LOG_PREFIX} 写入 ${STORAGE_KEY} 失败, 刷新后会回到上一档:`, error);
      }
    }

    /**
     * 是否为合法档位 id。
     * @param value - 待校验值 (来自 localStorage / 组件回调, 都可能是脏数据)。
     * @returns 是否命中 LEVELS 里的一档。
     */
    function isLevelId(value) {
      return LEVELS.some((level) => level.id === value);
    }

    // ─────────────────────────── token 覆盖表 ───────────────────────────

    /**
     * 构造某一档的令牌覆盖表 (名 -> { light, dark } 双值)。
     * @param id - 档位 id; 非法值回落到第一档 (高), 保证覆盖层永远有值可叠。
     * @returns 可直接交给 ctx.theme.overrideTokens 的覆盖表。
     */
    function tokensFor(id) {
      const level = LEVELS.find((candidate) => candidate.id === id) ?? LEVELS[0];
      const tokens = {};
      for (const [role, name] of Object.entries(TOKEN_NAMES)) {
        tokens[name] = { light: LIGHT_VALUES[role], dark: level.dark[role] };
      }
      return tokens;
    }

    // ─────────────────────────── locale 字典 ───────────────────────────

    /** 中文文案 (键集是两者的真源, 必须与 en 完全一致)。 */
    const zh = {
      "title": "文字亮度",
      "hint": "选择界面文字的亮度档位。「高」是原来的调暗效果，每往下一档，整条文字梯度再暗一级（按 DSH 自带的蓝灰色板下移）。仅深色模式生效。",
      "level.high": "高",
      "level.medium": "中",
      "level.low": "低",
      "summary": "当前亮度：{level}",
      "previewLabel": "深色模式预览",
      "previewPrimary": "主要文字 Aa 示例",
      "previewSecondary": "次要文字 Aa 示例",
      "previewTertiary": "三级文字 Aa 示例",
    };

    /** 英文文案 (键集与 zh 一致)。 */
    const en = {
      "title": "Text brightness",
      "hint": "Pick how bright UI text is. High is the original dimmed level; each step down dims the whole text ladder one more notch along DSH's own bluish-gray palette. Dark mode only.",
      "level.high": "High",
      "level.medium": "Medium",
      "level.low": "Low",
      "summary": "Brightness: {level}",
      "previewLabel": "Dark-mode preview",
      "previewPrimary": "Primary text Aa sample",
      "previewSecondary": "Secondary text Aa sample",
      "previewTertiary": "Tertiary text Aa sample",
    };

    // ─────────────────────────── 配置页 (行详情页里的 section) ───────────────────────────

    /** 页面容器: 与插件管理器的 detailSection 同样的纵向节奏, 宽度限制在可读范围。 */
    const SECTION_STYLE = {
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      maxWidth: "520px",
      color: "var(--dsw-alias-label-primary)",
    };

    /** 小节标题: 对齐插件管理器的 sectionTitle (14px/500)。 */
    const TITLE_STYLE = {
      margin: 0,
      fontSize: "14px",
      fontWeight: 500,
      lineHeight: "20px",
    };

    /** 说明文字: 对齐插件管理器的 detailName / hint (12px, 三级文字)。 */
    const HINT_STYLE = {
      margin: 0,
      fontSize: "12px",
      lineHeight: "18px",
      color: "var(--dsw-alias-label-tertiary)",
    };

    /** 分段选择器容器: 三段短标签不需要占满整个小节宽度, 限到 320px 更像「选择项」而非标签栏。 */
    const CONTROL_SEAT_STYLE = { maxWidth: "320px" };

    /**
     * 预览卡片: 固定用深色背景 #151517 (档位只影响深色模式), 让用户在浅色主题下
     * 也能看到三档的实际文字颜色。边框/圆角跟 DSH 的卡片语言一致。
     */
    const PREVIEW_STYLE = {
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      marginTop: "4px",
      padding: "12px 14px",
      border: "0.5px solid var(--dsw-alias-border-l3)",
      borderRadius: "12px",
      background: "#151517",
    };

    /** 预览卡片的小标题 (深色卡片里的三级文字, 固定色值不受档位影响)。 */
    const PREVIEW_LABEL_STYLE = {
      margin: 0,
      fontSize: "11px",
      lineHeight: "16px",
      color: "#81858c",
    };

    /**
     * 预览面板的可见性样式。注意不能只靠 `hidden` 属性: PREVIEW_STYLE 里的内联
     * `display: flex` 会盖过浏览器对 `[hidden]` 的 `display: none`, 三块预览会同时显示。
     * 所以隐藏态直接写内联 `display: none` (hidden 属性保留, 给读屏/语义一个交代)。
     * @param visible - 是否显示这块面板。
     * @returns React 内联样式对象。
     */
    function previewPanelStyle(visible) {
      return visible ? PREVIEW_STYLE : { display: "none" };
    }

    /**
     * 构造预览行的样式: 文字颜色 = 该档位该 token 的深色值。
     * @param color - 档位色值 (十六进制)。
     * @returns React 内联样式对象。
     */
    function previewLineStyle(color) {
      return { margin: 0, fontSize: "13px", lineHeight: "20px", color };
    }

    /**
     * 行配置页组件: 三段式亮度选择 + 当前档位的深色模式预览。
     * 选中立即生效 (写 localStorage + 重绘 token 覆盖层), 没有保存按钮。
     * @param props - slot 注入的页面参数: view ('summary' | 'page') 与 locale 的 t。
     * @returns summary 视图返回一行文字; page 视图返回小节的 React 元素。
     */
    function BrightnessPage(props) {
      const { t } = props;
      const current = react.useSyncExternalStore(subscribeLevel, getLevelId);
      const controlId = react.useId();

      // 行描述缺失时插件管理器用 summary 视图当卡片一行说明。
      if (props.view === "summary") return t("summary", { level: t(`level.${current}`) });

      return react.createElement(
        "section",
        { style: SECTION_STYLE, "data-dsh-dim-text": "" },
        [
          react.createElement("h4", { key: "title", style: TITLE_STYLE }, t("title")),
          react.createElement("p", { key: "hint", style: HINT_STYLE }, t("hint")),
          react.createElement(
            "div",
            { key: "control-seat", style: CONTROL_SEAT_STYLE },
            react.createElement(primitives.SegmentedControl, {
              id: controlId,
              // SegmentedControl 用 label 当 tablist 的无障碍名称。
              label: t("title"),
              value: current,
              options: LEVELS.map((level) => ({ value: level.id, label: t(`level.${level.id}`) })),
              onChange: (next) => {
                setLevelId(next);
              },
            }),
          ),
          // 每个档位各渲染一块预览面板 (id 与 SegmentedControl 的 aria-controls 对齐),
          // 只显示当前档位的那块: 切换档位时预览与全局文字同时变化。
          ...LEVELS.map((level) =>
            react.createElement(
              "div",
              {
                key: `preview-${level.id}`,
                id: `${controlId}-${level.id}-panel`,
                role: "tabpanel",
                "aria-labelledby": `${controlId}-${level.id}`,
                hidden: level.id !== current,
                style: previewPanelStyle(level.id === current),
              },
              [
                react.createElement("p", { key: "label", style: PREVIEW_LABEL_STYLE }, t("previewLabel")),
                react.createElement("p", { key: "primary", style: previewLineStyle(level.dark.primary) }, t("previewPrimary")),
                react.createElement("p", { key: "secondary", style: previewLineStyle(level.dark.secondary) }, t("previewSecondary")),
                react.createElement("p", { key: "tertiary", style: previewLineStyle(level.dark.tertiary) }, t("previewTertiary")),
              ],
            ),
          ),
        ],
      );
    }

    // ─────────────────────────── 插件体 ───────────────────────────

    /**
     * 客户端插件体: 叠一层令牌覆盖并把它绑到插件生命周期上, 再把行配置页注册到
     * 插件管理器的 `plugins.row.config` 槽; 档位变化时替换覆盖层。
     * @param ctx - 客户端 cordis 上下文 (经 exports.inject 声明 theme/locale/slots 依赖)。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dim-text: dictionaries");

      // 覆盖层: 每次档位变化重新 overrideTokens(SOURCE, ...) —— 同一 source 会替换旧层
      // 并重新叠到最上层; 卸载时用最新的 disposer 移除, 不留残余覆盖。
      let removeLayer = null;
      const paint = () => {
        removeLayer = ctx.theme.overrideTokens(SOURCE, tokensFor(levelId));
      };
      paint();
      ctx.effect(
        () => () => {
          if (removeLayer !== null) removeLayer();
        },
        "dim-text: token override layer",
      );
      ctx.effect(() => subscribeLevel(paint), "dim-text: repaint on level change");

      // 多标签页: 另一个标签页改了档位 -> 只采纳、不回写 (避免写风暴)。
      const onStorage = (event) => {
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        setLevelId(readStoredLevel(), { persist: false });
      };
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        window.addEventListener("storage", onStorage);
        ctx.effect(
          () => () => {
            window.removeEventListener("storage", onStorage);
          },
          "dim-text: cross-tab sync",
        );
      }

      // 插件管理器的行配置页: ctx.slots.inject 等声明方 (插件管理器主面板) 出现后再注册,
      // 声明方卸载/热重载时自动撤掉并在地面恢复后重注册。
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          {
            name: "plugins.row.config",
            key: ROW_CONFIG_KEY,
            locale: NS,
          },
          BrightnessPage,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["theme", "locale", "slots"];
    return module.exports;
  },
});
