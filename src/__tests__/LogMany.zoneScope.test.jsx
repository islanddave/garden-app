// V4-ZONEDECIDE-001 — LogMany's zone-scope resolution on mount, and the invariant underneath it:
// NO zone selected means NO filtering, never an empty batch.
//
// Three independent paths can seed a `space` scope before the user touches anything — a
// `?location_id=` deep link, a dismissed-while-dirty draft, and the `quicklog.lastScope` memory of
// the previous batch — and each carries its own `locs.some(...)` validation (LogMany.jsx:166, :188,
// :215). What they are guarding against is subtle and silent: a zone that has since been deleted,
// renamed away, or belongs to a different device's user leaves a location_id that resolves to
// nothing. `{type:'space', location_id:<dead id>}` is a perfectly valid batch request — the server
// accepts it and answers with an empty preview, so the screen reads "No plantings match this scope"
// on a garden of 221 live plantings. The user has picked no zone and is shown nothing.
//
// The fallback in all three cases is `{type:'all'}`, LogMany's initial state — everything, unfiltered.
// These cases pin that the validation exists on each path SEPARATELY (a mutation to one predicate
// leaves the other two green) and that a LIVE id still restores, so the guard is not satisfied by a
// seed that never works at all.
//
// ScopeChecklist is stubbed to echo the resolved `scope` prop, the same shape
// LogMany.reloadGateWire.test.jsx uses: the assertion is about which scope LogMany hands down, not
// about how the checklist renders it (that is scopeChecklist.test.jsx). The server side of the same
// invariant is lambda/events/logmany-zone-scope.test.js ("the 'all' branch is unconditionally
// true") and tests/integration/logmany-zone.int.test.js.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const navigate = vi.fn()
// STABLE module-scope instance, not a fresh one per call: LogMany's initial-load effect depends on
// the destructured `params`, so a new object every render reruns it forever.
let searchParams = new URLSearchParams()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, vi.fn()],
  Link: ({ children }) => children,
}))

const apiFetch = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch, getToken: vi.fn(async () => null) }) }))

vi.mock('../components/forms', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    ScopeChecklist: ({ scope }) => <div data-testid="stub-scope">{JSON.stringify(scope)}</div>,
  }
})

import LogMany from '../pages/LogMany.jsx'

const LIVE_ZONE = 'loc-pasture'
const DEAD_ZONE = 'loc-deleted-last-week'
const SCOPE_KEY = 'quicklog.lastScope'
const DRAFT_KEY = 'gardenApp.draft.logmany'

function wireApi() {
  apiFetch.mockImplementation((path) => {
    if (path === '/api/projects') return Promise.resolve([{ id: 'proj-1', name: 'Beds' }])
    // DEAD_ZONE is deliberately absent — this is what "the zone no longer resolves" looks like.
    if (path === '/api/locations') {
      return Promise.resolve({ locations: [{ id: LIVE_ZONE, name: 'Pasture', level: 0, parent_id: null }] })
    }
    return Promise.resolve(null)
  })
}

async function mountAndReadScope() {
  render(<LogMany />)
  await screen.findByText('Watered')
  await waitFor(() => expect(screen.getByTestId('stub-scope').textContent).not.toBe(''))
  return JSON.parse(screen.getByTestId('stub-scope').textContent)
}

const stashDraft = (scope) =>
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, data: { eventType: 'watering', scope } }))

describe('LogMany zone scope — an unresolvable zone falls back to ALL, never to an empty batch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    searchParams = new URLSearchParams()
    wireApi()
  })

  it('a bare mount with nothing remembered scopes to all — the default is unfiltered', async () => {
    expect(await mountAndReadScope()).toEqual({ type: 'all' })
  })

  it('a remembered zone that still exists is restored', async () => {
    // The control. Without it, every fallback case below is satisfied just as well by a restore path
    // that is broken outright.
    localStorage.setItem(SCOPE_KEY, JSON.stringify({ type: 'space', location_id: LIVE_ZONE }))
    expect(await mountAndReadScope()).toEqual({ type: 'space', location_id: LIVE_ZONE })
  })

  it('a remembered zone that no longer exists falls back to all', async () => {
    localStorage.setItem(SCOPE_KEY, JSON.stringify({ type: 'space', location_id: DEAD_ZONE }))
    expect(await mountAndReadScope()).toEqual({ type: 'all' })
  })

  it('a ?location_id= deep link to a live zone is honoured', async () => {
    searchParams = new URLSearchParams(`location_id=${LIVE_ZONE}`)
    expect(await mountAndReadScope()).toEqual({ type: 'space', location_id: LIVE_ZONE })
  })

  it('a ?location_id= deep link to a dead zone falls back to all', async () => {
    // The sharpest case in the file: a stale notification, bookmark or shared link is the one path
    // where the user did not choose this zone in this session at all, so an empty result has no
    // explanation on screen.
    searchParams = new URLSearchParams(`location_id=${DEAD_ZONE}`)
    expect(await mountAndReadScope()).toEqual({ type: 'all' })
  })

  it('a stashed draft carrying a live zone is restored', async () => {
    stashDraft({ type: 'space', location_id: LIVE_ZONE })
    expect(await mountAndReadScope()).toEqual({ type: 'space', location_id: LIVE_ZONE })
  })

  it('a stashed draft carrying a dead zone falls back to all', async () => {
    // Separate predicate from the localStorage one (LogMany.jsx:188 vs :215) and separate storage —
    // a mutation to either alone leaves the other green, which is why both are asserted.
    stashDraft({ type: 'space', location_id: DEAD_ZONE })
    expect(await mountAndReadScope()).toEqual({ type: 'all' })
  })

  it('a dead remembered zone does not fall through to a project scope either', async () => {
    // "Falls back" has to mean ALL specifically. Landing on the first project would also make the
    // preview non-empty while quietly logging a batch the user never scoped.
    localStorage.setItem(SCOPE_KEY, JSON.stringify({ type: 'space', location_id: DEAD_ZONE }))
    const scope = await mountAndReadScope()
    expect(scope.type).toBe('all')
    expect(scope.project_id).toBeUndefined()
    expect(scope.location_id).toBeUndefined()
  })
})
