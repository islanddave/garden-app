// V5-SEEDSTAB-001 — /sow and /seeds/saved are REPLACE redirects into the one Seeds page.
//
// Driven through App.jsx's REAL route table (renderRoutes) in a real MemoryRouter (routerHarness),
// so what is under test is the redirect as the app registers it — the path, the Protected wrapper
// and the `view` each row passes — not a hand-built <Route> that could agree with
// LegacySeedsRedirect.jsx while App.jsx drifted. Only the pages at either end are stubbed: the claim
// is where the URL lands and what the back stack holds, and the real Seeds page would drag its data
// hooks into a test about routing.
//
// REPLACE IS PINNED TWO WAYS. currentNavigationType() reads the router's own record of the landing
// (the observable routerHarness recommends). The Back case is the consequence Dave would feel: a
// pushed redirect leaves [today, /sow, /seeds], so one Back lands on /sow, which pushes forward to
// /seeds again and Back never escapes the page. Unlike the self-healing case routerHarness warns
// about, that Back is NOT vacuous here — under a push the location ends on /seeds, never on /today.
//
// MEASURED (2026-09-18), each mutation of the shipped source then restored byte-identical:
//   `replace` dropped from the <Navigate>        -> 4 red: both REPLACE and both Back cases
//   `rest.delete('view')` dropped                -> 2 red: the stray-view cases
//   `location.search` not passed to the builder  -> 3 red: the three carry cases
//   SEEDS_VIEWS 'sow' renamed                    -> 1 red: only the accepts-the-view case
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { Routes } from 'react-router-dom'

// Provider-free, the App.collectionSplit.test.jsx shape: Protected only needs useAuth, and the real
// AuthProvider would drag Clerk into a routing test.
vi.mock('../context/AuthContext.jsx', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => ({ user: { id: 'u' }, loading: false }),
  useAuthOptional: () => ({ user: { id: 'u' }, loading: false }),
}))
vi.mock('../pages/Today.jsx', () => ({ default: () => <div data-testid="today-page" /> }))
vi.mock('../pages/Seeds.jsx', () => ({ default: () => <div data-testid="seeds-page" /> }))

import { renderRoutes } from '../App.jsx'
import { legacySeedsSearch } from '../components/LegacySeedsRedirect.jsx'
import { resolveView } from '../lib/seedsRoutes.js'
import {
  renderWithRouter, navigateTo, currentLocation, currentParams, currentNavigationType, resetRouterHarness,
} from './helpers/routerHarness.jsx'

beforeEach(resetRouterHarness)

const mountApp = (route = '/today') => renderWithRouter(
  <Routes>{renderRoutes({ overlay: false, user: { id: 'u' }, loading: false })}</Routes>,
  { route },
)
const at = () => ({ pathname: currentLocation().pathname, search: currentLocation().search })

describe('the legacy URLs land on the Seeds page', () => {
  it('/sow, pushed from Today, lands on /seeds?view=sow', async () => {
    await mountApp('/today')
    // Control: the real /today row rendered, so the route table is live in this harness.
    expect(screen.getByTestId('today-page')).toBeTruthy()
    await navigateTo('/sow')
    expect(at()).toEqual({ pathname: '/seeds', search: '?view=sow' })
    expect(screen.getByTestId('seeds-page')).toBeTruthy()
    expect(screen.queryByTestId('today-page')).toBeNull()
  })

  it('/seeds/saved, pushed from Today, lands on /seeds?view=saved', async () => {
    await mountApp('/today')
    await navigateTo('/seeds/saved')
    expect(at()).toEqual({ pathname: '/seeds', search: '?view=saved' })
    expect(screen.getByTestId('seeds-page')).toBeTruthy()
  })

  // The `view` each row passes is a bare string in App.jsx. If SEEDS_VIEWS were ever renamed, the
  // search pins above would stay green while the page read the view as null and fell back to its
  // default — landing on the wrong view with nothing red. This ties the two ends together.
  it('each redirect names a view the Seeds page actually accepts', async () => {
    await mountApp('/sow')
    expect(resolveView(currentParams().get('view'))).toBe('sow')
    await navigateTo('/seeds/saved')
    expect(resolveView(currentParams().get('view'))).toBe('saved')
  })

  it('carries the rest of the old query string: /sow?x=1 -> ?view=sow&x=1', async () => {
    await mountApp('/today')
    await navigateTo('/sow?x=1')
    expect(at()).toEqual({ pathname: '/seeds', search: '?view=sow&x=1' })
  })

  it('carries a lot arrival hint through /seeds/saved?lot=7', async () => {
    await mountApp('/today')
    await navigateTo('/seeds/saved?lot=7')
    expect(at()).toEqual({ pathname: '/seeds', search: '?view=saved&lot=7' })
  })

  it('a stray view= on the old URL cannot outvote the door it came through', async () => {
    await mountApp('/today')
    await navigateTo('/sow?view=mine&x=1')
    expect(at()).toEqual({ pathname: '/seeds', search: '?view=sow&x=1' })
  })

  it('a cold start on the old URL (a bookmark, a restored tab) lands the same way', async () => {
    await mountApp('/seeds/saved')
    expect(at()).toEqual({ pathname: '/seeds', search: '?view=saved' })
    expect(screen.getByTestId('seeds-page')).toBeTruthy()
  })
})

// Two tests per URL rather than one, so each observable is proved red on its own: in a single test
// the REPLACE assertion fails first and hides whether the Back assertion would have caught it too.
describe('the redirect REPLACES — one Back leaves the Seeds page', () => {
  for (const [legacy, search] of [['/sow', '?view=sow'], ['/seeds/saved', '?view=saved']]) {
    it(`${legacy}: the router records the landing as a REPLACE, not a PUSH`, async () => {
      await mountApp('/today')
      await navigateTo(legacy)
      expect(at()).toEqual({ pathname: '/seeds', search })
      expect(currentNavigationType()).toBe('REPLACE')
    })

    it(`${legacy}: one Back from Seeds returns to /today, not to ${legacy}`, async () => {
      await mountApp('/today')
      await navigateTo(legacy)
      expect(at()).toEqual({ pathname: '/seeds', search })

      await navigateTo(-1)
      expect(at()).toEqual({ pathname: '/today', search: '' })
      expect(screen.getByTestId('today-page')).toBeTruthy()

      // The old entry is GONE, not skipped: Forward from Today reaches Seeds directly.
      await navigateTo(1)
      expect(at()).toEqual({ pathname: '/seeds', search })
      expect(currentNavigationType()).toBe('POP')
    })
  }
})

describe('legacySeedsSearch — the query the redirect writes', () => {
  it('names the view alone when the old URL had no query', () => {
    expect(legacySeedsSearch('sow', '')).toBe('?view=sow')
    expect(legacySeedsSearch('saved', '')).toBe('?view=saved')
  })

  it('puts view FIRST and carries every other param in order', () => {
    expect(legacySeedsSearch('sow', '?x=1&lot=7')).toBe('?view=sow&x=1&lot=7')
  })

  // Seeds reads the FIRST view= (URLSearchParams.get). Setting view first is half of the guarantee;
  // deleting every inherited view= is the other half, or `?view=sow&view=mine` would still be sow
  // only by accident of order.
  it('drops every stray view= so the page reads only the door it came through', () => {
    const out = legacySeedsSearch('saved', '?view=mine&lot=3&view=sow')
    expect(out).toBe('?view=saved&lot=3')
    expect(new URLSearchParams(out).getAll('view')).toEqual(['saved'])
  })

  it('carried values survive re-encoding — an encoded & cannot split a param', () => {
    const p = new URLSearchParams(legacySeedsSearch('sow', '?q=a%20b%26c&lot=7'))
    expect([...p.keys()]).toEqual(['view', 'q', 'lot'])
    expect(p.get('q')).toBe('a b&c')
    expect(p.get('lot')).toBe('7')
  })
})
