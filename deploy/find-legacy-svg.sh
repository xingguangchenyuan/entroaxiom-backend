#!/usr/bin/env bash
# 只读盘点：列出旧上传目录里遗留的 .svg / .svgz
# 不会删除任何文件；把输出贴进变更单，再按 docs/DEPLOY.md「历史 SVG 处置」处理。
#
# 用法：sudo -u entroaxiom /srv/entroaxiom/api/deploy/find-legacy-svg.sh
#       UPLOAD_ROOT=/path/to/uploads ./find-legacy-svg.sh
set -Eeuo pipefail

UPLOAD_ROOT="${UPLOAD_ROOT:-/srv/entroaxiom/shared/uploads}"
if [ ! -d "${UPLOAD_ROOT}" ]; then
  echo "上传目录不存在：${UPLOAD_ROOT}" >&2
  exit 1
fi

printf '盘点时间: %s\n上传根目录: %s\n\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${UPLOAD_ROOT}"

for scope in public private; do
  dir="${UPLOAD_ROOT}/${scope}"
  printf '== %s ==\n' "${dir}"
  if [ ! -d "${dir}" ]; then
    printf '（目录不存在）\n\n'
    continue
  fi
  count="$(find "${dir}" -type f \( -iname '*.svg' -o -iname '*.svgz' \) | wc -l | tr -d ' ')"
  if [ "${count}" = "0" ]; then
    printf '未发现 svg/svgz（共 %s 个文件）\n\n' "$(find "${dir}" -type f | wc -l | tr -d ' ')"
    continue
  fi
  printf '发现 %s 个 svg/svgz：\n' "${count}"
  find "${dir}" -type f \( -iname '*.svg' -o -iname '*.svgz' \) -printf '%TY-%Tm-%Td %10s  %p\n' | sort
  printf '\n'
done

printf '提示：这些文件在 Nginx 上已被 location 规则阻断（返回 404），不会被浏览器执行。\n'
printf '      处置方式见 docs/DEPLOY.md「历史 SVG 处置」，务必先备份再操作，不要直接删除。\n'