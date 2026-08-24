// V4-APPBAR-003 — unified peach header on every surface. No jest-dom (L-182): roles/attrs + toBeTruthy/toBe(null).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { APP_NAME } from '../lib/constants.js'
import { ROOT_TABS } from '../lib/routeClass.js'

// The three circles every content surface carries, in render order.
//
// BD-032 — Snap's value is `null`, not '/capture'. It is no longer a Link: it is a button that
// opens the OS file picker inside its own tap (a file input needs a trusted gesture, and the
// navigation that used to get you to /capture spent it), parks the file, and THEN navigates.
// `null` means "present, but carries no href" and the parity assertions below check exactly that
// rather than pretending the href is still there.
const ACTIONS = { 'topchrome-snap': 'NO-HREF', 'topchrome-harvest': '/log?session=harvest', 'topchrome-search': '/search' }

let mockUser
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: mockUser }) }))

import TopChrome from '../components/TopChrome.jsx'

function renderAt(path) {
  return render(<MemoryRouter initialEntries={[path]}><TopChrome /></MemoryRouter>)
}

beforeEach(() => { mockUser = { id: 'u1' } })

describe('TopChrome (V4-APPBAR-003) — root: icon-parity header, no Back', () => {
  it('root tab (/today): wordmark + the search ICON, NO Favorites heart in header', () => {
    renderAt('/today')
    expect(screen.getByText(APP_NAME)).toBeTruthy()
    expect(screen.getByLabelText('Search your garden').getAttribute('href')).toBe('/search')
    expect(screen.queryByLabelText('Favorites')).toBe(null)
  })
  it('brand wordmark links home (/dashboard)', () => {
    renderAt('/garden')
    expect(screen.getByText(APP_NAME).getAttribute('href')).toBe('/dashboard')
  })
  it('root header is 52px + safe-area tall (V4-HEADERPARITY-001, was 88 with the launcher)', () => {
    const { container } = renderAt('/dashboard')
    expect(container.querySelector('header').style.height).toBe('calc(52px + env(safe-area-inset-top))')
  })
  it('root renders the daily banner photo + scrim', () => {
    renderAt('/today')
    const img = screen.getByTestId('header-banner')
    expect(img.getAttribute('aria-hidden')).toBe('true')
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('src')).toBeTruthy()
    expect(screen.getByTestId('header-banner-scrim')).toBeTruthy()
  })
  it('root keeps a solid peach base under the banner (image-failure fallback)', () => {
    const { container } = renderAt('/garden')
    expect(container.querySelector('header').style.backgroundColor).toBe('rgb(249, 227, 214)')
  })
})

// V4-HEADERPARITY-001 (Dave, 2026-08-18) — the five root tabs took the detail header's icon search
// and did NOT take its Back arrow. Both halves are load-bearing and both are asserted here: the
// cheap way to get the icon is to drop the tabs to 'detail', which also ships a navigate(-1) arrow
// on the app's five primary destinations. routeClass.js records that exact regression shipping once
// already (V4-NAVHARVEST-001, /harvests), green tests throughout.
describe('TopChrome (V4-HEADERPARITY-001) — root tabs: icon search, NO Back arrow', () => {
  it('every root tab carries the same three action circles as every other screen', () => {
    for (const path of ROOT_TABS) {
      cleanup()
      renderAt(path)
      for (const [testid, href] of Object.entries(ACTIONS)) {
        // Same three-way read as the parity helper below: getByTestId already fails loudly if the
        // element is missing, so 'NO-HREF' here means present-and-hrefless (Snap, post-BD-032).
        const el = screen.getByTestId(testid)
        expect(el.getAttribute('href') ?? 'NO-HREF', `${path} ${testid}`).toBe(href)
      }
    }
  })

  it('NO root tab renders a Back button — the half of the detail header they must not inherit', () => {
    for (const path of ROOT_TABS) {
      cleanup()
      renderAt(path)
      expect(screen.queryByTestId('topbar-back'), `${path} must not have Back`).toBe(null)
      // The label, not just the testid: an arrow re-added under a different hook still fails here.
      expect(screen.queryByLabelText('Back'), `${path} must not have Back`).toBe(null)
    }
  })

  // The anti-drift invariant, stated as a property rather than as two copies of a list: root and
  // detail render from ONE JSX block, so an action added to one is on both. If that block is ever
  // split back into two variants, this is what goes red.
  it('root and detail expose an IDENTICAL action set — Back is the only difference', () => {
    const actionsAt = (path) => {
      cleanup()
      renderAt(path)
      // Three-way, not two. Before BD-032 every action was a Link, so `href ?? 'ABSENT'` was
      // unambiguous; now Snap is a button and a missing ELEMENT and a missing HREF would both have
      // read 'ABSENT' — which would let this parity test go green while an action silently vanished
      // from one variant. That is the single failure it exists to catch.
      return Object.keys(ACTIONS).map((t) => {
        const el = screen.queryByTestId(t)
        if (!el) return `${t}=ABSENT`
        return `${t}=${el.getAttribute('href') ?? 'NO-HREF'}`
      })
    }
    const root = actionsAt('/today')
    const detail = actionsAt('/projects/abc')
    expect(root).toEqual(detail)
    expect(root).toEqual(Object.entries(ACTIONS).map(([t, h]) => `${t}=${h}`))
  })
})

describe('TopChrome (V4-APPBAR-003) — detail: condensed, same header family', () => {
  it('detail (/projects/abc): Back + condensed search icon + banner, 52px', () => {
    const { container } = renderAt('/projects/abc')
    expect(screen.getByTestId('topbar-back')).toBeTruthy()
    expect(screen.getByLabelText('Search your garden').getAttribute('href')).toBe('/search')
    expect(screen.getByTestId('header-banner')).toBeTruthy()
    expect(container.querySelector('header').style.height).toBe('calc(52px + env(safe-area-inset-top))')
  })
  it('detail KEEPS its Back arrow (the parity change took search to root, not Back off detail)', () => {
    renderAt('/inventory/i1')
    expect(screen.getByTestId('topbar-back').getAttribute('aria-label')).toBe('Back')
    expect(screen.getByTestId('topchrome-search').getAttribute('href')).toBe('/search')
  })
  it('detail has NO Favorites heart in the header (rehomed to Garden)', () => {
    renderAt('/projects/abc')
    expect(screen.queryByLabelText('Favorites')).toBe(null)
  })
})

describe('TopChrome (V4-APPBAR-003) — unauth: brand + Sign in, no search', () => {
  it('unauth (/login): brand + Sign in, NO search', () => {
    mockUser = null
    renderAt('/login')
    expect(screen.getByText(APP_NAME)).toBeTruthy()
    expect(screen.getByText('Sign in').getAttribute('href')).toBe('/login')
    expect(screen.queryByLabelText('Search your garden')).toBe(null)
  })
})

describe('TopChrome — capture: immersive bar', () => {
  it('capture (/capture): CaptureBar Back, no search', () => {
    renderAt('/capture')
    expect(screen.getByTestId('capture-back')).toBeTruthy()
    expect(screen.queryByLabelText('Search your garden')).toBe(null)
  })
})

// V4-TOPCHROMEACTIONS-001 (BD-027) — Snap + Harvest as header actions on every content surface.
// V4-HEADERPARITY-001 added Search to the same cluster, so these now describe all three.
describe('TopChrome (V4-TOPCHROMEACTIONS-001) — Snap + Harvest header actions', () => {
  for (const path of ['/today', '/garden', '/dashboard']) {
    it(`root ${path}: Snap opens the picker in-tap and Harvest -> the weigh-in session`, () => {
      renderAt(path)
      const snap = screen.getByTestId('topchrome-snap')
      expect(snap.tagName).toBe('BUTTON')
      expect(snap.getAttribute('href')).toBe(null)
      expect(screen.getByTestId('topchrome-snap-input').getAttribute('type')).toBe('file')
      expect(screen.getByTestId('topchrome-harvest').getAttribute('href')).toBe('/log?session=harvest')
    })
  }
  it('detail (/projects/abc): both actions present alongside the search icon', () => {
    renderAt('/projects/abc')
    expect(screen.getByTestId('topchrome-snap').tagName).toBe('BUTTON')
    expect(screen.getByTestId('topchrome-harvest').getAttribute('href')).toBe('/log?session=harvest')
    expect(screen.getByTestId('topchrome-search').getAttribute('href')).toBe('/search')
  })
  // REVERSED by V4-WEIGHINCTA-001 (CHECKIN PLAN B5, Dave GO 2026-08-18), deliberately kept as the
  // record of the reversal. This asserted the opposite until 2026-08-20 ("the Harvest href is
  // byte-identical to the retired FAB row target" = /log?event_type=harvest), because the exact-string
  // match in BottomNav's OVERLAYABLE_CREATE was what made the FAB harvest row open as an overlay.
  // That coupling is already dead: V4-HARVFABREMOVE-001 dropped the string from OVERLAYABLE_CREATE
  // and BottomNav.jsx:83 records that the header action never consulted the Set at all. What replaces
  // it is the ?session= pin below — the param, not the pathname, is what EventNew reads.
  it('the Harvest href carries ?session= — ?event_type=harvest would silently skip session mode', () => {
    renderAt('/today')
    const href = screen.getByTestId('topchrome-harvest').getAttribute('href')
    expect(href).toBe('/log?session=harvest')
    expect(new URLSearchParams(href.split('?')[1]).get('session')).toBe('harvest')
  })
  it('all three actions are icon-only with accessible names (no visible text label)', () => {
    renderAt('/today')
    const labels = { 'topchrome-snap': 'Snap a photo', 'topchrome-harvest': 'Log a harvest', 'topchrome-search': 'Search your garden' }
    for (const [testid, label] of Object.entries(labels)) {
      const el = screen.getByTestId(testid)
      expect(el.getAttribute('aria-label'), testid).toBe(label)
      expect(el.textContent, testid).toBe('')
      expect(el.querySelector('svg'), testid).toBeTruthy()
    }
  })
  // V4-ICON-001: the header must not regress to platform emoji. The registry has no harvest anchor
  // (event.harvest resolves to the emoji basket), which is exactly why these are inline SVG.
  it('neither action renders a platform emoji', () => {
    renderAt('/today')
    const EMOJI = /\p{Extended_Pictographic}/u
    expect(EMOJI.test(screen.getByTestId('topchrome-snap').textContent)).toBe(false)
    expect(EMOJI.test(screen.getByTestId('topchrome-harvest').textContent)).toBe(false)
  })
  // REVERSED by V4-HEADERPARITY-001, deliberately kept as the record of the reversal. This asserted
  // the opposite until 2026-08-18 ("root keeps the full-width search launcher — actions do NOT
  // displace search-first"): the 88px root header led with a full-width pill carrying the visible
  // words "Search your garden" and a mic glyph. Dave asked for the icon-style search the other ~40
  // screens have, so the pill is gone and search is the third circle. Restoring the launcher — or
  // leaving both — goes red here.
  it('root has NO full-width launcher: search is the icon circle, exactly as on detail', () => {
    renderAt('/today')
    expect(screen.queryByText('Search your garden')).toBe(null)   // the pill's visible label
    const search = screen.getByTestId('topchrome-search')
    expect(search.getAttribute('href')).toBe('/search')
    expect(search.textContent).toBe('')                            // icon-only, like Snap + Harvest
    expect(search.querySelector('svg')).toBeTruthy()
    // Exactly ONE search affordance on a root tab — not a circle plus a surviving launcher.
    expect(screen.getAllByLabelText('Search your garden').length).toBe(1)
  })
  // All THREE now, not two: search shares the HeaderActions cluster since V4-HEADERPARITY-001, so
  // hoisting that cluster out of the signed-in row would leak a Protected target pre-auth.
  it('unauth (/login) shows NONE of the actions — targets are Protected pre-auth', () => {
    mockUser = null
    renderAt('/login')
    for (const testid of Object.keys(ACTIONS)) expect(screen.queryByTestId(testid), testid).toBe(null)
  })
  it('capture (/capture) shows NONE of the actions — the immersive bar stays immersive', () => {
    renderAt('/capture')
    for (const testid of Object.keys(ACTIONS)) expect(screen.queryByTestId(testid), testid).toBe(null)
  })
})
