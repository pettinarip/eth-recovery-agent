import { join } from "path"
import { loadJSON } from "../lib/state.mjs"

export function fetchCrawlerFindings({ stateDir, actedOn }) {
  const findings = loadJSON(join(stateDir, "crawler-findings.json"), [])
  const candidates = []
  let alreadySeen = 0

  for (const finding of findings) {
    const itemId = finding.id || ""
    if (!itemId) continue
    if (itemId in actedOn) {
      alreadySeen++
      continue
    }

    const { id, title, timestamp, ...rest } = finding
    candidates.push({
      id: itemId,
      source: "crawler",
      title: title || "",
      timestamp: timestamp || "",
      ...rest,
    })
  }

  if (findings.length > 0) {
    console.error(`Crawler: ${findings.length} findings${alreadySeen > 0 ? `, ${alreadySeen} already-seen` : ""}`)
  }

  return { candidates, skipped: 0 }
}
