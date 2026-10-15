#!/usr/bin/env node
// scripts/check-bundles.mjs —— 校验 packages/{ui,runtime,bundles}/* 的结构一致性。
//
// 为什么需要它：DSH 的行 id 在**整棵组合树里必须唯一** —— 同一个 id 出现两次，
// dsh-plugin-manager 的 listPlugins() 会把该行判成 `unaddressable`（面板里既没有开关也拨不动，
// 而且不报错）。拆分/搬家 bundle 行时最容易犯的两个错是：① 一行被两个 bundle 同时 insert；
// ② 行写进了 patch 却没写进该 bundle 的 dependencies（别人装不上）。本脚本把这两类结构错误
// 拦在部署/发布之前。
//
// 用法: node scripts/check-bundles.mjs
// 退出码: 0 = 全部通过; 1 = 有问题（逐条打印）。
//
// 覆盖的判据：
//   1. 目录名 = 包名去掉 scope（deploy 脚本按这条规则决定落地目录，错了会铺错地方）；
//   2. 每个 bundle 包的 `dsh.bundle.patch` 指向的文件存在，且能解析出组件行；
//   3. 行 id 全局唯一，且行 id = 行 name 去掉 scope；
//   4. 每个 bundle 的 dependencies 集合 == 它的行 name 集合；
//   5. 每个组件包（ui/ 与 runtime/ 下的包）恰好被一个 bundle 行引用 —— 除非它被显式登记进
//      下面的 UNBUNDLED（「故意不随任何 bundle 下发」的包）；
//   6. 源码树分组 = bundle 归属（packages/ui/* → dsh-plugins-ui，packages/runtime/* →
//      dsh-plugins-runtime）—— 分组自 2026-10-15 起就是「归属判据」的落地，防止搬行/搬目录时
//      只改一半。UNBUNDLED 里的包不参与本条。
//
// 限制：patch 解析只认本仓库使用的块式写法（`- insert:` + 缩进的 `- id:` / `disabled:` / `name:`）。
// 若哪天改成 flow style，请先扩展 parseInsertRows()。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const PACKAGES = join(REPO, 'packages')
const GROUPS = ['ui', 'runtime', 'bundles']

// 判据 5 的豁免清单：**故意不随任何 bundle 下发**的组件包（写目录名）。
// 为什么要有它：仓库里的包不一定都在 bundle 里 —— 包可以只留作真源、按需在 profile 里手写
// insert 单独挂；但「没被引用」这件事必须是**显式登记**的，不能靠漏写静默通过（否则一行被
// 误删也查不出来）。清单里的包如果又被某个 bundle 引用了，同样报错（清单过期，该删掉这行）。
//   kanban-board：2026-10-15 从 @gavinc-cn/dsh-plugins-ui 移除（行 + dependencies），包本体留在
//                 仓库 packages/ui/kanban-board/，npm 上的 0.1.2 也仍在。
const UNBUNDLED = new Set(['kanban-board'])

// 判据 6 的期望映射：源码树分组 → 该分组的包应归属的 bundle 包名。
// 为什么要机检：2026-10-15 把 dsh-patch-ask-expand 从 runtime 分组搬到 ui 分组 + 从运行时 bundle
// 搬到 UI bundle（判据从「代码跑在哪」改成「面向谁」，见 docs/plan-2026-10-15-ask-expand-to-ui-bundle.md）。
// 那种「搬一半」的状态（目录搬了、行没搬，或反过来）此前只能靠人肉核对，现在由本条拦住。
const GROUP_BUNDLE = {
  ui: '@gavinc-cn/dsh-plugins-ui',
  runtime: '@gavinc-cn/dsh-plugins-runtime',
}

const failures = []
const fail = (msg) => failures.push(msg)

/** 列出 packages/<group>/<pkg> 下所有含 package.json 的包目录。 */
function listPackages() {
  const out = []
  for (const group of GROUPS) {
    let entries
    try {
      entries = readdirSync(join(PACKAGES, group), { withFileTypes: true })
    } catch {
      fail(`缺少分组目录 packages/${group}/`)
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(PACKAGES, group, entry.name)
      if (!statSync(join(dir, 'package.json'), { throwIfNoEntry: false })) {
        fail(`packages/${group}/${entry.name}/ 没有 package.json`)
        continue
      }
      out.push({ group, dirName: entry.name, dir, manifest: readManifest(dir) })
    }
  }
  return out
}

/** 读包清单（解析失败直接算失败项）。 */
function readManifest(dir) {
  const file = join(dir, 'package.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`无法解析 ${file}: ${error.message}`)
    return {}
  }
}

/** 包名去掉 scope：@gavinc-cn/dsh-memory → dsh-memory。 */
const slug = (name) => String(name ?? '').split('/').pop()

/**
 * 解析 bundle patch 里的 `- insert:` 行。
 * @returns {{id: string, name?: string, disabled?: boolean, line: number}[]}
 */
function parseInsertRows(text, file) {
  const rows = []
  let current = undefined
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) return
    const id = /^\s*-\s+id:\s*(.+?)\s*$/.exec(line)
    if (id) {
      current = { id: unquote(id[1]), line: index + 1 }
      rows.push(current)
      return
    }
    if (current === undefined) return
    const name = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (name) {
      current.name = unquote(name[1])
      return
    }
    const disabled = /^\s*disabled:\s*(true|false)\s*$/.exec(line)
    if (disabled) current.disabled = disabled[1] === 'true'
  })
  if (rows.length === 0) fail(`${file} 里解析不到任何组件行（写法变了？见脚本头部说明）`)
  return rows
}

const unquote = (value) => value.replace(/^["']|["']$/g, '')

// ── 主流程 ────────────────────────────────────────────────────────────────────
const packages = listPackages()
const components = packages.filter((p) => p.group !== 'bundles')
const bundles = packages.filter((p) => p.group === 'bundles')
const componentNames = new Set(components.map((p) => p.manifest.name))

// 判据 1：目录名 = 包名短名
for (const pkg of packages) {
  if (slug(pkg.manifest.name) !== pkg.dirName) {
    fail(`packages/${pkg.group}/${pkg.dirName}/: 目录名与包名短名不一致（${pkg.manifest.name}）`)
  }
}

// 判据 2-4：bundle 的行
const rowOwner = new Map()
/** 组件包短名 → 引用它的 bundle 包名（判据 6 用；只有 ui/runtime 分组的包会进这张表）。 */
const bundleOf = new Map()
for (const bundle of bundles) {
  const name = bundle.manifest.name
  const rel = `packages/bundles/${bundle.dirName}`
  const patchRel = bundle.manifest.dsh?.bundle?.patch
  if (patchRel === undefined) {
    // 聚合元包：合法形态，但必须在 README 里说明它不能被写进 dsh.profile.bundles
    console.log(`-- ${name}: 非 bundle（聚合元包），跳过行校验`)
    continue
  }
  const patchFile = join(bundle.dir, patchRel)
  let text
  try {
    text = readFileSync(patchFile, 'utf8')
  } catch {
    fail(`${rel}: dsh.bundle.patch 指向的 ${patchRel} 不存在`)
    continue
  }
  const rows = parseInsertRows(text, `${rel}/${patchRel}`)
  const deps = new Set(Object.keys(bundle.manifest.dependencies ?? {}))
  const rowNames = new Set()

  for (const row of rows) {
    if (row.name === undefined) {
      fail(`${rel}/${patchRel}:${row.line}: 行 ${row.id} 缺少 name`)
      continue
    }
    if (slug(row.name) !== row.id) fail(`${rel}/${patchRel}:${row.line}: 行 id ${row.id} ≠ 包名短名 ${slug(row.name)}`)
    if (rowOwner.has(row.id)) fail(`行 id 重复: ${row.id}（${rowOwner.get(row.id)} 与 ${rel}）`)
    else rowOwner.set(row.id, rel)
    if (!deps.has(row.name)) fail(`${rel}: 行 ${row.id} 的包 ${row.name} 不在 dependencies 里`)
    if (!componentNames.has(row.name)) fail(`${rel}: 行 ${row.id} 的包 ${row.name} 在 packages/{ui,runtime}/ 里找不到`)
    else bundleOf.set(row.id, name)
    rowNames.add(row.name)
  }

  for (const dep of deps) if (!rowNames.has(dep)) fail(`${rel}: dependencies 里的 ${dep} 没有对应的组件行`)

  const off = rows.filter((row) => row.disabled === true).length
  console.log(`-- ${name}: ${rows.length} 行（默认停用 ${off} 个）`)
}

// 判据 5：每个组件包恰好被一个行引用（UNBUNDLED 里登记过的除外，且登记过的必须确实没被引用）
for (const component of components) {
  const owner = rowOwner.get(component.dirName)
  const exempt = UNBUNDLED.has(component.dirName)
  if (owner === undefined && !exempt) {
    fail(
      `packages/${component.group}/${component.dirName}/: 没有任何 bundle 行引用它` +
        `（若是有意不随 bundle 下发，请登记进 check-bundles.mjs 的 UNBUNDLED）`
    )
  }
  if (owner !== undefined && exempt) {
    fail(
      `packages/${component.group}/${component.dirName}/: 已在 UNBUNDLED 里登记为「不随 bundle 下发」，` +
        `却又被 ${owner} 引用 ⇒ 清单过期，请从 UNBUNDLED 里删掉它`
    )
  }
}

// 判据 6：源码树分组与 bundle 归属一致（搬行/搬目录只做一半时在这里报错）
for (const component of components) {
  const expected = GROUP_BUNDLE[component.group]
  const actual = bundleOf.get(component.dirName)
  if (expected === undefined || actual === undefined) continue
  if (actual !== expected) {
    fail(
      `packages/${component.group}/${component.dirName}/: 归 ${actual}，但它在 packages/${component.group}/ 分组里` +
        ` ⇒ 期望归 ${expected}。要么把行搬过去、要么把目录搬过去（判据见 docs/plan-2026-10-15-ask-expand-to-ui-bundle.md）`
    )
  }
}

// 汇总
console.log(`\n组件包 ${components.length} 个，bundle 包 ${bundles.length} 个，组件行 ${rowOwner.size} 条`)
if (UNBUNDLED.size > 0) {
  console.log(`-- 不随任何 bundle 下发（UNBUNDLED 显式豁免）：${[...UNBUNDLED].join(', ')}`)
}
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项不通过:`)
  for (const message of failures) console.error(`   - ${message}`)
  process.exit(1)
}
console.log('✓ 结构校验全部通过')
