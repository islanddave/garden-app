// sharedStateClient — read/write the shared-garden reward substrate (V3-REWARDSTATE-001).
// Lambda: VITE_API_SHARED_STATE (garden-shared-state); workspace-shared; auth required.
// House pattern (notificationPrefsClient.js / critterClient.js): await getToken -> Bearer,
// NEVER throws, returns null on no-op (env unset / no token) or any failure.

const BASE = (import.meta.env.VITE_API_SHARED_STATE ?? '').replace(/\/$/, '')

async function authedFetch(path, { getToken, method = 'GET', body = null } = {}) {
  if (!BASE) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const headers = { Authorization: `Bearer ${token}` }
    if (body != null) headers['Content-Type'] = 'application/json'
    const res = await fetch(`${BASE}${path}`, {
      method, headers, body: body != null ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) return null
    const json = await res.json().catch(() => null)
    return json && typeof json === 'object' ? json : null
  } catch {
    return null
  }
}

// GET featured-of-day -> { date, featured, updated_at } | null
export function getFeaturedOfDay({ getToken, date = null } = {}) {
  const q = date ? `?date=${encodeURIComponent(date)}` : ''
  return authedFetch(`/api/shared-state/featured-of-day${q}`, { getToken })
}

// PUT featured-of-day { date?, payload } -> { date, featured, updated_at } | null
export function putFeaturedOfDay({ getToken, payload, date = null } = {}) {
  if (payload === undefined || payload === null) return Promise.resolve(null)
  const body = { payload }
  if (date) body.date = date
  return authedFetch('/api/shared-state/featured-of-day', { getToken, method: 'PUT', body })
}

// V3-DELIGHT-001 D2 — shared household "sighting tally" natural_key. CONTRACT: this exact
// string is shared across THREE bundles — keep them in sync: this file (TallyDisplay read),
// lambda/events/critterAward.js (server-side increment on a genuine award), and the
// garden_shared_state incentive_counter rows. Changing it orphans the live counter.
export const TALLY_SIGHTINGS = 'tally:sightings'

// GET tally/{key} -> { natural_key, counter } | null   (D2-ready; unused by D1)
export function getTally({ getToken, key } = {}) {
  if (!key) return Promise.resolve(null)
  return authedFetch(`/api/shared-state/tally/${encodeURIComponent(key)}`, { getToken })
}

// POST tally/{key}/increment { by? } -> { natural_key, counter } | null   (D2-ready; unused by D1)
export function incrementTally({ getToken, key, by = 1 } = {}) {
  if (!key) return Promise.resolve(null)
  const body = Number.isInteger(by) && by > 0 ? { by } : {}
  return authedFetch(`/api/shared-state/tally/${encodeURIComponent(key)}/increment`, { getToken, method: 'POST', body })
}
