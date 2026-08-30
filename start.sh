#!/usr/bin/env bash
# GitHub Monitor — startup script
# Verifies prerequisites, then launches the server and opens the dashboard.

set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-4177}"
URL="http://localhost:${PORT}"

# Load local env overrides (.env is gitignored — safe place for GITHUB_APP_ID, etc.)
if [ -f "$(dirname "$0")/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$(dirname "$0")/.env"
  set +a
fi

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }

bold "GitHub Operations Bureau"
dim  "Port ${PORT} · ${URL}"
echo

# 1. node >= 22
if ! command -v node >/dev/null 2>&1; then
  red "✗ node is not installed. Install Node.js 22+ (e.g. \`brew install node\`)."
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "${NODE_MAJOR}" -lt 22 ]; then
  red "✗ node ${NODE_MAJOR} found — this project needs node 22 or newer."
  exit 1
fi
green "✓ node $(node -v)"

# 2. GitHub credentials. Which check applies depends on how server.js will
#    authenticate, so mirror its order: GitHub App, then GITHUB_TOKEN/GH_TOKEN,
#    then gh. Demanding gh unconditionally is what blocked startup for a
#    dashboard that had a working App key and needed nothing from gh at all.
if [ -n "${GITHUB_APP_ID:-}" ] && [ -n "${GITHUB_APP_PRIVATE_KEY_PATH:-}" ]; then
  # App auth signs its own JWT from this key. gh is never invoked, so its
  # absence or its login state cannot make the dashboard fail.
  APP_KEY_PATH="${GITHUB_APP_PRIVATE_KEY_PATH/#\~/$HOME}"
  if [ ! -r "${APP_KEY_PATH}" ]; then
    red "✗ GitHub App private key is not readable at ${APP_KEY_PATH}"
    dim  "  Fix GITHUB_APP_PRIVATE_KEY_PATH in .env, or unset both app vars to use a token."
    exit 1
  fi
  green "✓ GitHub App auth (id ${GITHUB_APP_ID})"
else
  if [ -n "${GITHUB_APP_ID:-}" ] || [ -n "${GITHUB_APP_PRIVATE_KEY_PATH:-}" ]; then
    yellow "! GitHub App auth is half-configured — set both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH, or neither."
    dim  "  Falling back to token auth, which has a flat 5,000 requests/hour."
  fi
  if [ -n "${GITHUB_TOKEN:-}" ] || [ -n "${GH_TOKEN:-}" ]; then
    green "✓ token from GITHUB_TOKEN/GH_TOKEN"
  elif ! command -v gh >/dev/null 2>&1; then
    red "✗ gh CLI not found. Install it: \`brew install gh\` then \`gh auth login\`."
    dim  "  Or export GITHUB_TOKEN, or configure GitHub App auth in .env."
    exit 1
  elif gh auth status >/dev/null 2>&1; then
    green "✓ gh authenticated"
  elif [ -n "$(gh auth token 2>/dev/null)" ]; then
    # `gh auth status` validates by calling the API, so an exhausted rate limit
    # reports as "not authenticated". A stored token is read from local config
    # and cannot be rate limited: if one exists, the credential is fine and it
    # is the check that is broken. Warn, but do not refuse to start.
    yellow "! gh auth status failed, but a token is stored — GitHub may be rate-limiting the check."
    dim  "  Starting anyway. If requests fail, run: gh auth status"
  else
    red "✗ gh is not authenticated. Run: gh auth login"
    exit 1
  fi
fi

# 3. Port in use?
if lsof -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  red "✗ Port ${PORT} is already in use."
  dim  "  Set a different port:  PORT=4188 ./start.sh"
  exit 1
fi

echo
bold "Starting server…"
dim  "(Ctrl-C to stop)"

# 4. Open browser shortly after the server boots
(
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.4
    if curl -fsS -o /dev/null "${URL}" 2>/dev/null; then
      if command -v open >/dev/null 2>&1; then
        open "${URL}"
      elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "${URL}" >/dev/null 2>&1 || true
      fi
      break
    fi
  done
) &

PORT="${PORT}" exec node server.js
