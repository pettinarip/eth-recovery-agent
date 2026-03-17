# Recovery Agent

An automated system that monitors [ethereum.org](https://ethereum.org) for production errors and uses Claude Code CLI to analyze, triage, and fix them — or escalate when it can't.

Runs on a VPS with system crontab. No Docker, no framework, no public endpoints.

## How It Works

```
Error Sources                          Agent (VPS, cron every hour)
─────────────────                      ─────────────────────────────────
Sentry (ethereum.org)  ←── REST API ── triage.mjs (deterministic filtering)
Grafana (function logs)←── REST API ──         ↓
Crawler (daily)        ←── file ─────  claude -p (one item per invocation)
                                               ↓
                                       Local branch + PR doc / Issue doc / Skip
```

1. **Triage** (`scripts/triage.mjs`) — Orchestrates all enabled sources (Sentry, Grafana function logs, crawler). Each source module (`scripts/sources/`) handles its own fetching and noise filtering. The orchestrator deduplicates against `state/acted-on.json` and writes an ordered queue to `state/triage-queue.json`.

2. **Analysis** (`claude -p`) — For each queued item, a fully isolated Claude Code invocation analyzes the error against the full codebase. Classifies confidence as high, low, or none.

3. **Action** — Based on confidence:
   - **High**: Creates a local fix branch, commits the fix, writes a PR document to `state/actions/prs/`
   - **Low**: Writes an issue document to `state/actions/issues/`
   - **None**: Logs and skips

## Project Structure

```
recovery-agent/
├── system-prompt.md          # Agent behavior (injected via --append-system-prompt)
├── package.json              # Node config + npm scripts (triage, check)
├── scripts/
│   ├── check-incidents.sh    # Cron entry point — flock guard, triage, process queue
│   ├── triage.mjs            # Orchestrator — loads sources, sanitizes, writes queue
│   ├── lib/
│   │   ├── state.mjs         # loadJSON, saveJSON (atomic), autoSkip helpers
│   │   ├── api.mjs           # Sentry and Grafana API client factories
│   │   └── sanitize.mjs      # Prompt injection sanitization for queue items
│   └── sources/
│       ├── sentry.mjs        # Sentry issue fetching + noise detection
│       ├── grafana-logs.mjs  # Grafana function log fetching (WARN/ERROR) + noise
│       └── crawler.mjs       # Crawler findings (passthrough)
├── state/                    # Runtime state (gitignored except examples)
│   ├── acted-on.json         # Tracks processed items (dedup, 30-day TTL)
│   ├── analysis-output.json  # Analysis results log
│   └── triage-queue.json     # Current queue for claude to process
├── repo/                     # Git clone of ethereum-org-website
└── .env                      # Secrets (SENTRY_AUTH_TOKEN, GRAFANA_TOKEN, etc.)
```

## Setup

1. Clone this repo and the target website repo:
   ```bash
   git clone <this-repo> ~/recovery-agent
   git clone <ethereum-org-website> ~/recovery-agent/repo
   ```

2. Install Claude Code CLI:
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

3. Configure secrets:
   ```bash
   cp .env.example .env
   # Edit .env — add your SENTRY_AUTH_TOKEN
   # Also set ANTHROPIC_API_KEY in your environment
   ```

4. Add crontab entries:
   ```cron
   # Incident check — every hour
   0 * * * * ~/recovery-agent/scripts/check-incidents.sh

   # Cleanup merged agent branches — weekly
   0 0 * * 0 cd ~/recovery-agent/repo && git branch --merged origin/dev | grep 'recovery/' | xargs -r git branch -d
   ```

5. Run manually to test:
   ```bash
   ./scripts/check-incidents.sh
   ```

## Configuration

| Env Variable | Description | Default |
|---|---|---|
| `SENTRY_AUTH_TOKEN` | Sentry API token (scopes: `project:read`, `event:read`) | — |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude | — |
| `SENTRY_ORG` | Sentry organization slug | `ethereumorg-ow` |
| `SENTRY_PROJECT` | Sentry project slug | `ethorg` |
| `GRAFANA_URL` | Grafana instance base URL | — |
| `GRAFANA_TOKEN` | Grafana service account token (`glsa_...`) | — |
| `GRAFANA_DATASOURCE_UID` | Elasticsearch datasource UID in Grafana | — |
| `ENABLED_SOURCES` | Comma-separated sources to enable | `sentry,grafana-logs,crawler` |
| `RECOVERY_AGENT_ENABLED` | Kill switch — set to `false` to disable | `true` |

## Safety

- **Local simulation mode**: No `git push`, no GitHub API calls. All branches and documents stay local.
- **One item per invocation**: Each error gets its own isolated Claude session with full context budget.
- **Deterministic pre-filtering**: Noise is filtered before the LLM runs, saving cost and reducing false positives.
- **Concurrency guard**: `flock` prevents overlapping cron runs from corrupting state.
- **Atomic writes**: State files use write-to-tmp + rename to prevent partial writes on crash.
- **Prompt injection sanitization**: Attacker-controlled strings (error titles, stack traces) are scrubbed before reaching the LLM.
- **Acted-on pruning**: Entries older than 30 days are automatically pruned to prevent unbounded growth.
- **Kill switch**: Set `RECOVERY_AGENT_ENABLED=false` to stop all processing within one hour.

## Logs

All output is appended to `agent.log` in the project root.
