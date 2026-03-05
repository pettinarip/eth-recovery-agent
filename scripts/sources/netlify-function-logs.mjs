import { join } from "path"
import { readFileSync, existsSync } from "fs"
import { createNetlifyAPI } from "../lib/api.mjs"
import { autoSkip } from "../lib/state.mjs"

const NOISE_PATTERNS = [
  /NEXT_NOT_FOUND/,
  /NEXT_REDIRECT/,
]

function functionLogId(entry) {
  const msg = (entry.message || "").replace(/["'].+?["']/g, '"x"').replace(/\d+/g, "N").slice(0, 80)
  const slug = msg.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()
  return `netlify-fn-${slug || "unknown"}`
}

function isFunctionLogNoise(entry) {
  const msg = entry.message || ""
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(msg)) return { noise: true, reason: `Message matches noise: ${pattern}` }
  }
  return { noise: false, reason: "" }
}

function parseLogFile(stateDir) {
  const filePath = join(stateDir, "netlify-function-logs.txt")
  if (!existsSync(filePath)) return []

  const raw = readFileSync(filePath, "utf-8").trim()
  if (!raw) return []

  const entryRegex = /^([A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}:\d{2} [AP]M): (\S+) (ERROR|WARN) {1,2}(.*)$/
  const entries = []
  let current = null

  for (const line of raw.split("\n")) {
    const match = line.match(entryRegex)
    if (match) {
      if (current) entries.push(current)
      current = {
        level: match[3],
        message: match[4],
        stack: "",
        request_id: match[2],
        timestamp: match[1],
        function_name: "",
      }
    } else if (current) {
      current.stack += (current.stack ? "\n" : "") + line
    }
  }
  if (current) entries.push(current)

  return entries
}

async function fetchLiveApiLogs({ authToken, siteId }) {
  const netlifyAPI = createNetlifyAPI(authToken)
  const res = await netlifyAPI(`sites/${siteId}/functions`)
  const functions = res?.functions || []
  if (functions.length === 0) {
    console.error("  No Netlify functions found")
    return []
  }

  console.error(`  Found ${functions.length} Netlify functions`)

  const allLogs = []
  const COLLECT_TIMEOUT_MS = 10_000

  for (const fn of functions) {
    const { a: accountId, oid: functionId, n: functionName } = fn
    if (!functionId || !accountId) continue

    try {
      const logs = await collectFunctionLogs({
        functionId,
        accountId,
        functionName,
        siteId,
        authToken,
        timeoutMs: COLLECT_TIMEOUT_MS,
      })
      allLogs.push(...logs)
    } catch (e) {
      console.error(`  WebSocket error for ${functionName}: ${e.message}`)
    }
  }

  return allLogs
}

function collectFunctionLogs({ functionId, accountId, functionName, siteId, authToken, timeoutMs }) {
  return new Promise((resolve) => {
    const logs = []
    const ws = new WebSocket("wss://socketeer.services.netlify.com/function/logs")

    const timeout = setTimeout(() => {
      ws.close()
      resolve(logs)
    }, timeoutMs)

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        function_id: functionId,
        site_id: siteId,
        access_token: authToken,
        account_id: accountId,
      }))
    })

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data)
        const level = (data.level || "").toUpperCase()
        if (level === "ERROR" || level === "WARN") {
          logs.push({
            level,
            message: data.message || "",
            stack: data.stack || "",
            request_id: data.request_id || "",
            timestamp: data.ts || new Date().toISOString(),
            function_name: functionName,
          })
        }
      } catch {
        // skip unparseable messages
      }
    })

    ws.addEventListener("error", () => {
      clearTimeout(timeout)
      resolve(logs)
    })

    ws.addEventListener("close", () => {
      clearTimeout(timeout)
      resolve(logs)
    })
  })
}

export async function fetchNetlifyFunctionLogs({ stateDir, authToken, siteId, actedOn, cycleTimestamp }) {
  let apiLogs = []
  if (!authToken || !siteId) {
    console.error("  NETLIFY_AUTH_TOKEN or NETLIFY_SITE_ID not set, skipping live API fetch")
  } else {
    apiLogs = await fetchLiveApiLogs({ authToken, siteId })
    console.error(`  Live API: ${apiLogs.length} error/warn entries`)
  }

  const fileLogs = parseLogFile(stateDir)
  if (fileLogs.length > 0) {
    console.error(`  Log file: ${fileLogs.length} error/warn entries`)
  }

  const logs = [...apiLogs, ...fileLogs]
  console.error(`Netlify function logs: ${logs.length} total entries`)

  const bySignature = {}
  for (const entry of logs) {
    const itemId = functionLogId(entry)
    if (!(itemId in bySignature)) {
      bySignature[itemId] = { ...entry, hit_count: 1 }
    } else {
      bySignature[itemId].hit_count = (bySignature[itemId].hit_count || 1) + 1
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
      source: "netlify-function-logs",
      title: `[${entry.level || "ERROR"}] ${entry.message || "Unknown error"}`,
      timestamp: entry.timestamp || "",
      level: entry.level || "ERROR",
      message: entry.message || "",
      stack: entry.stack || "",
      request_id: entry.request_id || "",
      hit_count: entry.hit_count || 1,
    })
  }

  return { candidates, skipped }
}
