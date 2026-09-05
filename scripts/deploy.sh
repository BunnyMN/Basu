#!/usr/bin/env bash
#
# The pilot server, brought to the commit that is already checked out.
#
# Run on the server as root, by /opt/basu/deploy-entry.sh — the small,
# stable wrapper that GitHub Actions reaches over SSH. The wrapper has
# already fetched and reset /opt/basu/app to the commit being deployed and
# then exec'd this file *fresh*, so what runs here is the deploy script of the
# version being deployed, not of the one being replaced. (Bash reads a script
# as it goes; a file that changes under a running script is how a deploy
# half-runs two versions of itself.)
#
# Order: dependencies → build → database backup → migrate → restart → health.
# A failure anywhere stops it with a non-zero exit, which Actions shows red.
# Nothing here is interactive.
set -euo pipefail

APP=/opt/basu/app
RUN_AS=basu
PORT=3210
KEEP_BACKUPS=10

cd "$APP"
# git is run as the checkout's owner throughout; root in another user's repo is
# "dubious ownership" and a refusal.
sha=$(sudo -u "$RUN_AS" git rev-parse --short HEAD)
echo "── deploy $sha ─────────────────────────────────────────"

echo "→ dependencies"
sudo -u "$RUN_AS" npm ci --no-audit --no-fund --silent

echo "→ build"
sudo -u "$RUN_AS" npm run build --silent

# The migration runner does not load .env on its own, and the backup needs
# the same URL, so read it once here.
DATABASE_URL=$(sudo -u "$RUN_AS" sh -c 'sed -n "s/^DATABASE_URL=//p" .env')
[ -n "$DATABASE_URL" ] || { echo "no DATABASE_URL in $APP/.env"; exit 1; }

echo "→ backup"
# The v16 dump: the server's default pg_dump may be older and refuse.
ts=$(date +%Y%m%d-%H%M%S)
/usr/lib/postgresql/16/bin/pg_dump "$DATABASE_URL" | gzip > "/root/basu-predeploy-$ts.sql.gz"
ls -1t /root/basu-predeploy-*.sql.gz | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

echo "→ migrate"
sudo -u "$RUN_AS" node --env-file=.env dist/db/migrate.js

echo "→ restart"
systemctl restart basu-api
if systemctl is-enabled --quiet basu-scheduler 2>/dev/null; then
  systemctl restart basu-scheduler
fi

echo "→ health"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "✓ $sha is up on :$PORT"
    exit 0
  fi
  sleep 1
done
echo "✗ the API did not answer /health within 30s; last lines of its log:"
tail -n 30 /var/log/basu-api.log
exit 1
