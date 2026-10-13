#!/usr/bin/env bash
#
# 把本仓库（源码真源）铺到 dsh **真正加载**的那份「共享活副本」：
#
#   仓库 packages/<分组>/<包>/  →  ~/.dsh/profiles/node_modules/@gavinc-cn/<包>/
#
# 分组（ui | runtime | bundles）只是**源码树里的组织方式**，落地目录始终是扁平的
# `@gavinc-cn/<包>/` —— Node 的 scope 解析、profile 覆盖行里的绝对路径都按包名走，
# 所以目标目录名由 package.json 的 name 去掉 scope 决定，并要求它等于目录名（不等直接报错，
# 免得铺错地方）。
#
# 目标目录在 mutagen 白名单 `!.dsh/profiles/node_modules/@gavinc-cn/**` 之内，会双向同步到宿主
# `<宿主用户目录>/.dsh/profiles/node_modules/@gavinc-cn/<包>` —— 容器 web profile 与宿主 desktop
# profile 共用同一份，改完 patch 层/代码当场热重载，不需要 pnpm 重装、也不需要重启
# （例外：profile 的 `dsh.profile.bundles` 是启动时读的，改它要重启宿主）。
#
# 用法:
#   scripts/deploy-to-dsh.sh [--dry-run] [--prune] [--quiet] [<包名>...]
#
#   --dry-run   只报告将发生的变化，不写盘（等价 rsync -n）
#   --prune     删除「共享副本里有、仓库里没有」的文件（默认只报告不删：共享副本是 dsh 正在
#               加载的活目录，宁可留多余文件也不要误删运行时要用的东西）
#   --quiet     只打印有差异的包
#   <包名>...   只部署指定包（缺省 = packages/<分组>/<包>/ 下全部）
#
# 环境变量:
#   DSH_SHARED_ROOT  共享活副本的根目录（缺省 $HOME/.dsh/profiles/node_modules/@gavinc-cn）
#
# 退出码: 0 = 目标与仓库一致（--prune 时逐字节一致，默认模式下允许共享副本存在多余文件）;
#         1 = 有包部署失败或校验不通过; 2 = 用法错误。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST_ROOT="${DSH_SHARED_ROOT:-$HOME/.dsh/profiles/node_modules/@gavinc-cn}"

DRY_RUN=0
PRUNE=0
QUIET=0
WANTED=()

usage() {
  # 打印文件头注释块（第 3 行起、直到第一行非注释）
  awk 'NR >= 3 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
    --prune)      PRUNE=1 ;;
    -q|--quiet)   QUIET=1 ;;
    -h|--help)    usage; exit 0 ;;
    -*)           echo "未知选项: $1" >&2; usage >&2; exit 2 ;;
    *)            WANTED+=("$1") ;;
  esac
  shift
done

command -v rsync >/dev/null 2>&1 || { echo "需要 rsync（未安装）" >&2; exit 1; }
[ -d "$DST_ROOT" ] || { echo "共享活副本根目录不存在: $DST_ROOT" >&2; exit 1; }

# 包发现：packages/<分组>/<包>/（分组 ui | runtime | bundles），建「包短名 → 仓库目录」映射。
# 短名 = package.json 的 name 去掉 scope，必须等于目录名 —— 这条规则同时决定落地目录，
# 所以在这里 fail-fast，而不是等 rsync 把文件铺到错的地方。
declare -A PKG_DIR=()
for d in "$REPO"/packages/*/*/; do
  [ -f "$d/package.json" ] || continue
  dir_name="$(basename "$d")"
  pkg_slug="$(node -e 'const m=require(process.argv[1]); process.stdout.write(String(m.name ?? "").split("/").pop())' "$d/package.json")"
  if [ "$pkg_slug" != "$dir_name" ]; then
    echo "错误: $d 的包名短名（$pkg_slug）与目录名（$dir_name）不一致；deploy 按目录名铺到共享副本，先统一再跑" >&2
    exit 1
  fi
  PKG_DIR["$dir_name"]="$d"
done
if [ "${#PKG_DIR[@]}" -eq 0 ]; then
  echo "错误: $REPO/packages/*/*/ 下没发现任何包" >&2
  exit 1
fi

# 待部署的包：显式给的包名，否则全部（排序后输出稳定）
if [ ${#WANTED[@]} -gt 0 ]; then
  PKGS=("${WANTED[@]}")
else
  PKGS=()
  while IFS= read -r name; do PKGS+=("$name"); done < <(printf '%s\n' "${!PKG_DIR[@]}" | sort)
fi

# --checksum: 按内容比对而不是 mtime+size。本仓库位于 9p/drvfs 挂载（Windows D: 盘），
# mtime 只有秒级精度（亚秒被截断），靠 mtime 比对会把每个文件都误判成「变了」→ 无谓改写
# 活副本、白白触发 HMR。一百多个小文件算校验和的开销可以忽略。
#
# 只同步**内容**，不碰元数据（2026-10-13 拆包时补）：
#   --no-perms/--no-owner/--no-group  仓库在 9p 挂载上，POSIX 权限不可信（同一批文件在不同时刻
#                                     会被渲染成 644 或 777）；而共享活副本在容器 ext4 上，权限是
#                                     真实生效的。跟着仓库走会把活副本刷成 777，故一律不动。
#   --no-times                        内容相同就不该改 mtime —— inotify 型热重载（含 dsh 的
#                                     patch 层与 client bundle stat-poll）会因此无谓重载。
# 效果：内容一致 = 零写入（连元数据都不动）；内容变了才写，写完整层照常热重载。
RSYNC_OPTS=(-r -l -c --no-times --no-perms --no-owner --no-group --itemize-changes --exclude node_modules/ --exclude .git/)
[ "$DRY_RUN" -eq 1 ] && RSYNC_OPTS+=(-n)
[ "$PRUNE"   -eq 1 ] && RSYNC_OPTS+=(--delete)
[ "$QUIET"   -eq 1 ] && RSYNC_OPTS+=(-q)

echo "仓库:   $REPO"
echo "目标:   $DST_ROOT"
echo "模式:   $([ "$DRY_RUN" -eq 1 ] && echo 'dry-run（不写盘）' || echo '写入')$([ "$PRUNE" -eq 1 ] && echo ' + prune（会删除多余文件）' || echo '')"
echo

rc=0
checked=0
for pkg in "${PKGS[@]}"; do
  src="${PKG_DIR[$pkg]:-}"
  dst="$DST_ROOT/$pkg"

  if [ -z "$src" ]; then
    echo "跳过 $pkg: 仓库 packages/*/*/ 下没有这个包" >&2
    rc=1
    continue
  fi

  [ -d "$dst" ] || echo "== $pkg: 共享副本里不存在，将新建（rsync 会自动创建目录）"

  # 统计「真实变化」：-i 会给每个文件一行，`$1` 是 11 位 itemize 串 —— `.f` / `.d` 表示无变化
  # （长度恰为 2），带任何标志位或 `<`/`>`/`c`/`h` 前缀才算变化。
  changes="$(rsync "${RSYNC_OPTS[@]}" "$src/" "$dst/" | awk '{ s = $1; if (s ~ /^[<>ch]/) n++; else if (length(s) > 2) n++ } END { print n + 0 }')"
  checked=$((checked + 1))

  if [ ! -d "$dst" ]; then
    printf '== %-28s %s\n' "$pkg" "$([ "${changes:-0}" -gt 0 ] && echo "待同步（${changes} 项变化）" || echo '无差异')"
    continue
  fi

  # 逐包校验：默认模式容忍共享副本多出的文件（可能是运行时的东西），--prune 时要求逐字节一致
  mismatch="$(diff -rq --exclude node_modules --exclude .git "$src" "$dst" 2>&1 || true)"
  if [ "$PRUNE" -eq 1 ]; then
    bad="$(printf '%s\n' "$mismatch" | grep -v '^$' || true)"
  else
    bad="$(printf '%s\n' "$mismatch" | grep -v '^$' | grep -v '^Only in ' || true)"
    extra="$(printf '%s\n' "$mismatch" | grep '^Only in ' || true)"
  fi

  if [ -n "${bad:-}" ]; then
    echo "== $pkg: 校验不通过"
    printf '%s\n' "$bad" | sed 's/^/   /'
    rc=1
  elif [ "$DRY_RUN" -eq 1 ]; then
    printf '== %-28s %s\n' "$pkg" "$([ "${changes:-0}" -gt 0 ] && echo "待同步（${changes} 项变化）" || echo '无差异')"
  elif [ "$QUIET" -eq 0 ] || [ "${changes:-0}" -gt 0 ]; then
    printf '== %-28s %s\n' "$pkg" "$([ "${changes:-0}" -gt 0 ] && echo "已同步（${changes} 项变化）" || echo '无差异')"
  fi
  if [ -n "${extra:-}" ]; then
    echo "   注意: 共享副本里有仓库中不存在的文件（未删除；要删加 --prune）:"
    printf '%s\n' "$extra" | sed 's/^/     /'
  fi
done

echo
if [ "$rc" -eq 0 ]; then
  echo "OK: $checked 个包已核对$([ "$DRY_RUN" -eq 1 ] && echo '（dry-run，未写盘）' || echo '，目标与仓库一致')"
else
  echo "FAIL: 有包未通过校验" >&2
fi
exit "$rc"
