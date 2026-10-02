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

# ── What .env says ─────────────────────────────────────────────────────
# Read in $APP, before anything there changes, and the way the API reads it.

env_url() { sudo -u "$RUN_AS" sh -c 'sed -n "s/^DATABASE_URL=//p" .env'; }

# Every question below is put to root's node, and env_value takes any
# failure of it for a key .env does not have. With no node on root's PATH,
# or one from before process.loadEnvFile (Node 20.12), every key would read
# as missing: the mode and the database .env names would be named nowhere,
# and what the deploy then refused, or let through, would be for a reason
# that is not the real one. So it is asked first, and said plainly.
node_reads_env() {
  if ! command -v node >/dev/null 2>&1; then
    echo "✗ no node on root's PATH — the deploy reads .env with it. Install Node 22 for root, or put it on root's PATH; nothing was changed." >&2
    return 1
  fi
  if ! node -e 'process.exit(typeof process.loadEnvFile === "function" ? 0 : 1)' >/dev/null 2>&1; then
    echo "✗ root's node ($(node --version 2>/dev/null || echo 'version unknown')) cannot read .env: process.loadEnvFile came in Node 20.12, and Basu runs on 22. Upgrade it; nothing was changed." >&2
    return 1
  fi
}

# A key of .env as the API will read it: by Node's own parser, which takes
# quotes, a trailing comment and the last of two lines the way the API does.
# Empty when .env does not have it — and when node cannot read it at all,
# which node_reads_env has ruled out before anything asks.
env_value() { env -u "$1" node -e 'process.loadEnvFile(".env"); console.log(process.env[process.argv[1]] ?? "")' "$1" 2>/dev/null || true; }

# The mode .env names as the API reads one: in any case, without the blanks
# around it. Empty when it names none.
named_mode() { node -e 'console.log(process.argv[1].trim().toLowerCase())' "$(env_value BASU_MODE)"; }

# The database .env points at, by name. A URL that names none this can read
# — a # in an unquoted password starts a comment, for the API as well — is
# refused rather than taken for some other database: which one it is decides
# whether the demo may run on it, and whether this server has left the demo.
named_db() {
  local name
  name=$(node -e 'try { console.log(decodeURIComponent(new URL(process.argv[1]).pathname.slice(1))) } catch { console.log("") }' "$(env_value DATABASE_URL)")
  if [ -z "$name" ]; then
    echo "✗ .env names no database in DATABASE_URL that the deploy can read — refused" >&2
    return 1
  fi
  echo "$name"
}

# What the API is to run as. A server is production unless its .env says
# demo in as many words: naming no mode is production — it used to be the
# demo — and a word that is neither is refused, not guessed at. Nor is the
# real database ever a demo, whatever the line says: the demo signs anybody
# in as anybody and hands out the desk's secret.
pinned_mode() {
  local db
  case "$(named_mode)" in
    production | '') echo production ;;
    demo)
      db=$(named_db) || return 1
      if [ "$db" = "$PROD_DB" ]; then
        echo "✗ .env names the demo on $PROD_DB, the real database — refused" >&2
        return 1
      fi
      echo demo
      ;;
    *)
      echo "✗ .env names a BASU_MODE that is neither demo nor production — refused" >&2
      return 1
      ;;
  esac
}

# Whether this server is still the demo, and the switch below still to come.
# Once is once: an .env that names production however it is spelled, or
# that already points at the production database, is not the demo's. Taking
# it for the demo's would keep it as .env.demo — the way back — and a
# failure would then put it back and stop the scheduler.
still_the_demo() {
  local db
  [ "$(named_mode)" != production ] || return 1
  db=$(named_db) || exit 1
  [ "$db" != "$PROD_DB" ]
}

cd "$APP"
# git is run as the checkout's owner throughout; root in another user's repo is
# "dubious ownership" and a refusal.
sha=$(sudo -u "$RUN_AS" git rev-parse --short HEAD)
echo "── deploy $sha ─────────────────────────────────────────"

# A node that cannot read .env, a mode or a database the deploy refuses:
# each stops it here, before the dependencies, the build or the schema
# change, and the API goes on as it was.
node_reads_env || exit 1
pinned_mode >/dev/null || exit 1
leaving=0
if still_the_demo; then leaving=1; fi

echo "→ dependencies"
sudo -u "$RUN_AS" npm ci --no-audit --no-fund --silent

echo "→ build"
sudo -u "$RUN_AS" npm run build --silent

# The units were written for the demo and may carry a BASU_MODE of their own,
# and a variable already in the process environment beats one in .env. So
# the mode is pinned into both units with a drop-in whose EnvironmentFile is
# read last — later files win, and files beat Environment=. A mode refused
# pins nothing and restarts nothing: the API keeps the one it has.
pin_mode() {
  local node_env unit
  PINNED=$(pinned_mode) || exit 1
  node_env=$(env_value NODE_ENV)
  { echo "BASU_MODE=$PINNED"; [ -z "$node_env" ] || echo "NODE_ENV=$node_env"; } > /opt/basu/mode.env
  chmod 644 /opt/basu/mode.env
  for unit in basu-api basu-scheduler; do
    systemctl cat "$unit" >/dev/null 2>&1 || continue
    mkdir -p "/etc/systemd/system/$unit.service.d"
    printf '[Service]\nEnvironmentFile=/opt/basu/mode.env\n' > "/etc/systemd/system/$unit.service.d/zz-mode.conf"
  done
  systemctl daemon-reload
  echo "  mode: $PINNED"
}

# ── Leaving the demo, once ─────────────────────────────────────────────
# The pilot ran as a walkthrough: a demo clock, a shared desk token, a
# seeded catalogue of restaurants and suppliers nobody owns, a door that let
# anybody in without a password. Real people start on an empty database with
# nothing seeded. The demo database stays beside it, untouched, and is
# dumped once more for good measure. Nothing printed here may carry the
# database URL: this log is public.
#
# Whether it is still to come was read at the start, by still_the_demo.
flipped=0
if [ "$leaving" = 1 ]; then
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
MANAGED_KEYS=" GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET SMTP_URL MAIL_FROM OPS_MEMBERS WIRE_SECRET_KEY WIRE_WEBHOOK_SECRET WIRE_RETURN_URL "
if [ -n "$incoming" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    key=${line%%=*}
    value=${line#*=}
    case "$MANAGED_KEYS" in *" $key "*) ;; *) echo "  .env: ignored a key the deploy does not manage"; continue ;; esac
    [ -n "$value" ] || continue
    # «-» takes the key out: how a door is turned off from GitHub alone (WIRE_SECRET_KEY set to «-» closes
    # online payment on the next deploy) — an emptied or deleted secret is simply not sent.
    if [ "$value" = "-" ]; then
      if grep -q "^$key=" .env; then
        tmp=$(mktemp .env.XXXXXX)
        { grep -v "^$key=" .env || true; } > "$tmp"
        chown --reference=.env "$tmp"
        chmod 600 "$tmp"
        mv "$tmp" .env
        echo "  .env: $key removed by the repository's secrets"
      fi
      continue
    fi
    case "$value" in *'"'*) echo "  .env: $key refused — a double quote in the value"; continue ;; esac
    wanted="$key=\"$value\""
    # Compared in the shell, not by grep: a value on a command line is readable by anyone listing processes.
    same=0
    while IFS= read -r existing || [ -n "$existing" ]; do
      if [ "$existing" = "$wanted" ]; then same=1; break; fi
    done < .env
    [ "$same" = 1 ] && continue
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
    # Anything but a demo pinned by name must have no /dev at all.
    if [ "$PINNED" != demo ]; then
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
