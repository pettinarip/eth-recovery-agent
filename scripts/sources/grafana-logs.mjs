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
