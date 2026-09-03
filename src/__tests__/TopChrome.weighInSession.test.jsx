// V5-HARVESTONEDOOR-001 UPDATE: the header action now opens the COMBINED harvest page
// (/log/harvest), which is voice by default with the weigh-in session one tap away on its selector.
// Everything below still holds and still matters — the page must arrive as a PAGE and not an
// overlay, because the Manual half IS the weigh-in session and EventNew gates it on
// `harvestSessionParam && !inOverlay`. The target string changed; the posture requirement did not,
// and it is now load-bearing for one of two modes rather than for the whole surface.
//
// V4-WEIGHINCTA-001 (CHECKIN PLAN B5) — the global header Harvest action opens the WEIGH-IN SESSION.
//
// Why this file exists separately from TopChrome.test.jsx: that suite asserts hrefs, and an href
// alone cannot catch this bug. Session mode is gated in EventNew on `harvestSessionParam &&
// !inOverlay`, so a header action that carries the right ?session=harvest target but ships it
// through an OverlayLink lands with the param and the session STILL never engages — the form
// degrades to the plain ?event_type=harvest posture and nothing anywhere says so. The target and
// the posture are two independent failure modes; both are asserted below.
//
// The observable for posture is `location.state.background`: OverlayProvider computes its
// `background` from exactly that value, and the overlay tree (hence OverlaySurfaceContext, hence
// useInOverlaySurface, hence `inOverlay`) exists only when it is set. OverlayLink sets it; Link does
// not. The Search circle is the non-vacuity control — it is still an OverlayLink, so a probe that
// reported "page" for everything would fail on Search rather than pass silently.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

let mockUser
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: mockUser }) }))

import TopChrome from '../components/TopChrome.jsx'

// `${pathname}${search}|${posture}` — one string so a wrong target and a wrong posture are
// distinguishable in the failure message instead of collapsing into a bare true/false.
function Probe() {
  const loc = useLocation()
  return <div data-testid="probe">{`${loc.pathname}${loc.search}|${loc.state?.background ? 'overlay' : 'page'}`}</div>
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TopChrome />
      <Probe />
    </MemoryRouter>
  )
}

beforeEach(() => { mockUser = { id: 'u1' } })

describe('TopChrome (V4-WEIGHINCTA-001 / V5-HARVESTONEDOOR-001) — header Harvest = the combined harvest page, full page', () => {
  it('lands on /log/harvest as a PAGE, not an overlay', () => {
    renderAt('/today')
    expect(screen.getByTestId('probe').textContent).toBe('/today|page')
    fireEvent.click(screen.getByTestId('topchrome-harvest'))
    expect(screen.getByTestId('probe').textContent).toBe('/log/harvest|page')
  })

  // Non-vacuity control for the assertion above: same probe, same click mechanism, an action that IS
  // still an overlay. If this reads 'page' the probe is broken and the Harvest assertion proves nothing.
  it('Search still opens as an overlay — the probe can see the difference', () => {
    renderAt('/today')
    fireEvent.click(screen.getByTestId('topchrome-search'))
    expect(screen.getByTestId('probe').textContent).toBe('/search|overlay')
  })

  // The circle is on every content surface (root AND detail render from one HeaderActions block), so
  // "<=1 tap from anywhere" is the whole done-criterion. A regression that kept it only on root tabs
  // would still pass the href tests in TopChrome.test.jsx for those tabs.
  it('reaches the session in ONE tap from a detail surface too', () => {
    for (const path of ['/today', '/harvests', '/projects/abc', '/plantings/xyz']) {
      cleanup()
      renderAt(path)
      fireEvent.click(screen.getByTestId('topchrome-harvest'))
      expect(screen.getByTestId('probe').textContent, `from ${path}`).toBe('/log/harvest|page')
    }
  })
})
