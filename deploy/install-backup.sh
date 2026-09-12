#!/usr/bin/env bash
# install-backup.sh — puts the nightly backup on a timer. Run once, with sudo.
#
#   sudo bash deploy/install-backup.sh
#
# A systemd timer rather than a crontab entry, for one reason that matters: if
# the box is asleep or rebooting at 02:15, Persistent=true runs the backup as
# soon as it comes back. A cron job that misses its window simply does not
# happen that day, and nothing tells you.
#
# 02:15 IST is chosen to sit clear of Pulse's own 02:30 backup. Two pg_dumps at
# once on a shared box is avoidable contention.

set -Eeuo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo."; exit 1; }

APP=/opt/bluechip/app
SCRIPT="$APP/deploy/backup-bluechip.sh"

[ -f "$SCRIPT" ] || { echo "FATAL: $SCRIPT not found. Deploy first."; exit 1; }
chmod +x "$SCRIPT"

mkdir -p /var/backups/bluechip
chown ubuntu:ubuntu /var/backups/bluechip
chmod 750 /var/backups/bluechip        # dumps contain every candidate's phone number
touch /var/log/bluechip-backup.log
chown ubuntu:ubuntu /var/log/bluechip-backup.log

# Where the off-box destination is configured. Written only if absent, so
# re-running this never wipes settings someone already put in.
if [ ! -f /etc/default/bluechip-backup ]; then
  cat > /etc/default/bluechip-backup <<'EOF'
# Off-box destination for Blue Chip backups. Set ONE of these.
#
# Until one is set, backups exist only on this machine — which means they do
# not protect you from the failure you are actually worried about.
#
# Cloudflare R2 (Pulse already uses R2; reuse the same bucket, different prefix):
#   BACKUP_S3_URI=s3://your-bucket/bluechip
#   BACKUP_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
#   AWS_ACCESS_KEY_ID=...
#   AWS_SECRET_ACCESS_KEY=...
#
# Or another machine you control:
#   BACKUP_SCP_TARGET=user@host:/path/to/backups/
#
KEEP_DAYS=14
EOF
  chmod 600 /etc/default/bluechip-backup   # it will hold credentials
  echo "wrote /etc/default/bluechip-backup — set an off-box destination in it"
fi

cat > /etc/systemd/system/bluechip-backup.service <<EOF
[Unit]
Description=Blue Chip HR database backup
After=network-online.target postgresql.service

[Service]
Type=oneshot
User=ubuntu
EnvironmentFile=-/etc/default/bluechip-backup
ExecStart=/usr/bin/env bash $SCRIPT
# A backup that hangs on a dead network mount must not hold the box all night.
TimeoutStartSec=1800
EOF

cat > /etc/systemd/system/bluechip-backup.timer <<'EOF'
[Unit]
Description=Nightly Blue Chip HR database backup

[Timer]
# 02:15 IST. systemd timers are in the system timezone; the box is on UTC, so
# this is 20:45 UTC the previous day. Written as the local time the machine is
# actually set to, whatever that is, rather than assuming.
OnCalendar=*-*-* 02:15:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now bluechip-backup.timer

echo
echo "Installed. Next run:"
systemctl list-timers bluechip-backup.timer --no-pager | tail -2
echo
echo "Run one NOW and watch it, rather than finding out in the morning:"
echo "  sudo systemctl start bluechip-backup.service && tail -30 /var/log/bluechip-backup.log"
echo
echo "Then do the restore test at the bottom of backup-bluechip.sh. Ten minutes,"
echo "once, and you will know the backups are real."
