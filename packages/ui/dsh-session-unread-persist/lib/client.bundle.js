/**
 * 会话「已完成未查看」绿点持久化插件 —— 浏览器半 (DSH 客户端模块加载器的 CJS 工厂格式,
 * 与 dsh-dim-text / dsh-turn-labels / kanban-board 一致)。
 *
 * 目的: 左侧会话列表行首的绿点表示「这个会话跑完了, 但你还没点开看」
 * (workspace 客户端: completed = sessionStatus.completionUnread === true,
 *  再渲染成 StateDot state="done", 颜色 = --dsw-alias-state-success-primary)。
 * 该标记原本只是 dsh-client-ui-session 里 UiSession 服务的一个内存 Set
 * (`completionUnread`), 页面一刷新就重新构造为空 —— 而宿主只在 agent 状态**变化**时
 * 广播 api-session/status, 重连不回放, 首次加载列表走的是「建基线」分支
 * (previous === void 0 时直接 set, 不置未读), 所以刷新后绿点必然消失。
 *
 * 做法: 不碰任何成品包, 在本插件里给这个内存集合补一层 localStorage 持久化 ——
 *   1. 加载时把上次留下的未读会话 id 灌回 ctx.uiSession.completionUnread, 并
 *      publishStatus() 让订阅方 (workspace 侧栏) 立刻看到 → 刷新后绿点仍在;
 *   2. 之后跟随: 未读集合 / 会话列表一变就(合并式)落盘;
 *   3. 清理不再成立的标记, 但三条判据都必须避免「拿滞后数据误杀」——2026-10-06
 *      实测过一次事故: 会话跑完的瞬间绿点被本插件自己删掉, 之后原生不再补, 症状是
 *      「绿点彻底不显示了」。详见 shouldPrune() 与下方 schedule() 的注释。
 *   4. 多标签页: 落盘是「storage ∪ 本地未读 − 墓碑」的合并, 而不是直接覆盖成本地集合;
 *      否则任何一个没看到过这条标记的标签页 (刚刷新 / 正看着那个会话) 一次例行落盘
 *      就会把别的标签页的绿点抹掉。storage 事件只采纳「别的标签页把它标成已读」的删除。
 *
 * 边界 (与原生语义一致, 本插件不改变):
 *   - 只有客户端观测到 running: true → false 才置位, 因此「浏览器关着的时候跑完」的会话
 *     不会补绿点 (宿主侧没有完成时间可查, 列表的 updatedAt 是最后一次用户提问时间)。
 *   - 状态按浏览器 origin 存 localStorage, 换浏览器 / 隐身窗口是各自独立的一套。
 *
 * 生效链路: 本包由 profile 的 cordis.patch.yml insert 条目挂载, 客户端 bundle 属于
 * client-hmr 监控的图行 —— 改本文件后 webserver stat-poll 到变化即热重载;
 * 但**新增**条目要重进启动清单, 需重启一次 dsh web。
 *
 * 移除方式: 删掉 cordis.patch.yml 里对应的 insert 条目, 删除本目录, 重启 dsh web;
 * 顺手可 `localStorage.removeItem("dsh.sessions.completionUnread")`。
 *
 * 设计文档: doc_ai/spec/dsh-plugin/dsh-session-unread-persist.md
 */
window.__ModuleLoader__.load({
  // 模块 id 必须等于包名 (@gavinc-cn/dsh-session-unread-persist), 理由见 kanban-board 同处注释:
  // boot 清单行 id 取自包名, 不一致会被加载器判为 "loaded without registering"。
  id: "@gavinc-cn/dsh-session-unread-persist",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /**
     * localStorage 键: 已完成但用户还没点开看的会话 id 数组。
     * 命名与 dsh 自有的 dsh.sessions.current 同族 (见 dsh-client-ui-workspace 里的
     * createSnapshotStore(..., { persist: { name: "dsh.sessions.current" } }))。
     */
    const STORAGE_KEY = "dsh.sessions.completionUnread";
    /** 统一日志前缀, 便于在浏览器控制台按插件名过滤。 */
    const LOG_PREFIX = "[dsh-session-unread-persist]";

    /**
     * 读回上次留下的未读会话 id。
     * 无 localStorage / 坏 JSON / 非字符串数组一律按「没有记录」处理: 持久化只是锦上添花,
     * 不能因为它让页面挂掉 —— 与 dsh-client-store 的 attachPersistence() 容错取向一致。
     * @returns {string[]} 未读会话 id 列表, 可能为空。
     */
    function readPersistedIds() {
      if (typeof localStorage === "undefined") return [];
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((id) => typeof id === "string" && id !== "");
      } catch (error) {
        console.warn(`${LOG_PREFIX} 读取 ${STORAGE_KEY} 失败, 按空处理:`, error);
        return [];
      }
    }

    /**
     * 把一批未读会话 id 整体落盘 (配额满 / 隐私模式失败只警告, 不影响界面)。
     * @param ids - 未读会话 id 的可迭代集合。
     */
    function writePersistedIds(ids) {
      if (typeof localStorage === "undefined") return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
      } catch (error) {
        console.warn(`${LOG_PREFIX} 写入 ${STORAGE_KEY} 失败, 刷新后会丢失未读标记:`, error);
      }
    }

    /**
     * 客户端插件体: 给 UiSession 的 completionUnread 补一层 localStorage 持久化。
     * @param ctx - 客户端 cordis 上下文 (经 exports.inject 声明依赖 sessions/uiSession)。
     */
    function apply(ctx) {
      const service = ctx.uiSession;
      const unread = service?.completionUnread;
      // 依赖的是 dsh 内部字段: 版本变化导致拿不到时, 只降级为「没有这个插件」, 不报错打断界面。
      if (!(unread instanceof Set) || typeof service.publishStatus !== "function") {
        console.warn(`${LOG_PREFIX} 当前 dsh 版本的 uiSession 没有 completionUnread/publishStatus, 未启用持久化`);
        return;
      }

      // 1) 播种: 把上次留下的未读标记灌回内存集合, 并让订阅方重新渲染。
      let restored = 0;
      for (const id of readPersistedIds()) {
        if (unread.has(id)) continue;
        unread.add(id);
        restored += 1;
      }
      if (restored > 0) {
        service.publishStatus();
        console.info(`${LOG_PREFIX} 已恢复 ${restored} 条未读完成标记`);
      }

      // 2) 跟随内存集合: 变化时清理失效标记并落盘; 插件卸载时一并摘掉订阅。
      ctx.effect(() => {
        let active = true;
        let queued = false;
        /** 上一次观测到的未读集合: 原生把它删掉 (用户点开/开始跑/会话消失) 时要在盘上同步删除。 */
        let observed = new Set();
        /**
         * 本标签页确认「已不再是未读」的墓碑 (自己剪掉的 + 采纳别的标签页删除的)。
         * 落盘时用它把 id 从 storage 里摘掉; 一旦该 id 又被置为未读 (新一轮完成), 墓碑即作废。
         */
        const cleared = new Set();
        /**
         * 在会话列表里出现过的 id。宿主列表是渐进补全的 (子会话要靠 projection 拉取),
         * 所以「这一轮没看到」不等于「不存在」—— 只有见过又消失才当作会话被删掉。
         */
        const seen = new Set();

        /**
         * 判断一条未读标记是否仍然成立。每条判据都要防「拿滞后数据误杀」:
         * @param id - 会话 id。
         * @param row - 当前列表快照里的一行 (可能不存在)。
         * @returns 需要剪掉返回 true。
         */
        const shouldPrune = (id, row) => {
          // 会话不在列表里: 只在「以前见过」时才认定被删除, 否则可能只是列表还没补全。
          if (row === undefined) return seen.has(id);
          if (row.running === true) {
            // 行上写着「正在跑」。但列表快照是**微任务**才发布的
            // (dsh-api-session-controller/lib/client.js 的 Notifier.markDirty → queueMicrotask),
            // 而原生置未读 (UiSession.observeRunning) 与本插件都在同一个事件派发里同步执行 ——
            // 会话刚跑完那一瞬间, 行上还留着上一次的 running: true。
            // uiSession.running 由 observeRunning 同步更新, 是更权威的读数:
            // 它说「没在跑」就以它为准, 不剪 (否则会把刚点亮的绿点误删, 且原生不会再补回来)。
            return service.running?.get?.(id) !== false;
          }
          // 已经是当前正在查看的会话 (与 dsh-client-ui-session 的 isMain 判据一致)。
          return (row.retainedBy?.mainView ?? 0) > 0;
        };

        /** 对账一次: 清理失效标记 → 合并落盘。 */
        const flush = () => {
          if (!active) return;
          const list = ctx.sessions.list.getSnapshot();
          for (const id of list.ids ?? []) seen.add(id);

          // 列表还没就绪时 byId 为空, 此刻清理会把刚播种的标记全删掉 —— 必须等 phase === "ready"。
          if (list.phase === "ready") {
            let pruned = false;
            for (const id of [...unread]) {
              if (!shouldPrune(id, list.byId[id])) continue;
              unread.delete(id);
              cleared.add(id);
              pruned = true;
            }
            if (pruned) service.publishStatus();
          }

          // 原生把某条标记清掉了 (用户点开 / 开始跑 / 会话消失) → 同样记成墓碑, 盘上也要删。
          const present = new Set(unread);
          for (const id of observed) if (!present.has(id)) cleared.add(id);
          observed = present;
          for (const id of present) cleared.delete(id);

          // 合并落盘: 保留盘上其它标签页的标记, 只应用本标签页的墓碑与新增。
          const stored = new Set(readPersistedIds());
          let changed = false;
          for (const id of cleared) if (stored.delete(id)) changed = true;
          for (const id of present) if (!stored.has(id)) { stored.add(id); changed = true; }
          if (changed) writePersistedIds(stored);
        };

        /**
         * 合并同一轮里的多次通知, 并推迟到微任务再对账 ——
         * ① 让 dsh 自己那批延迟发布的列表快照先落地, 避免读到中间态;
         * ② 避免 publishStatus() 触发的回调在本函数内递归。
         */
        const schedule = () => {
          if (!active || queued) return;
          queued = true;
          queueMicrotask(() => {
            queued = false;
            flush();
          });
        };

        const offStatus = service.sessionStatus.subscribe(schedule);
        const offList = ctx.sessions.list.subscribe(schedule);
        /**
         * 另一个标签页把会话标成已读时跟着收敛。
         * 只采纳「删除」, 不采纳「新增」—— 新增标记由本标签页自己的状态订阅产生,
         * 避免把别的标签页的绿点搬到正在看这个会话的标签页上。
         * 采纳时补记墓碑, 免得下一次合并落盘又把它加回来。
         */
        const onStorage = (event) => {
          if (event.key !== STORAGE_KEY && event.key !== null) return;
          const stored = new Set(readPersistedIds());
          let changed = false;
          for (const id of [...unread]) {
            if (stored.has(id)) continue;
            unread.delete(id);
            cleared.add(id);
            changed = true;
          }
          if (changed) service.publishStatus();
        };
        window.addEventListener("storage", onStorage);
        flush();
        return () => {
          active = false;
          offStatus();
          offList();
          window.removeEventListener("storage", onStorage);
        };
      }, "dsh-session-unread-persist: 持久化未读完成标记");
    }

    exports.apply = apply;
    exports.inject = ["sessions", "uiSession"];
    return module.exports;
  },
});
