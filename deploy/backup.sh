#!/usr/bin/env bash
#
# Back up the TradeGate database to a dated dump and keep the newest few.
#
# Run as the service account, or let deploy/tradegate-backup.timer run it:
#   sudo -u tradegate -H /home/tradegate/TradeGate/deploy/backup.sh
#
# Most of what the database holds can be fetched again, but not all of it.
# Stored model outputs are the record of what each model said at the time,
# which the alert-outcome and track-record panels are scored against; alert
# history and watchlists are the same. A provider can resend a price; it
# cannot resend what the platform concluded from it last March.
#
# The dump is written under a temporary name and only takes its real name
# once pg_restore can read its table of contents, so a dump cut short by a
# full disk or a dropped connection never sits among the good ones looking
# like a backup.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/tradegate/TradeGate}"
BACKUP_DIR="${BACKUP_DIR:-/home/tradegate/backups}"
KEEP="${KEEP:-14}"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"

if [ -z "${DATABASE_URL:-}" ] && [ -f "$ENV_FILE" ]; then
  DATABASE_URL="$(grep -E '^[[:space:]]*DATABASE_URL=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"
  # Values in .env are often quoted; the quotes are not part of the URL.
  DATABASE_URL="${DATABASE_URL%\"}"; DATABASE_URL="${DATABASE_URL#\"}"
  DATABASE_URL="${DATABASE_URL%\'}"; DATABASE_URL="${DATABASE_URL#\'}"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set and not found in $ENV_FILE; there is no database to back up." >&2
  exit 1
fi
case "$KEEP" in
  ''|*[!0-9]*|0) echo "KEEP must be a positive whole number (got '$KEEP')." >&2; exit 1 ;;
esac

umask 077
mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/tradegate-$stamp.dump"
partial="$target.partial"
trap 'rm -f "$partial"' EXIT

# Custom format: compressed, and restorable table by table with pg_restore.
pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$partial"
pg_restore --list "$partial" > /dev/null
mv "$partial" "$target"

echo "Backed up to $target ($(du -h "$target" | cut -f1))"

# Newest first; everything past the newest $KEEP goes. Only completed dumps
# match, so a partial file from another run is never counted or kept.
mapfile -t dumps < <(ls -1t "$BACKUP_DIR"/tradegate-*.dump 2>/dev/null || true)
if [ "${#dumps[@]}" -gt "$KEEP" ]; then
  for old in "${dumps[@]:$KEEP}"; do
    rm -f -- "$old"
    echo "Removed $old (keeping the newest $KEEP)"
  done
fi
