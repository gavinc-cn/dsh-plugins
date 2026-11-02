# vendored 二维码实现：来源与改动

本目录是 **MIT 许可**的第三方源码副本，目的是让 `@gavinc-cn/dsh-feishu` 不依赖
`node_modules` 也能在 DSH 共享活副本里生成真实二维码（`deploy-to-dsh.sh` 不复制
`node_modules`，普通 npm 依赖在活副本里无法解析）。

| 来源 | 版本 | 复制内容 | 许可证 |
|---|---|---|---|
| [node-qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | `lib/core/*.js`、`lib/renderer/svg-tag.js`、`lib/renderer/utils.js` | `LICENSE`（原文照录） |
| [dijkstrajs](https://github.com/tcort/dijkstrajs) | 1.0.3 | `dijkstra.js`（放到 `core/dijkstra.js`） | `LICENSE-dijkstra.md`（原文照录） |

来源包目录（本机 pnpm store，2026-10-29；下面是相对各自项目的路径，不含绝对路径）：

- `node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode`
- `node_modules/.pnpm/dijkstrajs@1.0.3/node_modules/dijkstrajs`

## 改动（仅三处，不重写算法）

1. `core/segments.js` 的 `require('dijkstrajs')` 改为 `require('./dijkstra.js')`，
   让 dijkstra 以随包单文件解析；
2. 新增 `index.mjs`：用 `createRequire(import.meta.url)` 加载这两个 CJS 模块，导出
   `toSvgDataUrl(text, options?)`，返回 `data:image/svg+xml;base64,...`；
3. 换行规范化：上游 `core/error-correction-code.js` 原为 CRLF，复制时转为仓库要求的
   LF；**文件内容（含代码与注释）未改**，不要恢复 CRLF。

其余 QR 算法、渲染代码与版权头逐字保留。`package.json` 只声明
`{"type":"commonjs"}`，使复制的 `.js` 按 CJS 解析。

## 已知边界

- 只带 SVG 渲染器，不带 canvas/PNG/terminal 渲染器；不新增任何 npm 依赖。
- 二维码内容由调用方传入（`lib/provision.mjs` 传 Device Flow 的二维码 URL）。
