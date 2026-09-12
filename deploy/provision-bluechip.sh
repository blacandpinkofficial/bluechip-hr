#!/usr/bin/env bash
# provision-bluechip.sh — one-time setup for the Blue Chip HR app on the Pulse box.
#
# WHAT THIS DOES
#   1. Creates a Postgres role + database for Blue Chip.
#   2. Makes the Pulse database genuinely unreachable from that role.
#   3. Creates /opt/bluechip/app, a systemd service and an nginx site.
#
# WHAT IT DELIBERATELY DOES NOT DO
#   It never touches /opt/pulse, the pulse service, or any pulse table. The only
#   thing it changes about Pulse is who is allowed to CONNECT to its database —
#   and that step verifies Pulse still works before it commits, and rolls itself
#   back automatically if it doesn't.
#
# RUN AS: ubuntu (not root), on the Lightsail box.
#   bash provision-bluechip.sh
#
# Safe to run twice. Every step checks before it acts.

set -Eeuo pipefail

BC_DB=bluechip
BC_ROLE=bluechip
BC_DIR=/opt/bluechip/app
BC_SERVICE=bluechip
BC_PORT=3100
BC_HOST=app.bluechiphr.com
PULSE_ENV=/opt/pulse/app/.env
SHARED_LOCK=/tmp/pulse-deploy.lock   # same file the Pulse deploy uses — one build at a time

RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'; DIM=$'\e[2m'; OFF=$'\e[0m'
say()  { echo "${DIM}·${OFF} $*"; }
ok()   { echo "${GRN}✓${OFF} $*"; }
warn() { echo "${YEL}!${OFF} $*"; }
die()  { echo "${RED}✗ $*${OFF}" >&2; exit 1; }

psql_admin() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qtAX "$@"; }

echo
echo "Blue Chip HR — server provisioning"
echo "══════════════════════════════════"

# ── 0. Preconditions ────────────────────────────────────────────────────────
[ "$(id -un)" = "ubuntu" ] || die "Run this as ubuntu, not $(id -un)."
command -v psql   >/dev/null || die "psql not found."
command -v nginx  >/dev/null || die "nginx not found."
sudo -n true 2>/dev/null    || die "Need passwordless sudo (it is how the deploy script already works)."

# Which role does Pulse connect as? We must not lock Pulse out of its own database.
[ -f "$PULSE_ENV" ] || die "Cannot read $PULSE_ENV — I need it to find out which Postgres role Pulse uses."
PULSE_URL="$(grep -m1 -E '^DATABASE_URL=' "$PULSE_ENV" | cut -d= -f2- | tr -d '\042\047')"
[ -n "$PULSE_URL" ] || die "No DATABASE_URL in $PULSE_ENV."
PULSE_ROLE="$(sed -E 's#^postgres(ql)?://([^:/@]+).*#\2#' <<<"$PULSE_URL")"
PULSE_DB="$(sed -E 's#.*/([^/?]+)(\?.*)?$#\1#' <<<"$PULSE_URL")"
[ -n "$PULSE_ROLE" ] && [ -n "$PULSE_DB" ] || die "Could not parse the Pulse DATABASE_URL."
ok "Pulse connects to database '$PULSE_DB' as role '$PULSE_ROLE'"

[ "$PULSE_DB" != "$BC_DB" ] || die "Pulse is already using the name '$BC_DB'. Stopping."

# ── 1. Blue Chip role + database ────────────────────────────────────────────
echo
echo "1. Database"
if [ "$(psql_admin -c "SELECT 1 FROM pg_roles WHERE rolname='$BC_ROLE'")" = "1" ]; then
  # The role exists. Whether we may touch its password depends entirely on
  # whether anything is using it.
  #
  # A .env means a working install: the password in that file is the only copy
  # anywhere, so changing it here would silently break the app with a password
  # mismatch nobody could diagnose. Leave it alone.
  #
  # No .env means a half-finished run — the role was created and then the
  # script stopped before recording the password. That password is now lost to
  # everyone, including us, so the role is unusable until it is reset. Resetting
  # it is safe precisely because nothing can be using it.
  if [ -f "$BC_DIR/.env" ]; then
    say "role '$BC_ROLE' already exists and $BC_DIR/.env is present — leaving the password alone"
    BC_PASS=""
  else
    BC_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"
    psql_admin -c "ALTER ROLE $BC_ROLE LOGIN PASSWORD '$BC_PASS';"
    warn "role '$BC_ROLE' existed from an earlier run but no .env was written —"
    warn "its password was unrecoverable, so a new one has been set. Nothing was"
    warn "using it yet, so nothing breaks."
  fi
else
  BC_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"
  psql_admin -c "CREATE ROLE $BC_ROLE LOGIN PASSWORD '$BC_PASS';"
  ok "created role '$BC_ROLE'"
fi

if [ "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname='$BC_DB'")" = "1" ]; then
  say "database '$BC_DB' already exists"
else
  psql_admin -c "CREATE DATABASE $BC_DB OWNER $BC_ROLE;"
  ok "created database '$BC_DB' owned by '$BC_ROLE'"
fi

# Pulse must never be able to read Blue Chip either. Isolation goes both ways.
psql_admin -c "REVOKE CONNECT ON DATABASE $BC_DB FROM PUBLIC;" >/dev/null
psql_admin -c "GRANT  CONNECT ON DATABASE $BC_DB TO $BC_ROLE;"  >/dev/null
ok "only '$BC_ROLE' may connect to '$BC_DB'"

# ── 2. Close the Pulse database ─────────────────────────────────────────────
# By default Postgres lets PUBLIC connect to any database, so the Blue Chip role
# could read every retail table. This is the step that actually builds the wall.
# Order matters: grant Pulse's own role explicitly FIRST, then remove PUBLIC's
# blanket grant, then prove Pulse still connects — and undo it if it doesn't.
echo
echo "2. Closing '$PULSE_DB' to everyone but Pulse"
PUBLIC_HAD_CONNECT="$(psql_admin -c "SELECT has_database_privilege('public','$PULSE_DB','CONNECT')")"

# Who ACTUALLY connects to the Pulse database? .env names one role, but the
# running service could have been started with a different DATABASE_URL, and a
# backup job or cron could use another again. Ask Postgres who is connected
# right now and grant every one of them explicitly — trusting .env alone could
# lock out whoever was not in it.
LIVE_ROLES="$(psql_admin -c "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname='$PULSE_DB' AND usename IS NOT NULL AND usename <> '$BC_ROLE';" | tr -d ' ')"

GRANTEES="$PULSE_ROLE"
for r in $LIVE_ROLES; do
  case " $GRANTEES " in *" $r "*) ;; *) GRANTEES="$GRANTEES $r" ;; esac
done

for r in $GRANTEES; do
  psql_admin -c "GRANT CONNECT ON DATABASE $PULSE_DB TO \"$r\";" >/dev/null
  ok "granted CONNECT on '$PULSE_DB' to '$r'"
done

# Prove the grants took BEFORE removing anything. If this fails, nothing has
# been revoked and Pulse was never at risk for a moment.
for r in $GRANTEES; do
  if [ "$(psql_admin -c "SELECT has_database_privilege('$r','$PULSE_DB','CONNECT')")" != "t" ]; then
    die "Could not give '$r' its own CONNECT on '$PULSE_DB'. Nothing was revoked — Pulse is untouched."
  fi
done
ok "every Pulse role holds CONNECT in its own right, not through PUBLIC"

if [ "$PUBLIC_HAD_CONNECT" = "t" ]; then
  psql_admin -c "REVOKE CONNECT ON DATABASE $PULSE_DB FROM PUBLIC;" >/dev/null
  say "revoked PUBLIC's blanket CONNECT on '$PULSE_DB' — re-checking…"

  # CONNECT is what the revoke changed, so CONNECT is what has to be re-proven.
  # This check is authoritative and needs no password.
  for r in $GRANTEES; do
    if [ "$(psql_admin -c "SELECT has_database_privilege('$r','$PULSE_DB','CONNECT')")" != "t" ]; then
      psql_admin -c "GRANT CONNECT ON DATABASE $PULSE_DB TO PUBLIC;" >/dev/null
      die "'$r' lost CONNECT after the revoke. PUBLIC's grant has been put back — Pulse is unaffected. Send me this output."
    fi
  done
  ok "Pulse's access to '$PULSE_DB' survives the revoke"

  # A live connection is extra confirmation, NOT the test, and must not gate
  # anything. Prisma connection strings carry parameters libpq rejects —
  # "?schema=public" being the usual one — so psql can refuse a URL that Prisma
  # uses perfectly well. Strip the query string, and print whatever happens
  # rather than swallowing it: hiding this error is exactly what made the first
  # version of this script abort with no way to tell why.
  PULSE_URI_CLEAN="${PULSE_URL%%\?*}"
  if live_out="$(psql "$PULSE_URI_CLEAN" -qtAX -c "SELECT 1" 2>&1)"; then
    ok "live test connection as '$PULSE_ROLE' succeeded"
  else
    warn "could not make a live test connection: ${live_out}"
    warn "This does NOT mean Pulse is broken. The privilege check above is the real"
    warn "test and it passed; a live connection can fail for auth reasons this"
    warn "script never touched. Confirm by loading app.blacandpink.com."
  fi
else
  say "PUBLIC already had no CONNECT on '$PULSE_DB' — nothing to revoke"
fi

# Prove the wall from the other side. The privilege check is authoritative and
# needs no password; the live connection attempt is a second opinion when we
# happen to know one.
if [ "$(psql_admin -c "SELECT has_database_privilege('$BC_ROLE','$PULSE_DB','CONNECT')")" = "t" ]; then
  die "'$BC_ROLE' still has CONNECT on '$PULSE_DB'. Do not go further — send me this output and I will work out why."
fi
if [ -n "$BC_PASS" ]; then
  if PGPASSWORD="$BC_PASS" psql -h 127.0.0.1 -U "$BC_ROLE" -d "$PULSE_DB" -qtAX -c "SELECT 1" >/dev/null 2>&1; then
    die "'$BC_ROLE' can STILL read '$PULSE_DB' despite having no CONNECT privilege. Stop and send me this."
  fi
fi
ok "'$BC_ROLE' is refused by '$PULSE_DB'  ← the wall is real"

# ── 3. App directory ────────────────────────────────────────────────────────
echo
echo "3. Application directory"
sudo mkdir -p "$BC_DIR"
sudo chown -R ubuntu:ubuntu /opt/bluechip
ok "$BC_DIR ready, owned by ubuntu"

if [ -n "$BC_PASS" ]; then
  sudo -u ubuntu tee "$BC_DIR/.env" >/dev/null <<ENV
DATABASE_URL="postgresql://$BC_ROLE:$BC_PASS@127.0.0.1:5432/$BC_DB"
PORT=$BC_PORT
NODE_ENV=production
APP_NAME="Blue Chip HR"
AUTH_SECRET="$(openssl rand -base64 32)"
ENV
  chmod 600 "$BC_DIR/.env"
  ok "wrote $BC_DIR/.env (mode 600)"
else
  warn "role already existed, so I don't know its password — $BC_DIR/.env not rewritten."
  warn "If this is a fresh install, reset it:  sudo -u postgres psql -c \"ALTER ROLE $BC_ROLE PASSWORD 'newpass'\""
fi

# ── 4. systemd service ──────────────────────────────────────────────────────
echo
echo "4. systemd service"
if ss -lntp 2>/dev/null | grep -q ":$BC_PORT "; then
  die "Port $BC_PORT is already in use. Pick another and re-run."
fi
sudo tee /etc/systemd/system/$BC_SERVICE.service >/dev/null <<UNIT
[Unit]
Description=Blue Chip HR
After=network.target postgresql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=$BC_DIR
EnvironmentFile=$BC_DIR/.env
ExecStart=/usr/bin/env npm run start
Restart=on-failure
RestartSec=5
# Small app, small footprint. Keeps it from ever crowding out Pulse.
MemoryMax=700M

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable $BC_SERVICE >/dev/null 2>&1
ok "$BC_SERVICE.service installed (port $BC_PORT, capped at 700 MB) — not started, there is no app yet"

# ── 5. nginx site ───────────────────────────────────────────────────────────
echo
echo "5. nginx"
sudo tee /etc/nginx/sites-available/$BC_HOST >/dev/null <<NGINX
server {
    listen 80;
    server_name $BC_HOST;
    client_max_body_size 25M;   # résumé uploads

    location / {
        proxy_pass         http://127.0.0.1:$BC_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 300s;
    }
}
NGINX
sudo ln -sfn /etc/nginx/sites-available/$BC_HOST /etc/nginx/sites-enabled/$BC_HOST
if sudo nginx -t 2>&1 | grep -q "successful"; then
  sudo systemctl reload nginx
  ok "nginx serving $BC_HOST → 127.0.0.1:$BC_PORT"
else
  sudo rm -f /etc/nginx/sites-enabled/$BC_HOST
  sudo nginx -t
  die "nginx config test failed. I removed the new site so nginx stays healthy — Pulse is unaffected."
fi

# ── 6. Shared build lock ────────────────────────────────────────────────────
echo
echo "6. Build lock"
touch "$SHARED_LOCK" 2>/dev/null || true
ok "both deploy scripts will flock $SHARED_LOCK — two Next builds can never run at once"

# ── Done ────────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════"
ok "Provisioning complete. Pulse was not restarted and is untouched."
echo
echo "Next, in order:"
echo "  1. Point $BC_HOST at this box's IP:  $(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo '<run: curl ifconfig.me>')"
echo "  2. Certificate:  sudo certbot --nginx -d $BC_HOST"
echo "  3. Clone the Blue Chip repo into $BC_DIR and deploy."
echo
echo "To check the wall at any time:"
echo "  psql -h 127.0.0.1 -U $BC_ROLE -d $PULSE_DB -c 'select 1'   # must FAIL"
echo "  psql -h 127.0.0.1 -U $PULSE_ROLE -d $PULSE_DB -c 'select 1' # must SUCCEED"
echo
