#!/bin/sh
# Monatliche Restore-Probe (NEW_DESIGN.md 12.3): den Dump aus dem Manifest in eine Prüfdatenbank einspielen, Ereignisse zählen,
# Ergebnis nach restore-check.json. Die Prüfdatenbank wird immer gelöscht, auch bei Fehlern.
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
EXPECTED="$(sed -n 's/.*"events":\([0-9]*\).*/\1/p' "${MANIFEST}")"
[ -n "${FILE}" ] && [ -f "${FILE}" ] || fail "Dump aus dem Manifest fehlt: ${FILE}"
[ -n "${EXPECTED}" ] || fail "Manifest ohne Ereigniszahl"

cleanup
psql -X -d postgres -c "CREATE DATABASE \"${CHECK_DB}\"" > /dev/null || fail "Prüfdatenbank anlegen fehlgeschlagen"
pg_restore --no-owner --no-privileges -d "${CHECK_DB}" "${FILE}" || fail "pg_restore fehlgeschlagen"
ACTUAL="$(psql -X -At -d "${CHECK_DB}" -c 'SELECT count(*) FROM events')" || fail "Ereignisse in der Prüfdatenbank zählen fehlgeschlagen"
[ "${ACTUAL}" = "${EXPECTED}" ] || fail "Ereigniszahl ${ACTUAL} statt ${EXPECTED}"

printf '{"status":"ok","at":"%s","file":"%s","events":%s}\n' "${TS}" "${FILE}" "${ACTUAL}" > "${RESULT}"
echo "[restore-check] ok ${FILE} (${ACTUAL} Ereignisse)"
