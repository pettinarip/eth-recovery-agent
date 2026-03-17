---
title: "feat: Replace Netlify function log fetchers with Grafana"
type: feat
status: completed
date: 2026-03-16
---

# Replace Netlify function log fetchers with Grafana

Replace the two Netlify log sources (`netlify-logs` and `netlify-function-logs`) with a single Grafana source that queries WARN/ERROR function logs via the managed Grafana instance (Elasticsearch-backed).

## Acceptance Criteria

- [x] New source module `scripts/sources/grafana-logs.mjs` queries Grafana's `POST /api/ds/query` endpoint for WARN+ERROR logs from the last hour
- [x] New API helper `createGrafanaAPI()` added to `scripts/lib/api.mjs` (follows existing Sentry/Netlify pattern: Bearer auth, 30s timeout, fail-fast)
- [x] `netlify-logs.mjs` deleted entirely (no more HTTP 404 source)
- [x] `netlify-function-logs.mjs` deleted entirely (WebSocket + file parsing replaced by Grafana)
- [x] `triage.mjs` updated: imports `grafana-logs`, registers as `"grafana-logs"` source, removes both netlify imports
- [x] `check-incidents.sh` updated: new env vars (`GRAFANA_URL`, `GRAFANA_TOKEN`, `GRAFANA_DATASOURCE_UID`), remove `NETLIFY_AUTH_TOKEN`/`NETLIFY_SITE_ID` exports, update `ENABLED_SOURCES` default
- [x] `.env.example` updated with Grafana credentials (remove Netlify ones)
- [x] Candidate output shape matches what downstream expects: `{ id, source, title, timestamp, level, message, stack, request_id, hit_count }`
- [x] Existing noise filters (`NEXT_NOT_FOUND`, `NEXT_REDIRECT`) and signature-based dedup (`functionLogId`) preserved
- [x] `system-prompt.md` updated to describe Grafana log items instead of Netlify function logs

## Context

**Current state:** Two Netlify sources exist — `netlify-logs` (reads static JSON of HTTP 404s) and `netlify-function-logs` (WebSocket to Netlify + manual txt file parsing). The function logs source already filters to WARN/ERROR only.

**Grafana setup:** DevOps provides a managed Grafana instance with Elasticsearch-style log ingest. Auth is via service account tokens (`glsa_...`). Logs are queried through `POST /api/ds/query` using Lucene query syntax against an Elasticsearch datasource.

**What stays the same:** Noise filtering, signature-based dedup, candidate shape, triage orchestration, cron schedule.

**Discovery needed before implementation:** The exact Elasticsearch field names (`level` vs `log.level`, `@timestamp` vs `timestamp`, `message` vs `line`) must be confirmed by inspecting the Grafana Explore view or browser DevTools on a real query. The datasource UID must be obtained from the Grafana admin UI or `GET /api/datasources`.

## MVP

### scripts/lib/api.mjs — add `createGrafanaAPI`

```js
export function createGrafanaAPI(baseUrl, token) {
  return async function grafanaAPI(endpoint, { method = "GET", body } = {}) {
    const url = `${baseUrl}/api/${endpoint}`
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        console.error(`  Grafana API error: ${res.status} ${res.statusText} for ${endpoint}`)
        return null
      }
      return await res.json()
    } catch (e) {
      console.error(`  Grafana API error: ${e.message} for ${endpoint}`)
      return null
    }
  }
}
```

### scripts/sources/grafana-logs.mjs — new source module

```js
import { createGrafanaAPI } from "../lib/api.mjs"
import { autoSkip } from "../lib/state.mjs"

const NOISE_PATTERNS = [/NEXT_NOT_FOUND/, /NEXT_REDIRECT/]

function grafanaLogId(entry) {
  const msg = (entry.message || "").replace(/["'].+?["']/g, '"x"').replace(/\d+/g, "N").slice(0, 80)
  const slug = msg.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()
  return `grafana-fn-${slug || "unknown"}`
}

function isFunctionLogNoise(entry) {
  const msg = entry.message || ""
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(msg)) return { noise: true, reason: `Message matches noise: ${pattern}` }
  }
  return { noise: false, reason: "" }
}

function parseFrames(frames) {
  const logs = []
  for (const frame of frames) {
    const fieldNames = frame.schema.fields.map((f) => f.name)
    const columns = frame.data.values
    const rowCount = columns[0]?.length ?? 0
    for (let i = 0; i < rowCount; i++) {
      const row = {}
      for (let col = 0; col < fieldNames.length; col++) {
        row[fieldNames[col]] = columns[col][i]
      }
      logs.push(row)
    }
  }
  return logs
}

export async function fetchGrafanaLogs({
  grafanaUrl, grafanaToken, datasourceUid,
  // These field names may need adjustment after inspecting the actual Grafana instance
  timeField = "@timestamp", levelField = "level", messageField = "message",
  actedOn, cycleTimestamp,
}) {
  if (!grafanaUrl || !grafanaToken || !datasourceUid) {
    console.error("  GRAFANA_URL, GRAFANA_TOKEN, or GRAFANA_DATASOURCE_UID not set, skipping")
    return { candidates: [], skipped: 0 }
  }

  const grafanaAPI = createGrafanaAPI(grafanaUrl, grafanaToken)
  const result = await grafanaAPI("ds/query", {
    method: "POST",
    body: {
      queries: [{
        refId: "A",
        datasource: { type: "elasticsearch", uid: datasourceUid },
        query: `${levelField}:WARN OR ${levelField}:ERROR`,
        timeField,
        metrics: [{ id: "1", type: "logs" }],
        bucketAggs: [],
        maxDataPoints: 500,
        intervalMs: 1000,
      }],
      from: "now-1h",
      to: "now",
    },
  })

  if (!result?.results?.A?.frames) {
    console.error("  Grafana: no frames in response")
    return { candidates: [], skipped: 0 }
  }

  const rawLogs = parseFrames(result.results.A.frames)
  console.error(`  Grafana: ${rawLogs.length} WARN/ERROR entries from last hour`)

  // Normalize field names (adjust mapping after discovery)
  const logs = rawLogs.map((row) => ({
    level: (row[levelField] || row.level || "ERROR").toUpperCase(),
    message: row[messageField] || row.line || row.Message || "",
    stack: row.stack || row.stacktrace || "",
    request_id: row.request_id || row.trace_id || "",
    timestamp: row[timeField] || "",
    function_name: row.function_name || row.service || "",
  }))

  // Dedup by signature
  const bySignature = {}
  for (const entry of logs) {
    const itemId = grafanaLogId(entry)
    if (!(itemId in bySignature)) {
      bySignature[itemId] = { ...entry, hit_count: 1 }
    } else {
      bySignature[itemId].hit_count += 1
    }
  }

  const candidates = []
  let skipped = 0

  for (const [itemId, entry] of Object.entries(bySignature)) {
    if (itemId in actedOn) continue

    const { noise, reason } = isFunctionLogNoise(entry)
    if (noise) {
      autoSkip(actedOn, itemId, reason, cycleTimestamp)
      skipped++
      console.error(`  AUTO-SKIP ${itemId}: ${reason}`)
      continue
    }

    candidates.push({
      id: itemId,
      source: "grafana-logs",
      title: `[${entry.level}] ${entry.message || "Unknown error"}`,
      timestamp: entry.timestamp || "",
      level: entry.level,
      message: entry.message || "",
      stack: entry.stack || "",
      request_id: entry.request_id || "",
      hit_count: entry.hit_count || 1,
    })
  }

  return { candidates, skipped }
}
```

### triage.mjs — update imports and source map

```js
// Remove:
// import { fetchNetlifyLogs } from "./sources/netlify-logs.mjs"
// import { fetchNetlifyFunctionLogs } from "./sources/netlify-function-logs.mjs"

// Add:
import { fetchGrafanaLogs } from "./sources/grafana-logs.mjs"

// In sources map, replace both netlify entries with:
"grafana-logs": () => fetchGrafanaLogs({
  grafanaUrl: process.env.GRAFANA_URL || "",
  grafanaToken: process.env.GRAFANA_TOKEN || "",
  datasourceUid: process.env.GRAFANA_DATASOURCE_UID || "",
  actedOn,
  cycleTimestamp: CYCLE_TIMESTAMP,
}),

// Update ENABLED_SOURCES default:
const ENABLED_SOURCES = (process.env.ENABLED_SOURCES || "sentry,grafana-logs,crawler").split(",")
```

### check-incidents.sh — update env vars

```bash
# Remove:
# export NETLIFY_AUTH_TOKEN="${NETLIFY_AUTH_TOKEN:-}"
# export NETLIFY_SITE_ID="${NETLIFY_SITE_ID:-}"

# Add:
export GRAFANA_URL="${GRAFANA_URL:-}"
export GRAFANA_TOKEN="${GRAFANA_TOKEN:-}"
export GRAFANA_DATASOURCE_UID="${GRAFANA_DATASOURCE_UID:-}"

# Update ENABLED_SOURCES default:
export ENABLED_SOURCES="${ENABLED_SOURCES:-sentry,grafana-logs,crawler}"
```

### .env.example — update credentials

```env
# Grafana service account token (glsa_...)
# Ask devops for access to the managed Grafana instance
GRAFANA_URL=
GRAFANA_TOKEN=
# Elasticsearch datasource UID — find via Grafana UI or GET /api/datasources
GRAFANA_DATASOURCE_UID=
```

### Files to delete

- `scripts/sources/netlify-logs.mjs`
- `scripts/sources/netlify-function-logs.mjs`

## Sources

- Grafana DS Query API: `POST /api/ds/query` — unified datasource query endpoint
- Grafana Service Accounts: `glsa_*` tokens with Viewer role for query access
- Elasticsearch Lucene syntax for level filtering: `level:WARN OR level:ERROR`
- Response format: columnar data frames (`schema.fields` + `data.values` zipped by index)
- DevOps context: managed Grafana with elastic-style log ingest, GlitchTip (Sentry-compatible) also available but not ready yet
