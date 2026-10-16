// V5-TODAYREDESIGN-001 S2 — /today's chooser and the per-device switch behind it (plan-v2 §6.4, §6.10), the
// Debug & smoke row that flips it (visible to both users, default ON since S8b / L7), sign-out's scrub of every V2 key,
// and TodaySection as a controlled section.
// The chooser and the row as they are WITH the preview row shown (featureFlags TODAY_V2_PREVIEW_ROW true, as it
// ships by Dave's D14 — mocked on here, so these cases hold whichever way it ships). The shipped value and the
// row's subtitle are pinned in TodayRoute.previewShipped.test.jsx; the false branch (no row, a stored choice
// ignored) in TodayRoute.previewHidden.test.jsx. featureFlags TODAY_V2_DEFAULT is mocked through a getter set to TRUE
// before each case, so these mechanics hold whichever way it ships; the shipped value is previewShipped's single pin.
// One case sets it false (the default undone).
import React, { useState } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../pages/Today.jsx', () => ({ default: () => <div data-testid="today-v1" /> }))
const flags = vi.hoisted(() => ({ def: true, v2Throws: false }))
vi.mock('../pages/TodayV2.jsx', () => ({
  default: () => { if (flags.v2Throws) throw new Error('TodayV2 render failed'); return <div data-testid="today-v2" /> },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(async () => ({})) }) }))
vi.mock('../lib/featureFlags.js', async (orig) => ({
  ...(await orig()), TODAY_V2_PREVIEW_ROW: true, get TODAY_V2_DEFAULT() { return flags.def },
}))

import TodayRoute from '../components/today/v2/TodayRoute.jsx'
import DebugMenu from '../pages/DebugMenu.jsx'
import TodaySection from '../components/today/v2/TodaySection.jsx'
import { readTodayV2Flag, writeTodayV2Flag, TODAY_V2_FLAG_KEY } from '../lib/todayV2Flag.js'
import { clearClientPrefs } from '../lib/clientPrefs.js'

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); flags.def = true; flags.v2Throws = false })
afterEach(() => cleanup())

describe('the per-device switch', () => {
  it('is on by default and stores "1" / "0"; anything else reads as no choice', () => {
    expect(TODAY_V2_FLAG_KEY).toBe('garden.todayV2')
    expect(readTodayV2Flag()).toBe(true)
    writeTodayV2Flag(false)
    expect(localStorage.getItem('garden.todayV2')).toBe('0')
    expect(readTodayV2Flag()).toBe(false)
    writeTodayV2Flag(true)
    expect(localStorage.getItem('garden.todayV2')).toBe('1')
    expect(readTodayV2Flag()).toBe(true)
    for (const junk of ['', 'true', 'false', 'on', '01']) {
      localStorage.setItem('garden.todayV2', junk)
      expect(readTodayV2Flag()).toBe(true)
    }
  })

  it('storage that throws reads as no choice (the default) and a write does not throw', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      expect(readTodayV2Flag()).toBe(true)
      expect(() => writeTodayV2Flag(false)).not.toThrow()
    } finally { get.mockRestore(); set.mockRestore() }
  })

  it('TodayRoute mounts the redesign by default, the old Today when the switch is off, from the first render', () => {
    const a = render(<TodayRoute />)
    expect(screen.getByTestId('today-v2')).toBeTruthy()
    expect(screen.queryByTestId('today-v1')).toBeNull()
    a.unmount()
    localStorage.setItem('garden.todayV2', '0')
    const b = render(<TodayRoute />)
    expect(screen.getByTestId('today-v1')).toBeTruthy()
    expect(screen.queryByTestId('today-v2')).toBeNull()
    b.unmount()
    localStorage.setItem('garden.todayV2', '1')
    render(<TodayRoute />)
    expect(screen.getByTestId('today-v2')).toBeTruthy()
  })

  it('follows a flip while mounted, and another tab\'s flip (storage event)', () => {
    render(<TodayRoute />)
    act(() => writeTodayV2Flag(false))
    expect(screen.getByTestId('today-v1')).toBeTruthy()
    localStorage.removeItem('garden.todayV2')
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'garden.todayV2' })) })
    expect(screen.getByTestId('today-v2')).toBeTruthy()
    localStorage.setItem('garden.todayV2', '0')
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'garden.todayV2' })) })
    expect(screen.getByTestId('today-v1')).toBeTruthy()
  })

  it('with the default undone (TODAY_V2_DEFAULT false): no choice → the old Today, "1" → the redesign, "0" → the old', () => {
    flags.def = false
    expect(readTodayV2Flag()).toBe(false)
    const a = render(<TodayRoute />)
    expect(screen.getByTestId('today-v1')).toBeTruthy()
    a.unmount()
    localStorage.setItem('garden.todayV2', '1')
    const b = render(<TodayRoute />)
    expect(screen.getByTestId('today-v2')).toBeTruthy()
    b.unmount()
    localStorage.setItem('garden.todayV2', '0')
    render(<TodayRoute />)
    expect(screen.getByTestId('today-v1')).toBeTruthy()
    for (const junk of ['', 'true', 'on']) {
      localStorage.setItem('garden.todayV2', junk)
      expect(readTodayV2Flag()).toBe(false)
    }
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    try { expect(readTodayV2Flag()).toBe(false) } finally { get.mockRestore() }
  })

  it('the server snapshot is the default too (renderToStaticMarkup)', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    expect(renderToStaticMarkup(<TodayRoute />)).toContain('today-v2')
    flags.def = false
    expect(renderToStaticMarkup(<TodayRoute />)).toContain('today-v1')
  })

  it('a redesign that throws while rendering falls back to the old Today, not an error screen', () => {
    flags.v2Throws = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(<TodayRoute />)
      expect(screen.getByTestId('today-v1')).toBeTruthy()
      expect(err.mock.calls.some((c) => String(c[0]).includes('[ErrorBoundary scope=today-v2]'))).toBe(true)
    } finally { err.mockRestore() }
  })

  it('App\'s /today element is the chooser', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(`${process.cwd()}/src/App.jsx`, 'utf8')
    expect(src).toMatch(/path: '\/today',\s+element: <Protected><ErrorBoundary scope="route" fallback=\{<RouteFallback \/>\}><TodayRoute \/><\/ErrorBoundary><\/Protected>/)
    expect(src).not.toMatch(/React\.lazy\(\s*\(\)\s*=>\s*import\([^)]*TodayV2/)
  })
})

describe('Debug & smoke — "New Today on this phone"', () => {
  const mount = () => render(<MemoryRouter><DebugMenu /></MemoryRouter>)

  it('is a toggle, on by default, with a stable plain name', () => {
    mount()
    const t = screen.getByRole('button', { name: /^New Today on this phone/ })
    expect(t.getAttribute('aria-pressed')).toBe('true')
    expect(t.getBoundingClientRect).toBeTruthy()
    fireEvent.click(t)
    expect(localStorage.getItem('garden.todayV2')).toBe('0')
    expect(t.getAttribute('aria-pressed')).toBe('false')
    expect(t.textContent).toContain('Off')
    fireEvent.click(t)
    expect(localStorage.getItem('garden.todayV2')).toBe('1')
    expect(t.getAttribute('aria-pressed')).toBe('true')
  })

  it('with the default undone the row reads Off and its subtitle says how to turn the new page on', () => {
    flags.def = false
    mount()
    const t = screen.getByTestId('debug-today-v2')
    expect(t.getAttribute('aria-pressed')).toBe('false')
    expect(t.textContent).toContain('turn it on to use the new Today page, off for the old one.')
    expect(t.textContent).not.toContain('Now the standard Today page')
  })

  it('the On / Off pill is hidden from the accessible name', () => {
    mount()
    const t = screen.getByTestId('debug-today-v2')
    expect(t.querySelector('[aria-hidden="true"]').textContent).toBe('On')
    expect(t.style.minHeight).toBe('48px')
  })
})

describe('sign-out scrubs every V2 key', () => {
  it('the switch, the mirror, first-seen, and the tab-scoped visit / filters / logged families', () => {
    localStorage.setItem('garden.todayV2', '0')
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
