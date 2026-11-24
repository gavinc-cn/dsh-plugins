/**
 * @gavinc-cn/dsh-deepseek-account 宿主入口。
 * 目的：在 DSH 状态栏提供官方余额与本机当日 token 费用估算。
 * 生效链路：bundle 新增行 → 宿主注册 owner-only routes → client 胶囊轮询。
 * 移除方式：在 Plugins 面板停用本行；routes 与事件订阅随 fiber 一并卸载。
 */

import { DeepSeekAccountRuntime } from './runtime.mjs'
import { registerAccountRoutes } from './routes.mjs'

export const name = 'dsh-deepseek-account'
export const inject = ['credentials', 'sessionQuery', 'sessionPersistence', 'connection']

/** 创建运行体、注册路由并绑定卸载清理；初始化失败只告警，不阻断宿主。 */
export async function apply(ctx, config = {}) {
  let runtime
  let disposeRoutes = () => {}
  try {
    runtime = new DeepSeekAccountRuntime(ctx, config)
    disposeRoutes = registerAccountRoutes(ctx, runtime)
    await ctx.effect(async () => async () => {
      disposeRoutes()
      runtime.dispose()
    }, 'deepseek-account-runtime')
    runtime.start()
  } catch (error) {
    disposeRoutes()
    runtime?.dispose()
    console.warn('[dsh-deepseek-account] 初始化失败', error)
  }
}
