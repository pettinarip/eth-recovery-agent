#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR=~/recovery-agent

# Load secrets from .env if present
if [[ -f "$AGENT_DIR/.env" ]]; then
  set -a
  source "$AGENT_DIR/.env"
  set +a
fi

LOGFILE="$AGENT_DIR/agent.log"
STATE_DIR="$AGENT_DIR/state"
REPO_DIR="$AGENT_DIR/repo"
LOCKFILE="$AGENT_DIR/.agent.lock"

# ── Concurrency guard ──
# Prevent overlapping cron runs. flock exits immediately if lock is held.
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "$(date -Iseconds) Another cycle is still running. Skipping." >> "$LOGFILE"
  exit 0
fi
# Lock is held for the lifetime of this process (fd 9 stays open).

# Sentry project config (change these per-repo)
export SENTRY_ORG="ethereumorg-ow"
export SENTRY_PROJECT="ethorg"

# Grafana config (for function log fetching)
export GRAFANA_URL="${GRAFANA_URL:-}"
export GRAFANA_TOKEN="${GRAFANA_TOKEN:-}"
export GRAFANA_DATASOURCE_UID="${GRAFANA_DATASOURCE_UID:-}"

# Trigger.dev config (for data layer task monitoring)
export TRIGGER_DEV_API_KEY="${TRIGGER_DEV_API_KEY:-}"
export TRIGGER_DEV_PROJECT_REF="${TRIGGER_DEV_PROJECT_REF:-}"

# Discord webhook for notifications
export DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"

# Error sources to enable (comma-separated: sentry,grafana-logs,crawler,trigger-dev)
export ENABLED_SOURCES="${ENABLED_SOURCES:-sentry,grafana-logs,crawler,trigger-dev}"

# Kill switch
if [[ "${RECOVERY_AGENT_ENABLED:-true}" != "true" ]]; then
  echo "$(date -Iseconds) Agent disabled via RECOVERY_AGENT_ENABLED" >> "$LOGFILE"
  exit 0
fi

# Validate repo exists
if [[ ! -d "$REPO_DIR" ]]; then
  echo "$(date -Iseconds) ERROR: Repo not found at $REPO_DIR" >> "$LOGFILE"
  exit 1
fi

# Read the agent instructions (injected as system prompt overlay)
AGENT_PROMPT=$(cat "$AGENT_DIR/system-prompt.md")

export STATE_DIR

cleanup() {
  echo "$(date -Iseconds) Agent interrupted." >> "$LOGFILE"
  exit 1
}
trap cleanup INT TERM

# Build allowed tools list based on enabled sources
ALLOWED_TOOLS=("Bash()" "Read()" "Write()" "Edit()" "Glob()" "Grep()")
if [[ "$ENABLED_SOURCES" == *"sentry"* ]]; then
  ALLOWED_TOOLS+=("mcp__sentry()")
fi
if [[ "$ENABLED_SOURCES" == *"trigger-dev"* ]]; then
  ALLOWED_TOOLS+=("mcp__trigger()")
fi

echo "$(date -Iseconds) === Cycle start (sources: $ENABLED_SOURCES) ===" >> "$LOGFILE"

# ── Phase 1: Deterministic triage (no LLM) ──
export CYCLE_TIMESTAMP
CYCLE_TIMESTAMP="$(date -Iseconds)"

echo "$(date -Iseconds) Running triage..." >> "$LOGFILE"
node "$AGENT_DIR/scripts/triage.mjs" 2>> "$LOGFILE"

QUEUE_FILE="$STATE_DIR/triage-queue.json"
QUEUE_LEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$QUEUE_FILE','utf-8')).length)")

if [[ "$QUEUE_LEN" == "0" ]]; then
  echo "$(date -Iseconds) Queue empty after triage. Done." >> "$LOGFILE"
  echo "$(date -Iseconds) === Cycle end ===" >> "$LOGFILE"
  exit 0
fi

echo "$(date -Iseconds) Triage complete: $QUEUE_LEN items queued" >> "$LOGFILE"

# ── Phase 2: Process items one by one (LLM per item) ──
while true; do
  CYCLE_TIMESTAMP="$(date -Iseconds)"
  export CYCLE_TIMESTAMP

  QUEUE_LEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$QUEUE_FILE','utf-8')).length)")
  if [[ "$QUEUE_LEN" == "0" ]]; then
    echo "$(date -Iseconds) Queue empty. Done." >> "$LOGFILE"
    break
  fi

  echo "$(date -Iseconds) $QUEUE_LEN items in queue. Processing next..." >> "$LOGFILE"

  cd "$REPO_DIR"
  claude -p "Process the next item from the triage queue. State directory: $STATE_DIR" \
    --append-system-prompt "$AGENT_PROMPT" \
    --allowedTools "${ALLOWED_TOOLS[@]}" \
    --disallowedTools "Bash(git push --force:*)" "Bash(git push -f:*)" \
    --add-dir "$STATE_DIR" \
    >> "$LOGFILE" 2>&1

  # Send Discord notification if the agent created a PR or issue
  node "$AGENT_DIR/scripts/notify-discord.mjs" 2>> "$LOGFILE" || true
done

echo "$(date -Iseconds) === Cycle end ===" >> "$LOGFILE"
