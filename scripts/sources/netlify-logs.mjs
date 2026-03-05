import { join } from "path"
import { loadJSON, autoSkip } from "../lib/state.mjs"

const NOISE_PATHS = [
  /^\/\.well-known\//,
  /^\/\.?appspec\.(yaml|yml)$/,
  /^\/\.?appveyor\.yml$/,
  /^\/\.env$/,
  /^\/wp-admin/,
  /^\/wp-login/,
  /^\/\.git\//,
  /^\/xmlrpc\.php$/,
  /^\/_next\/static\/chunks\//,
  /^\/senior-school\//,
]

function isNetlifyNoise(entry) {
  if (entry.status === 499) return { noise: true, reason: "499 client closed connection" }

  const path = entry.path || ""
  for (const pattern of NOISE_PATHS) {
    if (pattern.test(path)) return { noise: true, reason: `Path matches noise: ${pattern}` }
  }

  return { noise: false, reason: "" }
}

function netlifyId(path) {
  return `netlify-404-${path.replace(/^\/|\/$/g, "").replace(/\//g, "-").toLowerCase()}`
}

export function fetchNetlifyLogs({ stateDir, actedOn, cycleTimestamp }) {
  const logs = loadJSON(join(stateDir, "netlify-logs.json"), [])

  const byPath = {}
  for (const entry of logs) {
    const path = entry.path || ""
    if (!(path in byPath)) {
      byPath[path] = { ...entry, hit_count: 1 }
    } else {
      byPath[path].hit_count = (byPath[path].hit_count || 1) + 1
    }
  }

  const candidates = []
  let skipped = 0

  for (const [path, entry] of Object.entries(byPath)) {
    const itemId = netlifyId(path)
    if (itemId in actedOn) continue

    const { noise, reason } = isNetlifyNoise(entry)
    if (noise) {
      autoSkip(actedOn, itemId, reason, cycleTimestamp)
      skipped++
      console.error(`  AUTO-SKIP ${itemId}: ${reason}`)
      continue
    }

    candidates.push({
      id: itemId,
      source: "netlify-logs",
      title: `${entry.status || "?"} on ${path}`,
      timestamp: entry.timestamp || "",
      path,
      status: entry.status || 0,
      hit_count: entry.hit_count || 1,
    })
  }

  return { candidates, skipped }
}
