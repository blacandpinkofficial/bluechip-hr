#!/usr/bin/env bash
# bluechip-deploy.sh — lives at /opt/bluechip/app/deploy/bluechip-deploy.sh
#
# Deliberately modelled on the Pulse deploy script, with one difference that
# matters more than all the others:
#
#   IT SHARES PULSE'S BUILD LOCK.
#
# Both applications run on one 3.7 GB box. A single `next build` wants ~2.5 GB.
# Two at once do not fit — they swap, then one is OOM-killed, and there is no
# rule saying the survivor is the retail app. So both scripts flock the same
# file: whichever starts second simply waits. It costs a few minutes and buys
# the guarantee that a Blue Chip deploy can never take down Monday's billing.
#
# Usage:  bash deploy/bluechip-deploy.sh
#         HEAP_MB=1536 bash deploy/bluechip-deploy.sh   # if a build ever OOMs

set -Eeuo pipefail

APP=/opt/bluechip/app
SERVICE=bluechip
PORT="${PORT:-3100}"
LOCK=/tmp/pulse-deploy.lock        # SHARED with Pulse. Do not change.
LOG=/var/log/bluechip-deploy.log
HEAP_MB="${HEAP_MB:-1024}"         # this app is small; Pulse needs 2560
HEALTH="http://127.0.0.1:${PORT}/api/health"

# Re-exec from /tmp so that `git reset --hard` cannot pull the script out from
# under its own running shell mid-deploy.
if [ "${BC_REEXEC:-}" != "1" ]; then
  cp "$0" /tmp/bluechip-deploy-running.sh
  chmod +x /tmp/bluechip-deploy-running.sh
  BC_REEXEC=1 exec /tmp/bluechip-deploy-running.sh "$@"
fi

log()  { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }
die()  { log "FATAL: $*"; exit 1; }

sudo touch "$LOG" && sudo chown ubuntu:ubuntu "$LOG" 2>/dev/null || true

# ── Lock ────────────────────────────────────────────────────────────────────
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another build (Pulse or Blue Chip) is running — waiting for the lock…"
  flock 9
  log "lock acquired"
fi

log "═══════ Blue Chip deploy start (heap ${HEAP_MB}MB) ═══════"

# ── Preflight ───────────────────────────────────────────────────────────────
cd "$APP" || die "$APP does not exist. Run provision-bluechip.sh first."

# Root-owned files inside the app directory break both `git` and `next build`,
# and the failure messages point everywhere except the real cause. This has
# already happened once on the Pulse side; check for it before touching git.
if find . -maxdepth 3 -not -user ubuntu -not -path "./node_modules/*" -not -path "./.git/*" -print -quit | grep -q .; then
  log "found files not owned by ubuntu — fixing"
  sudo chown -R ubuntu:ubuntu "$APP"
fi

[ -f .env ] || die ".env missing. provision-bluechip.sh writes it."
touch .deploy-write-probe 2>/dev/null || die "$APP is not writable by $(id -un)."
rm -f .deploy-write-probe

FREE_MB=$(free -m | awk '/^Mem:/{print $7}')
log "available memory: ${FREE_MB}MB"

# ── Pull ────────────────────────────────────────────────────────────────────
log "git pull"
git pull --ff-only 2>&1 | tee -a "$LOG"
log "now at: $(git log -1 --pretty='%h %s')"

# ── Install + schema ────────────────────────────────────────────────────────
# NOT --omit=dev. `prisma` is a devDependency (correctly — it is a CLI, not a
# runtime import) and `npm run build` calls `prisma generate`. Omitting dev
# dependencies would make every single deploy fail at the build step with a
# "prisma: not found" that looks like a broken machine rather than a wrong flag.
#
# --include=dev is stated EXPLICITLY rather than relied on as the default,
# because the default flips: npm omits devDependencies whenever NODE_ENV is
# "production", and this app's .env sets exactly that. Inherit it into the
# deploy shell once — a sourced .env, a systemd-run deploy, a cron job — and
# every build fails on a missing tailwindcss or prisma, which reads like a
# broken machine rather than an environment variable doing its documented job.
log "npm install"
NPM_FLAGS="--include=dev --no-audit --no-fund"
if [ -f package-lock.json ]; then
  # npm ci refuses to run when package.json and the lockfile disagree — which
  # is exactly what a dependency bump produces. Fall back rather than fail.
  if ! npm ci $NPM_FLAGS 2>&1 | tail -20 | tee -a "$LOG"; then
    log "npm ci could not be used (lockfile out of step with package.json) — using npm install"
    npm install $NPM_FLAGS 2>&1 | tail -20 | tee -a "$LOG"
  fi
else
  npm install $NPM_FLAGS 2>&1 | tail -20 | tee -a "$LOG"
fi

# Prove the build can actually run before spending three minutes finding out it
# can't. Each of these is imported by the build and by nothing else, so a
# missing one produces an error deep inside webpack that names a file in
# node_modules rather than the real problem.
for mod in tailwindcss postcss autoprefixer prisma; do
  [ -d "node_modules/$mod" ] || die "'$mod' is missing from node_modules after install. The build needs it. Most likely NODE_ENV=production leaked into this shell and npm skipped devDependencies — check with: echo \$NODE_ENV"
done
log "build dependencies present"

log "prisma db push"
npx prisma db push --skip-generate 2>&1 | tail -20 | tee -a "$LOG"

# ── Build ───────────────────────────────────────────────────────────────────
# Keep the previous build until the new one is confirmed healthy. The Pulse
# script used to delete its backup before the health check; a transient boot
# failure then took the site down with nothing to roll back to.
rm -rf .next.prev
[ -d .next ] && mv .next .next.prev

restore() {
  log "restoring previous build"
  rm -rf .next
  [ -d .next.prev ] && mv .next.prev .next
  sudo systemctl start "$SERVICE" || true
}

log "next build"
if ! NODE_OPTIONS="--max-old-space-size=${HEAP_MB}" npm run build 2>&1 | tail -40 | tee -a "$LOG"; then
  restore
  die "build failed. The previous build has been restored and the service restarted."
fi
log "build OK"

# ── Restart ─────────────────────────────────────────────────────────────────
log "restarting $SERVICE"
sudo systemctl restart "$SERVICE"

# ── Health check ────────────────────────────────────────────────────────────
# Retry once: a cold Next start on a loaded box can take a few seconds longer
# than the first poll allows, and a false failure is worse than a slow success.
healthy=0
for attempt in 1 2 3; do
  sleep $((attempt * 5))
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$HEALTH" || echo 000)
  log "health attempt $attempt: $code"
  [ "$code" = "200" ] && { healthy=1; break; }
done

if [ "$healthy" != "1" ]; then
  sudo journalctl -u "$SERVICE" --since "2 minutes ago" --no-pager | tail -30 | tee -a "$LOG"
  restore
  die "new build did not come up healthy. Rolled back to the previous build."
fi

# Only now is it safe to throw the backup away.
rm -rf .next.prev
log "service: $(sudo systemctl is-active "$SERVICE")"
log "═══════ Blue Chip deploy OK ═══════"
