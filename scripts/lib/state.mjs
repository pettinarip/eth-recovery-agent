import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { dirname } from "path"

export function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return fallback
  }
}

export function saveJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n")
}

export function autoSkip(actedOn, itemId, reason, cycleTimestamp) {
  actedOn[itemId] = {
    action: "skip",
    timestamp: cycleTimestamp,
    confidence: "none",
    ref: null,
    auto_skipped: true,
    skip_reason: reason,
  }
}
