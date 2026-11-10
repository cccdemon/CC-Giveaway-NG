#!/bin/sh
# Monatliche Restore-Probe (NEW_DESIGN.md 12.3): den Dump aus dem Manifest in eine Prüfdatenbank einspielen, Ereignisse zählen,
# gegen die Spanne aus dem Manifest prüfen, Ergebnis nach restore-check.json. Die Prüfdatenbank wird immer gelöscht.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
CHECK_DB="${CHECK_DB:-ccg_restore_check}"
MANIFEST="${BACKUP_DIR}/manifest.json"
RESULT="${BACKUP_DIR}/restore-check.json"
TS="$(date +%Y%m%d_%H%M%S)"

cleanup() {
  psql -X -d postgres -c "DROP DATABASE IF EXISTS \"${CHECK_DB}\"" > /dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf '{"status":"error","at":"%s","message":"%s"}\n' "${TS}" "$1" > "${RESULT}"
  echo "[restore-check] Fehler: $1" >&2
  exit 1
}

[ -f "${MANIFEST}" ] || fail "Kein Manifest, kein Backup"
FILE="$(sed -n 's/.*"file":"\([^"]*\)".*/\1/p' "${MANIFEST}")"
LO="$(sed -n 's/.*"eventsBefore":\([0-9]*\).*/\1/p' "${MANIFEST}")"
HI="$(sed -n 's/.*"eventsAfter":\([0-9]*\).*/\1/p' "${MANIFEST}")"
[ -n "${FILE}" ] && [ -f "${FILE}" ] || fail "Dump aus dem Manifest fehlt: ${FILE}"
[ -n "${LO}" ] && [ -n "${HI}" ] || fail "Manifest ohne Ereignisspanne"

cleanup
psql -X -d postgres -c "CREATE DATABASE \"${CHECK_DB}\"" > /dev/null || fail "Prüfdatenbank anlegen fehlgeschlagen"
pg_restore --exit-on-error --no-owner --no-privileges -d "${CHECK_DB}" "${FILE}" || fail "pg_restore fehlgeschlagen"
ACTUAL="$(psql -X -At -d "${CHECK_DB}" -c 'SELECT count(*) FROM events')" || fail "Ereignisse in der Prüfdatenbank zählen fehlgeschlagen"
[ "${ACTUAL}" -ge "${LO}" ] && [ "${ACTUAL}" -le "${HI}" ] || fail "Ereigniszahl ${ACTUAL} außerhalb ${LO} bis ${HI}"

printf '{"status":"ok","at":"%s","file":"%s","events":%s}\n' "${TS}" "${FILE}" "${ACTUAL}" > "${RESULT}"
echo "[restore-check] ok ${FILE} (${ACTUAL} Ereignisse)"
