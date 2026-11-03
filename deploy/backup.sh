#!/usr/bin/env bash
# 快照式备份：每次一个时间戳目录，数据库与上传文件严格配对
#
#   BACKUP_ROOT/daily/YYYYMMDD-HHMMSS/
#     database.dump        pg_dump --format=custom
#     uploads/public/…     公开上传文件（rsync 镜像）
#     uploads/private/…    私密上传文件（不要放到任何可公开目录）
#     manifest.txt         时间戳/库名/PG 版本/源路径/文件数/校验和/结果
#
# 设计要点：
#   1. 先写 .tmp-<stamp> 临时目录，全部校验通过后再原子改名为正式快照，
#      失败时清理临时目录并 exit 非 0 —— 绝不留下"看起来成功"的半成品。
#   2. 每一份快照都自带 db + uploads，恢复时不会出现"今天的库配昨天的文件"。
#   3. 周备（周日）用 --link-dest 硬链接到当日快照，省空间且旧快照不会被后续写入改动。
#   4. 清理按快照目录整体进行：日备保留 7 份、周备保留 4 份。
#
# 用法：由 entroaxiom-backup.service 调用（EnvironmentFile=/etc/entroaxiom/api.env），
#       也可手工执行：sudo -u entroaxiom /srv/entroaxiom/api/deploy/backup.sh
set -Eeuo pipefail
export LC_ALL=C

: "${DATABASE_URL:?需要 DATABASE_URL（来自 /etc/entroaxiom/api.env）}"
: "${BACKUP_ROOT:?需要 BACKUP_ROOT（来自 /etc/entroaxiom/api.env）}"
: "${UPLOAD_ROOT:?需要 UPLOAD_ROOT（来自 /etc/entroaxiom/api.env）}"

KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"

STAMP="$(date +%Y%m%d-%H%M%S)"
DAY_OF_WEEK="$(date +%u)"            # 1..7，周日是 7
DAILY_DIR="${BACKUP_ROOT}/daily"
WEEKLY_DIR="${BACKUP_ROOT}/weekly"
TARGET="${DAILY_DIR}/${STAMP}"
TMP="${DAILY_DIR}/.tmp-${STAMP}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

cleanup() {
  if [ -d "${TMP}" ]; then
    rm -rf "${TMP}"
    log "已清理未完成的临时目录 ${TMP}"
  fi
}
trap 'rc=$?; cleanup; log "备份失败（exit ${rc}），未产生新快照"; exit ${rc}' ERR
trap 'cleanup' EXIT

mkdir -p "${DAILY_DIR}" "${WEEKLY_DIR}"
if [ -e "${TARGET}" ]; then
  log "目标快照目录已存在，拒绝覆盖：${TARGET}"
  exit 3
fi
mkdir -p "${TMP}/uploads/public" "${TMP}/uploads/private"

log "开始备份 ${STAMP}"

# 1) 数据库
DB_NAME="$(printf '%s' "${DATABASE_URL}" | sed -E 's#^[^/]+//[^/]*/##; s#\?.*$##')"
[ -n "${DB_NAME}" ] || DB_NAME="unknown"
pg_dump --format=custom --no-owner --no-privileges --file="${TMP}/database.dump" "${DATABASE_URL}"

# 2) 上传文件：public 与 private 分别镜像到快照内，绝不混放
if [ -d "${UPLOAD_ROOT}/public" ]; then
  rsync -a --delete "${UPLOAD_ROOT}/public/" "${TMP}/uploads/public/"
else
  log "警告：${UPLOAD_ROOT}/public 不存在，按空目录处理"
fi
if [ -d "${UPLOAD_ROOT}/private" ]; then
  rsync -a --delete "${UPLOAD_ROOT}/private/" "${TMP}/uploads/private/"
else
  log "警告：${UPLOAD_ROOT}/private 不存在，按空目录处理"
fi

# 3) 校验：dump 必须非空且能被 pg_restore 读出目录，sha256 自证完整
[ -s "${TMP}/database.dump" ] || { log "database.dump 为空"; exit 4; }
pg_restore --list "${TMP}/database.dump" > /dev/null
PUBLIC_COUNT="$(find "${TMP}/uploads/public" -type f | wc -l | tr -d ' ')"
PRIVATE_COUNT="$(find "${TMP}/uploads/private" -type f | wc -l | tr -d ' ')"
DUMP_SHA="$(sha256sum "${TMP}/database.dump" | awk '{print $1}')"
DUMP_SIZE="$(wc -c < "${TMP}/database.dump" | tr -d ' ')"

# 4) manifest：只写元信息，不写口令/连接串
{
  printf 'snapshot=%s\n' "${STAMP}"
  printf 'created_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'database=%s\n' "${DB_NAME}"
  printf 'pg_dump_version=%s\n' "$(pg_dump --version | head -n 1)"
  printf 'server_version=%s\n' "$(psql "${DATABASE_URL}" -At -c 'show server_version' 2>/dev/null || echo unknown)"
  printf 'upload_source=%s\n' "${UPLOAD_ROOT}"
  printf 'database_dump_sha256=%s\n' "${DUMP_SHA}"
  printf 'database_dump_bytes=%s\n' "${DUMP_SIZE}"
  printf 'uploads_public_files=%s\n' "${PUBLIC_COUNT}"
  printf 'uploads_private_files=%s\n' "${PRIVATE_COUNT}"
  printf 'result=ok\n'
} > "${TMP}/manifest.txt"

# 5) 原子改名：到这一步才算成功
mv "${TMP}" "${TARGET}"
log "快照完成：${TARGET}（库 ${DB_NAME}，dump ${DUMP_SIZE} 字节，公共文件 ${PUBLIC_COUNT}，私密文件 ${PRIVATE_COUNT}）"

# 6) 周备：周日再做一份硬链接副本（不复制数据，旧快照不受影响）
if [ "${DAY_OF_WEEK}" = "7" ]; then
  WEEKLY_TARGET="${WEEKLY_DIR}/${STAMP}"
  if [ ! -e "${WEEKLY_TARGET}" ]; then
    rsync -a --link-dest="${TARGET}" "${TARGET}/" "${WEEKLY_TARGET}/"
    log "周备完成：${WEEKLY_TARGET}"
  fi
fi

# 7) 清理：按快照目录整体删除（而不是删目录里的某个文件）
prune() {
  local dir="$1" keep="$2"
  mapfile -t snapshots < <(find "${dir}" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort)
  local total="${#snapshots[@]}"
  if [ "${total}" -le "${keep}" ]; then return 0; fi
  local remove_count=$((total - keep))
  for ((i = 0; i < remove_count; i++)); do
    rm -rf "${snapshots[$i]}"
    log "清理旧快照 $((i + 1))/${remove_count}：${snapshots[$i]}"
  done
}
prune "${DAILY_DIR}" "${KEEP_DAILY}"
prune "${WEEKLY_DIR}" "${KEEP_WEEKLY}"

# 8) 备份目录里不允许出现 env / cookie / 会话文件
if find "${BACKUP_ROOT}" \( -name '.env*' -o -name '*.cookie' \) -print -quit | grep -q .; then
  log "备份目录出现敏感文件，请立即清理"
  exit 5
fi

log "备份成功：${TARGET}"