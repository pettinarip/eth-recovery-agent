import { createTriggerDevAPI } from "../lib/api.mjs"
import { autoSkip } from "../lib/state.mjs"

// Keep noise patterns minimal — Trigger.dev tasks are our own code,
// so most failures are worth investigating (unlike browser-side Sentry noise).
// Only skip truly transient network blips with a single occurrence.
const NOISE_PATTERNS = []

function triggerDevId(run) {
  const task = run.taskIdentifier || "unknown"
  const error = (run._errorMessage || "")
    .replace(/["'].+?["']/g, '"x"')
    .replace(/\d+/g, "N")
    .slice(0, 80)
  const slug = `${task}--${error}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()
  return `trigger-${slug || "unknown"}`
}

function isTriggerDevNoise(run) {
  const msg = run._errorMessage || ""
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(msg)) return { noise: true, reason: `Error matches noise: ${pattern}` }
  }
  return { noise: false, reason: "" }
}

const CONCURRENT_DETAIL_FETCHES = 5
const FAILURE_STATUSES = ["FAILED", "CRASHED", "SYSTEM_FAILURE"]

export async function fetchTriggerDev({
  apiKey, projectRef, environment = "prod",
  lookbackHours = 24, actedOn, cycleTimestamp,
}) {
  if (!apiKey || !projectRef) {
    console.error("Trigger.dev: not configured, skipping")
    return { candidates: [], skipped: 0 }
  }

  const api = createTriggerDevAPI(apiKey)

  // Fetch failed/crashed/system_failure runs from the lookback window
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString()
  let allRuns = []

  for (const status of FAILURE_STATUSES) {
    const params = new URLSearchParams({
      "filter[status]": status,
      "filter[createdAt.from]": since,
      "page[size]": "100",
    })
    const result = await api(`api/v1/runs?${params}`)
    if (result?.data) allRuns.push(...result.data)
  }

  console.error(`Trigger.dev: ${allRuns.length} failed runs from last ${lookbackHours}h`)

  // Fetch run details in parallel batches to get error info
  for (let i = 0; i < allRuns.length; i += CONCURRENT_DETAIL_FETCHES) {
    const batch = allRuns.slice(i, i + CONCURRENT_DETAIL_FETCHES)
    const details = await Promise.all(
      batch.map((run) => api(`api/v3/runs/${run.id}`))
    )
    for (let j = 0; j < batch.length; j++) {
      const detail = details[j]
      if (!detail) continue
      // Error lives at the top level of the run detail, not inside attempts
      batch[j]._errorMessage = detail.error?.message || ""
      batch[j]._errorStack = detail.error?.stackTrace || ""
      batch[j]._attempts = detail.attemptCount || 0
    }
  }

  const candidates = []
  let skipped = 0

  // Deduplicate by signature (same task + normalized error = one candidate)
  const bySignature = {}
  for (const run of allRuns) {
    const itemId = triggerDevId(run)
    if (!(itemId in bySignature)) {
      bySignature[itemId] = { ...run, _hitCount: 1 }
    } else {
      bySignature[itemId]._hitCount += 1
    }
  }

  let alreadySeen = 0
  for (const [itemId, run] of Object.entries(bySignature)) {
    if (itemId in actedOn) {
      alreadySeen++
      continue
    }

    const { noise, reason } = isTriggerDevNoise(run)
    if (noise) {
      autoSkip(actedOn, itemId, reason, cycleTimestamp)
      skipped++
      console.error(`  AUTO-SKIP ${itemId}: ${reason}`)
      continue
    }

    candidates.push({
      id: itemId,
      source: "trigger-dev",
      title: `[${run.status}] ${run.taskIdentifier}`,
      timestamp: run.createdAt || "",
      task: run.taskIdentifier || "",
      run_id: run.id || "",
      status: run.status || "",
      error_message: run._errorMessage || "",
      error_stack: run._errorStack || "",
      attempts: run._attempts || 0,
      failed_runs_24h: run._hitCount || 1,
      dashboard_url: `https://cloud.trigger.dev/projects/v3/${projectRef}/runs/${run.id}`,
    })
  }

  if (alreadySeen > 0) console.error(`  ${alreadySeen} already-seen`)

  return { candidates, skipped }
}
