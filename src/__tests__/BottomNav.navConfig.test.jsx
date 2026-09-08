/**
 * src/__tests__/BottomNav.navConfig.test.jsx
 *
 * V5-ADMINCENTER-001 — the tab bar under INSTALLATION config.
 *
 * Global, not per-user (Dave's 2026-09-08 ruling): the order comes from public.app_config, which is
 * keyed by `key` alone, so Dave and Jen render the same bar. The chain moved off PrefsProvider —
 * user_notification_prefs is keyed by created_by and cannot hold an installation-wide fact.
 *
 * WHAT THIS FILE OWNS THAT ITS SIBLINGS CANNOT. BottomNav.test.jsx renders <BottomNav /> bare, so
 * every assertion in it is about the DEFAULT config — including the six-slot count that is the tab
 * bar's only cap. Nothing there can set a config, so nothing there can prove the cap survives one.
 * This file is the other half: it drives the REAL chain — AppConfigProvider → fetchAppConfig →
 * resolveNavTabs → the rendered bar — with a stubbed response, which is the only place the provider,
 * the resolver and the renderer are exercised together.
 *
 * The unit-level guards live in navConfig.test.js with their killing mutations named. What is
 * asserted here is that they are actually WIRED: a resolver that rejects a bad config is worth
 * nothing if BottomNav reads the raw column instead.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const { configRef, fetchConfigSpy } = vi.hoisted(() => {
  const configRef = { current: null }
  return { configRef, fetchConfigSpy: vi.fn(async () => configRef.current) }
})

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, state, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>
  ),
  useLocation: () => ({ pathname: '/dashboard' }),
  useNavigate: () => vi.fn(),
}))

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1' }, profile: { display_name: 'Dave' }, signOut: vi.fn() }),
}))
vi.mock('../components/CatchUpBadge.jsx', () => ({ default: () => null }))
vi.mock('../components/BottomNavDot.jsx', () => ({ default: () => null }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: () => Promise.resolve(null), getToken: () => Promise.resolve('t') }),
}))
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))

// The ONLY stub in the chain under test. Everything from AppConfigProvider inward is the real code —
// stubbing useNavTabs instead would have left the provider and the resolver untested and turned
// these into assertions about the mock.
vi.mock('../lib/appConfigClient.js', () => ({
  fetchAppConfig: fetchConfigSpy,
}))

import BottomNav from '../components/BottomNav.jsx'
import { AppConfigProvider } from '../context/AppConfigContext.jsx'

// The nav's own children, in render order. Text rather than testids because that is what the
// existing suite pins and what a human reads off the bar.
const labels = () => [...screen.getByLabelText('Main navigation').children]
  .map(c => c.getAttribute('aria-label') === 'Create' ? 'Create' : c.textContent)

// `undefined` stands for the live state: app_config has zero rows, so the GET answers
// { nav_tabs: null } and nothing has ever been configured.
async function renderWithConfig(navTabs) {
  configRef.current = navTabs === undefined ? { nav_tabs: null } : { nav_tabs: navTabs }
  await act(async () => { render(<AppConfigProvider><BottomNav /></AppConfigProvider>) })
}

beforeEach(() => { fetchConfigSpy.mockClear() })

describe('BottomNav — config-driven order', () => {
  it('renders the shipped order when no app_config row exists', async () => {
    await renderWithConfig(undefined)
    expect(labels()).toEqual(['Today', 'Garden', 'Create', 'Harvests', 'Put-Up', 'More'])
  })

  it('applies a reorder', async () => {
    await renderWithConfig(['harvests', 'put-up', 'create', 'today', 'garden'])
    expect(labels()).toEqual(['Harvests', 'Put-Up', 'Create', 'Today', 'Garden', 'More'])
  })

  // The FAB is identified by `highlight`, not by index — it can be moved off centre and it is still
  // the button that opens the create sheet, not a link.
  it('a moved FAB is still the create button, not a link to /log', async () => {
    await renderWithConfig(['create', 'today', 'garden', 'harvests', 'put-up'])
    expect(labels()[0]).toBe('Create')
    const fab = screen.getByLabelText('Create')
    expect(fab.tagName).toBe('BUTTON')
    expect(fab.getAttribute('aria-haspopup')).toBe('true')
  })

  // THE CAP, AS A CAP ON THE RENDERED BAR — the condition on which BottomNav.test.jsx's six-slot
  // assertion was allowed to change meaning from "the shipped bar" to "the default config". A
  // config that asks for a seventh slot does not get one.
  //
  // WHICH GUARD HOLDS IT, stated precisely rather than assumed: with a five-key registry a longer
  // config must repeat a key or invent one, so today the cap is held by the duplicate and
  // unknown-key guards and the arity guard's "too long" arm is not what reds this. The cap is real
  // either way — the bar cannot grow by ANY route — but a future row that adds an optional tab key
  // to the registry moves which line is load-bearing, and should re-read this note before assuming
  // arity was covering it.
  it('a seven-key config does NOT grow the bar past six slots', async () => {
    await renderWithConfig(['today', 'garden', 'create', 'harvests', 'put-up', 'today', 'garden'])
    expect(screen.getByLabelText('Main navigation').children.length).toBe(6)
    expect(labels()).toEqual(['Today', 'Garden', 'Create', 'Harvests', 'Put-Up', 'More'])
  })

  // The failure that matters most on a device with no address bar. Asserted through the real
  // render, not the resolver, because "the resolver returns a default" and "the bar draws it" are
  // two claims and only the second one is what Dave sees.
  it('an empty config renders the full bar, never a bar with only More', async () => {
    await renderWithConfig([])
    expect(labels()).toEqual(['Today', 'Garden', 'Create', 'Harvests', 'Put-Up', 'More'])
  })

  it('a malformed config renders the full bar', async () => {
    await renderWithConfig({ order: ['today'] })
    expect(labels()).toEqual(['Today', 'Garden', 'Create', 'Harvests', 'Put-Up', 'More'])
  })

  it('an unknown key renders the full bar rather than a blank slot', async () => {
    await renderWithConfig(['today', 'garden', 'create', 'harvests', 'sprockets'])
    expect(labels()).toEqual(['Today', 'Garden', 'Create', 'Harvests', 'Put-Up', 'More'])
    // No slot rendered with no label — the specific damage an unguarded unknown key would do.
    expect(labels().some(l => l === '' || l == null)).toBe(false)
  })

  it('reordering does not change where a tab points', async () => {
    await renderWithConfig(['put-up', 'harvests', 'create', 'garden', 'today'])
    expect(screen.getByText('Put-Up').closest('a').getAttribute('href')).toBe('/put-up')
    expect(screen.getByText('Today').closest('a').getAttribute('href')).toBe('/today')
    expect(screen.getByText('Harvests').closest('a').getAttribute('href')).toBe('/harvests')
    expect(screen.getByText('Garden').closest('a').getAttribute('href')).toBe('/garden')
  })

  // More is emitted after the map as a hardcoded button, so it is pinned last STRUCTURALLY rather
  // than by being ordered last. Config cannot move it and cannot remove it — asserted with the
  // FAB pushed to the end, the one config most likely to expose an ordering mistake.
  it('More stays pinned last whatever the config says', async () => {
    await renderWithConfig(['today', 'garden', 'harvests', 'put-up', 'create'])
    expect(labels().at(-1)).toBe('More')
  })
})

describe('AppConfigProvider — one read at boot, not one per consumer', () => {
  it('reads the config once for the whole tree', async () => {
    configRef.current = { nav_tabs: null }
    await act(async () => {
      render(<AppConfigProvider><BottomNav /></AppConfigProvider>)
    })
    expect(fetchConfigSpy).toHaveBeenCalledTimes(1)
  })

  // Not a decoration: this is the degradation path the whole design rests on. A config read that
  // fails must leave the app with its shipped nav, not with no nav.
  it('a failed config read still renders the shipped bar', async () => {
    fetchConfigSpy.mockResolvedValueOnce(null)
    await act(async () => { render(<AppConfigProvider><BottomNav /></AppConfigProvider>) })
    expect(labels()).toEqual(['Today', 'Garden', 'Create', 'Harvests', 'Put-Up', 'More'])
  })

  // The no-row case stated end to end, because it is the state prod is actually in: app_config has
  // zero rows, so this is the response every boot gets today.
  it('an app_config with no nav_tabs row renders the shipped bar', async () => {
    fetchConfigSpy.mockResolvedValueOnce({ nav_tabs: null })
    await act(async () => { render(<AppConfigProvider><BottomNav /></AppConfigProvider>) })
    expect(labels()).toEqual(['Today', 'Garden', 'Create', 'Harvests', 'Put-Up', 'More'])
  })
})
