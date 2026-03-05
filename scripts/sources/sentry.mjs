import { autoSkip } from "../lib/state.mjs"
import { createSentryAPI } from "../lib/api.mjs"

const NOISE_STACK_PATTERNS = [
  /chrome-extension:\/\//,
  /moz-extension:\/\//,
  /safari-extension:\/\//,
  /inpage\.js/,
  /injectedScript\.bundle\.js/,
  /extensionServiceWorker\.js/,
  /content-?script\.js/,
]

const NOISE_TITLE_PATTERNS = [
  /Failed to fetch.*ingesteer\.services-prod\.nsvcs\.net/i,
  /Failed to connect to MetaMask/i,
  /feature named .+ was not found/i,
  /DApp request timeout/i,
  /disconnected port/i,
]

const NOISE_MESSAGE_PATTERNS = [
  /keepAlive/i,
  /invalid origin/i,
  /^Load failed$/i,
]

function hasAppCodeInStack(event) {
  if (!event) return true

  const frames = []
  for (const entry of event.entries || []) {
    if (entry.type === "exception") {
      for (const val of entry.data?.values || []) {
        frames.push(...(val.stacktrace?.frames || []))
      }
    }
  }

  if (frames.length === 0) return false

  for (const frame of frames) {
    const filename = frame.filename || frame.absPath || ""
    if (!filename || filename === "<anonymous>" || filename === "[native code]") continue
    if (filename.startsWith("undefined")) continue
    if (NOISE_STACK_PATTERNS.some((p) => p.test(filename))) continue
    if (
      filename.includes("node_modules/@sentry") ||
      filename.includes("node_modules/@sentry-internal") ||
      filename.includes(".netlify/scripts/")
    )
      continue
    return true
  }

  return false
}

function isSentryNoise(issue, event) {
  const title = issue.title || ""

  for (const pattern of NOISE_TITLE_PATTERNS) {
    if (pattern.test(title)) return { noise: true, reason: `Title matches noise: ${pattern}` }
  }

  if (event) {
    for (const entry of event.entries || []) {
      if (entry.type === "exception") {
        for (const val of entry.data?.values || []) {
          const msg = val.value || ""
          for (const pattern of NOISE_MESSAGE_PATTERNS) {
            if (pattern.test(msg))
              return { noise: true, reason: `Exception message matches noise: ${pattern}` }
          }
        }
      }
    }

    if (!hasAppCodeInStack(event)) {
      return { noise: true, reason: "No application code in stack trace" }
    }
  }

  return { noise: false, reason: "" }
}

export async function fetchSentry({ authToken, org, project, actedOn, cycleTimestamp }) {
  if (!authToken) {
    console.error("WARNING: SENTRY_AUTH_TOKEN not set, skipping Sentry source")
    return { candidates: [], skipped: 0 }
  }

  const sentryAPI = createSentryAPI(authToken)
  const q = encodeURIComponent("is:unresolved lastSeen:-24h")
  const issues = (await sentryAPI(
    `projects/${org}/${project}/issues/?query=${q}&sort=date&limit=100`
  )) || []
  console.error(`Sentry: ${issues.length} unresolved issues from last 24h`)

  const candidates = []
  let skipped = 0

  for (const issue of issues) {
    const shortId = issue.shortId || ""
    if (shortId in actedOn) {
      console.error(`  ALREADY-SEEN ${shortId}: ${actedOn[shortId].action}`)
      continue
    }

    const event = await sentryAPI(`issues/${issue.id}/events/latest/`)
    const { noise, reason } = isSentryNoise(issue, event)

    if (noise) {
      autoSkip(actedOn, shortId, reason, cycleTimestamp)
      skipped++
      console.error(`  AUTO-SKIP ${shortId}: ${reason}`)
      continue
    }

    candidates.push({
      id: shortId,
      source: "sentry",
      title: issue.title || "",
      timestamp: issue.firstSeen || "",
      last_seen: issue.lastSeen || "",
      event_count: issue.count || 0,
    })
  }

  return { candidates, skipped }
}
