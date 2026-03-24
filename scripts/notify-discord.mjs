/**
 * Post-processing Discord notifier.
 *
 * Reads the latest entry from analysis-output.json and sends a Discord
 * webhook notification if an action was taken (PR or issue).
 *
 * Usage:
 *   node scripts/notify-discord.mjs
 *
 * Env:
 *   DISCORD_WEBHOOK_URL — required, exits silently if not set
 *   STATE_DIR           — path to state directory
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL
if (!WEBHOOK_URL) process.exit(0)

const STATE_DIR = process.env.STATE_DIR
if (!STATE_DIR) {
  console.error("STATE_DIR not set")
  process.exit(1)
}

const outputFile = join(STATE_DIR, "analysis-output.json")
let entries
try {
  entries = JSON.parse(readFileSync(outputFile, "utf-8"))
} catch {
  process.exit(0) // file doesn't exist yet
}

if (!Array.isArray(entries) || entries.length === 0) process.exit(0)

const latest = entries[entries.length - 1]

// Only notify for actual actions (PR or issue), not skips
if (latest.action_taken === "skip" || !latest.action_ref) process.exit(0)

const isPR = latest.action_taken === "branch"
const color = isPR ? 0x238636 : 0xd29922
const label = isPR ? "Draft PR" : "Issue"

const embed = {
  title: `${isPR ? "\u{1F527}" : "\u{1F50D}"} New ${label}`,
  description: latest.title,
  url: latest.action_ref,
  color,
  fields: [
    { name: "Source", value: latest.source || "unknown", inline: true },
    { name: "Confidence", value: latest.confidence || "—", inline: true },
    { name: "Item ID", value: latest.item_id || "—", inline: true },
  ],
  footer: { text: "Recovery Agent" },
  timestamp: new Date().toISOString(),
}

if (latest.analysis) {
  const truncated =
    latest.analysis.length > 300
      ? latest.analysis.slice(0, 300) + "…"
      : latest.analysis
  embed.fields.push({ name: "Analysis", value: truncated })
}

try {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    console.error(`Discord webhook error: ${res.status} ${res.statusText}`)
    process.exit(1)
  }
  console.log(`Discord notification sent (${label}: ${latest.item_id})`)
} catch (e) {
  console.error(`Discord webhook error: ${e.message}`)
  process.exit(1)
}
