// API prefix → Lambda routing table.
// Owner: Dave. Change requires staging smoke of affected route.
//
// Resolution is FIRST-MATCH on insertion order — Object.entries preserves
// declaration order. Longer / more-specific prefixes MUST be declared BEFORE
// their shorter parents (e.g., '/api/projects/inactive' precedes '/api/projects').
//
// Prefix → Lambda env var → purpose
//   /api/projects/inactive  → VITE_API_DASHBOARD     dashboard footer / inactive surface (S3)
//   /api/projects           → VITE_API_PROJECTS      projects CRUD
//   /api/plants             → VITE_API_PLANTS        plants CRUD
//   /api/locations          → VITE_API_LOCATIONS     locations CRUD
//   /api/notifications      → VITE_API_EVENTS        web-push subscribe (Lambda 2.2.x)
//   /api/events             → VITE_API_EVENTS        events CRUD
//   /api/favorites          → VITE_API_FAVORITES     favorites toggle
//   /api/photos             → VITE_API_PHOTOS        photo upload/list
//   /api/dashboard          → VITE_API_DASHBOARD     dashboard composite
//   /api/inventory-items    → VITE_API_INVENTORY     inventory CRUD
//   /api/varieties          → VITE_API_VARIETIES     variety reference data
//   /api/achievements       → VITE_API_ACHIEVEMENTS  achievements list
//   /api/ux-events          → VITE_API_UX_EVENTS     UX success-metric sink (Inc 0; admin-read + telemetry write)
//   /api/shared-state       → VITE_API_SHARED_STATE  shared-garden reward substrate (V3-REWARDSTATE-001)
//   /api/findings           → VITE_API_FINDINGS      DRG care findings read model (DRG-TAB-001)
//   /api/daily-plan         → VITE_API_DAILY_PLAN_READ  Daily Plan read model — Today surface (DRG-TODAY-002)

import { useAuth } from '@clerk/react'
import { useCallback } from 'react'

const FUNCTION_URLS = {
  '/api/projects/inactive': import.meta.env.VITE_API_DASHBOARD     ?? '',
  '/api/projects':          import.meta.env.VITE_API_PROJECTS      ?? '',
  '/api/plants':            import.meta.env.VITE_API_PLANTS        ?? '',
  '/api/locations':         import.meta.env.VITE_API_LOCATIONS     ?? '',
  '/api/notifications':     import.meta.env.VITE_API_EVENTS        ?? '',
  '/api/events':            import.meta.env.VITE_API_EVENTS        ?? '',
  '/api/favorites':         import.meta.env.VITE_API_FAVORITES     ?? '',
  '/api/photos':            import.meta.env.VITE_API_PHOTOS        ?? '',
  '/api/dashboard':         import.meta.env.VITE_API_DASHBOARD     ?? '',
  '/api/inventory-items':   import.meta.env.VITE_API_INVENTORY     ?? '',
  '/api/varieties':         import.meta.env.VITE_API_VARIETIES     ?? '',
  '/api/achievements':      import.meta.env.VITE_API_ACHIEVEMENTS  ?? '',
  '/api/ux-events':         import.meta.env.VITE_API_UX_EVENTS     ?? '',
  '/api/shared-state':      import.meta.env.VITE_API_SHARED_STATE  ?? '',
  '/api/findings':          import.meta.env.VITE_API_FINDINGS      ?? '',
  '/api/daily-plan':        import.meta.env.VITE_API_DAILY_PLAN_READ ?? '',
}

export function resolveUrl(path, urls = FUNCTION_URLS) {
  for (const [prefix, base] of Object.entries(urls)) {
    if (path.startsWith(prefix)) return `${base.replace(/\/$/, '')}${path}`
  }
  throw new Error(`No Lambda URL configured for path: ${path}`)
}

export async function apiFetch(path, options = {}, token) {
  const url = resolveUrl(path)
  const headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, { ...options, headers })
  if (!res.ok) {
    let errBody
    try { errBody = await res.json() } catch { errBody = { error: res.statusText } }
    const e = new Error(errBody?.error ?? `HTTP ${res.status}`)
    e.status = res.status
    e.body = errBody
    throw e
  }
  if (res.status === 204) return null
  return res.json()
}

export function useApiFetch() {
  const { getToken } = useAuth()
  const fetch = useCallback(async (path, options = {}) => {
    const token = await getToken()
    return apiFetch(path, options, token)
  }, [getToken])
  // getToken is also returned so fire-and-forget telemetry (uxEvents) can route token
  // acquisition through this same seam — component tests mock useApiFetch, which keeps
  // the Clerk dependency out of every consumer's test.
  return { fetch, getToken }
}
