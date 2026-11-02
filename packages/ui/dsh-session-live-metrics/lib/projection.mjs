/**
 * `sessionLiveMetrics` 的宿主投影定义（Zod schema + 纯折叠）。
 *
 * state 会被持久化缓存，因此只允许 JSON 值；wire view 剔除 route/lastSeq 等宿主字段。
 * 任何 schema 变更都必须提升 stateVersion，否则旧缓存会被当作新状态继续 forward-apply。
 */

import { z } from 'zod'
import { createSessionLiveMetricsDefinition } from './definition.mjs'

const SAFE_INT = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const SAFE_TIME = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const LAST_SEQ = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER)

const ROUTE = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
}).strict()

const SAMPLE = z.object({
  firstTokenTime: SAFE_TIME,
  completedTime: SAFE_TIME,
  outputTokens: SAFE_INT,
}).strict()

const BREAKDOWN = z.object({
  model: z.string().min(1),
  period: z.enum(['peak', 'offPeak']),
  cacheMissTokens: SAFE_INT,
  cacheHitTokens: SAFE_INT,
  outputTokens: SAFE_INT,
  calls: SAFE_INT,
  nanoYuan: SAFE_INT,
}).strict()

const REASONS = z.record(z.string(), SAFE_INT)

const stateSchema = z.object({
  lastSeq: LAST_SEQ,
  route: ROUTE.nullable(),
  requestStartedAt: SAFE_TIME.nullable(),
  nanoYuan: SAFE_INT,
  pricedCalls: SAFE_INT,
  unpricedCalls: SAFE_INT,
  unpricedReasons: REASONS,
  approximateCalls: SAFE_INT,
  holidayTableMissingCalls: SAFE_INT,
  breakdown: z.record(z.string(), BREAKDOWN),
  samples: z.array(SAMPLE),
  latestEventTime: SAFE_TIME,
}).strict()

const viewSchema = z.object({
  nanoYuan: SAFE_INT,
  pricedCalls: SAFE_INT,
  unpricedCalls: SAFE_INT,
  unpricedReasons: REASONS,
  approximateCalls: SAFE_INT,
  holidayTableMissingCalls: SAFE_INT,
  breakdown: z.array(BREAKDOWN),
  samples: z.array(SAMPLE),
}).strict()

/** 注册到 `ctx.sessionProjections` 的正式定义。 */
export const sessionLiveMetricsDefinition = createSessionLiveMetricsDefinition({
  stateSchema,
  viewSchema,
})
