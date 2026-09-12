#!/usr/bin/env bash
# install-cron.sh — makes the app speak up every morning. Run once, with sudo.
#
#   sudo bash deploy/install-cron.sh
#
# The nightly job builds each person's list for the day: follow-ups due,
# interviews tomorrow, guarantees expiring, invoices overdue, CVs sent into
# silence. All of it from data the app already holds.
#
# 06:30, not midnight. The list should be built shortly before people look at
# it, so that "interviews tomorrow" means tomorrow from the morning they read
# it — and so a follow-up added late last night is included.

set -Eeuo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo."; exit 1; }

APP=/opt/bluechip/app
ENVFILE="$APP/.env"
PORT="${PORT:-3100}"

[ -f "$ENVFILE" ] || { echo "FATAL: $ENVFILE not found. Deploy first."; exit 1; }

# ── the shared secret ───────────────────────────────────────────────────────
# Generated here if absent, never printed, and only ever read from .env by both
# sides. The endpoint refuses every request when CRON_SECRET is unset, so a
# missing secret fails closed rather than leaving an open write endpoint.
if ! grep -q '^CRON_SECRET=' "$ENVFILE"; then
  SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
  printf '\nCRON_SECRET=%s\n' "$SECRET" >> "$ENVFILE"
  chown ubuntu:ubuntu "$ENVFILE"
  chmod 600 "$ENVFILE"
  echo "generated CRON_SECRET and added it to .env"
  echo "NOTE: the app must be restarted to pick it up — the deploy script does that."
else
  echo "CRON_SECRET already set — leaving it alone"
fi

cat > /etc/systemd/system/bluechip-daily.service <<EOF
[Unit]
Description=Blue Chip HR nightly reminders
After=network-online.target bluechip.service

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=$APP
# The secret is read out of .env at run time rather than baked into this unit
# file, so rotating it means editing one file, not two.
ExecStart=/bin/bash -c 'set -a; . $ENVFILE; set +a; \
  curl -fsS --max-time 120 -X POST \
    -H "X-Service-Token: \$CRON_SECRET" \
    http://127.0.0.1:$PORT/api/cron/daily'
TimeoutStartSec=180

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/bluechip-daily.timer <<'EOF'
[Unit]
Description=Build the day's reminders each morning

[Timer]
OnCalendar=*-*-* 06:30:00
# If the box was off at 06:30, run it as soon as it is back. A reminder list
# that silently did not get built is worse than one that is an hour late.
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now bluechip-daily.timer

echo
systemctl list-timers bluechip-daily.timer --no-pager | tail -2
echo
echo "Run it now and see what it finds:"
echo "  sudo systemctl start bluechip-daily.service && journalctl -u bluechip-daily -n 20 --no-pager"
echo
echo "A 401 in that output means the app has not been restarted since CRON_SECRET"
echo "was added, or that /api/cron is missing from the PUBLIC list in middleware.js."
