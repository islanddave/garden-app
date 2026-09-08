/**
 * src/__tests__/AdminConfig.test.jsx
 *
 * V5-ADMINCENTER-001 — the admin centre's first surface.
 *
 * Three properties, in descending order of how much they matter:
 *   1. AUTHORIZATION IS THE SERVER'S. A 403 on the WRITE swaps the page for a neutral placard. There
 *      is no client admin list and this file asserts that there is none — inventing one would
 *      reverse a decision recorded in three separate files.
 *   2. THE EDITOR CAN ONLY REORDER. Every affordance is a move; nothing removes a row. That is v1's
 *      scope and it is enforced at the resolver, but a UI that offered a delete button would be
 *      writing configs the renderer silently ignores, which is worse than not offering it.
 *   3. THE SAVE TELLS THE TRUTH. A refusal, a rejected order and an outage are three different
 *      outcomes and the page distinguishes all three. It never reports a save it did not make.
 *
 * The store is GLOBAL (public.app_config, keyed by `key` alone) as of Dave's 2026-09-08 ruling, not
 * per-user — which is what turns property 1 from a nicety into a privilege boundary: a save here
 * changes Jen's bar too.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

const { saveSpy, configRef, refreshSpy } = vi.hoisted(() => ({
  saveSpy: vi.fn(async () => ({ ok: true, config: {} })),
  configRef: { current: null },
  refreshSpy: vi.fn(async () => null),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: vi.fn(), getToken: vi.fn(async () => 'token') }),
}))
vi.mock('../context/AppConfigContext.jsx', () => ({
  useAppConfig: () => ({ appConfig: configRef.current, appConfigLoaded: true, refreshAppConfig: refreshSpy }),
}))
vi.mock('../lib/appConfigClient.js', () => ({ saveNavTabs: saveSpy }))

import AdminConfig from '../pages/AdminConfig.jsx'
import { DEFAULT_NAV_TABS } from '../lib/navConfig.js'

const rows = () => screen.getAllByTestId('nav-order-row').map(r => r.getAttribute('data-tab-key'))
const moveDown = (label) => fireEvent.click(screen.getByLabelText(`Move ${label} down`))
const moveUp = (label) => fireEvent.click(screen.getByLabelText(`Move ${label} up`))

beforeEach(() => {
  configRef.current = null
  saveSpy.mockClear().mockResolvedValue({ ok: true, config: {} })
  refreshSpy.mockClear()
})

describe('AdminConfig — the editor', () => {
  it('opens on the shipped order when nothing is configured', () => {
    render(<AdminConfig />)
    expect(rows()).toEqual(DEFAULT_NAV_TABS)
  })

  it('opens on the stored order when one is configured', () => {
    configRef.current = { nav_tabs: ['harvests', 'today', 'create', 'garden', 'put-up'] }
    render(<AdminConfig />)
    expect(rows()).toEqual(['harvests', 'today', 'create', 'garden', 'put-up'])
  })

  // The editor seeds from resolveNavTabs, not from the raw column, so a config the BAR is ignoring
  // is not presented here as though it were live. Showing the stored-but-rejected value would make
  // the page disagree with the nav for reasons a user cannot see.
  it('opens on the shipped order when the stored value is one the bar rejects', () => {
    configRef.current = { nav_tabs: ['today', 'today', 'garden', 'create', 'harvests'] }
    render(<AdminConfig />)
    expect(rows()).toEqual(DEFAULT_NAV_TABS)
  })

  it('moves a tab down and back up', () => {
    render(<AdminConfig />)
    moveDown('Today')
    expect(rows()).toEqual(['garden', 'today', 'create', 'harvests', 'put-up'])
    moveUp('Today')
    expect(rows()).toEqual(DEFAULT_NAV_TABS)
  })

  // The ends cannot walk off the list. `disabled` alone would not prove the handler is guarded —
  // jsdom skips clicks on disabled buttons — so the guard is also asserted at the reducer level by
  // the move() bounds check; what this pins is that the affordance is not offered.
  it('cannot move the first tab up or the last tab down', () => {
    render(<AdminConfig />)
    expect(screen.getByLabelText('Move Today up').disabled).toBe(true)
    expect(screen.getByLabelText('Move Put-Up down').disabled).toBe(true)
    expect(screen.getByLabelText('Move Today down').disabled).toBe(false)
  })

  // SCOPE, ASSERTED. v1 reorders; it does not hide. A remove/hide control would produce configs the
  // renderer discards, and hiding a tab removes the only door to a page.
  it('offers no way to remove or hide a tab', () => {
    const { container } = render(<AdminConfig />)
    const labels = [...container.querySelectorAll('button')].map(b => `${b.getAttribute('aria-label') ?? ''} ${b.textContent}`)
    for (const l of labels) expect(l).not.toMatch(/hide|remove|delete|off/i)
    expect(rows()).toHaveLength(DEFAULT_NAV_TABS.length)
  })

  it('every tab keeps a row however it is reordered', () => {
    render(<AdminConfig />)
    moveDown('Today'); moveDown('Today'); moveUp('Put-Up')
    expect([...rows()].sort()).toEqual([...DEFAULT_NAV_TABS].sort())
  })

  it('Reset restores the shipped order', () => {
    configRef.current = { nav_tabs: ['harvests', 'today', 'create', 'garden', 'put-up'] }
    render(<AdminConfig />)
    fireEvent.click(screen.getByText('Reset'))
    expect(rows()).toEqual(DEFAULT_NAV_TABS)
  })

  it('Save is inert until something actually changed', () => {
    render(<AdminConfig />)
    expect(screen.getByText('Save order').disabled).toBe(true)
    moveDown('Today')
    expect(screen.getByText('Save order').disabled).toBe(false)
  })
})

describe('AdminConfig — the write', () => {
  it('sends the edited order', async () => {
    render(<AdminConfig />)
    moveDown('Today')
    await act(async () => { fireEvent.click(screen.getByText('Save order')) })
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy.mock.calls[0][0].tabs).toEqual(['garden', 'today', 'create', 'harvests', 'put-up'])
  })

  it('re-reads the config after a successful save rather than trusting the echo', async () => {
    render(<AdminConfig />)
    moveDown('Today')
    await act(async () => { fireEvent.click(screen.getByText('Save order')) })
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toMatch(/Saved/)
  })

  // THE PROPERTY THIS PAGE EXISTS TO GET RIGHT. Authorization is the Lambda's ADMIN_CLERK_SUBS
  // allowlist; a refusal reaches the client as a 403 on the write, and the surface goes neutral —
  // the same placard GardenActivity shows, revealing nothing about what is behind it.
  it('a 403 on the write replaces the page with the neutral placard', async () => {
    saveSpy.mockResolvedValue({ ok: false, status: 403 })
    render(<AdminConfig />)
    moveDown('Today')
    await act(async () => { fireEvent.click(screen.getByText('Save order')) })
    expect(screen.getByRole('status').textContent).toBe('Nothing to see here.')
    expect(screen.queryByTestId('nav-order-editor')).toBeNull()
    expect(screen.queryByText(/tab bar order/i)).toBeNull()
  })

  // A refusal must not be reported as a failure of the same kind as an outage, and neither may be
  // reported as a save. 400 is the route rejecting the ORDER — anything that is not a permutation of
  // the shipped five, since v1 is reorder-only.
  it('reports a rejected order instead of claiming a save', async () => {
    saveSpy.mockResolvedValue({ ok: false, status: 400 })
    render(<AdminConfig />)
    moveDown('Today')
    await act(async () => { fireEvent.click(screen.getByText('Save order')) })
    const msg = screen.getByRole('status').textContent
    expect(msg).toMatch(/Not saved/)
    expect(msg).toMatch(/rejected this order/)
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('reports an unreachable server distinctly from a refusal', async () => {
    saveSpy.mockResolvedValue({ ok: false, status: 0 })
    render(<AdminConfig />)
    moveDown('Today')
    await act(async () => { fireEvent.click(screen.getByText('Save order')) })
    expect(screen.getByRole('status').textContent).toMatch(/could not reach the server/i)
    // NOT the placard: an outage is not a refusal, and treating it as one would tell Dave he is not
    // an admin every time his phone drops the network.
    expect(screen.getByTestId('nav-order-editor')).toBeTruthy()
  })

  it('leaves the edited order on screen after a failed save, so the work is not lost', async () => {
    saveSpy.mockResolvedValue({ ok: false, status: 400 })
    render(<AdminConfig />)
    moveDown('Today')
    await act(async () => { fireEvent.click(screen.getByText('Save order')) })
    expect(rows()).toEqual(['garden', 'today', 'create', 'harvests', 'put-up'])
  })
})

describe('AdminConfig — no client admin list', () => {
  // Asserted against the SOURCE, because the defect is a thing a future session would ADD in good
  // faith ("hide the page from Jen"), and it would pass every render-level test in this file.
  // DebugMenu.jsx:18-26 records the decision: the real gate is server-side and fail-closed, and a
  // client list is the thing an attacker edits. GardenActivity and useShareToFacebook say the same.
  it('does not hardcode a Clerk sub or an admin allowlist', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../pages/AdminConfig.jsx'), 'utf8')
    expect(src).not.toMatch(/user_[0-9A-Za-z]{20,}/)     // a Clerk sub literal
    expect(src).not.toMatch(/ADMIN_[A-Z_]*\s*=\s*\[/)    // a local allowlist array
    expect(src).not.toMatch(/isAdmin\s*[=:]/)            // a client-side admin predicate
  })
})

describe('AdminConfig — reachability (the gate this surface was placed to inherit)', () => {
  const ROOT = path.resolve(__dirname, '../..')

  // DebugMenu.reachability.test.jsx already fails the build for a missing row. This asserts the two
  // things it CANNOT: that the route path is single-quoted (a double-quoted path escapes its regex
  // and passes it vacuously) and that the row Dave taps points where the route lives.
  it('registers /admin/config with a single-quoted path, as the reachability regex requires', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8')
    const routes = [...appSrc.matchAll(/path:\s*'(\/admin\/[^']*)'/g)].map(m => m[1])
    expect(routes).toContain('/admin/config')
  })

  it('has a row in the debug menu that a thumb can hit', async () => {
    vi.resetModules()
    vi.doMock('../lib/api.js', () => ({
      useApiFetch: () => ({ fetch: vi.fn().mockResolvedValue([]), getToken: vi.fn() }),
      apiFetch: vi.fn().mockResolvedValue([]),
    }))
    const { default: DebugMenu } = await import('../pages/DebugMenu.jsx')
    const { container } = render(<DebugMenu />)
    const link = [...container.querySelectorAll('a')].find(a => a.getAttribute('href') === '/admin/config')
    expect(link, '/admin/config has no row in DebugMenu LINKS').toBeTruthy()
    expect(link.style.minHeight).toBe('44px')
    expect(link.style.color).not.toBe('')
    expect(within(link).getByText('App configuration')).toBeTruthy()
    expect(link.querySelector('svg')).toBeTruthy()
  })
})
