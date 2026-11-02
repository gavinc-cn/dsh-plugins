// @gavinc-cn/dsh-feishu —— 随包 vendor 的 MIT 二维码实现（qrcode core + dijkstra）
//
// 目的：在 deploy-to-dsh 不复制 node_modules 的前提下生成真实二维码，避免新增
// 运行时 npm 依赖（plan Global Constraints）。
//
// 设计约束：
//   - 复制的 `core/` 与 `renderer/` 是按原样保留的 CommonJS 源码（含版权头），
//     本文件用 createRequire 加载，不 import 包名 `qrcode`；
//   - 只暴露 `toSvgDataUrl`，输出 base64 data URL，便于直接放进 `<img src>` / 面板状态；
//   - 输入空串与非法类型立即抛 TypeError（qrcode core 的 No input text 语义前移，
//     避免把 undefined 静默编码成 "undefined"）。
//
// 来源/许可证/改动：见同目录 PROVENANCE.md、LICENSE、LICENSE-dijkstra.md。
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const QRCode = require('./core/qrcode.js')
const SvgTag = require('./renderer/svg-tag.js')

/** SVG data URL 前缀 */
const DATA_URL_PREFIX = 'data:image/svg+xml;base64,'

/**
 * 把文本编码成二维码 SVG，并包成 base64 data URL。
 * @param {string} text 二维码内容（本包传 Device Flow 的 verification URL）
 * @param {object} [options] qrcode 渲染选项（errorCorrectionLevel/width/margin/color）
 * @returns {string} `data:image/svg+xml;base64,...`
 */
export function toSvgDataUrl(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('toSvgDataUrl: text 必须是非空字符串')
  }
  const errorCorrectionLevel = options.errorCorrectionLevel === undefined
    ? 'M'
    : options.errorCorrectionLevel
  const qr = QRCode.create(text, { errorCorrectionLevel })
  const svg = SvgTag.render(qr, options)
  return `${DATA_URL_PREFIX}${Buffer.from(svg, 'utf8').toString('base64')}`
}
