#!/bin/sh
# Tägliches Backup (NEW_DESIGN.md 12.3): pg_dump im Custom-Format, Manifest mit Ereigniszahl, Dumps älter als KEEP_DAYS löschen.
# Verbindung über PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE. Exit 0 nur bei Erfolg, das Manifest trägt den Status.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
TS="$(date +%Y%m%d_%H%M%S)"
FILE="${BACKUP_DIR}/ccg_${TS}.dump"
MANIFEST="${BACKUP_DIR}/manifest.json"

mkdir -p "${BACKUP_DIR}"

fail() {
  printf '{"status":"error","at":"%s","message":"%s"}\n' "${TS}" "$1" > "${MANIFEST}"
  echo "[backup] Fehler: $1" >&2
  rm -f "${FILE}.part"
  exit 1
}

EVENTS="$(psql -X -At -c 'SELECT count(*) FROM events')" || fail "Ereignisse zählen fehlgeschlagen"
pg_dump --format=custom --file="${FILE}.part" || fail "pg_dump fehlgeschlagen"
mv "${FILE}.part" "${FILE}"
SIZE="$(wc -c < "${FILE}" | tr -d ' ')"

find "${BACKUP_DIR}" -name 'ccg_*.dump' -mtime "+${KEEP_DAYS}" -delete

printf '{"status":"ok","at":"%s","file":"%s","bytes":%s,"events":%s,"keepDays":%s}\n' "${TS}" "${FILE}" "${SIZE}" "${EVENTS}" "${KEEP_DAYS}" > "${MANIFEST}"
echo "[backup] ok ${FILE} (${SIZE} Bytes, ${EVENTS} Ereignisse)"
