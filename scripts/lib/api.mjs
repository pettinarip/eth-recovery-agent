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

export function createGrafanaAPI(baseUrl, token, orgId) {
  return async function grafanaAPI(endpoint, { method = "GET", body } = {}) {
    const url = `${baseUrl}/api/${endpoint}`
    try {
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      }
      if (orgId) headers["X-Grafana-Org-Id"] = String(orgId)
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        console.error(`  Grafana API error: ${res.status} ${res.statusText} for ${endpoint}`)
        return null
      }
      return await res.json()
    } catch (e) {
      console.error(`  Grafana API error: ${e.message} for ${endpoint}`)
      return null
    }
  }
}
