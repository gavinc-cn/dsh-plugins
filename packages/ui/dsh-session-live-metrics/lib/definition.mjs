/**
 * 构造 `sessionLiveMetrics` 的 ProjectionDefinition。
 *
 * 本模块刻意不导入 zod：宿主入口把真实 Zod schema 注入进来，仓库内单测则注入最小
 * identity schema，从而既能测注册形状，又不需要在 monorepo 里安装宿主依赖。
 */

import {
  applyLiveMetricsEvent,
  initialLiveMetricsState,
  toLiveMetricsView,
} from './fold.mjs'

/**
 * 校验 schema 具备 registry 当前使用的 `.parse` 方法。
 * @param {unknown} schema - Zod-like schema。
 * @returns {boolean} 是否可用。
 */
function isSchema(schema) {
  return schema !== null && typeof schema === 'object' && typeof schema.parse === 'function'
}

/**
 * 创建一个完整的 projection definition。
 * @param {object} input - `{ stateSchema, viewSchema }`。
 * @param {unknown} input.stateSchema - 校验持久化状态的 Zod-like schema。
 * @param {unknown} input.viewSchema - 校验客户端 wire 值的 Zod-like schema。
 * @returns {object} 可交给 `ctx.sessionProjections.register()` 的定义。
 */
export function createSessionLiveMetricsDefinition({ stateSchema, viewSchema } = {}) {
  if (!isSchema(stateSchema) || !isSchema(viewSchema)) {
    throw new TypeError('sessionLiveMetrics requires stateSchema and viewSchema with parse()')
  }
  return {
    key: 'sessionLiveMetrics',
    stateVersion: 4,
    stateSchema,
    init: () => initialLiveMetricsState(),
    apply: applyLiveMetricsEvent,
    wire: {
      viewSchema,
      view: toLiveMetricsView,
    },
  }
}
