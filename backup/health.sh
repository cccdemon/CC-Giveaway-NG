#!/bin/sh
# Healthcheck des Dienstes backup (NEW_DESIGN.md 12.1: kein Fehler bleibt still): Exit 1, wenn das letzte gute Backup älter als
# MAX_AGE_HOURS ist, wenn der letzte Lauf fehlschlug (last-error.json liegt vor) oder die Restore-Probe zuletzt scheiterte.
set -u

BACKUP_DIR="${BACKUP_DIR:-/backups}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"
MANIFEST="${BACKUP_DIR}/manifest.json"
LAST_ERROR="${BACKUP_DIR}/last-error.json"
RESULT="${BACKUP_DIR}/restore-check.json"

[ -f "${MANIFEST}" ] || { echo "kein Backup"; exit 1; }
grep -q '"status":"ok"' "${MANIFEST}" || { echo "letztes Backup fehlgeschlagen"; exit 1; }
if [ -n "$(find "${MANIFEST}" -mmin "+$((MAX_AGE_HOURS * 60))")" ]; then echo "Backup älter als ${MAX_AGE_HOURS} h"; exit 1; fi
# backup.sh löscht last-error.json nach jedem guten Lauf: existiert die Datei, war der letzte Lauf ein Fehler (kein Zeitvergleich nötig).
if [ -f "${LAST_ERROR}" ]; then echo "Backup fehlgeschlagen nach dem letzten guten"; exit 1; fi
if [ -f "${RESULT}" ] && ! grep -q '"status":"ok"' "${RESULT}"; then echo "Restore-Probe fehlgeschlagen"; exit 1; fi
echo ok
