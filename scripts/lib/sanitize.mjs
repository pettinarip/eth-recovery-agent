/**
 * Sanitizes triage queue items to mitigate prompt injection.
 *
 * Attacker-controlled strings (Sentry issue titles, error messages, stack traces,
 * URL paths) flow into the LLM system prompt via the triage queue. This module
 * strips patterns that could be interpreted as instructions by the model.
 */

// Patterns that look like prompt injection attempts
const INJECTION_PATTERNS = [
  // Direct instruction patterns
  /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/gi,
  /\b(you are|act as|pretend|roleplay|behave as|switch to|new role|system prompt)/gi,
  // System/assistant/user message delimiters
  /<\s*\/?(?:system|assistant|user|human|prompt|instruction)[^>]*>/gi,
  // Markdown heading injection (could look like system prompt sections)
  /^#{1,3}\s+(system|instructions?|rules?|mode|identity|role)\b/gim,
  // Common jailbreak fragments
  /\bDAN\b.*\bdo anything now\b/gi,
  /\bjailbreak/gi,
  /\bdev(?:eloper)?\s*mode/gi,
]

// Max length for any single string field (prevents context stuffing)
const MAX_FIELD_LENGTH = 2000

/**
 * Sanitize a single string value.
 * Replaces injection-like patterns with [REDACTED] and truncates.
 */
function sanitizeString(value) {
  if (typeof value !== "string") return value

  let cleaned = value
  for (const pattern of INJECTION_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0
    cleaned = cleaned.replace(pattern, "[REDACTED]")
  }

  if (cleaned.length > MAX_FIELD_LENGTH) {
    cleaned = cleaned.slice(0, MAX_FIELD_LENGTH) + "... [truncated]"
  }

  return cleaned
}

/**
 * Sanitize all string fields in a triage queue item.
 * Returns a new object with sanitized values (does not mutate input).
 */
export function sanitizeItem(item) {
  const sanitized = {}
  for (const [key, value] of Object.entries(item)) {
    sanitized[key] = sanitizeString(value)
  }
  return sanitized
}
