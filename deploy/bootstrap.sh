#!/usr/bin/env bash
# bootstrap.sh — everything from "empty server" to "signed in", in one run.
#
# Run on the Lightsail box, as ubuntu:
#
#   bash /opt/bluechip/app/deploy/bootstrap.sh
#
# It is one script rather than eight commands because the ORDER matters and one
# ordering mistake is silent: the README originally said to provision first and
# clone second, but provisioning writes .env into /opt/bluechip/app, and
# `git clone` refuses a directory that is not empty. Clone first, always.
#
# Safe to run again. Every step checks whether it already happened.

set -Eeuo pipefail

APP=/opt/bluechip/app
SERVICE=bluechip
PORT=3100

GRN=$'\e[32m'; YEL=$'\e[33m'; RED=$'\e[31m'; DIM=$'\e[2m'; OFF=$'\e[0m'
step() { echo; echo "${DIM}────${OFF} $* ${DIM}────${OFF}"; }
ok()   { echo "${GRN}✓${OFF} $*"; }
warn() { echo "${YEL}!${OFF} $*"; }
die()  { echo "${RED}✗ $*${OFF}" >&2; exit 1; }

[ "$(id -un)" = "ubuntu" ] || die "Run as ubuntu, not $(id -un)."
[ -d "$APP/.git" ] || die "$APP is not a git checkout. Clone the repo there first (the paste above this one does that)."
cd "$APP"

# ── 1. Server: database, role, service, nginx ───────────────────────────────
step "1/6  Provisioning"
if [ -f "$APP/.env" ] && systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}.service"; then
  ok "already provisioned — skipping"
else
  bash deploy/provision-bluechip.sh
fi
[ -f "$APP/.env" ] || die "Provisioning did not produce a .env. Stop here and send me the output above."

# ── 2. Dependencies ─────────────────────────────────────────────────────────
step "2/6  Installing dependencies"
# Not --omit=dev: prisma itself is a devDependency and `prisma db push` and
# `prisma generate` both need it. The build script calls generate.
npm install --no-audit --no-fund 2>&1 | tail -5
ok "dependencies installed"

# ── 3. Schema ───────────────────────────────────────────────────────────────
step "3/6  Creating the tables"
npx prisma db push 2>&1 | tail -10
ok "schema applied to the bluechip database"

# ── 4. Build ────────────────────────────────────────────────────────────────
step "4/6  Building"
# Shares Pulse's lock so two Next builds can never run at once on this box.
exec 9>/tmp/pulse-deploy.lock
if ! flock -n 9; then
  warn "a Pulse build is running — waiting for it to finish"
  flock 9
  ok "lock acquired"
fi
NODE_OPTIONS="--max-old-space-size=1024" npm run build 2>&1 | tail -25
flock -u 9
ok "build complete"

# ── 5. Start ────────────────────────────────────────────────────────────────
step "5/6  Starting the service"
sudo systemctl restart "$SERVICE"
sleep 5
for i in 1 2 3; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:${PORT}/api/health" || echo 000)
  [ "$code" = "200" ] && break
  sleep $((i * 4))
done
if [ "$code" != "200" ]; then
  echo
  sudo journalctl -u "$SERVICE" --since "2 minutes ago" --no-pager | tail -30
  die "The service did not come up (health returned $code). Pulse is untouched. Send me the log above."
fi
ok "service healthy on port $PORT"

# ── 6. First account ────────────────────────────────────────────────────────
step "6/6  Owner account"
HAS_USER=$(node -e '
  const {PrismaClient}=require("@prisma/client");
  new PrismaClient().user.count().then(n=>{console.log(n);process.exit(0)}).catch(()=>{console.log("err");process.exit(0)});
' 2>/dev/null || echo err)

if [ "$HAS_USER" != "0" ] && [ "$HAS_USER" != "err" ]; then
  ok "$HAS_USER account(s) already exist — not creating another"
else
  echo "Create the first owner account. This is the login your brother will use."
  read -r -p "  Full name: " OWNER_NAME
  read -r -p "  Email:     " OWNER_EMAIL
  if [ -n "$OWNER_NAME" ] && [ -n "$OWNER_EMAIL" ]; then
    node scripts/seed-owner.mjs "$OWNER_NAME" "$OWNER_EMAIL"
  else
    warn "skipped — create it later with:"
    warn "  cd $APP && node scripts/seed-owner.mjs \"Name\" \"email@example.com\""
  fi
fi

# ── Done ────────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════"
ok "Blue Chip HR is running."
echo
echo "  Local check:   curl -s localhost:$PORT/api/health"
echo "  Service:       sudo systemctl status $SERVICE"
echo "  Logs:          sudo journalctl -u $SERVICE -f"
echo "  Deploy later:  cd $APP && bash deploy/bluechip-deploy.sh"
echo
echo "  Still to do, whenever you are ready:"
echo "    • point app.bluechiphr.com at $(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo '<this box>')"
echo "    • sudo certbot --nginx -d app.bluechiphr.com"
echo
echo "  Pulse was not restarted at any point in this run."
echo "════════════════════════════════════════════════════════════"
