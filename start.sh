#!/usr/bin/env bash
# GitHub Monitor — run, supervise and watch the dashboard.
#
#   ./start.sh                 preflight checks, then run in the foreground (same as `run`)
#   ./start.sh start           install/load the LaunchAgent and wait until the server answers
#   ./start.sh stop            unload the LaunchAgent (it loads again at your next login)
#   ./start.sh restart         restart under launchd, e.g. to pick up a merged change
#   ./start.sh status          one-shot report; exits 0 healthy, 1 down, 2 up but needs attention
#   ./start.sh monitor [secs]  keep the status report on screen, refreshed every secs (default 10)
#   ./start.sh logs            follow the server log
#
# start/stop/restart drive launchd rather than a background process of their
# own: launchd is what restarts the server after a crash, and a second
# supervisor would fight it for the port. The agent runs node directly (see
# macos/com.ryabinski.github-monitor.plist for why it cannot run this script).

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd -P)"

# Load local env overrides (.env is gitignored — safe place for GITHUB_APP_ID, etc.)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PORT="${PORT:-4177}"
URL="http://localhost:${PORT}"

LABEL="com.ryabinski.github-monitor"
PLIST_SRC="${ROOT}/macos/${LABEL}.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG="${HOME}/Library/Logs/github-monitor.log"
WAIT_SECONDS="${START_SH_WAIT_SECONDS:-30}"
TAB="$(printf '\t')"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }

usage() {
  sed -n '2,10s/^# \{0,1\}//p' "$0"
}

# ---------------------------------------------------------------- preflight

check_node() {
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
}

# Which check applies depends on how server.js will authenticate, so mirror its
# order: GitHub App, then GITHUB_TOKEN/GH_TOKEN, then gh. Demanding gh
# unconditionally is what blocked startup for a dashboard that had a working
# App key and needed nothing from gh at all.
check_credentials() {
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
    return
  fi
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
}

# The pid listening on PORT, if any.
port_holder() {
  lsof -nP -t -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

# ------------------------------------------------------------------ launchd

require_launchd() {
  if ! command -v launchctl >/dev/null 2>&1; then
    red "✗ launchctl not found — start/stop/restart supervise the server with macOS launchd."
    dim  "  Elsewhere, run ./start.sh in the foreground under your own supervisor."
    exit 1
  fi
  DOMAIN="gui/$(id -u)"
  SERVICE="${DOMAIN}/${LABEL}"
}

# Reads the job's state from launchd into SVC_* variables. Only the job's own
# top-level keys are read: they are indented by exactly one tab, nested blocks
# by more.
service_info() {
  SVC_LOADED=0 SVC_PID="" SVC_RUNS="" SVC_LAST_EXIT="" SVC_STATE="" SVC_DIR=""
  command -v launchctl >/dev/null 2>&1 || return 0
  local out
  out=$(launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null) || return 0
  SVC_LOADED=1
  SVC_PID=$(printf '%s\n' "$out" | sed -n "s/^${TAB}pid = //p" | head -n 1)
  SVC_RUNS=$(printf '%s\n' "$out" | sed -n "s/^${TAB}runs = //p" | head -n 1)
  SVC_STATE=$(printf '%s\n' "$out" | sed -n "s/^${TAB}state = //p" | head -n 1)
  SVC_LAST_EXIT=$(printf '%s\n' "$out" | sed -n "s/^${TAB}last exit code = //p" | head -n 1)
  [ "$SVC_LAST_EXIT" = "(never exited)" ] && SVC_LAST_EXIT=""
  SVC_DIR=$(printf '%s\n' "$out" | sed -n "s/^${TAB}working directory = //p" | head -n 1)
}

# bootout returns before launchd has finished tearing the job down, and a
# bootstrap in that window fails with "5: Input/output error". Wait it out.
unload_agent() {
  launchctl bootout "$SERVICE" 2>/dev/null || true
  local i=0
  while launchctl print "$SERVICE" >/dev/null 2>&1 && [ "$i" -lt 20 ]; do
    sleep 0.5
    i=$((i + 1))
  done
}

# The <string> right after <key>$1</key> in plist $2.
plist_value() {
  sed -n "/<key>$1<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}" "$2"
}

# The checked-in plist carries this machine's paths. Rewrite them for wherever
# this checkout, node and $HOME actually are, so `start` works from any clone.
render_plist() {
  local src_dir src_log src_node node_bin
  src_dir=$(plist_value WorkingDirectory "$PLIST_SRC")
  src_log=$(plist_value StandardOutPath "$PLIST_SRC")
  src_node=$(sed -n '/<key>ProgramArguments<\/key>/,/<\/array>/s/.*<string>\(.*\)<\/string>.*/\1/p' "$PLIST_SRC" | head -n 1)
  node_bin=$(command -v node)
  sed -e "s#${src_node}#${node_bin}#g" \
      -e "s#${src_dir}#${ROOT}#g" \
      -e "s#${src_log}#${LOG}#g" \
      "$PLIST_SRC"
}

# Installs or refreshes the LaunchAgent plist. Sets PLIST_CHANGED=1 when the
# file on disk changed, so a loaded job knows it must be reloaded to see it.
sync_agent() {
  PLIST_CHANGED=0
  local rendered installed_dir
  rendered=$(render_plist)
  if [ -f "$PLIST_DST" ]; then
    installed_dir=$(plist_value WorkingDirectory "$PLIST_DST")
    if [ -n "$installed_dir" ] && [ "$installed_dir" != "$ROOT" ]; then
      red "✗ The installed LaunchAgent runs another checkout: ${installed_dir}"
      dim  "  Manage it from there, or remove ${PLIST_DST} to hand it to this one."
      exit 1
    fi
    [ "$(cat "$PLIST_DST")" = "$rendered" ] && return 0
    green "✓ LaunchAgent updated from macos/${LABEL}.plist"
  else
    mkdir -p "$(dirname "$PLIST_DST")" "$(dirname "$LOG")"
    green "✓ LaunchAgent installed at ${PLIST_DST}"
  fi
  printf '%s\n' "$rendered" > "$PLIST_DST"
  PLIST_CHANGED=1
}

# ------------------------------------------------------------------- health

health_json() {
  curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null
}

# One line describing /api/health. Exit 0 healthy, 3 quota blocked, 1 unreadable.
health_summary() {
  # shellcheck disable=SC2016 # the backticks are JavaScript template literals
  node -e '
    let body = "";
    process.stdin.on("data", (chunk) => (body += chunk)).on("end", () => {
      let health;
      try { health = JSON.parse(body); } catch { process.exit(1); }
      if (!health.ok) process.exit(1);
      const quota = health.quota || {};
      const auth = health.authMode === "app" ? "GitHub App" : "token auth";
      const where = quota.installationKey ? ` (${quota.installationKey} ${quota.resource})` : "";
      const reading = quota.remaining == null
        ? "quota unknown until the first scan"
        : `quota ${quota.status} ${quota.remaining}/${quota.limit}${where}`;
      console.log(`ok · ${auth} · ${reading}${quota.blocked ? " · requests paused until reset" : ""}`);
      process.exit(quota.blocked ? 3 : 0);
    });
  '
}

# Waits for a launchd-run server, other than $1 (a pid being replaced), to answer.
wait_healthy() {
  local old_pid="${1:-}" i=0
  while [ "$i" -lt "$WAIT_SECONDS" ]; do
    service_info
    if [ -n "$SVC_PID" ] && [ "$SVC_PID" != "$old_pid" ] && health_json >/dev/null; then
      green "✓ Serving ${URL} (pid ${SVC_PID})"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  red "✗ The server did not answer within ${WAIT_SECONDS}s."
  if [ -f "$LOG" ]; then
    dim "  Last lines of ${LOG}:"
    tail -n 15 "$LOG" | sed 's/^/    /'
  fi
  return 1
}

# ps etime ([[dd-]hh:]mm:ss) as seconds.
etime_seconds() {
  local t="${1// /}" d=0 h=0 m=0 s=0 a b c
  case "$t" in *-*) d="${t%%-*}"; t="${t#*-}" ;; esac
  IFS=: read -r a b c <<EOF
$t
EOF
  if [ -n "$c" ]; then h="$a" m="$b" s="$c"; else m="$a" s="$b"; fi
  echo $(( 10#$d * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s ))
}

# The newest mtime (epoch seconds) of the files the running server read at start.
code_mtime() {
  # shellcheck disable=SC2016
  node -p '
    const fs = require("fs");
    Math.max(0, ...["server.js", ".env"].filter((f) => fs.existsSync(f))
      .map((f) => Math.floor(fs.statSync(f).mtimeMs / 1000)))
  '
}

# ------------------------------------------------------------------ commands

cmd_run() {
  bold "GitHub Operations Bureau"
  dim  "Port ${PORT} · ${URL}"
  echo

  check_node
  check_credentials

  if lsof -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    red "✗ Port ${PORT} is already in use."
    service_info
    if [ -n "$SVC_PID" ]; then
      dim  "  The LaunchAgent is serving it (pid ${SVC_PID}): ./start.sh status, or ./start.sh stop first."
    else
      dim  "  Set a different port:  PORT=4188 ./start.sh"
    fi
    exit 1
  fi

  echo
  bold "Starting server…"
  dim  "(Ctrl-C to stop)"

  PORT="${PORT}" exec node server.js
}

# start and restart share everything but what they do to a job already running.
launch() {
  local mode="$1" holder old_pid=""
  require_launchd
  bold "GitHub Operations Bureau"
  dim  "Port ${PORT} · ${URL}"
  echo
  check_node
  check_credentials
  sync_agent
  service_info

  holder=$(port_holder)
  if [ -n "$holder" ] && [ "$holder" != "$SVC_PID" ]; then
    red "✗ Port ${PORT} is held by pid ${holder}, which launchd did not start."
    dim  "  Probably a foreground ./start.sh — stop it (Ctrl-C), then run ./start.sh ${mode} again."
    exit 1
  fi

  if [ "$SVC_LOADED" = 1 ] && [ "$PLIST_CHANGED" = 1 ]; then
    # launchd reads the plist when the job is bootstrapped, never after.
    old_pid="$SVC_PID"
    unload_agent
    launchctl bootstrap "$DOMAIN" "$PLIST_DST"
  elif [ "$SVC_LOADED" = 1 ] && [ -n "$SVC_PID" ]; then
    if [ "$mode" = start ]; then
      green "✓ Already running (pid ${SVC_PID}) — ./start.sh restart to reload it."
      wait_healthy
      return
    fi
    old_pid="$SVC_PID"
    launchctl kickstart -k "$SERVICE"
  elif [ "$SVC_LOADED" = 1 ]; then
    launchctl kickstart "$SERVICE"
  else
    launchctl bootstrap "$DOMAIN" "$PLIST_DST"
  fi
  wait_healthy "$old_pid"
}

cmd_stop() {
  require_launchd
  service_info
  if [ "$SVC_LOADED" = 0 ]; then
    yellow "! The LaunchAgent is not loaded."
  else
    unload_agent
    local i=0
    while [ -n "$(port_holder)" ] && [ "$i" -lt 10 ]; do sleep 1; i=$((i + 1)); done
    green "✓ Stopped. It loads again at your next login; ./start.sh start brings it back now."
  fi
  local holder
  holder=$(port_holder)
  if [ -n "$holder" ]; then
    yellow "! Port ${PORT} is still held by pid ${holder} — a foreground ./start.sh? Stop it with Ctrl-C or kill ${holder}."
  fi
}

# Prints the report and returns 0 healthy, 1 down, 2 up but needs attention.
cmd_status() {
  local rc=0 holder summary health_rc elapsed started newest line
  service_info
  holder=$(port_holder)

  bold "GitHub Monitor · ${URL}"

  if [ "$SVC_LOADED" = 0 ]; then
    if command -v launchctl >/dev/null 2>&1; then
      printf '  %-9s %s\n' launchd "not loaded — ./start.sh start"
    fi
  elif [ -n "$SVC_PID" ]; then
    line="running · pid ${SVC_PID}"
    elapsed=$(ps -o etime= -p "$SVC_PID" 2>/dev/null || true)
    [ -n "${elapsed// /}" ] && line="${line} · up ${elapsed// /}"
    [ -n "$SVC_RUNS" ] && line="${line} · ${SVC_RUNS} start(s) this login"
    [ -n "$SVC_LAST_EXIT" ] && line="${line} · last exit ${SVC_LAST_EXIT}"
    printf '  %-9s %s\n' launchd "$line"
  else
    printf '  %-9s %s\n' launchd "loaded, not running (${SVC_STATE:-unknown}; last exit ${SVC_LAST_EXIT:-none}) — launchd retries every 60s"
    rc=1
  fi
  if [ -n "$SVC_DIR" ] && [ "$SVC_DIR" != "$ROOT" ]; then
    printf '  %-9s %s\n' checkout "! the agent runs ${SVC_DIR}, not this checkout"
    [ "$rc" = 0 ] && rc=2
  fi
  if [ -n "$holder" ] && [ "$holder" != "$SVC_PID" ]; then
    printf '  %-9s %s\n' port "! ${PORT} is served by pid ${holder}, outside launchd (foreground run?)"
    [ "$rc" = 0 ] && rc=2
    SVC_PID="$holder"
  fi

  set +e
  summary=$(health_json | health_summary)
  health_rc=$?
  set -e
  if [ "$health_rc" = 0 ]; then
    printf '  %-9s %s\n' health "$summary"
  elif [ "$health_rc" = 3 ]; then
    printf '  %-9s %s\n' health "! $summary"
    [ "$rc" = 0 ] && rc=2
  else
    printf '  %-9s %s\n' health "✗ nothing answers on 127.0.0.1:${PORT}"
    rc=1
  fi

  if [ -n "$SVC_PID" ]; then
    elapsed=$(ps -o etime= -p "$SVC_PID" 2>/dev/null || true)
    if [ -n "${elapsed// /}" ]; then
      started=$(( $(date +%s) - $(etime_seconds "$elapsed") ))
      newest=$(code_mtime)
      if [ "$newest" -gt $((started + 1)) ]; then
        printf '  %-9s %s\n' code "! server.js or .env changed after the server started — ./start.sh restart"
        [ "$rc" = 0 ] && rc=2
      else
        line="running what is on disk"
        if command -v git >/dev/null 2>&1 && git rev-parse --short HEAD >/dev/null 2>&1; then
          line="${line} ($(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD))"
        fi
        printf '  %-9s %s\n' code "$line"
      fi
    fi
  fi

  line="$LOG"
  case "$line" in "$HOME"/*) line="~${line#"$HOME"}" ;; esac
  printf '  %-9s %s\n' log "$line"
  if [ -f "$LOG" ]; then
    # Only this run's errors: everything before the latest startup banner
    # belongs to a process that is already gone.
    tail -n 2000 "$LOG" \
      | awk '/GitHub Monitor dashboard:/ { run = "" } { run = run $0 "\n" } END { printf "%s", run }' \
      | grep -iE 'error|failed|not permitted|✗' | tail -n 3 | sed 's/^/            /' || true
  fi
  return "$rc"
}

cmd_monitor() {
  local interval="${1:-10}"
  case "$interval" in ''|*[!0-9]*|0) red "✗ monitor takes a whole number of seconds"; exit 64 ;; esac
  trap 'echo; exit 0' INT TERM
  while true; do
    printf '\033[H\033[2J'
    cmd_status || true
    echo
    dim "$(date '+%H:%M:%S') · refreshing every ${interval}s · Ctrl-C to exit"
    sleep "$interval"
  done
}

cmd_logs() {
  if [ ! -f "$LOG" ]; then
    red "✗ No log yet at ${LOG} — it appears once the LaunchAgent has run."
    exit 1
  fi
  exec tail -n 50 -F "$LOG"
}

case "${1:-run}" in
  run)          cmd_run ;;
  start)        launch start ;;
  restart)      launch restart ;;
  stop)         cmd_stop ;;
  status)       cmd_status ;;
  monitor)      cmd_monitor "${2:-10}" ;;
  logs)         cmd_logs ;;
  -h|--help|help) usage ;;
  *)            usage >&2; exit 64 ;;
esac
