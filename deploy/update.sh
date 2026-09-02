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

# GitHub answers a request for a repository it will not serve you with 401,
# never 404 - that is deliberate, so a private repository's existence does not
# leak to someone guessing URLs. The consequence is that "401" and "no such
# repository" are the same response, and a wrong remote URL is indistinguishable
# from a credentials problem unless you go and check. This does the checking.
diagnose_fetch_failure() {
  echo
  echo "----------------------------------------------------------------------"
  echo "The fetch failed. Working out why before you go looking for a token."
  echo "----------------------------------------------------------------------"

  # --get-url applies any insteadOf rewrite, which `git remote -v` does not.
  # A rewrite rule is the one failure that makes the configured URL look
  # perfectly correct while the request goes somewhere else entirely.
  local configured resolved status
  configured="$(git config --get remote.origin.url || echo '<unset>')"
  resolved="$(git ls-remote --get-url origin 2>/dev/null || echo "$configured")"

  echo "Configured remote : $configured"
  echo "Actually requested: $resolved"
  [ "$configured" != "$resolved" ] && echo "  ^ these differ, so an insteadOf rewrite is redirecting the fetch."

  case "$resolved" in
    *@github.com*) echo "  ^ the URL carries a username or token. That is what gets rejected." ;;
  esac

  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    "${resolved%.git}.git/info/refs?service=git-upload-pack" 2>/dev/null || echo '000')"
  echo "Anonymous probe   : HTTP $status"

  case "$status" in
    200)
      echo
      echo "The repository IS reachable anonymously, so the URL is right and no"
      echo "credential is needed. Something local is injecting a rejected one, or"
      echo "sending the request somewhere other than where curl just sent it."
      echo
      echo "Config contributing to this, and the file each setting came from:"
      git config --list --show-origin 2>/dev/null \
        | grep -Ei 'credential|http\.|url\.|proxy' || echo "  (none)"
      # curl's netrc support is on by default in some git builds, so a stale
      # login here is sent without any git config mentioning it - which makes it
      # the hardest of these to find by reading configuration.
      for netrc in "$HOME/.netrc" "$HOME/.netrc.gpg" /etc/netrc; do
        if [ -f "$netrc" ] && grep -qs 'github\.com' "$netrc"; then
          echo
          echo "  !! $netrc has a github.com entry. curl reads this automatically,"
          echo "     so it is sent even though no git config mentions it."
        fi
      done
      echo
      echo "If nothing above explains it, have git show the exchange itself:"
      echo "  GIT_TERMINAL_PROMPT=0 GIT_CURL_VERBOSE=1 \\"
      echo "    git -c credential.helper= ls-remote origin 2>&1 \\"
      echo "    | grep -Ei 'Send header: (GET|Authorization)|Recv header: HTTP|netrc|fatal'"
      echo "That prints the exact URL requested, the status returned, and any"
      echo "Authorization header sent."
      ;;
    401|403)
      echo
      echo "GitHub will not serve this URL anonymously. It returns 401 both for a"
      echo "private repository and for one that does not exist, so the likeliest"
      echo "cause is that the URL is wrong - a typo, the wrong owner, or a stale"
      echo "path from an earlier clone. Compare it against the real one:"
      echo "  git remote set-url origin https://github.com/AA-2020743/TradeGate.git"
      echo "If the URL is correct and the repository is private, this server needs"
      echo "a read-only deploy key rather than a token that expires."
      ;;
    000)
      echo
      echo "No HTTP response at all: DNS, egress firewall, or a proxy is blocking"
      echo "github.com from this host. Try: curl -sSI https://github.com"
      ;;
    *)
      echo
      echo "Unexpected status. Try the request by hand to see the body:"
      echo "  curl -sS '${resolved%.git}.git/info/refs?service=git-upload-pack' | head"
      ;;
  esac
  echo "----------------------------------------------------------------------"
}

step "Fetching $BRANCH without credentials (the repository is public)"
export GIT_TERMINAL_PROMPT=0
if ! git -c credential.helper= fetch --prune origin "$BRANCH"; then
  diagnose_fetch_failure
  exit 1
fi

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
