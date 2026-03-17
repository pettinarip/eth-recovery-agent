#!/usr/bin/env node
/**
 * Deterministic triage for the recovery agent.
 *
 * Fetches issues from all enabled sources, filters noise, deduplicates
 * against acted-on.json, and writes an ordered queue of items to process.
 *
 * Noise items are auto-skipped (written to acted-on.json) without LLM involvement.
 */

import { join } from "path"
import { loadJSON, saveJSON } from "./lib/state.mjs"
import { sanitizeItem } from "./lib/sanitize.mjs"
import { fetchSentry } from "./sources/sentry.mjs"
import { fetchGrafanaLogs } from "./sources/grafana-logs.mjs"
import { fetchCrawlerFindings } from "./sources/crawler.mjs"

const STATE_DIR = process.env.STATE_DIR
const CYCLE_TIMESTAMP = process.env.CYCLE_TIMESTAMP
const ENABLED_SOURCES = (process.env.ENABLED_SOURCES || "sentry,grafana-logs,crawler").split(",")

if (!STATE_DIR) {
  console.error("STATE_DIR is required")
  process.exit(1)
}
if (!CYCLE_TIMESTAMP) {
  console.error("CYCLE_TIMESTAMP is required")
  process.exit(1)
}

const ACTED_ON_TTL_DAYS = 30

function pruneActedOn(actedOn) {
  const cutoff = Date.now() - ACTED_ON_TTL_DAYS * 24 * 60 * 60 * 1000
  let pruned = 0
  for (const [id, entry] of Object.entries(actedOn)) {
    const ts = Date.parse(entry.timestamp)
    if (!ts || ts < cutoff) {
      delete actedOn[id]
      pruned++
    }
  }
  return pruned
}

async function main() {
  const actedOnPath = join(STATE_DIR, "acted-on.json")
  const actedOn = loadJSON(actedOnPath, {})

  const pruned = pruneActedOn(actedOn)
  if (pruned > 0) {
    console.error(`Pruned ${pruned} acted-on entries older than ${ACTED_ON_TTL_DAYS} days`)
  }

  let allCandidates = []
  let totalSkipped = 0

  const sources = {
    sentry: () => fetchSentry({
      authToken: process.env.SENTRY_AUTH_TOKEN || "",
      org: process.env.SENTRY_ORG || "ethereumorg-ow",
      project: process.env.SENTRY_PROJECT || "ethorg",
      actedOn,
      cycleTimestamp: CYCLE_TIMESTAMP,
    }),
    "grafana-logs": () => fetchGrafanaLogs({
      grafanaUrl: process.env.GRAFANA_URL || "",
      grafanaToken: process.env.GRAFANA_TOKEN || "",
      datasourceUid: process.env.GRAFANA_DATASOURCE_UID || "",
      actedOn,
      cycleTimestamp: CYCLE_TIMESTAMP,
    }),
    crawler: () => fetchCrawlerFindings({
      stateDir: STATE_DIR,
      actedOn,
    }),
  }

  for (const name of ENABLED_SOURCES) {
    const fetch = sources[name]
    if (!fetch) {
      console.error(`Unknown source: ${name}`)
      continue
    }
    const { candidates, skipped } = await fetch()
    allCandidates.push(...candidates)
    totalSkipped += skipped
  }

  if (totalSkipped > 0 || pruned > 0) {
    saveJSON(actedOnPath, actedOn)
    if (totalSkipped > 0) console.error(`Auto-skipped ${totalSkipped} noise items`)
  }

  allCandidates.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")))

  // Sanitize all items before writing to queue (prompt injection mitigation)
  const sanitized = allCandidates.map(sanitizeItem)

  saveJSON(join(STATE_DIR, "triage-queue.json"), sanitized)

  console.error(`Queue: ${allCandidates.length} items to process`)
  if (allCandidates.length > 0) {
    console.error(`Next: ${allCandidates[0].id} (${allCandidates[0].source})`)
  }
}

main().catch((e) => {
  console.error(`Triage failed: ${e.message}`)
  process.exit(1)
})
