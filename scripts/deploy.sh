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
PG=/usr/lib/postgresql/16/bin
PROD_DB=basu_prod
# Keys for the server's .env that live as repository secrets on GitHub, so
# nobody has to log in to the server to turn on Google or email: the deploy
# job sends them on stdin, one KEY=value a line. Read once, here, before
# anything below can swallow stdin; a deploy run by hand from a terminal
# sends none.
incoming=""
if [ ! -t 0 ]; then incoming=$(timeout 10 cat || true); fi
exec </dev/null

cd "$APP"
# git is run as the checkout's owner throughout; root in another user's repo is
# "dubious ownership" and a refusal.
sha=$(sudo -u "$RUN_AS" git rev-parse --short HEAD)
echo "── deploy $sha ─────────────────────────────────────────"

echo "→ dependencies"
sudo -u "$RUN_AS" npm ci --no-audit --no-fund --silent

echo "→ build"
sudo -u "$RUN_AS" npm run build --silent

env_url() { sudo -u "$RUN_AS" sh -c 'sed -n "s/^DATABASE_URL=//p" .env'; }

# The units were written for the demo and may carry a BASU_MODE of their own,
# and a variable already in the process environment beats one in .env. So
# the mode .env names is pinned into both units with a drop-in whose
# EnvironmentFile is read last — later files win, and files beat Environment=.
pin_mode() {
  local mode node_env unit
  mode=$(sed -n 's/^BASU_MODE=//p' .env | tail -n 1)
  node_env=$(sed -n 's/^NODE_ENV=//p' .env | tail -n 1)
  { echo "BASU_MODE=${mode:-demo}"; [ -z "$node_env" ] || echo "NODE_ENV=$node_env"; } > /opt/basu/mode.env
  chmod 644 /opt/basu/mode.env
  for unit in basu-api basu-scheduler; do
    systemctl cat "$unit" >/dev/null 2>&1 || continue
    mkdir -p "/etc/systemd/system/$unit.service.d"
    printf '[Service]\nEnvironmentFile=/opt/basu/mode.env\n' > "/etc/systemd/system/$unit.service.d/zz-mode.conf"
  done
  systemctl daemon-reload
}

# ── Leaving the demo, once ─────────────────────────────────────────────
# The pilot ran as a walkthrough: a demo clock, a shared desk token, a
# seeded catalogue of restaurants and suppliers nobody owns, a door that let
# anybody in without a password. Real people start on an empty database with
# nothing seeded. The demo database stays beside it, untouched, and is
# dumped once more for good measure. Nothing printed here may carry the
# database URL: this log is public.
flipped=0
if ! sudo -u "$RUN_AS" grep -q '^BASU_MODE=production$' .env; then
  echo "→ production (once): a fresh database, the demo one kept"
  demo_url=$(env_url)
  [ -n "$demo_url" ] || { echo "no DATABASE_URL in $APP/.env"; exit 1; }
  read -r db_user db_port < <(node -e 'const u = new URL(process.argv[1]); console.log(decodeURIComponent(u.username), u.port || 5432)' "$demo_url")
  prod_url=$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.toString())' "$demo_url" "$PROD_DB")

  [ -f /root/basu-demo-final.sql.gz ] || "$PG/pg_dump" "$demo_url" | gzip > /root/basu-demo-final.sql.gz

  if ! sudo -u postgres "$PG/psql" -p "$db_port" -tAc "SELECT 1 FROM pg_database WHERE datname = '$PROD_DB'" | grep -q 1; then
    sudo -u postgres "$PG/psql" -p "$db_port" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $PROD_DB OWNER \"$db_user\""
  fi
  # Extensions want a superuser; everything after them is the app's own.
  sudo -u postgres "$PG/psql" -p "$db_port" -d "$PROD_DB" -v ON_ERROR_STOP=1 -q \
    -c 'CREATE EXTENSION IF NOT EXISTS btree_gist' -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto'

  # The demo .env is kept whole as .env.demo, which is also the way back.
  cp -p .env .env.demo
  {
    grep -v -E '^(BASU_MODE|NODE_ENV|DATABASE_URL|OPS_TOKEN)=' .env.demo || true
    echo 'BASU_MODE=production'
    echo 'NODE_ENV=production'
    printf 'DATABASE_URL=%s\n' "$prod_url"
  } > .env.next
  # Bank details are sealed with this; production refuses to store one without it.
  grep -q '^BANK_KEY=.' .env.next || printf 'BANK_KEY=%s\n' "$(openssl rand -base64 32)" >> .env.next
  chown --reference=.env .env.next && chmod 600 .env.next && mv .env.next .env

  # The scheduler sat out the demo (its clock came from the page); now it is
  # what fires every lunch on time, so it runs, and starts with the machine.
  if systemctl cat basu-scheduler >/dev/null 2>&1; then
    systemctl enable -q basu-scheduler
  else
    echo "! no basu-scheduler unit on this server — orders will not fire on their own"
  fi
  flipped=1
  # Any failure from here until the API answers puts the demo back as it
  # was, rather than leave the pilot dark or half-switched.
  trap 'if [ "$flipped" = 1 ]; then
          echo "↩ back to the demo .env"
          cp -p .env.demo .env
          pin_mode
          systemctl disable -q --now basu-scheduler 2>/dev/null || true
          systemctl restart basu-api
        fi' EXIT
fi

# ── Keys from the repository's secrets ─────────────────────────────────
# Only these names, and a name the secrets do not set is left as it is on
# the server: an unset secret never wipes a key. The log says which key was
# set, never what to — it is public.
MANAGED_KEYS=" GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET SMTP_URL MAIL_FROM OPS_MEMBERS "
if [ -n "$incoming" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    key=${line%%=*}
    value=${line#*=}
    case "$MANAGED_KEYS" in *" $key "*) ;; *) echo "  .env: ignored a key the deploy does not manage"; continue ;; esac
    [ -n "$value" ] || continue
    case "$value" in *'"'*) echo "  .env: $key refused — a double quote in the value"; continue ;; esac
    wanted="$key=\"$value\""
    grep -qxF "$wanted" .env && continue
    tmp=$(mktemp .env.XXXXXX)
    { grep -v "^$key=" .env || true; printf '%s\n' "$wanted"; } > "$tmp"
    # Each its own step: any of them failing stops the deploy, red.
    chown --reference=.env "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" .env
    echo "  .env: $key set from the repository's secrets"
  done <<< "$incoming"
fi

# The migration runner does not load .env on its own, and the backup needs
# the same URL, so read it once here.
DATABASE_URL=$(env_url)
[ -n "$DATABASE_URL" ] || { echo "no DATABASE_URL in $APP/.env"; exit 1; }

echo "→ backup"
# The v16 dump: the server's default pg_dump may be older and refuse.
ts=$(date +%Y%m%d-%H%M%S)
/usr/lib/postgresql/16/bin/pg_dump "$DATABASE_URL" | gzip > "/root/basu-predeploy-$ts.sql.gz"
ls -1t /root/basu-predeploy-*.sql.gz | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

echo "→ migrate"
sudo -u "$RUN_AS" node --env-file=.env dist/db/migrate.js

echo "→ restart"
pin_mode
systemctl restart basu-api
if systemctl is-enabled --quiet basu-scheduler 2>/dev/null; then
  systemctl restart basu-scheduler
fi

echo "→ health"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "✓ $sha is up on :$PORT"
    if grep -q '^BASU_MODE=production$' .env; then
      dev=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/dev/clock")
      if [ "$dev" != 404 ]; then
        # Demo shortcuts on the real database let anybody in as anybody.
        # Dark is better than that.
        echo "✗ production, yet /dev answers $dev — stopping the API"
        echo "  unit environment names: $(systemctl show -p Environment --value basu-api | tr ' ' '\n' | cut -d= -f1 | paste -sd' ' -)"
        echo "  unit environment files: $(systemctl show -p EnvironmentFiles --value basu-api)"
        systemctl stop basu-api
        exit 1
      fi
      echo "✓ production: no /dev on :$PORT"
      # Which ways in are open — Google and email wait on keys in .env.
      echo "  sign-in: $(curl -s "http://127.0.0.1:$PORT/v1/auth/methods")"
    fi
    flipped=0
    exit 0
  fi
  sleep 1
done
echo "✗ the API did not answer /health within 30s; last lines of its log:"
tail -n 30 /var/log/basu-api.log
exit 1
