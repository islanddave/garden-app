// OPS-DEBUGMENU-001 — THE REACHABILITY INVARIANT.
//
// The defect this guards is not a broken page; it is a page that works perfectly and that nobody can
// open. Three /admin/* routes were each shipped "unlinked, reachable by URL" — a sound rule on a
// desktop and a dead end in an installed PWA, where there is no address bar. Dave runs this app from
// the Android home screen, so "unlinked" had silently meant "unreachable" for every one of them.
//
// The test that matters is the LAST one in this file: every /admin/* route registered in App.jsx
// must have a row on the debug menu. It reads both files as TEXT rather than importing them, because
// the invariant is about what a developer wrote in the router, and a runtime render can only see the
// routes that happen to load. A new admin route added without a row fails here, at the point the
// mistake is made, rather than shipping a page only a laptop can reach.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import fs from 'node:fs'
import path from 'node:path'

const { prefsRef } = vi.hoisted(() => ({ prefsRef: { current: null } }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: vi.fn().mockResolvedValue([]), getToken: vi.fn() }),
  apiFetch: vi.fn().mockResolvedValue([]),
}))
// For the BottomNav render below: identity, the two Clerk-backed children, mode, and the network edge
// of the prefs read. Everything from PrefsProvider to the sheet's rows is the real code.
vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1' }, profile: { display_name: 'Dave' }, signOut: vi.fn() }),
}))
vi.mock('../components/CatchUpBadge.jsx', () => ({ default: () => null }))
vi.mock('../components/BottomNavDot.jsx', () => ({ default: () => null }))
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: vi.fn(async () => prefsRef.current),
}))

import DebugMenu from '../pages/DebugMenu.jsx'
import BottomNav from '../components/BottomNav.jsx'
import { PrefsProvider } from '../context/PrefsContext.jsx'
import { NavPrefsProvider } from '../context/NavPrefsContext.jsx'

const ROOT = path.resolve(__dirname, '../..')
const appSrc = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8')
const menuSrc = fs.readFileSync(path.join(ROOT, 'src/pages/DebugMenu.jsx'), 'utf8')

const renderMenu = () => render(<MemoryRouter><DebugMenu /></MemoryRouter>)

describe('DebugMenu — the diagnostic index', () => {
  it('links the voice probe, which is the page that prompted this', () => {
    renderMenu()
    const link = screen.getByText(/Voice debug/i).closest('a')
    expect(link.getAttribute('href')).toBe('/admin/voice-debug')
  })

  it('gives every link a 44px tap target', () => {
    const { container } = renderMenu()
    const links = [...container.querySelectorAll('a')]
    expect(links.length).toBeGreaterThan(0)
    for (const a of links) expect(a.style.minHeight).toBe('44px')
  })

  // BUG-LINKICONBLUE-001 — shipped wrong in v4.58.0 and caught in a real browser, not here, which is
  // why the assertion is on the inline style rather than a computed colour: jsdom applies no UA
  // stylesheet, so the browser-default link blue that WAS rendering (#0000EE, measured at 375px)
  // computes as plain black in this environment. A computed-colour assertion would therefore have
  // passed against the broken code. What is actually checkable here is the thing whose ABSENCE
  // caused it: an explicit ink on any <Link> that contains an <Icon>, because Icon emits
  // `<svg stroke="currentColor">` and only substitutes a palette hex on regioned parts.
  it('sets an explicit ink on every link, so icons cannot inherit link blue', () => {
    const { container } = renderMenu()
    for (const a of container.querySelectorAll('a')) {
      expect(a.querySelector('svg'), 'fixture assumption: each row carries an icon').toBeTruthy()
      expect(a.style.color, 'a Link wrapping an Icon must set its own color').not.toBe('')
    }
  })

  it('reports build, service worker and network state without being asked', () => {
    renderMenu()
    expect(screen.getByText('App build')).toBeTruthy()
    expect(screen.getByText('Service worker')).toBeTruthy()
    expect(screen.getByText('Network')).toBeTruthy()
    expect(screen.getByText('Display mode')).toBeTruthy()
  })

  it('does NOT ping the API on mount — only when asked', async () => {
    renderMenu()
    // Opening the page must not cost a rate-limited authenticated round-trip.
    expect(screen.getByText('not run')).toBeTruthy()
    fireEvent.click(screen.getByText('Ping the API'))
    expect(await screen.findByText(/OK in \d+ms/)).toBeTruthy()
  })
})

describe('BottomNav — the one door to the diagnostics', () => {
  // V5-NAVCUSTOM-001 — REWRITTEN, NOT PATCHED. This used to be a regex over BottomNav.jsx's SOURCE
  // (`to="/admin"…Debug`). The More sheet's rows are data now (src/lib/moreRegistry.js), so that
  // literal no longer exists — and no source regex could ever see a row that a person's pins or bar
  // layout moved. So this renders the REAL sheet, through the real prefs chain, under every layout
  // and pin state that could move the row, and looks for the door where Dave would.
  // KILLING MUTATIONS: drop the admin row from MORE_ROWS; draw a pinned row at home AND in Pinned
  // (two doors); drop pinned rows from both places (no door). RESULT: RED for each.
  const LAYOUTS = [null, { order: ['put-up', 'harvests', 'create', 'today', 'garden'], hidden: ['garden', 'harvests', 'put-up'] }]
  const PINS = [null, ['admin'], ['seeds', 'photos', 'about', 'helper'], ['seeds', 'admin', 'photos', 'about', 'helper']]

  it('the rendered More sheet has exactly one Debug & smoke row to /admin, under every layout and pin state', async () => {
    for (const bar_layout of LAYOUTS) {
      for (const more_pins of PINS) {
        localStorage.clear()
        prefsRef.current = { bar_layout, more_pins, can_edit_bar: false }
        let view
        await act(async () => {
          view = render(<MemoryRouter><PrefsProvider><NavPrefsProvider><BottomNav /></NavPrefsProvider></PrefsProvider></MemoryRouter>)
        })
        fireEvent.click(screen.getByLabelText('More navigation options'))
        const sheet = screen.getByRole('dialog', { name: 'More navigation options' })
        const doors = within(sheet).getAllByRole('link').filter(a => a.getAttribute('href') === '/admin')
        const label = JSON.stringify({ bar_layout, more_pins })
        expect(doors, label).toHaveLength(1)
        expect(doors[0].textContent, label).toContain('Debug & smoke')
        view.unmount()
      }
    }
  })
})

describe('REACHABILITY INVARIANT — no admin route may ship unreachable in the PWA', () => {
  it('gives every /admin/* route in App.jsx a row on the debug menu', () => {
    const routes = [...appSrc.matchAll(/path:\s*'(\/admin\/[^']*)'/g)].map(m => m[1])
    // Sanity: if this ever finds nothing, the regex has drifted and the test below is vacuous —
    // exactly the silently-passing guard this file exists to avoid being.
    expect(routes.length).toBeGreaterThanOrEqual(3)

    const missing = routes.filter(r => !menuSrc.includes(`'${r}'`))
    expect(missing, `admin routes with no row in DebugMenu LINKS (unreachable in an installed PWA): ${missing.join(', ')}`).toEqual([])
  })

  it('registers the /admin index itself', () => {
    expect(appSrc).toMatch(/path:\s*'\/admin'/)
  })
})
