#!/usr/bin/env bash
# backup-bluechip.sh — the copy that exists somewhere else.
#
# Install:  sudo bash deploy/install-backup.sh
# Run now:  bash deploy/backup-bluechip.sh
# Restore:  see RESTORE, at the bottom of this file. Read it before you need it.
#
# THE POINT OF THIS FILE is not the dump. pg_dump is one line. The point is
# everything around it, because every one of these is how a backup turns out to
# be worthless at the moment it is needed:
#
#   - A dump that failed but exited 0, leaving a 0-byte file that looks like a
#     backup in a directory listing. Verified by size AND by reading the footer
#     pg_dump writes last, which is only there if it finished.
#   - Fourteen days of backups on the same disk as the database. When the disk
#     goes, they go. So this copies off the box if a destination is configured,
#     and SHOUTS if one is not, rather than quietly being a local-only copy.
#   - A backup nobody ever restored. An untested backup is a guess. The restore
#     procedure is at the bottom and takes ten minutes; do it once, now, while
#     nothing is wrong.
#
# Running as: ubuntu. Uses the DATABASE_URL out of /opt/bluechip/app/.env so
# there is exactly one place the password lives.

set -Eeuo pipefail

APP=/opt/bluechip/app
DEST="${BACKUP_DIR:-/var/backups/bluechip}"
KEEP_DAYS="${KEEP_DAYS:-14}"
LOG=/var/log/bluechip-backup.log
STAMP=$(date '+%Y%m%d-%H%M%S')

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }
die() { log "FATAL: $*"; exit 1; }

mkdir -p "$DEST"

# ── the connection ──────────────────────────────────────────────────────────
[ -f "$APP/.env" ] || die "$APP/.env not found — cannot find the database."
# shellcheck disable=SC1090
DATABASE_URL=$(grep -E '^DATABASE_URL=' "$APP/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'')
[ -n "$DATABASE_URL" ] || die "DATABASE_URL is not set in $APP/.env"

# Prisma appends ?schema=public, which psql and pg_dump reject as a database
# name. Strip the query string. (This exact thing already cost an afternoon
# during provisioning — the error it produces blames authentication.)
PG_URI="${DATABASE_URL%%\?*}"

OUT="$DEST/bluechip-$STAMP.sql.gz"

# ── the dump ────────────────────────────────────────────────────────────────
log "dumping to $OUT"
# --no-owner and --no-privileges so the dump restores into a database owned by
# whatever role does the restoring, instead of failing on a role that does not
# exist on the machine you are restoring to — which is, by definition, a
# different machine from the one that died.
#
# PIPESTATUS, not $?, because in a pipeline $? is gzip's status and gzip will
# happily succeed at compressing pg_dump's failure.
set -o pipefail
if ! pg_dump --no-owner --no-privileges --format=plain "$PG_URI" | gzip -9 > "$OUT"; then
  rm -f "$OUT"
  die "pg_dump failed — no backup written for $STAMP"
fi

# ── proof it is a real backup ───────────────────────────────────────────────
BYTES=$(stat -c %s "$OUT")
[ "$BYTES" -gt 2000 ] || { rm -f "$OUT"; die "dump is only $BYTES bytes — that is not a database"; }

# pg_dump writes this line LAST. If it is present, the dump ran to completion;
# a truncated dump (disk full, connection dropped) will not have it. Checking
# the size alone would pass a dump that died three-quarters of the way through.
if ! gzip -dc "$OUT" | tail -5 | grep -q "PostgreSQL database dump complete"; then
  rm -f "$OUT"
  die "dump is truncated — the completion marker is missing"
fi

# Does it actually contain the tables that matter? A dump of an empty database
# is well-formed and useless, and that is exactly what you get if the URL points
# at the wrong database.
MISSING=""
for t in User Candidate Placement PayrollItem Attendance; do
  gzip -dc "$OUT" | grep -q "CREATE TABLE public.\"$t\"" || MISSING="$MISSING $t"
done
[ -z "$MISSING" ] || { rm -f "$OUT"; die "dump is missing tables:$MISSING — wrong database?"; }

log "ok — $(numfmt --to=iec "$BYTES" 2>/dev/null || echo "$BYTES bytes"), all key tables present"

# ── off the box ─────────────────────────────────────────────────────────────
# A backup on the same disk as the database survives exactly the failures that
# do not matter. This is the half people skip.
COPIED=no

if [ -n "${BACKUP_S3_URI:-}" ] && command -v aws >/dev/null 2>&1; then
  if aws s3 cp "$OUT" "${BACKUP_S3_URI%/}/$(basename "$OUT")" \
       ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} >>"$LOG" 2>&1; then
    log "copied to ${BACKUP_S3_URI%/}/$(basename "$OUT")"
    COPIED=yes
  else
    log "WARNING: copy to object storage FAILED — the backup is local only"
  fi
fi

if [ -n "${BACKUP_SCP_TARGET:-}" ]; then
  if scp -o StrictHostKeyChecking=accept-new "$OUT" "$BACKUP_SCP_TARGET" >>"$LOG" 2>&1; then
    log "copied to $BACKUP_SCP_TARGET"
    COPIED=yes
  else
    log "WARNING: scp to $BACKUP_SCP_TARGET FAILED — the backup is local only"
  fi
fi

if [ "$COPIED" = no ]; then
  log "WARNING: this backup exists ONLY on this machine. If the disk dies, it dies with it."
  log "         Set BACKUP_S3_URI (with BACKUP_S3_ENDPOINT for R2) or BACKUP_SCP_TARGET in /etc/default/bluechip-backup"
fi

# ── retention ───────────────────────────────────────────────────────────────
# Deleting happens LAST and only after a good dump was written. Pruning first
# would mean a failing backup quietly eats the good ones it is replacing, and
# you would find out on day fifteen.
find "$DEST" -name 'bluechip-*.sql.gz' -mtime +"$KEEP_DAYS" -print -delete | while read -r f; do
  log "pruned $(basename "$f")"
done

COUNT=$(find "$DEST" -name 'bluechip-*.sql.gz' | wc -l)
log "done — $COUNT backups on disk, keeping $KEEP_DAYS days"

# ═══════════════════════════════════════════════════════════════════════════
# RESTORE
# ═══════════════════════════════════════════════════════════════════════════
#
# Do this once now, on a scratch database, so that the first time you do it is
# not the day the box is gone.
#
#   # 1. Make a scratch database to restore INTO. Never restore over a live one
#   #    to "test" it — a half-finished restore leaves you with neither.
#   sudo -u postgres createdb bluechip_restoretest
#
#   # 2. Restore the newest backup into it.
#   gzip -dc /var/backups/bluechip/$(ls -t /var/backups/bluechip | head -1) \
#     | sudo -u postgres psql -d bluechip_restoretest
#
#   # 3. Prove it is real — these should be the numbers you expect.
#   sudo -u postgres psql -d bluechip_restoretest -c \
#     'SELECT (SELECT count(*) FROM "User") users,
#             (SELECT count(*) FROM "Candidate") candidates,
#             (SELECT count(*) FROM "Placement") placements;'
#
#   # 4. Throw the scratch database away.
#   sudo -u postgres dropdb bluechip_restoretest
#
# FOR A REAL RESTORE after a real loss: create the database and the bluechip
# role first (see provision-bluechip.sh), restore as above into `bluechip`,
# then `cd /opt/bluechip/app && npx prisma db push` to bring the schema level
# with the current code before starting the service.
