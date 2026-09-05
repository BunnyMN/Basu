#!/usr/bin/env bash
#
# What the deploy key is allowed to do — and all it is allowed to do.
#
# Installed once on the server as /opt/basu/deploy-entry.sh and named as the
# forced `command=` of the deploy key in root's authorized_keys, so a login
# with that key cannot open a shell, forward a port, or run anything else:
# whatever GitHub Actions sends as the command arrives here as
# $SSH_ORIGINAL_COMMAND and is only ever read as "which commit".
#
#   ssh root@host <sha>       → deploy that commit of main
#   ssh root@host             → deploy the tip of main
#
# It fetches, resets the checkout, and then exec's the repo's own
# scripts/deploy.sh — fresh from the commit just checked out — which does
# the rest. Kept tiny on purpose: this file is outside the repo, so every
# line here is one that a deploy cannot update.
set -euo pipefail

APP=/opt/basu/app
RUN_AS=basu

ref="${SSH_ORIGINAL_COMMAND:-origin/main}"
if ! [[ "$ref" =~ ^([0-9a-f]{7,40}|origin/main)$ ]]; then
  echo "refused: '$ref' is not a commit of main" >&2
  exit 2
fi

cd "$APP"
sudo -u "$RUN_AS" git fetch -q origin main
if [[ "$ref" != origin/main ]] && ! sudo -u "$RUN_AS" git merge-base --is-ancestor "$ref" origin/main; then
  echo "refused: $ref is not on main" >&2
  exit 2
fi
sudo -u "$RUN_AS" git reset -q --hard "$ref"

exec bash scripts/deploy.sh
