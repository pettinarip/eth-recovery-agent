#!/usr/bin/env node

/**
 * Crawls ethereum.org (English locale only) and detects broken resources.
 *
 * Phase 1: spider-rs crawls all HTML pages at native speed.
 * Phase 2: Parses each page and HEAD-checks all embedded resources
 *          (images, scripts, styles, etc.) concurrently with deduplication.
 *
 * Usage: node scripts/crawl.mjs [url]
 *   url defaults to https://ethereum.org/
 */

import { Website } from "@spider-rs/spider-rs"
import { parse } from "node-html-parser"
import { writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_DIR = join(__dirname, "..", "state")
const OUTPUT_FILE = join(STATE_DIR, "crawler-findings.json")
const PAGES_FILE = join(STATE_DIR, "crawler-pages.json")
const LOG_FILE = join(STATE_DIR, "crawler-errors.log")

const TARGET_URL = process.argv[2] || "https://ethereum.org/"
const HEAD_CONCURRENCY = 50

// All ethereum.org locale prefixes except English (which has no prefix)
const LOCALE_PREFIXES = [
  "ar", "az", "bg", "bn", "ca", "cs", "da", "de", "el", "es", "fa", "fi",
  "fr", "gl", "gu", "ha", "he", "hi", "hr", "hu", "id", "ig", "it", "ja",
  "ka", "kk", "km", "kn", "ko", "lt", "ml", "mr", "ms", "nb", "nl", "pcm",
  "ph", "pl", "pt", "pt-br", "ro", "ru", "se", "sk", "sl", "sr", "sw", "ta",
  "te", "th", "tk", "tr", "uk", "ur", "uz", "vi", "yo", "zh", "zh-tw",
]

const blacklistPatterns = LOCALE_PREFIXES.map(
  (locale) => `/${locale}(/|$)`
)

// --- Helpers ---

const ETHEREUM_ORIGIN = "https://ethereum.org"

/** Returns true if the URL is an ethereum.org page under a non-English locale */
function isBlacklistedLocale(url) {
  try {
    const u = new URL(url)
    if (u.origin !== ETHEREUM_ORIGIN) return false
    const firstSegment = u.pathname.split("/")[1]
    return LOCALE_PREFIXES.includes(firstSegment)
  } catch {
    return false
  }
}

/**
 * For _next/image proxy URLs, extract the underlying source image URL.
 * This avoids false positives: the proxy requires browser headers but
 * the real question is whether the source image exists.
 * For all other URLs, returns them unchanged.
 */
function resolveImageProxyUrl(url) {
  try {
    const u = new URL(url)
    if (u.pathname === "/_next/image/" || u.pathname === "/_next/image") {
      const src = u.searchParams.get("url")
      if (src) return new URL(src, u.origin).href
    }
    return url
  } catch {
    return url
  }
}

// --- Resource extraction ---

const RESOURCE_SELECTORS = [
  { sel: "img[src]", attr: "src" },
  { sel: "img[srcset]", attr: "srcset" },
  { sel: "script[src]", attr: "src" },
  { sel: 'link[rel="stylesheet"][href]', attr: "href" },
  { sel: 'link[rel="icon"][href]', attr: "href" },
  { sel: 'link[rel="preload"][href]', attr: "href" },
  { sel: "source[src]", attr: "src" },
  { sel: "source[srcset]", attr: "srcset" },
  { sel: "video[src]", attr: "src" },
  { sel: "video[poster]", attr: "poster" },
  { sel: "audio[src]", attr: "src" },
]

function extractResourceUrls(html, pageUrl) {
  const root = parse(html)
  const urls = new Set()

  for (const { sel, attr } of RESOURCE_SELECTORS) {
    for (const el of root.querySelectorAll(sel)) {
      const raw = el.getAttribute(attr)
      if (!raw) continue

      const values =
        attr === "srcset"
          ? raw.split(",").map((s) => s.trim().split(/\s+/)[0])
          : [raw]

      for (const v of values) {
        if (!v || v.startsWith("data:") || v.startsWith("blob:") || v.startsWith("mailto:")) continue
        try {
          urls.add(new URL(v, pageUrl).href)
        } catch {
          // malformed URL
        }
      }
    }
  }

  return [...urls]
}

// --- Concurrent HEAD checker with dedup ---

// Maps resource URL -> Promise<number> (status code)
const checkCache = new Map()
let inflightCount = 0

const MAX_RETRIES = 3

function headersForUrl(url) {
  const h = {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "*/*",
  }
  try {
    if (new URL(url).origin === ETHEREUM_ORIGIN) {
      h["Referer"] = "https://ethereum.org/"
    }
  } catch {}
  return h
}

function checkResource(url) {
  if (checkCache.has(url)) return checkCache.get(url)

  const promise = (async () => {
    // Simple semaphore
    while (inflightCount >= HEAD_CONCURRENCY) {
      await new Promise((r) => setTimeout(r, 10))
    }
    inflightCount++
    try {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 1000 * attempt))
        }
        try {
          const res = await fetch(url, {
            method: "HEAD",
            redirect: "follow",
            signal: AbortSignal.timeout(15000),
            headers: headersForUrl(url),
          })
          return res.status
        } catch {
          // Retry with GET on last HEAD attempt, then retry loop continues
          try {
            const res = await fetch(url, {
              method: "GET",
              redirect: "follow",
              signal: AbortSignal.timeout(15000),
              headers: headersForUrl(url),
            })
            return res.status
          } catch {
            // Will retry if attempts remain
          }
        }
      }
      return 0
    } finally {
      inflightCount--
    }
  })()

  checkCache.set(url, promise)
  return promise
}

// --- Main ---

const errors = []
const logLines = []
let pagesScanned = 0

function logLine(msg) {
  const ts = new Date().toISOString()
  return `[${ts}] ${msg}`
}

function statusLabel(code) {
  if (code === 0) return "FAILED"
  if (code === 404) return "NOT_FOUND"
  if (code >= 500) return "SERVER_ERROR"
  return `HTTP_${code}`
}

console.log(`Crawling ${TARGET_URL} (English locale only)...`)
console.log(`Blacklisting ${LOCALE_PREFIXES.length} locale prefixes\n`)

// Phase 1: Crawl pages with spider-rs
const website = new Website(TARGET_URL)
  .withBlacklistUrl(blacklistPatterns)
  .withBudget({ "*": 2000 })
  .withDepth(5)
  .withRespectRobotsTxt(true)
  .withRequestTimeout(30000)
  .build()

const pages = []

const onPageEvent = (_err, page) => {
  pagesScanned++
  const { url, statusCode, content } = page

  if (pagesScanned % 100 === 0) {
    console.log(`  [crawl] ${pagesScanned} pages...`)
  }

  // Page-level errors
  if (_err || statusCode >= 400 || statusCode === 0) {
    const code = statusCode || 0
    const label = statusLabel(code)
    errors.push({
      id: `crawler-${label.toLowerCase()}-${url}`,
      url,
      statusCode: code,
      foundOnPage: url,
      resourceType: "page",
      error: label.toLowerCase(),
      label,
      title: `${label} (${code}): ${url}`,
      timestamp: new Date().toISOString(),
    })
    logLines.push(logLine(`${label} [${code}] ${url}`))
    console.log(`  ✗ page ${code} ${url}`)
    return
  }

  if (content && content.includes("<")) {
    pages.push({ url, content })
  }
}

console.log("Phase 1: Crawling pages...")
try {
  await website.crawl(onPageEvent)
} catch (err) {
  console.error("Crawl failed:", err)
  process.exit(1)
}
console.log(`  ${pagesScanned} pages crawled.\n`)

// Phase 2: Extract and check all embedded resources
console.log("Phase 2: Checking embedded resources...")

// Build a map of checkable URL -> { originalUrls (Set), pages[] }
// For _next/image URLs we resolve to the underlying source image for checking.
// This deduplicates across different widths/qualities of the same source.
const resourceToPages = new Map()

for (const { url: pageUrl, content } of pages) {
  const resourceUrls = extractResourceUrls(content, pageUrl)
  for (const resUrl of resourceUrls) {
    if (isBlacklistedLocale(resUrl)) continue
    const checkUrl = resolveImageProxyUrl(resUrl)
    if (!resourceToPages.has(checkUrl)) {
      resourceToPages.set(checkUrl, { originalUrls: new Set(), pages: [] })
    }
    const entry = resourceToPages.get(checkUrl)
    entry.originalUrls.add(resUrl)
    entry.pages.push(pageUrl)
  }
}

const uniqueResources = [...resourceToPages.entries()]
console.log(`  ${uniqueResources.length} unique resources to check across ${pages.length} pages`)

// Fire off all checks concurrently (semaphore limits inflight)
const allChecks = uniqueResources.map(async ([checkUrl, { originalUrls }]) => {
  const status = await checkResource(checkUrl)
  return { checkUrl, originalUrls, status }
})

let checked = 0
for (const promise of allChecks) {
  const { checkUrl, originalUrls, status } = await promise
  checked++

  if (checked % 200 === 0) {
    console.log(`  [check] ${checked}/${uniqueResources.length}...`)
  }

  if (status >= 400 || status === 0) {
    const label = statusLabel(status)
    const foundOn = resourceToPages.get(checkUrl).pages
    // Report the URL we actually checked (the resolved source, not the proxy)
    errors.push({
      id: `crawler-${label.toLowerCase()}-${checkUrl}`,
      url: checkUrl,
      statusCode: status,
      foundOnPages: foundOn,
      originalUrls: [...originalUrls],
      resourceType: "resource",
      error: label.toLowerCase(),
      label,
      title: `${label} (${status}): ${checkUrl}`,
      timestamp: new Date().toISOString(),
    })
    logLines.push(logLine(`${label} [${status}] ${checkUrl} (on ${foundOn.length} page(s))`))
    console.log(`  ✗ ${status} ${checkUrl}`)
    console.log(`    └─ found on ${foundOn.length} page(s): ${foundOn[0]}${foundOn.length > 1 ? ` (+${foundOn.length - 1} more)` : ""}`)
  }
}

// Write results
mkdirSync(STATE_DIR, { recursive: true })

const crawledPages = pages.map(({ url }) => url).sort()
writeFileSync(PAGES_FILE, JSON.stringify(crawledPages, null, 2))
writeFileSync(OUTPUT_FILE, JSON.stringify(errors, null, 2))
writeFileSync(LOG_FILE, logLines.join("\n") + "\n")

console.log(`\nDone.`)
console.log(`  Pages crawled:      ${pagesScanned}`)
console.log(`  Resources checked:  ${uniqueResources.length}`)
console.log(`  Errors found:       ${errors.length}`)
console.log(`  Pages:   ${PAGES_FILE}`)
console.log(`  Errors:  ${OUTPUT_FILE}`)
console.log(`  Log:     ${LOG_FILE}`)
