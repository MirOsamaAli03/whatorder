#!/bin/sh
# Takes one backup of the database, then prunes old ones.
#
# The database is the only thing in this system that cannot be rebuilt from the
# repository: it holds the orders, the customers and the money. Everything else
# is a `docker compose build` away.
#
# Deliberately a plain `pg_dump` to a gzipped file rather than anything
# cleverer. A backup you cannot restore under pressure, with tools that are
# already on the machine, is not a backup — and `gunzip | psql` is something
# anybody can do at 2am.
#
# Run once per invocation; the compose service loops. That split is what makes
# it testable: BACKUP_DIR=/tmp sh backup.sh takes exactly one backup.
set -eu

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_USER:=restaurant_owner}"
: "${POSTGRES_DB:=restaurant_os}"
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_KEEP_DAYS:=7}"

stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
target="${BACKUP_DIR}/${POSTGRES_DB}-${stamp}.sql.gz"
partial="${target}.partial"

mkdir -p "$BACKUP_DIR"

echo "[backup] dumping ${POSTGRES_DB} to ${target}"

# Written to a .partial name and renamed only on success.
#
# A dump interrupted half way — the container stopped, the disk filled — would
# otherwise sit in the directory looking exactly like a good one, and be found
# to be truncated on the day it is needed. The rename is atomic, so a file
# without .partial is always complete.
if ! pg_dump -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip > "$partial"; then
  echo "[backup] FAILED: pg_dump did not complete" >&2
  rm -f "$partial"
  exit 1
fi

# pg_dump writes its terminating line last, so finding it proves the dump ran
# to the end rather than being cut off mid-table.
if ! gzip -dc "$partial" | tail -5 | grep -q "PostgreSQL database dump complete"; then
  echo "[backup] FAILED: the dump has no completion marker; refusing to keep it" >&2
  rm -f "$partial"
  exit 1
fi

mv "$partial" "$target"

size="$(wc -c < "$target")"
echo "[backup] wrote ${target} (${size} bytes)"

# Prune, but only ever files this script wrote, and only if at least one
# backup survives. A retention policy that can empty the directory is a
# deletion policy.
if [ "$(find "$BACKUP_DIR" -name "${POSTGRES_DB}-*.sql.gz" -mtime "-${BACKUP_KEEP_DAYS}" | wc -l)" -gt 0 ]; then
  removed="$(find "$BACKUP_DIR" -name "${POSTGRES_DB}-*.sql.gz" -mtime "+${BACKUP_KEEP_DAYS}" -print -delete | wc -l)"
  echo "[backup] pruned ${removed} backup(s) older than ${BACKUP_KEEP_DAYS} days"
else
  echo "[backup] nothing recent enough to prune against; keeping everything"
fi

# Leftover partials from an earlier crash, so they do not accumulate.
find "$BACKUP_DIR" -name "*.sql.gz.partial" -mmin +60 -delete 2>/dev/null || true
