/**
 * 文字配色插件 — 浏览器半 (DSH 客户端模块加载器的 CJS 工厂格式, 与 ui-theme/kanban-board 一致)。
 *
 * 目的: 深色模式下正文 #f9fafb 对背景 #151517 的对比度是 17.45:1 (WCAG AAA 只要 7:1),
 * 过于刺眼。这里经官方扩展点 ctx.theme.overrideTokens(source, tokens) 在当前主题上叠一层
 * 令牌覆盖, 把整条文字梯度按现有色板降一档, 层次关系保持不变:
 *
 *   令牌                              原值(深色)   覆盖后        对 #151517 对比度
 *   --dsw-alias-label-primary         #f9fafb      #cfd3d6       17.45:1 -> 12.11:1
 *   --dsw-alias-label-secondary       #cfd3d6      #adb2b8       12.11:1 ->  8.54:1
 *   --dsw-alias-label-tertiary        #adb2b8      #979da6        8.54:1 ->  6.68:1
 *
 * light 值一律填原色, 所以浅色模式不受影响; 明暗两套值必须都给, 否则 overrideTokens 抛错。
 * 覆盖层只存在于内存, 卸载 = 移除 cordis.patch.yml 里的 insert 条目并重启 dsh web。
 */
window.__ModuleLoader__.load({
  // 模块 id 必须等于包名 (@gavinc-cn/dsh-dim-text), 理由见 kanban-board/lib/client.bundle.js 同处注释:
  // boot 清单行 id 取自包名, 不一致会被加载器判为 "loaded without registering"。
  id: "@gavinc-cn/dsh-dim-text",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** 覆盖层身份, 同时作为该层的 source 名 (同一 source 重复调用会整体替换并重新叠到最上层)。 */
    const SOURCE = "dsh-dim-text";

    /** 令牌覆盖表: 名 -> { light, dark } 双值。 */
    const TOKENS = {
      "--dsw-alias-label-primary": { light: "#0f1115", dark: "#cfd3d6" },
      "--dsw-alias-label-secondary": { light: "#61666b", dark: "#adb2b8" },
      "--dsw-alias-label-tertiary": { light: "#81858c", dark: "#979da6" },
    };

    /**
     * 客户端插件体: 叠一层令牌覆盖, 并把它绑到插件生命周期上。
     * @param ctx - 客户端 cordis 上下文 (经 exports.inject 声明依赖 theme 服务)。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.theme.overrideTokens(SOURCE, TOKENS));
    }

    exports.apply = apply;
    exports.inject = ["theme"];
    return module.exports;
  },
});
