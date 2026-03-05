export function createSentryAPI(authToken) {
  return async function sentryAPI(endpoint) {
    const url = `https://sentry.io/api/0/${endpoint}`
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        console.error(`  Sentry API error: ${res.status} ${res.statusText} for ${endpoint}`)
        return null
      }
      return await res.json()
    } catch (e) {
      console.error(`  Sentry API error: ${e.message} for ${endpoint}`)
      return null
    }
  }
}

export function createNetlifyAPI(authToken) {
  return async function netlifyAPI(endpoint) {
    const url = `https://api.netlify.com/api/v1/${endpoint}`
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        console.error(`  Netlify API error: ${res.status} ${res.statusText} for ${endpoint}`)
        return null
      }
      return await res.json()
    } catch (e) {
      console.error(`  Netlify API error: ${e.message} for ${endpoint}`)
      return null
    }
  }
}
