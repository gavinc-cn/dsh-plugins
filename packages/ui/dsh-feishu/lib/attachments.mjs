/**
 * 飞书入站附件适配（Task 6）：把 `NormalizedMessage.resources` 变成 DSH prompt content。
 *
 * 目的 / 生效链路：
 *   `inbound` worker 收到一条已归一化的飞书消息后调用 `preparePromptContent`，把结果直接
 *   作为 `sessionController.prompt({content})` 的内容。文本保持原文；图片下载后按 DSH
 *   `imageLimits` 准入并以 base64 `{type:'image'}` 交给 Host 的 attachment 准入；文件走限长
 *   `restStream` + `fileUploads.uploadStream` 换 `{type:'file', receiptId}`（receipt 与目标
 *   Session 绑定，后续由 Host 解析，不能跨会话复用）。
 *
 * 设计约束：
 *   1. **先校验全部元数据，再触网**：图片张数/声明类型/声明尺寸/声明字节，文件声明大小
 *      全部在第一次下载前检查；这样「9 张上限 / 50 MiB 文件」这类错误不会产生半截下载。
 *   2. **全有或全无**：任何下载、上传、限长、完整性或取消失败都直接 reject；本函数只在
 *      所有资源都成功后一次性返回 parts，调用方拿不到部分成功的内容。
 *   3. 图片字节必须与声明 mediaType 一致（PNG/JPEG/GIF/WebP 魔数），不一致即拒绝；未声明
 *      mediaType 时按魔数归一，未知格式拒绝。
 *   4. 文件只通过注入的 `fileUploads.uploadStream` 换 receiptId；**绝不**使用
 *      `attachments.saveFile` 或裸 `FileAttachmentRef`。`sessionId` 原样传给 uploadStream；
 *      真实 Host 对跨 Session receipt 的强制校验发生在 **prompt 绑定阶段**（Task 7/8 的
 *      bindPrompt/resolve），不在 uploadStream。本函数只保证不吞掉任何注入的拒绝错误。
 *   5. 文件字节用注入的 `restStream` 流式消费：restStream 自身有 `maxBytes` 上限，本模块
 *      再用计数包装二次执行 `fileMaxBytes`；响应带 `contentLength` 时消费总量必须与之一致
 *      （防截断/伪造长度）；没有 `contentLength` 时用飞书声明的 `file_size` 兜底，二者都
 *      不可用则无法识别短流。任何不一致都整体失败。
 *   6. 顺序：文本（非空时）第一，随后严格按 `message.resources` 原顺序输出图片/文件。
 *   7. 纯离线可测：REST / 上传 / AbortSignal 全部注入，无网络、无 npm 依赖、无 Touchstone
 *      运行时依赖。
 *
 * 已知边界：
 *   - `restBytes` 没有 signal 参数（Task 2 契约），图片下载过程中无法中断底层请求；字节上限
 *     只能在下载完成后执行，属 Task 11 的加固项。本模块在下载前后检查 signal，取消仍会阻止
 *     内容进入 prompt。
 *   - 图片尺寸分支只在 NormalizedMessage 自带可选 width/height 时可达；真实图片像素准入
 *     由 Host 的 `attachments.admitPromptContent` 负责。
 *   - 预消费拒绝会取消 restStream 响应体；文件上传完成后若才发现长度不符，Host 侧可能已
 *     落下一份 durable 对象并暂存 receipt（不会被 prompt 引用，成为孤儿），本模块不持有、
 *     也不负责清理 Host 内部对象。
 */
import { safeBaseName } from './utils.mjs'

/** 单条消息图片硬上限（spec：单消息最多 9 张；DSH 配置更小时取更小值）。 */
export const MAX_IMAGES_PER_MESSAGE = 9

/** 文件默认上限 50 MiB（spec 与 `rest.DEFAULT_STREAM_MAX_BYTES` 一致）。 */
export const DEFAULT_FILE_MAX_BYTES = 50 * 1024 * 1024

/** 图片魔数嗅探支持的扩展名映射（同时用于空文件名的回退命名）。 */
const IMAGE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** 附件适配失败（稳定 `code` 供上层分类/重试与测试断言）。 */
export class AttachmentPreparationError extends Error {
  /**
   * @param {string} message 面向日志的中文说明（不含 Secret / 正文）
   * @param {string} code 稳定错误码
   */
  constructor(message, code) {
    super(message)
    this.name = 'AttachmentPreparationError'
    this.code = code
  }
}

/** 构造并抛出附件错误。 */
function fail(code, message) {
  throw new AttachmentPreparationError(message, code)
}

/**
 * 取消检查：优先 `signal.throwIfAborted()`（DOMException），否则按 reason 抛出。
 * @param {AbortSignal | null | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal === null || signal === undefined) return
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted()
    return
  }
  if (signal.aborted) {
    if (signal.reason instanceof Error) throw signal.reason
    const error = new AttachmentPreparationError('附件处理已取消', 'ABORTED')
    if (signal.reason !== undefined) error.cause = signal.reason
    throw error
  }
}

/** 归一化 media type：小写、去空白，兼容 image/jpg 与 image/x-png 两种常见别名。 */
function normalizeMediaType(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'image/jpg' || normalized === 'image/pjpeg') return 'image/jpeg'
  if (normalized === 'image/x-png') return 'image/png'
  return normalized
}

/** 按魔数识别图片类型；未知格式返回 null（绝不按扩展名猜测）。 */
function sniffImageMediaType(bytes) {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString('latin1')
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
    && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/** 把 restBytes 返回值统一成 Buffer（容忍 Uint8Array / ArrayBuffer / Buffer）。 */
function toBytes(data) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  fail('INVALID_DOWNLOAD', '资源下载返回的 data 不是字节')
}

/** content-length 解析：只有有限非负整数才可用，其余视为未知。 */
function parseContentLength(value) {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value)
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value)
  return null
}

/** 取有限正数上限；缺省/非法时用 fallback。 */
function positiveLimit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 把任意流形态（AsyncIterable / ReadableStream）包装成 AsyncIterable。
 * 只做形态适配，不做聚合，保证大文件不整块进内存。
 * @param {AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>} data
 * @returns {AsyncIterable<Uint8Array>}
 */
async function* iterateStream(data) {
  if (data === null || data === undefined) {
    fail('INVALID_STREAM', '文件下载没有返回可读流')
  }
  if (typeof data[Symbol.asyncIterator] === 'function') {
    yield* data
    return
  }
  if (typeof data.getReader === 'function') {
    const reader = data.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        yield value
      }
    } finally {
      if (typeof reader.releaseLock === 'function') reader.releaseLock()
    }
  }
  fail('INVALID_STREAM', '文件下载返回的 data 既不是 AsyncIterable 也不是 ReadableStream')
}

/**
 * 预消费拒绝时尽力取消 restStream 响应体，避免连接/内存被晾着。
 * 兼容 ReadableStream（`cancel`）与 reader 两形态；已关闭/已取消的流再取消属预期噪音。
 * @param {unknown} data restStream 返回的 data
 * @param {unknown} reason 取消原因（通常是即将上抛的错误）
 */
async function cancelResponseStream(data, reason) {
  try {
    if (data !== null && typeof data === 'object' && typeof data.cancel === 'function') {
      await data.cancel(reason)
      return
    }
    if (data !== null && typeof data === 'object' && typeof data.getReader === 'function') {
      const reader = data.getReader()
      try {
        await reader.cancel(reason)
      } finally {
        if (typeof reader.releaseLock === 'function') reader.releaseLock()
      }
    }
  } catch {
    // 清理路径不覆盖原始错误。
  }
}

/**
 * 预消费拒绝的统一出口：先取消响应体，再抛稳定错误码。
 * @param {unknown} data restStream 返回的 data
 * @param {string} code 稳定错误码
 * @param {string} message 说明
 * @returns {Promise<never>}
 */
async function failAfterCancel(data, code, message) {
  const error = new AttachmentPreparationError(message, code)
  await cancelResponseStream(data, error)
  throw error
}

/**
 * 把声明名净化成基础文件名；空名或不可用名回退到调用方给的默认名。
 * @param {unknown} raw 原始名（来自飞书，可能是空串/路径/控制字符）
 * @param {string} fallback 回退名（feishu-image-N / feishu-file-N）
 * @returns {string}
 */
function resolvedName(raw, fallback) {
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  if (trimmed === '') return fallback
  const base = safeBaseName(raw)
  // safeBaseName 对 "." / ".." / 全控制字符会回退成 "file"；调用方没有显式叫 "file" 时
  // 用附件序号名，避免一堆同名的 file。
  if (base === 'file' && trimmed !== 'file') return fallback
  return base
}

/** 构造飞书消息资源下载路径（Task 2 会自行补恰好一层 /open-apis，这里显式写全）。 */
function resourcePath(messageId, key) {
  return `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}`
}

/**
 * 校验单条资源的基本形状，返回规范化描述符。
 * @param {unknown} resource
 * @param {number} index
 * @returns {{kind: 'image'|'file', key: string, name: string, size: number|undefined,
 *            mediaType: string|null, width: number|undefined, height: number|undefined}}
 */
function normalizeResource(resource, index) {
  if (resource === null || typeof resource !== 'object' || Array.isArray(resource)) {
    fail('INVALID_RESOURCE', `第 ${index + 1} 个资源不是对象`)
  }
  const kind = resource.kind
  if (kind !== 'image' && kind !== 'file') {
    fail('INVALID_RESOURCE', `第 ${index + 1} 个资源类型不受支持: ${String(kind)}`)
  }
  if (typeof resource.key !== 'string' || resource.key.length === 0) {
    fail('INVALID_RESOURCE', `第 ${index + 1} 个资源缺少 key`)
  }
  if (resource.name !== undefined && typeof resource.name !== 'string') {
    fail('INVALID_RESOURCE', `第 ${index + 1} 个资源 name 不是字符串`)
  }

  let size
  if (resource.size !== undefined && resource.size !== null) {
    if (typeof resource.size !== 'number' || !Number.isFinite(resource.size) || resource.size < 0) {
      fail('INVALID_RESOURCE', `第 ${index + 1} 个资源 size 非法`)
    }
    size = Math.trunc(resource.size)
  }

  let mediaType = null
  if (resource.mediaType !== undefined && resource.mediaType !== null) {
    mediaType = normalizeMediaType(resource.mediaType)
    if (mediaType === null) fail('INVALID_RESOURCE', `第 ${index + 1} 个资源 mediaType 非法`)
  }

  let width
  let height
  const hasWidth = resource.width !== undefined && resource.width !== null
  const hasHeight = resource.height !== undefined && resource.height !== null
  if (hasWidth !== hasHeight) {
    fail('INVALID_RESOURCE', `第 ${index + 1} 个资源尺寸必须同时给出 width/height`)
  }
  if (hasWidth) {
    if (typeof resource.width !== 'number' || typeof resource.height !== 'number'
      || !Number.isFinite(resource.width) || !Number.isFinite(resource.height)
      || resource.width <= 0 || resource.height <= 0) {
      fail('INVALID_RESOURCE', `第 ${index + 1} 个资源尺寸非法`)
    }
    width = Math.trunc(resource.width)
    height = Math.trunc(resource.height)
  }

  return {
    kind,
    key: resource.key,
    name: typeof resource.name === 'string' ? resource.name : '',
    size,
    mediaType,
    width,
    height,
  }
}

/**
 * 把一条飞书消息的附件准备成 DSH prompt content。
 *
 * @param {{id?: string, text?: string, resources?: unknown[]}} message NormalizedMessage
 * @param {{
 *   sessionId?: string,
 *   restClient?: {restBytes: Function, restStream: Function},
 *   fileUploads?: {uploadStream: Function},
 *   imageLimits?: {maxImageBytes?: number, maxImagesPerMessage?: number,
 *                  maxMessageImageBytes?: number, maxImagePixels?: number,
 *                  maxImageDimension?: number, mediaTypes: readonly string[]},
 *   fileMaxBytes?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<Array<
 *   {type: 'text', text: string} |
 *   {type: 'image', mediaType: string, data: string, name: string} |
 *   {type: 'file', receiptId: string}>>}
 * @throws {AttachmentPreparationError} 元数据/限长/完整性/取消失败
 * @throws {Error} 注入的 restClient / fileUploads 自身的错误原样穿透
 */
export async function preparePromptContent(message, options = {}) {
  const {
    sessionId,
    restClient,
    fileUploads,
    imageLimits,
    fileMaxBytes,
    signal,
  } = options ?? {}

  throwIfAborted(signal)

  // ── 1. 消息 / 资源形状 ───────────────────────────────────────────────
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    fail('INVALID_MESSAGE', '附件适配需要 NormalizedMessage 对象')
  }
  if (typeof message.text !== 'string') {
    fail('INVALID_MESSAGE', 'NormalizedMessage.text 必须是字符串')
  }
  if (!Array.isArray(message.resources)) {
    fail('INVALID_MESSAGE', 'NormalizedMessage.resources 必须是数组')
  }
  const resources = message.resources.map(normalizeResource)

  const images = resources.filter((resource) => resource.kind === 'image')
  const files = resources.filter((resource) => resource.kind === 'file')

  // ── 2. 依赖 / 上限参数 ───────────────────────────────────────────────
  let maxImages = MAX_IMAGES_PER_MESSAGE
  let maxImageBytes = Infinity
  let maxMessageImageBytes = Infinity
  let maxImageDimension = Infinity
  let maxImagePixels = Infinity
  let acceptedMediaTypes = []

  if (images.length > 0) {
    if (imageLimits === null || typeof imageLimits !== 'object' || Array.isArray(imageLimits)) {
      fail('INVALID_OPTIONS', '缺少 DSH imageLimits，无法校验图片准入')
    }
    if (!Array.isArray(imageLimits.mediaTypes) || imageLimits.mediaTypes.length === 0) {
      fail('INVALID_OPTIONS', 'imageLimits.mediaTypes 必须是非空数组')
    }
    acceptedMediaTypes = imageLimits.mediaTypes
      .map(normalizeMediaType)
      .filter((mediaType) => mediaType !== null)
    if (acceptedMediaTypes.length === 0) {
      fail('INVALID_OPTIONS', 'imageLimits.mediaTypes 没有可用的图片类型')
    }
    if (typeof imageLimits.maxImagesPerMessage === 'number'
      && Number.isInteger(imageLimits.maxImagesPerMessage)
      && imageLimits.maxImagesPerMessage > 0) {
      maxImages = Math.min(MAX_IMAGES_PER_MESSAGE, imageLimits.maxImagesPerMessage)
    }
    maxImageBytes = positiveLimit(imageLimits.maxImageBytes, Infinity)
    maxMessageImageBytes = positiveLimit(imageLimits.maxMessageImageBytes, Infinity)
    maxImageDimension = positiveLimit(imageLimits.maxImageDimension, Infinity)
    maxImagePixels = positiveLimit(imageLimits.maxImagePixels, Infinity)
  }

  let fileLimit = DEFAULT_FILE_MAX_BYTES
  if (fileMaxBytes !== undefined) {
    if (typeof fileMaxBytes !== 'number' || !Number.isFinite(fileMaxBytes) || fileMaxBytes <= 0) {
      fail('INVALID_OPTIONS', 'fileMaxBytes 必须是正数')
    }
    fileLimit = fileMaxBytes
  }

  if (images.length > 0 && (restClient === null || typeof restClient !== 'object'
    || typeof restClient.restBytes !== 'function')) {
    fail('INVALID_OPTIONS', '缺少 restClient.restBytes，无法下载图片')
  }
  if (files.length > 0) {
    if (restClient === null || typeof restClient !== 'object'
      || typeof restClient.restStream !== 'function') {
      fail('INVALID_OPTIONS', '缺少 restClient.restStream，无法下载文件')
    }
    if (fileUploads === null || typeof fileUploads !== 'object'
      || typeof fileUploads.uploadStream !== 'function') {
      fail('INVALID_OPTIONS', '缺少 fileUploads.uploadStream，无法上传文件')
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      fail('INVALID_OPTIONS', '文件上传需要非空 sessionId')
    }
    if (typeof message.id !== 'string' || message.id.length === 0) {
      fail('INVALID_MESSAGE', '带附件的消息缺少 id，无法构造资源下载路径')
    }
  }
  if (resources.length > 0 && (typeof message.id !== 'string' || message.id.length === 0)) {
    fail('INVALID_MESSAGE', '带附件的消息缺少 id，无法构造资源下载路径')
  }

  // ── 3. 元数据预检（全部通过后才开始下载）─────────────────────────────
  if (images.length > maxImages) {
    fail('TOO_MANY_IMAGES', `单条消息图片 ${images.length} 张，超过上限 ${maxImages} 张`)
  }

  let declaredImageBytes = 0
  for (const image of images) {
    if (image.mediaType !== null && !acceptedMediaTypes.includes(image.mediaType)) {
      fail('UNSUPPORTED_IMAGE_TYPE', `当前部署不接受图片类型 ${image.mediaType}`)
    }
    if (image.size !== undefined) {
      if (image.size > maxImageBytes) {
        fail('IMAGE_TOO_LARGE', `图片声明大小 ${image.size} 字节，超过单图上限 ${maxImageBytes}`)
      }
      declaredImageBytes += image.size
    }
    if (image.width !== undefined) {
      if (image.width > maxImageDimension || image.height > maxImageDimension) {
        fail('IMAGE_DIMENSIONS_EXCEEDED',
          `图片尺寸 ${image.width}x${image.height} 超过单边上限 ${maxImageDimension}`)
      }
      if (image.width * image.height > maxImagePixels) {
        fail('IMAGE_DIMENSIONS_EXCEEDED',
          `图片像素 ${image.width * image.height} 超过上限 ${maxImagePixels}`)
      }
    }
  }
  if (declaredImageBytes > maxMessageImageBytes) {
    fail('IMAGES_TOO_LARGE',
      `图片声明总大小 ${declaredImageBytes} 字节，超过单消息上限 ${maxMessageImageBytes}`)
  }
  for (const file of files) {
    if (file.size !== undefined && file.size > fileLimit) {
      fail('FILE_TOO_LARGE', `文件声明大小 ${file.size} 字节，超过上限 ${fileLimit}`)
    }
  }

  // ── 4. 依次下载/上传；任一失败直接 reject，parts 永不外泄 ──────────────
  const parts = []
  if (message.text.length > 0) parts.push({ type: 'text', text: message.text })

  let imageIndex = 0
  let fileIndex = 0
  let actualImageBytes = 0

  for (const resource of resources) {
    throwIfAborted(signal)
    const path = resourcePath(message.id, resource.key)

    if (resource.kind === 'image') {
      imageIndex += 1
      const downloaded = await restClient.restBytes('GET', path, {
        params: { type: 'image' },
        signal,
      })
      throwIfAborted(signal)

      const bytes = toBytes(downloaded?.data)
      if (bytes.length > maxImageBytes) {
        fail('IMAGE_TOO_LARGE', `图片实际大小 ${bytes.length} 字节，超过单图上限 ${maxImageBytes}`)
      }
      actualImageBytes += bytes.length
      if (actualImageBytes > maxMessageImageBytes) {
        fail('IMAGES_TOO_LARGE',
          `图片实际总大小 ${actualImageBytes} 字节，超过单消息上限 ${maxMessageImageBytes}`)
      }

      const sniffed = sniffImageMediaType(bytes)
      if (sniffed === null) {
        fail('UNSUPPORTED_IMAGE_BYTES', '图片字节不是 PNG/JPEG/GIF/WebP')
      }
      if (resource.mediaType !== null && resource.mediaType !== sniffed) {
        fail('MEDIA_TYPE_MISMATCH',
          `图片声明类型 ${resource.mediaType} 与实际字节 ${sniffed} 不一致`)
      }
      if (!acceptedMediaTypes.includes(sniffed)) {
        fail('UNSUPPORTED_IMAGE_TYPE', `当前部署不接受图片类型 ${sniffed}`)
      }

      const fallback = `feishu-image-${imageIndex}.${IMAGE_EXTENSIONS[sniffed]}`
      parts.push({
        type: 'image',
        mediaType: sniffed,
        data: bytes.toString('base64'),
        name: resolvedName(resource.name, fallback),
      })
      continue
    }

    fileIndex += 1
    const streamed = await restClient.restStream('GET', path, {
      params: { type: 'file' },
      maxBytes: fileLimit,
      signal,
    })
    const responseBody = streamed?.data
    // 取消发生在拿到响应之后、开始消费之前：先把响应体收掉再上抛。
    try {
      throwIfAborted(signal)
    } catch (error) {
      await cancelResponseStream(responseBody, error)
      throw error
    }

    const contentLength = parseContentLength(streamed?.contentLength)
    if (contentLength !== null && contentLength > fileLimit) {
      await failAfterCancel(responseBody, 'FILE_TOO_LARGE',
        `文件响应长度 ${contentLength} 字节，超过上限 ${fileLimit}`)
    }
    if (contentLength !== null && resource.size !== undefined && resource.size !== contentLength) {
      await failAfterCancel(responseBody, 'CONTENT_LENGTH_MISMATCH',
        `文件声明大小 ${resource.size} 与响应 content-length ${contentLength} 不一致`)
    }

    let total = 0
    let exhausted = false
    let countedFailure = null
    // 计数包装：restStream 已有 maxBytes，这里再按本次上限二次执行（防注入替身/上游实现
    // 漏判），并在消费过程中响应取消。底层失败记在 countedFailure 里，供 Host 包装
    // uploadStream 错误后还原真正的错误码（FILE_TOO_LARGE / CONTENT_LENGTH_MISMATCH）。
    const counted = (async function* countedStream() {
      try {
        for await (const chunk of iterateStream(responseBody)) {
          throwIfAborted(signal)
          const bytes = toBytes(chunk)
          total += bytes.length
          if (total > fileLimit) {
            fail('FILE_TOO_LARGE', `文件实际大小超过上限 ${fileLimit} 字节`)
          }
          if (contentLength !== null && total > contentLength) {
            fail('CONTENT_LENGTH_MISMATCH',
              `文件实际字节 ${total} 超过响应 content-length ${contentLength}`)
          }
          yield bytes
        }
        exhausted = true
      } catch (error) {
        if (countedFailure === null) countedFailure = error
        throw error
      }
    })()

    const fallback = `feishu-file-${fileIndex}`
    let uploaded
    try {
      uploaded = await fileUploads.uploadStream({
        sessionId,
        data: counted,
        name: resolvedName(resource.name, fallback),
        signal,
      })
    } catch (error) {
      // 真实 Host 会把流读取错误包装成自己的上传错误；限长/完整性错误码必须保留，
      // 否则上层分不清「文件太大/被截断」与普通上传失败。
      if (countedFailure !== null) throw countedFailure
      throw error
    }
    throwIfAborted(signal)

    if (uploaded === null || typeof uploaded !== 'object'
      || typeof uploaded.receiptId !== 'string' || uploaded.receiptId.length === 0) {
      fail('INVALID_RECEIPT', 'fileUploads.uploadStream 没有返回 receiptId')
    }
    // uploadStream 必须完整消费流；提前结束说明字节没有全部交付。
    if (!exhausted) {
      fail('CONTENT_LENGTH_MISMATCH', 'fileUploads.uploadStream 未消费完整文件流')
    }
    if (contentLength !== null && total !== contentLength) {
      fail('CONTENT_LENGTH_MISMATCH',
        `文件最终字节 ${total} 与响应 content-length ${contentLength} 不一致`)
    }
    // I1：响应没有 content-length 时，用飞书声明的 file_size 兜底识别短流/截断，
    // 绝不让不完整文件的 receipt 进入 prompt content。
    if (resource.size !== undefined && total !== resource.size) {
      fail('CONTENT_LENGTH_MISMATCH',
        `文件实际字节 ${total} 与声明大小 ${resource.size} 不一致`)
    }
    parts.push({ type: 'file', receiptId: uploaded.receiptId })
  }

  return parts
}
