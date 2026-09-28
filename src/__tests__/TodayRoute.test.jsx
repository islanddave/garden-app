// V5-TODAYREDESIGN-001 S2 — /today's chooser and the per-device switch behind it (plan-v2 §6.4, §6.10), the
// Debug & smoke row that flips it (visible to both users, default off), sign-out's scrub of every V2 key,
// and TodaySection as a controlled section.
import React, { useState } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../pages/Today.jsx', () => ({ default: () => <div data-testid="today-v1" /> }))
vi.mock('../pages/TodayV2.jsx', () => ({ default: () => <div data-testid="today-v2" /> }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(async () => ({})) }) }))

import TodayRoute from '../components/today/v2/TodayRoute.jsx'
import DebugMenu from '../pages/DebugMenu.jsx'
import TodaySection from '../components/today/v2/TodaySection.jsx'
import { readTodayV2Flag, writeTodayV2Flag, TODAY_V2_FLAG_KEY } from '../lib/todayV2Flag.js'
import { clearClientPrefs } from '../lib/clientPrefs.js'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => cleanup())

describe('the per-device switch', () => {
  it('is off by default and stores "1" / nothing', () => {
    expect(TODAY_V2_FLAG_KEY).toBe('garden.todayV2')
    expect(readTodayV2Flag()).toBe(false)
    writeTodayV2Flag(true)
    expect(localStorage.getItem('garden.todayV2')).toBe('1')
    writeTodayV2Flag(false)
    expect(localStorage.getItem('garden.todayV2')).toBeNull()
  })

  it('TodayRoute mounts the current Today by default and the redesign when the switch is on, from the first render', () => {
    const a = render(<TodayRoute />)
    expect(screen.getByTestId('today-v1')).toBeTruthy()
    a.unmount()
    localStorage.setItem('garden.todayV2', '1')
    render(<TodayRoute />)
    expect(screen.getByTestId('today-v2')).toBeTruthy()
    expect(screen.queryByTestId('today-v1')).toBeNull()
  })

  it('follows a flip while mounted, and another tab\'s flip (storage event)', () => {
    render(<TodayRoute />)
    act(() => writeTodayV2Flag(true))
    expect(screen.getByTestId('today-v2')).toBeTruthy()
    localStorage.removeItem('garden.todayV2')
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'garden.todayV2' })) })
    expect(screen.getByTestId('today-v1')).toBeTruthy()
  })

  it('App\'s /today element is the chooser', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(`${process.cwd()}/src/App.jsx`, 'utf8')
    expect(src).toMatch(/path: '\/today',\s+element: <Protected><ErrorBoundary scope="route" fallback=\{<RouteFallback \/>\}><TodayRoute \/><\/ErrorBoundary><\/Protected>/)
    expect(src).not.toMatch(/React\.lazy\(\s*\(\)\s*=>\s*import\([^)]*TodayV2/)
  })
})

describe('Debug & smoke — "New Today (preview) on this phone"', () => {
  const mount = () => render(<MemoryRouter><DebugMenu /></MemoryRouter>)

  it('is a toggle, off by default, with a stable plain name', () => {
    mount()
    const t = screen.getByRole('button', { name: /^New Today \(preview\) on this phone/ })
    expect(t.getAttribute('aria-pressed')).toBe('false')
    expect(t.getBoundingClientRect).toBeTruthy()
    fireEvent.click(t)
    expect(localStorage.getItem('garden.todayV2')).toBe('1')
    expect(t.getAttribute('aria-pressed')).toBe('true')
    expect(t.textContent).toContain('On')
    fireEvent.click(t)
    expect(localStorage.getItem('garden.todayV2')).toBeNull()
    expect(t.getAttribute('aria-pressed')).toBe('false')
  })

  it('the On / Off pill is hidden from the accessible name', () => {
    mount()
    const t = screen.getByTestId('debug-today-v2')
    expect(t.querySelector('[aria-hidden="true"]').textContent).toBe('Off')
    expect(t.style.minHeight).toBe('48px')
  })
})

describe('sign-out scrubs every V2 key', () => {
  it('the switch, the mirror, first-seen, and the tab-scoped visit / filters / logged families', () => {
    localStorage.setItem('garden.todayV2', '1')
    localStorage.setItem('today-sections:user_a', '{"v":1,"s":{},"dirty":[]}')
    localStorage.setItem('today-seen:user_a', '{}')
    sessionStorage.setItem('today-visit:user_a:2026-09-24:v2', '{}')
    sessionStorage.setItem('today-filters:user_a', '{}')
    sessionStorage.setItem('today-logged:user_a:2026-09-24', '[]')
    localStorage.setItem('unrelated.key', 'keep')
    sessionStorage.setItem('unrelated.session', 'keep')
    clearClientPrefs()
    for (const k of ['garden.todayV2', 'today-sections:user_a', 'today-seen:user_a']) expect(localStorage.getItem(k)).toBeNull()
    for (const k of ['today-visit:user_a:2026-09-24:v2', 'today-filters:user_a', 'today-logged:user_a:2026-09-24']) expect(sessionStorage.getItem(k)).toBeNull()
    expect(localStorage.getItem('unrelated.key')).toBe('keep')
    expect(sessionStorage.getItem('unrelated.session')).toBe('keep')
  })
})

describe('TodaySection', () => {
  function Host() {
    const [open, setOpen] = useState(false)
    return <TodaySection sectionKey="care" title="Needs care" count={233} summary="8 tray cells due" open={open} onToggle={() => setOpen((o) => !o)}><p data-testid="body">rows</p></TodaySection>
  }

  it('is controlled: `open` drives aria-expanded and the mounted body; the anchor is today-sec-<key>', () => {
    render(<Host />)
    const sec = screen.getByTestId('today-sec-care')
    expect(sec.tagName).toBe('SECTION')
    const btn = sec.querySelector('[aria-expanded]')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.closest('h2')).toBeTruthy()
    expect(screen.queryByTestId('body')).toBeNull()
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(sec.contains(screen.getByTestId('body'))).toBe(true)
    expect(sec.querySelectorAll('[data-testid^="today-sec-"]')).toHaveLength(0)
  })

  it('without onToggle it is the non-collapsible form', () => {
    render(<TodaySection sectionKey="hh-member_j" title="Jen’s care" count={15}><p data-testid="body">rows</p></TodaySection>)
    expect(screen.getByTestId('body')).toBeTruthy()
    expect(screen.getByTestId('today-sec-hh-member_j').querySelector('[aria-expanded]')).toBeNull()
  })

  it('an open section ignores a click that is not its own', () => {
    const onToggle = vi.fn()
    render(<TodaySection sectionKey="resting" title="Resting" open onToggle={onToggle}><button type="button">Resume</button></TodaySection>)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onToggle).not.toHaveBeenCalled()
  })
})
