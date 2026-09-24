/**
 * src/__tests__/AdminConfig.test.jsx
 *
 * V5-NAVCUSTOM-001 — "Your tab bar", the per-person bar editor (D3: only Dave sees it; D4: it changes
 * his bar only). Rewritten deliberately from the V5-ADMINCENTER-001 global-order editor.
 *
 * Driven through the REAL PrefsProvider and NavPrefsProvider with only the network edge stubbed
 * (fetchNotificationPrefs, saveBarLayout), because the defect this page most needed fixing lives in
 * the gap between them: the old editor seeded itself ONCE, from the shipped default when the read was
 * slow, so a Save could wipe a stored layout with a value nobody chose.
 *
 * Properties, in descending order of how much they matter:
 *   1. SAVE NEVER WRITES A VALUE NOBODY CHOSE. Disabled until the server's value is read; the editor
 *      follows that value until the person edits; a failed read keeps Save off and says so.
 *   2. TODAY AND ＋ CANNOT LEAVE THE BAR. "In bar" exists on Garden, Harvests and Put-Up only.
 *   3. THE PREVIEW IS THE BAR THEY WILL GET, More last, and names what moves into More.
 *   4. WHO SEES IT IS THE SERVER'S CALL (can_edit_bar). There is no client admin list.
 *   5. THE SAVE TELLS THE TRUTH: a rejection, an outage and a success read differently.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

const { fetchPrefsSpy, saveSpy } = vi.hoisted(() => ({
  fetchPrefsSpy: vi.fn(),
  saveSpy: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'dave' } }) }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: vi.fn(), getToken: vi.fn(async () => 'token') }),
}))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: fetchPrefsSpy,
  saveBarLayout: saveSpy,
  saveMorePins: vi.fn(async () => ({ ok: true })),
}))

import AdminConfig from '../pages/AdminConfig.jsx'
import { PrefsProvider } from '../context/PrefsContext.jsx'
import { NavPrefsProvider, BAR_LAYOUT_CACHE_KEY, useNavLayout } from '../context/NavPrefsContext.jsx'
import { DEFAULT_NAV_TABS } from '../lib/navConfig.js'

const rows = () => screen.getAllByTestId('nav-order-row').map(r => r.getAttribute('data-tab-key'))
const preview = () => screen.getAllByTestId('bar-preview-slot').map(s => s.getAttribute('data-tab-key'))
const moveDown = (label) => fireEvent.click(screen.getByLabelText(`Move ${label} down`))
const moveUp = (label) => fireEvent.click(screen.getByLabelText(`Move ${label} up`))
const inBar = (label) => screen.getByLabelText(`${label} in bar`)
const saveButton = () => screen.getByText('Save')

const prefs = (barLayout, canEdit = true) => ({ bar_layout: barLayout, more_pins: null, can_edit_bar: canEdit })
const tree = () => <PrefsProvider><NavPrefsProvider><AdminConfig /></NavPrefsProvider></PrefsProvider>
async function open(serverPrefs = prefs(null)) {
  fetchPrefsSpy.mockResolvedValue(serverPrefs)
  let view
  await act(async () => { view = render(tree()) })
  return view
}

beforeEach(() => {
  fetchPrefsSpy.mockReset()
  saveSpy.mockReset().mockResolvedValue({ ok: true })
})

describe('who sees the editor — the server’s can_edit_bar, nothing else', () => {
  // KILLING MUTATION: drop the canEditBar gate. RESULT: RED — Jen would see an editor D3 kept from her.
  it('shows the neutral placard when the server says this person may not edit', async () => {
    await open(prefs(null, false))
    expect(screen.getByRole('status').textContent).toBe('Nothing to see here.')
    expect(screen.queryByTestId('nav-order-editor')).toBeNull()
  })

  it('shows the placard when the server never said (no flag at all)', async () => {
    await open({ bar_layout: null, more_pins: null })
    expect(screen.queryByTestId('nav-order-editor')).toBeNull()
  })

  it('shows the editor, titled for its owner, when the server says yes', async () => {
    await open()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Your tab bar')
    expect(document.body.textContent).toMatch(/your tab bar only — nobody else’s/)
    expect(rows()).toEqual(DEFAULT_NAV_TABS)
  })

  // Asserted against the SOURCE, because the defect is a thing a future session would ADD in good
  // faith ("hide the page from Jen" with a client list), and it would pass every render test here.
  it('does not hardcode a Clerk sub or an admin allowlist', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../pages/AdminConfig.jsx'), 'utf8')
    expect(src).not.toMatch(/user_[0-9A-Za-z]{20,}/)
    expect(src).not.toMatch(/ADMIN_[A-Z_]*\s*=\s*\[/)
    expect(src).not.toMatch(/isAdmin\s*[=:]/)
  })
})

describe('the editor opens on what the server holds', () => {
  it('opens on the stored order and the stored moves', async () => {
    await open(prefs({ order: ['harvests', 'today', 'create', 'garden', 'put-up'], hidden: ['put-up'] }))
    expect(rows()).toEqual(['harvests', 'today', 'create', 'garden', 'put-up'])
    expect(inBar('Put-Up').checked).toBe(false)
    expect(inBar('Garden').checked).toBe(true)
  })

  // Seeded through resolveBarLayout, not the raw column: a value the BAR ignores is not presented
  // here as though it were live. KILLING MUTATION: seed from prefs.bar_layout raw. RESULT: RED.
  it('opens on the shipped layout when the stored value is one the bar rejects', async () => {
    await open(prefs({ order: ['today', 'today', 'garden', 'create', 'harvests'], hidden: ['create'] }))
    expect(rows()).toEqual(DEFAULT_NAV_TABS)
    expect(inBar('Put-Up').checked).toBe(true)
  })
})

describe('THE STALE-SEED FIX — Save never writes a value nobody chose', () => {
  // The read is SLOW: the cache says Dave may edit, but prefs have not answered. Before this fix the
  // page seeded from the default right here and a Save wrote it.
  // KILLING MUTATION: enable Save whenever dirty (drop the serverLayout requirement). RESULT: RED.
  it('Save is disabled until the server’s value has been read, even after an edit', async () => {
    localStorage.setItem(BAR_LAYOUT_CACHE_KEY, JSON.stringify({ userId: 'dave', layout: null, canEdit: true }))
    let answer
    fetchPrefsSpy.mockReturnValue(new Promise(r => { answer = r }))
    await act(async () => { render(tree()) })
    moveDown('Today')
    expect(saveButton().disabled).toBe(true)
    await act(async () => { answer(prefs(null)) })
    expect(saveButton().disabled).toBe(false)
  })

  // KILLING MUTATION: seed once at mount (useState(base)) instead of following the server value until
  // the person edits. RESULT: RED — the editor keeps showing the default the slow read left behind.
  it('an untouched editor switches to the server’s value when it lands — not the default', async () => {
    localStorage.setItem(BAR_LAYOUT_CACHE_KEY, JSON.stringify({ userId: 'dave', layout: null, canEdit: true }))
    let answer
    fetchPrefsSpy.mockReturnValue(new Promise(r => { answer = r }))
    await act(async () => { render(tree()) })
    expect(rows()).toEqual(DEFAULT_NAV_TABS)
    await act(async () => { answer(prefs({ order: ['garden', 'today', 'create', 'harvests', 'put-up'], hidden: ['harvests'] })) })
    expect(rows()).toEqual(['garden', 'today', 'create', 'harvests', 'put-up'])
    expect(inBar('Harvests').checked).toBe(false)
    expect(saveButton().disabled).toBe(true)   // nothing changed yet
  })

  // KILLING MUTATION: drop the readFailed line, or treat a failed read as loaded. RESULT: RED.
  it('a FAILED read keeps Save off and says the current bar could not be read', async () => {
    localStorage.setItem(BAR_LAYOUT_CACHE_KEY, JSON.stringify({ userId: 'dave', layout: null, canEdit: true }))
    await open(null)
    expect(screen.getByTestId('bar-read-failed').textContent).toMatch(/could not be read/)
    moveDown('Today')
    expect(saveButton().disabled).toBe(true)
  })

  it('Save is inert until something actually changed', async () => {
    await open()
    expect(saveButton().disabled).toBe(true)
    moveDown('Today')
    expect(saveButton().disabled).toBe(false)
    moveUp('Today')
    expect(saveButton().disabled).toBe(true)
  })
})

describe('moving tabs — Today and ＋ never leave the bar', () => {
  // KILLING MUTATION: render the checkbox on every row. RESULT: RED.
  it('offers "In bar" on Garden, Harvests and Put-Up only', async () => {
    const { container } = await open()
    const boxes = [...container.querySelectorAll('input[type="checkbox"]')].map(b => b.getAttribute('aria-label'))
    expect(boxes).toEqual(['Garden in bar', 'Harvests in bar', 'Put-Up in bar'])
    const fixed = screen.getAllByTestId('nav-order-fixed').map(f => f.closest('[data-testid="nav-order-row"]').getAttribute('data-tab-key'))
    expect(fixed).toEqual(['today', 'create'])
  })

  it('unticking a tab moves it out of the preview and names where it goes', async () => {
    await open()
    fireEvent.click(inBar('Put-Up'))
    expect(preview()).toEqual(['today', 'garden', 'create', 'harvests', 'more'])
    expect(document.body.textContent).toMatch(/In More, at the top of “Your garden”: Put-Up\./)
    fireEvent.click(inBar('Put-Up'))
    expect(preview()).toEqual(['today', 'garden', 'create', 'harvests', 'put-up', 'more'])
  })

  // The preview is the bar THIS person gets, More last, in the edited order.
  it('the preview follows the edited order and always ends in More', async () => {
    await open()
    moveDown('Today')
    fireEvent.click(inBar('Harvests'))
    expect(preview()).toEqual(['garden', 'today', 'create', 'put-up', 'more'])
  })

  it('moves a tab down and back up; the ends cannot walk off the list', async () => {
    await open()
    moveDown('Today')
    expect(rows()).toEqual(['garden', 'today', 'create', 'harvests', 'put-up'])
    moveUp('Today')
    expect(rows()).toEqual(DEFAULT_NAV_TABS)
    expect(screen.getByLabelText('Move Today up').disabled).toBe(true)
    expect(screen.getByLabelText('Move Put-Up down').disabled).toBe(true)
  })

  // An unticked tab keeps its place, so ticking it back puts it where it was.
  it('a moved tab keeps its place in the order', async () => {
    await open()
    fireEvent.click(inBar('Garden'))
    expect(rows()).toEqual(DEFAULT_NAV_TABS)
  })

  it('Reset restores the shipped order with nothing moved', async () => {
    await open(prefs({ order: ['harvests', 'today', 'create', 'garden', 'put-up'], hidden: ['put-up', 'garden'] }))
    fireEvent.click(screen.getByText('Reset'))
    expect(rows()).toEqual(DEFAULT_NAV_TABS)
    for (const l of ['Garden', 'Harvests', 'Put-Up']) expect(inBar(l).checked).toBe(true)
    expect(saveButton().disabled).toBe(false)
  })
})

describe('the write', () => {
  it('sends exactly the edited order and moves', async () => {
    await open()
    moveDown('Today')
    fireEvent.click(inBar('Put-Up'))
    await act(async () => { fireEvent.click(saveButton()) })
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy.mock.calls[0][0].layout).toEqual({ order: ['garden', 'today', 'create', 'harvests', 'put-up'], hidden: ['put-up'] })
  })

  // KILLING MUTATION: drop applyLayout from the success path. RESULT: RED — the bar (read here through
  // the same hook BottomNav uses) would not change until the next launch, after Dave pressed Save and
  // was told it had. The re-read alone cannot do it: a mid-session prefs read never re-lays the bar.
  it('on success the bar changes at once (applyLayout) and prefs are re-read', async () => {
    function BarProbe() {
      return <span data-testid="live-bar">{useNavLayout().bar.map(t => t.key).join(',')}</span>
    }
    fetchPrefsSpy.mockResolvedValue(prefs(null))
    await act(async () => { render(<PrefsProvider><NavPrefsProvider><AdminConfig /><BarProbe /></NavPrefsProvider></PrefsProvider>) })
    expect(screen.getByTestId('live-bar').textContent).toBe(DEFAULT_NAV_TABS.join(','))
    fireEvent.click(inBar('Garden'))
    fetchPrefsSpy.mockResolvedValue(prefs({ order: [...DEFAULT_NAV_TABS], hidden: ['garden'] }))
    await act(async () => { fireEvent.click(saveButton()) })
    expect(screen.getByTestId('live-bar').textContent).toBe('today,create,harvests,put-up')
    expect(JSON.parse(localStorage.getItem(BAR_LAYOUT_CACHE_KEY)).layout).toEqual({ order: [...DEFAULT_NAV_TABS], hidden: ['garden'] })
    expect(fetchPrefsSpy).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status').textContent).toBe('Saved. Your tab bar has changed.')
    expect(inBar('Garden').checked).toBe(false)
    expect(saveButton().disabled).toBe(true)
  })

  // A rejection must not be reported like an outage, and neither may be reported as a save.
  it('reports a rejected layout instead of claiming a save, and keeps the edit on screen', async () => {
    saveSpy.mockResolvedValue({ ok: false, status: 400 })
    await open()
    moveDown('Today')
    await act(async () => { fireEvent.click(saveButton()) })
    expect(screen.getByRole('status').textContent).toMatch(/Not saved — the server rejected this layout/)
    expect(rows()).toEqual(['garden', 'today', 'create', 'harvests', 'put-up'])
    expect(fetchPrefsSpy).toHaveBeenCalledTimes(1)   // no re-read on a failure
  })

  it('reports an unreachable server distinctly, and never swaps to the placard for it', async () => {
    saveSpy.mockResolvedValue({ ok: false, status: 0 })
    await open()
    moveDown('Today')
    await act(async () => { fireEvent.click(saveButton()) })
    expect(screen.getByRole('status').textContent).toMatch(/could not reach the server/i)
    expect(screen.getByTestId('nav-order-editor')).toBeTruthy()
  })
})

// QA MINOR-1 — the re-read AFTER a successful Save. The PATCH's 200 means the server stored exactly the
// saved layout, so that is the editor's server value for the rest of the visit, whatever the re-read
// returns. KILLING MUTATIONS: drop the savedLayout override of serverLayout; let readFailed ignore it.
// RESULT: RED — "Saved" and "could not be read" together, the old bar back in the editor, Save dead.
describe('after a successful Save, the re-read cannot take the saved bar away', () => {
  it('a FAILED re-read: no "could not be read", the saved bar stays, and Save still works', async () => {
    await open()
    fireEvent.click(inBar('Garden'))
    fetchPrefsSpy.mockResolvedValue(null)                 // the re-read fails
    await act(async () => { fireEvent.click(saveButton()) })
    expect(screen.getByRole('status').textContent).toBe('Saved. Your tab bar has changed.')
    expect(screen.queryByTestId('bar-read-failed')).toBeNull()
    expect(inBar('Garden').checked).toBe(false)
    expect(saveButton().disabled).toBe(true)             // nothing changed since the save…
    fireEvent.click(inBar('Harvests'))
    expect(saveButton().disabled).toBe(false)            // …and Save did not die
  })

  it('an OLDER re-read (a GET that left before the Save) does not roll the editor back', async () => {
    await open()
    fireEvent.click(inBar('Garden'))
    fetchPrefsSpy.mockResolvedValue(prefs(null))          // the pre-save row
    await act(async () => { fireEvent.click(saveButton()) })
    expect(inBar('Garden').checked).toBe(false)
    expect(saveButton().disabled).toBe(true)
    expect(preview()).toEqual(['today', 'create', 'harvests', 'put-up', 'more'])
  })
})

describe('reachability (the gate this surface was placed to inherit)', () => {
  const ROOT = path.resolve(__dirname, '../..')

  it('registers /admin/config with a single-quoted path, as the reachability regex requires', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8')
    const routes = [...appSrc.matchAll(/path:\s*'(\/admin\/[^']*)'/g)].map(m => m[1])
    expect(routes).toContain('/admin/config')
  })

  it('keeps its Back to Debug & smoke link', async () => {
    await open()
    expect(screen.getByText('Back to Debug & smoke').closest('a').getAttribute('href')).toBe('/admin')
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
