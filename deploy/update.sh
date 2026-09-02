#!/usr/bin/env bash
#
# Redeploy TradeGate from the current checkout.
#
# Run as the service account, from anywhere:
#   sudo -u tradegate -H /home/tradegate/TradeGate/deploy/update.sh
#
# Two settings here exist because of a real failure. TradeGate is a public
# repository, so fetching it needs no credentials at all - GitHub answers an
# anonymous request for a public repo happily. It answers a request carrying a
# *bad* credential with 401. So a deploy that 401s is not a deploy that needs
# to log in; it is one that found a stale token somewhere and sent it. The
# usual source is a credential helper holding a personal access token that has
# since expired, or a remote URL with a token baked into it from an earlier
# clone.
#
#   credential.helper=   empties the helper chain for this invocation, so no
#                        stored token is offered and the fetch stays anonymous.
#   GIT_TERMINAL_PROMPT=0  makes git fail with a message instead of blocking on
#                        a username prompt no one is there to answer. A deploy
#                        script that can hang waiting for input is a deploy
#                        script that will hang at the worst possible time.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/api/health}"
SERVICE="${SERVICE:-tradegate}"

cd "$REPO_DIR"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "Fetching $BRANCH without credentials (the repository is public)"
export GIT_TERMINAL_PROMPT=0
git -c credential.helper= fetch --prune origin "$BRANCH"

# --ff-only refuses rather than creating a merge commit on the server. A
# deploy checkout that has diverged is a problem to look at, not to paper over.
step "Fast-forwarding the working tree"
git -c credential.helper= merge --ff-only "origin/$BRANCH"

step "Installing dependencies from the lockfile"
npm ci

step "Applying database migrations"
# No DATABASE_URL means the platform is running keyless and there is nothing
# to migrate; that is a supported configuration, not a failure.
if grep -qs '^DATABASE_URL=.' .env; then
  npm run db:migrate
else
  echo "DATABASE_URL is not set - skipping migrations (keyless mode)."
fi

step "Building the frontend"
npm run build

step "Restarting $SERVICE"
sudo systemctl restart "$SERVICE"

step "Checking health"
# The unit restarts asynchronously, so poll rather than racing it with a sleep.
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 3 "$HEALTH_URL" > /tmp/tradegate-health.json 2>/dev/null; then
    echo "Healthy after ${attempt}s:"
    cat /tmp/tradegate-health.json
    echo
    exit 0
  fi
  sleep 1
done

echo "The service did not answer ${HEALTH_URL} within 30s." >&2
echo "Recent logs:" >&2
sudo journalctl -u "$SERVICE" -n 40 --no-pager >&2
exit 1
