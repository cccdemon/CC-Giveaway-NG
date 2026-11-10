#!/bin/sh
# Tägliches Backup (NEW_DESIGN.md 12.3): pg_dump im Custom-Format, Manifest mit Ereignisspanne, Dumps älter als KEEP_DAYS löschen.
# Verbindung über PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE. Exit 0 nur bei Erfolg.
# Ein Fehler lässt das Manifest des letzten guten Backups stehen und schreibt last-error.json (health.sh wertet beides aus).
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
TS="$(date +%Y%m%d_%H%M%S)"
FILE="${BACKUP_DIR}/ccg_${TS}.dump"
MANIFEST="${BACKUP_DIR}/manifest.json"
LAST_ERROR="${BACKUP_DIR}/last-error.json"

mkdir -p "${BACKUP_DIR}"

fail() {
  printf '{"status":"error","at":"%s","message":"%s"}\n' "${TS}" "$1" > "${LAST_ERROR}"
  echo "[backup] Fehler: $1" >&2
  rm -f "${FILE}.part"
  exit 1
}

# Ereignisse vor und nach dem Dump: der Dump liegt dazwischen, die Restore-Probe prüft die Spanne (kein Schnappschuss-Wettlauf).
BEFORE="$(psql -X -At -c 'SELECT count(*) FROM events')" || fail "Ereignisse zählen fehlgeschlagen"
pg_dump --format=custom --file="${FILE}.part" || fail "pg_dump fehlgeschlagen"
AFTER="$(psql -X -At -c 'SELECT count(*) FROM events')" || fail "Ereignisse zählen fehlgeschlagen"
mv "${FILE}.part" "${FILE}"
SIZE="$(wc -c < "${FILE}" | tr -d ' ')"

find "${BACKUP_DIR}" -name 'ccg_*.dump' -mtime "+${KEEP_DAYS}" -delete

printf '{"status":"ok","at":"%s","file":"%s","bytes":%s,"eventsBefore":%s,"eventsAfter":%s,"keepDays":%s}\n' "${TS}" "${FILE}" "${SIZE}" "${BEFORE}" "${AFTER}" "${KEEP_DAYS}" > "${MANIFEST}"
rm -f "${LAST_ERROR}"
echo "[backup] ok ${FILE} (${SIZE} Bytes, ${BEFORE} bis ${AFTER} Ereignisse)"
