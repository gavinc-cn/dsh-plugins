// dsh-write-guard 的 shell 词法小工具（纯函数）。
//
// 职责：把 `tokenizeShell` 产出的段内普通词列表解释成「真正的命令词下标」，供 decide.mjs
// （风险扫描）与 script.mjs（脚本引用识别）共用：
//   * `baseNameOf`：取路径最后一段（同时认 `/` 与 `\`，兼容 Windows 风格命令词）；
//   * `commandWordIndex`：跳过前缀环境变量赋值（`FOO=1 cmd`）与 `env` 包装
//     （`env -u FOO cmd`），返回真正执行的命令词下标。
//
// 边界：
//   * 只做词法判断，不解析完整 shell 语义、不读写文件、不访问网络；
//   * 只认 `env` 这一种包装：其它包装（nohup/timeout 等）由调用方按需再跳；
//   * 与 dsh-path-rules 的 analyze 模块保持同一 tokenizer 口径（同样的 words 列表形状）。
//
// spec 对应：§5.3 shell 静态分析（命令词识别）、§5.9 脚本引用识别。

/** 取路径的最后一段（同时认 `/` 与 `\`，用于 Windows 风格的命令词）。 */
export function baseNameOf(word) {
  return String(word ?? '').split(/[\\/]/).pop() ?? ''
}

/** `env` 里带取值的选项：值不是命令词，必须连同值一起跳过（否则 `env -u FOO ln …` 会漏判）。 */
export const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir'])

/**
 * 取一段命令词里的「命令词」下标：跳过前缀环境变量赋值与 `env` 包装。
 *
 * 为什么跳过 `env`：`env ln -s /etc /proj/etc` 的 words[0] 是 `env`，但真正建链的是
 * `ln`；分析器会把 `env` 递归成 `ln` 的写目标，若不在这里识别建链就会漏掉（I2）。
 *
 * @param words - `tokenizeShell` 的段内普通词列表。
 * @returns 命令词下标；没有可识别的命令词返回 -1。
 */
export function commandWordIndex(words) {
  if (!Array.isArray(words) || words.length === 0) return -1
  let index = 0
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1
  if (index >= words.length) return -1
  if (baseNameOf(words[index]).toLowerCase() !== 'env') return index
  index += 1
  // 跳过 env 的选项与 NAME=value；`-u NAME`/`-C DIR` 的值段不能被误当成命令词。
  while (index < words.length) {
    const word = words[index]
    if (word === '--') {
      index += 1
      break
    }
    const eq = word.indexOf('=')
    const name = eq === -1 ? word : word.slice(0, eq)
    if (ENV_VALUE_OPTIONS.has(name)) {
      index += eq === -1 ? 2 : 1
      continue
    }
    if (word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1
      continue
    }
    break
  }
  return index < words.length ? index : -1
}
