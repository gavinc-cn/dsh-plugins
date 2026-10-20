// dsh-write-guard 的自动白名单（spec §5.5）。
//
// 职责（三条）：
//   ① 推导：用户批准一次越界写后，把写目标折叠成「值得学习的目录」——目标本身已是
//      目录取自身，否则取父目录；路径先归一化（realpath 最深存在前缀），再按目标去重；
//   ② 过滤：按项目/白名单/临时区、保护路径、敏感根三条护栏筛掉不该自动学习的候选；
//      敏感根自身或其祖先不学目录，退化为「只学这次写入的精确文件」；
//   ③ 持久化：读写按平台分区的状态文件（缺省 `<dsh home>/write-guard/auto-whitelist.json`），
//      追加带时间戳与来源元数据的条目，超过 MAX_AUTO_ENTRIES 淘汰最旧。
//
// 三条职责边界：
//   - 不判定工具调用是否越界，也不决定插件是否激活、是否把调用记进 pending——那是
//     decide.mjs / index.mjs 的职责；本模块只处理「已经拿到用户批准的那次调用」。
//   - 不修改内存里的 config.whitelist、不自增 whitelistVersion、不写审计日志；这些接线
//     由 index.mjs 完成，保证本模块是可直接单测的纯工具集合。
//   - 不访问网络；文件系统接触仅限 statSync（判目录）与状态文件读写，所有失败都以
//     返回值（空数组 / error 字段 / saved:false）表达，绝不向调用方抛错——它运行在
//     审批监听器里，任何异常都绝不能影响审批结论本身。
//
// spec 对应：§5.5 自动白名单。

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  MAX_AUTO_ENTRIES,
  expandHome,
  loadAutoWhitelist,
  saveAutoWhitelist,
} from '@gavinc-cn/dsh-path-rules/auto-whitelist'
import { normalizePath, underRoot } from '@gavinc-cn/dsh-path-rules/rules'
import { classifyTargetKind } from './decide.mjs'

/**
 * 解析 DSH home：优先宿主注入的 `dshHomePath` 服务，其次 `$DSH_HOME`，最后 `~/.dsh`。
 *
 * 任一来源不可用/为空/抛错都继续回退；返回值可能是相对路径或用户手写的带空白路径，
 * 调用方（`resolveAutoWhitelistFile`）随后会做 `normalizePath`。
 *
 * @param ctx - 插件上下文（只需 `ctx.get`；可为 null）。
 * @returns {string} DSH home 路径（非空）。
 */
export function resolveDshHome(ctx) {
  // ① 宿主服务：`ctx.get('dshHomePath')` 返回一个取值函数，尊重 `DSH_HOME` 等宿主配置。
  const get = ctx?.get
  if (typeof get === 'function') {
    try {
      const provider = get.call(ctx, 'dshHomePath')
      if (typeof provider === 'function') {
        const home = provider()
        if (typeof home === 'string' && home.trim().length > 0) return home.trim()
      }
    } catch {
      /* 服务不可用 ⇒ 走环境变量回退（审批链上不能因宿主服务异常而中断）。 */
    }
  }
  // ② 环境变量：去掉首尾空白后非空才认。
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv.length > 0) return fromEnv
  // ③ 最终回退：`~/.dsh`（与 DSH 默认安装布局一致）。
  return join(homedir(), '.dsh')
}

/**
 * 解析自动白名单状态文件路径：配置项优先（支持 `~`），否则放在
 * `<dsh home>/write-guard/auto-whitelist.json`。
 *
 * 与 config.mjs 的分工：config 只负责 `~` 展开与「空 = 未配置」的语义，
 * 这里才基于运行期上下文决定最终绝对路径，并统一做 `normalizePath`（realpath 最深前缀）。
 *
 * @param config - 归一化后的插件配置（只读 `autoWhitelistFile`；可为 null）。
 * @param ctx - 插件上下文（传给 `resolveDshHome`）。
 * @returns {string} 归一化后的状态文件绝对路径。
 */
export function resolveAutoWhitelistFile(config, ctx) {
  const configured = config?.autoWhitelistFile
  if (typeof configured === 'string' && configured.trim().length > 0) {
    // 与 config.mjs 同序：先展开 `~`（展开后才可能变成绝对路径），再归一化。
    return normalizePath(expandHome(configured.trim(), homedir()), process.cwd())
  }
  return normalizePath(
    join(resolveDshHome(ctx), 'write-guard', 'auto-whitelist.json'),
    process.cwd(),
  )
}

/**
 * 目标路径 → 要学习的目录：目标本身已是目录就取自身，否则取父目录。
 *
 * 只以「是否已是目录」为证据：批准后要写的新文件/新目录通常还不存在，此时父目录是
 * 最保守的可学习范围。stat 失败（不存在/无权限/非法路径）一律按父目录处理，不抛。
 *
 * @param target - 归一化后的绝对路径（非法/空值返回空串）。
 * @returns {string} 目录路径；非法输入返回空串。
 */
export function directoryOf(target) {
  if (typeof target !== 'string' || target.trim().length === 0) return ''
  try {
    if (statSync(target).isDirectory() === true) return target
  } catch {
    /* 不存在/不可读 ⇒ 按「待创建的文件」处理，取父目录。 */
  }
  return dirname(target)
}

/**
 * 把一批原始写目标归一化并折叠成 `{target, dir}` 候选（去重、丢弃空/非法项）。
 *
 * 归一化基准是会话 cwd（相对路径按它解析），去重以归一化后的 target 为准、保留首次出现
 * 的顺序——同一目标在一条命令里被分析出多次是常见现象。
 *
 * @param targets - 原始写目标（数组；可为 null/含非法值）。
 * @param cwd - 相对路径解析基准；缺失时回退 process.cwd()。
 * @returns {Array<{target: string, dir: string}>} 去重后的候选对。
 */
export function deriveLearnDirs(targets, cwd) {
  const base =
    typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : process.cwd()
  const pairs = []
  const seen = new Set()
  for (const target of Array.isArray(targets) ? targets : []) {
    // 只处理非空字符串；数字/null/对象等一律忽略（上游分析结果可能不干净）。
    if (typeof target !== 'string' || target.trim().length === 0) continue
    let normalized
    try {
      normalized = normalizePath(target, base)
    } catch {
      continue
    }
    if (normalized.length === 0 || seen.has(normalized)) continue
    const dir = directoryOf(normalized)
    if (dir.length === 0) continue
    seen.add(normalized)
    pairs.push({ target: normalized, dir })
  }
  return pairs
}

/** 把「路径字符串列表」选项清洗成非空字符串数组（容忍 null/非数组/数组内非法项）。 */
function cleanPathList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.length > 0)
}

/** 目标是否为「已存在的目录」；stat 失败（不存在/无权限）返回 false。 */
function isExistingDirectory(target) {
  try {
    return statSync(target).isDirectory() === true
  } catch {
    return false
  }
}

/**
 * 过滤候选目录：只保留「值得且可以自动加入白名单」的那些，并逐条记录跳过原因。
 *
 * 检查顺序（先命中者胜，spec §5.5）：
 *   ① `no-need`：目录已被项目/白名单/临时区覆盖（本来就直通，学习无意义）；
 *   ② `protected`：与 DSH home、状态文件、日志文件等保护路径有祖先/后代关系
 *      （防止一次批准放大成「能改守卫自己的配置/白名单」的长期权限）；
 *   ③ `sensitive`：目录是敏感根或敏感根祖先。此时不学目录——若本次目标是已存在目录
 *      就跳过；否则只学 target 本身（精确文件），避免把整个系统目录/home 加进白名单；
 *   ④ 其余接受目录本身；`accepted` 按最终 path 去重，重复项记为 `dup`。
 *
 * @param pairs - `deriveLearnDirs` 的输出（容忍 null/坏项）。
 * @param options - `{roots: {project, whitelist, temp}, protectedPaths, sensitiveRoots}`。
 * @returns {{accepted: Array<{path: string, target: string}>,
 *   skipped: Array<{path: string, target: string,
 *     reason: 'no-need'|'protected'|'sensitive'|'dup'}>}}
 */
export function filterLearnDirs(pairs, options) {
  const roots = options?.roots ?? {}
  const protectedPaths = cleanPathList(options?.protectedPaths)
  const sensitive = cleanPathList(options?.sensitiveRoots)
  const accepted = []
  const acceptedPaths = new Set()
  const skipped = []

  for (const item of Array.isArray(pairs) ? pairs : []) {
    const target = item?.target
    const dir = item?.dir
    if (typeof target !== 'string' || target.length === 0) continue
    if (typeof dir !== 'string' || dir.length === 0) continue

    // ① 已有直通路径覆盖 ⇒ 无需学习。
    const classification = classifyTargetKind(dir, roots)
    if (
      classification === 'project' ||
      classification === 'whitelist' ||
      classification === 'temp'
    ) {
      skipped.push({ path: dir, target, reason: 'no-need' })
      continue
    }

    // ② 保护路径：自身、祖先或后代任一方向相关都算，永不自动学习。
    if (
      protectedPaths.some(
        (protectedPath) => underRoot(protectedPath, dir) || underRoot(dir, protectedPath),
      )
    ) {
      skipped.push({ path: dir, target, reason: 'protected' })
      continue
    }

    // ③ 敏感根：目录是敏感根或其祖先时不学目录，退化为精确文件。
    let path = dir
    if (sensitive.some((root) => underRoot(root, dir))) {
      if (isExistingDirectory(target)) {
        // 目标本身就是敏感根（或敏感根下已存在的目录）：学它会把审批放大成整个目录。
        skipped.push({ path: dir, target, reason: 'sensitive' })
        continue
      }
      // 目标不存在或是普通文件：只学习这一次的精确文件。
      path = target
    }

    // ④ 接受；同一 path 只保留第一次（例如 /data/a.txt 与 /data/b.txt 都折叠到 /data）。
    if (acceptedPaths.has(path)) {
      skipped.push({ path, target, reason: 'dup' })
      continue
    }
    acceptedPaths.add(path)
    accepted.push({ path, target })
  }

  return { accepted, skipped }
}

/**
 * 读取当前平台的自动白名单：归一化路径、过滤空/重复，同时返回归一化后的条目副本。
 *
 * 状态文件由用户手改/跨平台同步产生，损坏是常态：这里的约定是「只报 error、不抛、
 * 不阻止插件加载」。文件不存在由 path-rules 的 `loadAutoWhitelist` 视为正常空表。
 *
 * @param file - 状态文件绝对路径。
 * @param platform - 当前平台（默认 process.platform）。
 * @returns {{paths: string[], entries: object[], error?: string}}
 */
export function loadAutoWhitelistPaths(file, platform = process.platform) {
  const targetPlatform =
    typeof platform === 'string' && platform.length > 0 ? platform : process.platform
  let loaded
  try {
    loaded = loadAutoWhitelist(file, targetPlatform)
  } catch (error) {
    // path-rules 内部已做容错，这里只是最后一道保险：审批链上绝不向外抛。
    return { paths: [], entries: [], error: `读取失败：${String(error)}` }
  }

  const paths = []
  const entries = []
  for (const entry of Array.isArray(loaded?.entries) ? loaded.entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    let path
    try {
      path = normalizePath(entry.path, process.cwd())
    } catch {
      continue
    }
    // 归一化后为空（原值为空/非法）或与已有条目重复：跳过，保证落盘的是干净路径。
    if (path.length === 0 || paths.includes(path)) continue
    paths.push(path)
    entries.push({ ...entry, path, platform: entry.platform ?? targetPlatform })
  }

  const error =
    typeof loaded?.error === 'string' && loaded.error.length > 0 ? loaded.error : undefined
  // 成功时不要带 error 键（便于调用方 deepEqual 与「无错误」语义区分）。
  return error === undefined ? { paths, entries } : { paths, entries, error }
}

/**
 * 追加学习结果并落盘：按平台分区保留其它平台条目，超上限从最旧开始淘汰。
 *
 * 失败语义：写状态文件失败只返回 `saved:false` + `error`，不抛；返回值里的 `entries`
 * 仍是「本次尝试写入的完整列表」，调用方可用它决定是否更新内存态。
 *
 * @param input - `{file, platform, entries, addedPaths, meta}`：
 *   `entries` 为当前平台已有条目，`addedPaths` 为本次新学到的路径，
 *   `meta` 会浅合并进每条新条目（如 `{source, callId}`）。
 * @returns {{entries: object[], added: string[], saved: boolean, error?: string}}
 */
export function persistAutoWhitelist(input = {}) {
  const { file, platform, entries, addedPaths, meta } = input ?? {}
  const targetPlatform =
    typeof platform === 'string' && platform.length > 0 ? platform : process.platform
  // 只接受对象形式的 meta，避免字符串被展开成一堆字符键。
  const extra = meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}
  const added = Array.isArray(addedPaths) ? [...addedPaths] : []

  // 先按调用方给的顺序拼接；`addedAt` 逐条取当前时刻（与 spec 的条目形状一致）。
  const next = [
    ...(Array.isArray(entries) ? entries : []),
    ...added.map((path) => ({
      path,
      platform: targetPlatform,
      addedAt: new Date().toISOString(),
      ...extra,
    })),
  ]
  // 上限按「最旧淘汰」：自动白名单只是便利，不能无限膨胀。
  while (next.length > MAX_AUTO_ENTRIES) next.shift()

  let saved = false
  let error
  try {
    const result = saveAutoWhitelist(file, targetPlatform, next)
    saved = result?.ok === true
    if (!saved) {
      error =
        typeof result?.error === 'string' && result.error.length > 0
          ? result.error
          : '保存自动白名单失败'
    }
  } catch (cause) {
    // 理论上 saveAutoWhitelist 已吞掉所有异常，这里防御未来实现变化。
    saved = false
    error = String(cause)
  }

  return error === undefined
    ? { entries: next, added, saved }
    : { entries: next, added, saved, error }
}
