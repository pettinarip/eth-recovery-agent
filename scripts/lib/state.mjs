import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs"
import { dirname, join } from "path"
import { randomBytes } from "crypto"

export function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return fallback
  }
}

/**
 * Atomic JSON write: writes to a temp file in the same directory, then renames.
 * rename() is atomic on POSIX when src and dst are on the same filesystem.
 */
export function saveJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.tmp-${randomBytes(6).toString("hex")}`)
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n")
  renameSync(tmp, path)
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
