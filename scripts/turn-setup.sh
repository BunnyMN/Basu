#!/usr/bin/env bash
# The relay for calls that cannot go phone to phone: coturn, on this server.
#
# Run by scripts/deploy.sh after the API is up, and only once TURN_SECRET is
# in .env — set as a repository secret, so turning the relay on is a choice
# made in GitHub, not something a deploy does by itself. Safe to run again:
# it installs once, rewrites the config only when it would change, and
# restarts coturn only then.
#
# The deploy log is public. Nothing here prints the secret, or a path that
# holds it.
set -euo pipefail

APP=${APP:-/opt/basu/app}
ENV_FILE="$APP/.env"
CONF=/etc/turnserver.conf
CERTS=/etc/coturn/certs
MIN_PORT=49160
MAX_PORT=49999

value() { sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" "$ENV_FILE" | tail -n 1; }
SECRET=$(value TURN_SECRET)
HOST=$(value TURN_HOST)
if [ -z "$SECRET" ] || [ -z "$HOST" ]; then
  echo "  relay: off (no TURN_SECRET/TURN_HOST)"
  exit 0
fi

if ! command -v turnserver >/dev/null 2>&1; then
  echo "  relay: installing coturn"
  DEBIAN_FRONTEND=noninteractive timeout 300 apt-get install -y -q coturn >/dev/null
fi
# Older Ubuntu packages start nothing until told to.
[ -f /etc/default/coturn ] && sed -i 's/^#\{0,1\}TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

# coturn runs as its own user and cannot read Let's Encrypt's keys where they
# are; it gets a copy, and certbot copies again on every renewal.
LIVE="/etc/letsencrypt/live/$HOST"
tls=0
if [ -r "$LIVE/fullchain.pem" ] && [ -r "$LIVE/privkey.pem" ]; then
  install -d -m 750 -o root -g turnserver "$CERTS"
  install -m 640 -o root -g turnserver "$LIVE/fullchain.pem" "$CERTS/fullchain.pem"
  install -m 640 -o root -g turnserver "$LIVE/privkey.pem" "$CERTS/privkey.pem"
  hook=/etc/letsencrypt/renewal-hooks/deploy/coturn.sh
  if [ -d /etc/letsencrypt/renewal-hooks/deploy ] && [ ! -f "$hook" ]; then
    cat > "$hook" <<HOOK
#!/bin/sh
install -m 640 -o root -g turnserver "$LIVE/fullchain.pem" "$CERTS/fullchain.pem"
install -m 640 -o root -g turnserver "$LIVE/privkey.pem" "$CERTS/privkey.pem"
systemctl restart coturn
HOOK
    chmod 755 "$hook"
  fi
  tls=1
fi

# The relay must never become a way into this machine or the network it is
# on: no peer on a private, loopback or link-local address, and not this
# server's own addresses, where Postgres and the API listen. A machine behind
# NAT has a private address of its own; then coturn is told the public one
# phones reach it at (what TURN_HOST resolves to) as well.
SELF=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
PUBLIC=$(getent ahostsv4 "$HOST" 2>/dev/null | awk 'NR == 1 { print $1 }')

wanted=$(mktemp)
trap 'rm -f "$wanted"' EXIT
{
  echo "# Written by Basu's scripts/turn-setup.sh — edits here are overwritten on deploy."
  echo "listening-port=3478"
  [ "$tls" = 1 ] && echo "tls-listening-port=5349"
  echo "fingerprint"
  echo "use-auth-secret"
  echo "static-auth-secret=$SECRET"
  echo "realm=$HOST"
  echo "server-name=$HOST"
  if [ "$tls" = 1 ]; then
    echo "cert=$CERTS/fullchain.pem"
    echo "pkey=$CERTS/privkey.pem"
  else
    echo "no-tls"
    echo "no-dtls"
  fi
  echo "min-port=$MIN_PORT"
  echo "max-port=$MAX_PORT"
  [ -n "$PUBLIC" ] && [ -n "$SELF" ] && [ "$PUBLIC" != "$SELF" ] && echo "external-ip=$PUBLIC/$SELF"
  echo "no-cli"
  echo "no-multicast-peers"
  for range in 0.0.0.0-0.255.255.255 10.0.0.0-10.255.255.255 100.64.0.0-100.127.255.255 \
    127.0.0.0-127.255.255.255 169.254.0.0-169.254.255.255 172.16.0.0-172.31.255.255 \
    192.0.0.0-192.0.0.255 192.168.0.0-192.168.255.255 198.18.0.0-198.19.255.255 \
    ::1 fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff; do
    echo "denied-peer-ip=$range"
  done
  [ -n "$SELF" ] && echo "denied-peer-ip=$SELF"
  [ -n "$PUBLIC" ] && [ "$PUBLIC" != "$SELF" ] && echo "denied-peer-ip=$PUBLIC"
  # A call relayed both ways is four streams; this is room for fifty at once.
  echo "total-quota=200"
  echo "user-quota=8"
  echo "stale-nonce=600"
  echo "log-file=syslog"
  echo "simple-log"
} > "$wanted"

changed=0
if ! cmp -s "$wanted" "$CONF"; then
  install -m 640 -o root -g turnserver "$wanted" "$CONF"
  changed=1
fi

# Read once: a pipe into `grep -q` can end in SIGPIPE, which pipefail reads as «no».
firewall=$(command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null || true)
if grep -q '^Status: active' <<< "$firewall"; then
  for rule in 3478/udp 3478/tcp 5349/tcp "$MIN_PORT:$MAX_PORT/udp"; do
    grep -q "^$rule " <<< "$firewall" || ufw allow "$rule" >/dev/null
  done
fi

systemctl enable -q coturn
if [ "$changed" = 1 ] || ! systemctl is-active --quiet coturn; then
  systemctl restart coturn
fi
sleep 2
listening=$(ss -lnu 2>/dev/null | grep -c ':3478 ' || true)
echo "  relay: coturn $(systemctl is-active coturn) $(turnserver --version 2>/dev/null | head -n 1 || true), udp 3478 $([ "$listening" -gt 0 ] && echo listening || echo silent), tls $([ "$tls" = 1 ] && echo on || echo off), config $([ "$changed" = 1 ] && echo rewritten || echo unchanged)"
# Why it did not come up, in coturn's own words with every value cut out: this log is public.
if ! systemctl is-active --quiet coturn; then
  journalctl -u coturn --since '5 min ago' --no-pager -o cat 2>/dev/null | grep -iE 'error|cannot|bad|unknown' \
    | sed -E 's/=[^ ]*/=…/g; s/[A-Za-z0-9+\/]{20,}={0,2}/…/g' | tail -n 3 | sed 's/^/    /' || true
fi
