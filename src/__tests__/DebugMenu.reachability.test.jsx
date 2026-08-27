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
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: vi.fn().mockResolvedValue([]), getToken: vi.fn() }),
  apiFetch: vi.fn().mockResolvedValue([]),
}))

import DebugMenu from '../pages/DebugMenu.jsx'

const ROOT = path.resolve(__dirname, '../..')
const appSrc = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8')
const menuSrc = fs.readFileSync(path.join(ROOT, 'src/pages/DebugMenu.jsx'), 'utf8')
const navSrc = fs.readFileSync(path.join(ROOT, 'src/components/BottomNav.jsx'), 'utf8')

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
  it('carries a Debug & smoke row pointing at /admin', () => {
    // Asserted against source rather than a render because BottomNav needs the full auth/toast
    // provider stack; the row's existence and target are what matter and both are textual.
    expect(navSrc).toMatch(/to="\/admin"[\s\S]{0,200}Debug/)
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
