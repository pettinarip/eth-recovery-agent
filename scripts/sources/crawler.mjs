import { join } from "path"
import { loadJSON } from "../lib/state.mjs"

export function fetchCrawlerFindings({ stateDir, actedOn }) {
  const findings = loadJSON(join(stateDir, "crawler-findings.json"), [])
  const candidates = []

  for (const finding of findings) {
    const itemId = finding.id || ""
    if (!itemId || itemId in actedOn) continue

    const { id, title, timestamp, ...rest } = finding
    candidates.push({
      id: itemId,
      source: "crawler",
      title: title || "",
      timestamp: timestamp || "",
      ...rest,
    })
  }

  return { candidates, skipped: 0 }
}
