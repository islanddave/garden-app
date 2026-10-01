/**
 * src/__tests__/routeClass.slotLandsOn.test.jsx
 *
 * SLOT_LANDS_ON (src/lib/routeClass.js) is a HAND-KEPT map: a tab-bar slot whose route only redirects
 * opens the page it redirects to, so THAT page must carry the tab header (no Back arrow). Today it has
 * one entry, /settings → /settings/notifications, and TopChrome.barRoot.test.jsx renders that one
 * redirect. Nothing failed if a SECOND More row's `to` became a redirect: the slot would open a page
 * with a Back arrow on it — the /harvests and /put-up regression again — with every test green.
 *
 * THE SWEEP. Every enabled More row is opened the way a tap on its slot opens it: the REAL <App /> —
 * its real route table (renderRoutes), real pages, real shell — is rendered at the row's `to`, and the
 * pathname it settles on must be the row's `to`, or the row's SLOT_LANDS_ON entry when it has one.
 * Both directions: a row that redirects with no entry reds, and an entry for a row that no longer
 * redirects reds. Nothing here restates the map; the landing is read off the router.
 *
 * WHAT IT CANNOT SEE. Identity and the network are stubbed (signed in; every read answers nothing), so
 * a page that redirects only AFTER data arrives is not exercised. A route-table redirect, a page that
 * is a <Navigate>, and a redirect in a mount effect all are.
 *
 * KILLING MUTATION: empty SLOT_LANDS_ON. RESULT: RED — settings lands on /settings/notifications.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup, waitFor } from '@testing-library/react'

// The seam authRenderGate.test.jsx uses: the app's own auth context, driven directly, and the one
// token-bearing fetch. Both objects are module-level singletons — a fresh identity per render re-runs
// every effect that depends on them.
const SIGNEDIN = { user: { id: 'user_dave' }, profile: { id: 'user_dave', display_name: 'Dave', avatar_url: null }, loading: false, identity: 'signed-in' }
vi.mock('../context/AuthContext.jsx', async (importOriginal) => ({
  ...(await importOriginal()),
  useAuth: () => SIGNEDIN,
  useAuthOptional: () => SIGNEDIN,
  AuthProvider: ({ children }) => children,
}))
// Critters reads Clerk directly (useCritterCollection, CritterOfDay), outside the app's context.
const CLERK = { isLoaded: true, isSignedIn: true, getToken: () => Promise.resolve(null) }
vi.mock('@clerk/react', async (importOriginal) => ({
  ...(await importOriginal()),
  useAuth: () => CLERK,
}))
const API = { fetch: () => Promise.resolve(null), getToken: () => Promise.resolve(null) }
vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useApiFetch: () => API,
}))

const { default: App } = await import('../App.jsx')
const { MORE_ROWS, rowEnabled } = await import('../lib/moreRegistry.js')
const { SLOT_LANDS_ON } = await import('../lib/routeClass.js')

// What is on screen while a page has NOT mounted: Protected's skeleton, a split route's chunk still
// loading, or an error boundary's fallback (App.jsx RouteFallback / AppFallback).
const WAITING = '[data-testid="route-skeleton"], [data-testid="route-chunk-fallback"]'
const CRASHED = ['This page failed to load.', 'Something went wrong loading this page.']

// Open `path` in the real app and say where it settled. `mounted` is false when an error boundary is
// showing instead of the page — a page that threw may have thrown before it could redirect, so its
// landing proves nothing.
async function land(path) {
  window.history.replaceState({}, '', path)
  let view
  await act(async () => { view = render(<App />) })
  await waitFor(() => expect(document.querySelector(WAITING), path).toBeNull())
  // Two more turns of the event loop: a redirect issued from a mount effect, or from the first
  // (empty) answer of a read, has been committed by then.
  for (let i = 0; i < 2; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  const text = document.body.textContent
  const out = {
    landed: window.location.pathname,
    mounted: !!document.querySelector('nav[aria-label="Main navigation"]') && !CRASHED.some(c => text.includes(c)),
  }
  view.unmount()
  cleanup()
  return out
}

beforeEach(() => {
  try { sessionStorage.clear(); localStorage.clear() } catch { /* unavailable */ }
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in this suite'))))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

describe('SLOT_LANDS_ON — a More row on the bar opens the page the map says it opens', () => {
  const rows = MORE_ROWS.filter(r => rowEnabled(r) && typeof r.to === 'string')

  // The probe, proved against a redirect that has nothing to do with the map: /sow is a legacy door
  // that replaces itself with /seeds (LegacySeedsRedirect). A probe that always answered the path it
  // was given would red here.
  it('SELF-TEST: the probe sees a redirect, and sees a page that stays put', async () => {
    expect(await land('/sow')).toEqual({ landed: '/seeds', mounted: true })
    expect(await land('/about')).toEqual({ landed: '/about', mounted: true })
  })

  it('SWEEP: every enabled More row lands on its `to`, or on its SLOT_LANDS_ON entry', async () => {
    expect(rows.length).toBeGreaterThanOrEqual(16)
    const seen = []
    for (const row of rows) seen.push({ id: row.id, ...(await land(row.to)) })

    expect(seen.filter(s => !s.mounted).map(s => s.id), 'pages that did not mount — their landing is unknown').toEqual([])
    expect(seen.map(s => `${s.id} → ${s.landed}`))
      .toEqual(rows.map(r => `${r.id} → ${Object.hasOwn(SLOT_LANDS_ON, r.to) ? SLOT_LANDS_ON[r.to] : r.to}`))
  })
})
