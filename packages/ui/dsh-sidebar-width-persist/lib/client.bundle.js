/**
 * 侧栏宽度持久化插件 —— 浏览器半 (DSH 客户端模块加载器的 CJS 工厂格式, 与
 * dsh-session-unread-persist / dsh-dim-text / dsh-turn-labels 一致)。
 *
 * 目的: 左侧边栏的宽度在 dsh 里只是一个**内存字段** ——
 *   dsh-client-ui-layout 的 createLayoutStore() 里 init 硬编码 layoutInfo.sidebar = 280
 *   (columns.d.ts 的 SIDEBAR_DEFAULT), 且 defineStore 的 spec 没传 persist
 *   (dsh-client-store 支持 persist: localStorage 键, workspace 的 dsh.sessions.current 就是
 *    这么存的)。所以每次刷新页面都是新实例、必回 280 —— 不是 bug, 是设计如此。
 *
 * 做法: 不碰任何成品包, 在本插件里把 width 镜像到 localStorage。
 *   1. 找到 ui-layout 的 root store 实例: ctx.slots.entries("root") 的每个条目带 .store
 *      (dsh-client-ui-slots 把注册时的 options.store 原样存进条目), 而 ui-layout 注册时传的是
 *      {...handle, create: () => instance} —— 所以 store.create() 拿到的**就是 AppFrame 正在用的
 *      那个活实例**, 不是新的一份。拿到后可 getSnapshot() 读 / subscribe() 听 / actions.setSidebar() 写。
 *      用 spec.actions.setSidebar 是否存在做指纹(纯结构判断, 不执行别人的 init)。
 *      找不到就订阅 ctx.slots.subscribe("root", …) 等它注册/热重载后重新挂载, 不依赖加载顺序。
 *   2. 语义(用户 2026-10-09 选定 "C"):
 *      - 拖动 (>0 → >0): 落盘当前宽度;
 *      - 收起 (>0 → 0): **保留**盘上的宽度 (不写 0);
 *      - 重开 (0 → >0): 原生 toggleSidebar 写死 280, 这里覆盖成盘上记住的宽度;
 *      - 首次挂载: 盘上有值且当前不是该值 → setSidebar(恢复值)。
 *      判据依据: AppFrame 只在 !sidebarCollapsed 时渲染拖动把手, 折叠态根本没有把手,
 *      所以 setSidebar 不可能在 0 态被调用 ⇒ 快照的 0 → >0 只可能是「重开」。
 *   3. 落盘去抖 200ms: 拖动中 store 每 rAF 帧发布一次 (setSidebar 从把手 onDrag 来),
 *      不能每帧写 localStorage; 页面隐藏/卸载时补一次 flush, 免得刚拖完就刷新丢值。
 *   4. 容错: 无 localStorage / 坏 JSON / 值非法 / 找不到 store → 只 console.warn,
 *      降级为「没有这个插件」, 绝不打断界面(与 dsh-client-store 的 attachPersistence 取向一致)。
 *
 * 边界(已知, 与原生无关):
 *   - 折叠状态本身**不持久化**(用户选的是 C 而不是 B): 收起后刷新, 侧栏仍是打开的, 宽度 = 记住的值。
 *   - 多标签页: 最后一次改动者胜; 不做运行时互相同步, 只在「首次挂载 / 重开」时读盘上的值。
 *   - 只有拖动过(或展开过)才落盘: 从未拖动过的会话里 localStorage 是空的, 行为与原生完全一致。
 *   - 依赖 dsh 内部字段(layoutInfo.sidebar / root 条目的 store / toggleSidebar 的 280 重开值),
 *     dsh 升级后若结构变化, 会静默降级为「没这个插件」。
 *
 * 生效链路: 本包由 profile 的 cordis.patch.yml insert 条目挂载; client bundle 属于 client-hmr
 * 监控的图行, 改本文件后 webserver stat-poll 到变化即热重载。
 *
 * 移除方式: 删掉 cordis.patch.yml 里对应的 insert 条目, 删除本目录, 重启 dsh web;
 * 顺手可 `localStorage.removeItem("dsh.layout.sidebarWidth")`。
 *
 * 设计文档: doc_ai/spec/dsh-plugin/dsh-sidebar-width-persist.md
 */
window.__ModuleLoader__.load({
  // 模块 id 必须等于包名 (@gavinc-cn/dsh-sidebar-width-persist), 理由见 kanban-board 同处注释:
  // boot 清单行 id 取自包名, 不一致会被加载器判为 "loaded without registering"。
  id: "@gavinc-cn/dsh-sidebar-width-persist",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /**
     * localStorage 键: 侧栏宽度(px, JSON 数字)。
     * 命名与 dsh 自有的 dsh.sessions.current / dsh.sessions.completionUnread 同族。
     */
    const STORAGE_KEY = "dsh.layout.sidebarWidth";
    /** 统一日志前缀, 便于在浏览器控制台按插件名过滤。 */
    const LOG_PREFIX = "[dsh-sidebar-width-persist]";
    /** 拖动落盘去抖: store 每帧发布, 攒到停手后再写一次盘。 */
    const WRITE_DEBOUNCE_MS = 200;
    /** 原生「重开侧栏」写死的宽度(dsh-client-ui-layout 的 toggleSidebar), 仅用于日志措辞。 */
    const NATIVE_REOPEN_WIDTH = 280;
    /** 原生拖动钳制区间(dsh-client-ui-layout 的 SIDEBAR_MIN / SIDEBAR_MAX)。 */
    const SIDEBAR_MIN = 264;
    const SIDEBAR_MAX = 420;

    /**
     * 判断一个候选值能否当作「记住的宽度」用。
     * 只认有限数且在原生钳制区间内 —— 盘上有别的程序写的脏值时不参与恢复。
     * @param {unknown} value - 待检查的值。
     * @returns {boolean} 可用返回 true。
     */
    function isUsableWidth(value) {
      return typeof value === "number" && Number.isFinite(value) && value >= SIDEBAR_MIN && value <= SIDEBAR_MAX;
    }

    /**
     * 读回上次记住的宽度。
     * 无 localStorage / 坏 JSON / 值非法一律按「没有记录」处理: 持久化只是锦上添花,
     * 不能因为它让页面挂掉。
     * @returns {number|null} 记住的宽度, 没有则 null。
     */
    function readSavedWidth() {
      if (typeof localStorage === "undefined") return null;
      let raw;
      try {
        raw = localStorage.getItem(STORAGE_KEY);
      } catch (error) {
        console.warn(`${LOG_PREFIX} 读取 ${STORAGE_KEY} 失败, 按未记录处理:`, error);
        return null;
      }
      if (raw === null) return null;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        console.warn(`${LOG_PREFIX} ${STORAGE_KEY} 不是合法 JSON, 按未记录处理:`, error);
        return null;
      }
      if (!isUsableWidth(parsed)) {
        console.warn(`${LOG_PREFIX} ${STORAGE_KEY} 的值 ${raw} 不是 ${SIDEBAR_MIN}-${SIDEBAR_MAX} 的宽度, 忽略`);
        return null;
      }
      return parsed;
    }

    /**
     * 落盘一次宽度 (配额满 / 隐私模式失败只警告, 不影响界面)。
     * 值没变时不写: setSidebar 每次都会发布, 避免无意义地打扰别的标签页。
     * @param {number} px - 要记住的宽度。
     */
    function writeSavedWidth(px) {
      if (typeof localStorage === "undefined") return;
      if (!isUsableWidth(px)) return;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw !== null && JSON.parse(raw) === px) return;
      } catch {
        /* 读失败就当值变了, 直接写 */
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(px));
      } catch (error) {
        console.warn(`${LOG_PREFIX} 写入 ${STORAGE_KEY} 失败, 刷新后会丢失侧栏宽度:`, error);
      }
    }

    /**
     * 从槽位条目里认出 ui-layout 的 root store。
     * 指纹只看结构, 不执行别人的 init: 布局 store 的 actions 表里有 setSidebar。
     * @param {unknown} handle - 条目上的 store handle。
     * @returns {boolean} 是布局 store 返回 true。
     */
    function isLayoutStoreHandle(handle) {
      return (
        typeof handle === "object" &&
        handle !== null &&
        typeof handle.create === "function" &&
        typeof handle.spec?.actions?.setSidebar === "function"
      );
    }

    /**
     * 在当前已注册的 root 槽位里找布局 store 实例。
     * ui-layout 传给 register() 的是 {...handle, create: () => instance}, 因此 create() 返回的
     * 就是宿主正在使用的那一个实例 (框架内部对同一 handle 也走同一份缓存)。
     * 多个命中时取**最后一个**——entries() 按注册顺序返回, 热重载瞬间新旧两个条目可能同时在场,
     * 取新的那个才不会再挂到已经死掉的旧实例上(旧条目随后被摘掉时也会再通知一次)。
     * @param {object} slots - 客户端的 slots 服务。
     * @returns {object|null} store 实例, 尚未注册时 null。
     */
    function findLayoutInstance(slots) {
      let entries;
      try {
        entries = slots.entries("root");
      } catch (error) {
        console.warn(`${LOG_PREFIX} 读取 root 槽位失败:`, error);
        return null;
      }
      let found = null;
      for (const entry of entries ?? []) {
        const handle = entry?.store;
        if (!isLayoutStoreHandle(handle)) continue;
        try {
          const instance = handle.create();
          if (instance && typeof instance.getSnapshot === "function" && typeof instance.subscribe === "function") {
            found = instance;
          }
        } catch (error) {
          console.warn(`${LOG_PREFIX} 创建布局 store 实例失败:`, error);
        }
      }
      return found;
    }

    /**
     * 读实例当前快照里的侧栏宽度。
     * @param {object} instance - 布局 store 实例。
     * @returns {number|null} 宽度, 结构不符时 null。
     */
    function readSidebarWidth(instance) {
      const snapshot = instance.getSnapshot();
      const px = snapshot?.layoutInfo?.sidebar;
      return typeof px === "number" && Number.isFinite(px) ? px : null;
    }

    /**
     * 客户端插件体: 给布局 store 的 sidebar 字段补一层 localStorage 持久化。
     * @param {object} ctx - 客户端 cordis 上下文 (经 exports.inject 声明依赖 slots)。
     */
    function apply(ctx) {
      // 依赖的是 dsh 内部服务: 版本变化导致拿不到时, 只降级为「没有这个插件」, 不报错打断界面。
      const slots = ctx?.slots;
      if (!slots || typeof slots.entries !== "function" || typeof slots.subscribe !== "function") {
        console.warn(`${LOG_PREFIX} 当前 dsh 版本的 ctx.slots 不可用, 未启用侧栏宽度持久化`);
        return;
      }
      ctx.effect(() => {
        let active = true;
        /** 当前挂着的布局 store 实例; null = 还没找到(等待 root 槽位注册)。 */
        let instance = null;
        /** 卸载实例订阅用。 */
        let offStore = null;
        /** 上一次观测到的宽度, 用来区分「拖动」与「重开(0 → >0)」。 */
        let prevWidth = null;
        /** 去抖计时器与待落盘的值。 */
        let writeTimer = null;
        let pendingWidth = null;

        /**
         * 把攒着的宽度立刻落盘 (页面隐藏 / 卸载 / 卸载插件时用)。
         */
        const flushWrite = () => {
          if (pendingWidth === null) return;
          const px = pendingWidth;
          pendingWidth = null;
          writeSavedWidth(px);
        };

        /**
         * 安排一次落盘: 拖动是每帧发布, 攒 200ms 再写, 避免每帧一次同步 I/O。
         * @param {number} px - 当前宽度。
         */
        const scheduleWrite = (px) => {
          pendingWidth = px;
          if (writeTimer !== null) return;
          writeTimer = setTimeout(() => {
            writeTimer = null;
            flushWrite();
          }, WRITE_DEBOUNCE_MS);
        };

        /**
         * 快照变化: 按「收起 / 重开 / 拖动」三种情形处理 (见文件头语义表)。
         * 注意先改 prevWidth 再调 setSidebar —— actions 即使值没变也会发布,
         * 不这么写会与本回调互相触发。
         */
        const onStoreChange = () => {
          if (!active || instance === null) return;
          const next = readSidebarWidth(instance);
          if (next === null) return;
          const before = prevWidth;
          prevWidth = next;
          // 收起: 盘上保留宽度, 等重开时用。
          if (next <= 0) return;
          // 重开: 原生写死 280, 覆盖成记住的宽度 (没有记住值就跟随原生)。
          if (before === 0) {
            const saved = readSavedWidth();
            if (saved !== null && saved !== next) {
              prevWidth = saved;
              instance.actions.setSidebar(saved);
              console.info(`${LOG_PREFIX} 展开侧栏: 用记住的 ${saved}px 覆盖原生 ${NATIVE_REOPEN_WIDTH}px`);
              return;
            }
          }
          scheduleWrite(next);
        };

        /** 摘掉当前实例的订阅。 */
        const detachStore = () => {
          if (offStore !== null) {
            offStore();
            offStore = null;
          }
          instance = null;
          prevWidth = null;
        };

        /**
         * 挂到布局 store 上 (幂等): 找到实例 → 恢复记住的宽度 → 订阅后续变化。
         * 订阅放在恢复之后: 恢复那次 setSidebar 自己不需要被观察。
         */
        const attach = () => {
          if (!active) return;
          const found = findLayoutInstance(slots);
          if (found === null || found === instance) return;
          detachStore();
          instance = found;
          const current = readSidebarWidth(instance);
          prevWidth = current;
          const saved = readSavedWidth();
          if (saved !== null && current !== null && current > 0 && current !== saved) {
            prevWidth = saved;
            instance.actions.setSidebar(saved);
            console.info(`${LOG_PREFIX} 已恢复侧栏宽度 ${saved}px (原生默认 ${current}px)`);
          }
          offStore = instance.subscribe(onStoreChange);
        };

        // 页面要走了就把攒着的宽度写掉, 免得刚拖完就刷新/关页丢值。
        const onPageHide = () => {
          flushWrite();
        };
        const onVisibilityChange = () => {
          if (document.visibilityState === "hidden") flushWrite();
        };
        window.addEventListener("pagehide", onPageHide);
        document.addEventListener("visibilitychange", onVisibilityChange);

        // root 槽位注册变化(ui-layout 启动、热重载重建实例)时重新找一次。
        const offSlots = slots.subscribe("root", attach);
        attach();

        return () => {
          active = false;
          if (writeTimer !== null) {
            clearTimeout(writeTimer);
            writeTimer = null;
          }
          flushWrite();
          window.removeEventListener("pagehide", onPageHide);
          document.removeEventListener("visibilitychange", onVisibilityChange);
          offSlots();
          detachStore();
        };
      }, "dsh-sidebar-width-persist: 侧栏宽度持久化");
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
