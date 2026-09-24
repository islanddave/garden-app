/**
 * src/__tests__/AdminConfig.refreshJoin.test.jsx
 *
 * V5-NAVCUSTOM-001 — regression seat M5, reproduced as a unit test. AdminConfig is the FIRST caller of
 * PrefsContext.refreshPrefs, and refreshPrefs goes through fetchNotificationPrefs, whose single-flight
 * latch hands back any GET already in flight. So when another surface's prefs read is in flight at the
 * moment Dave's Save lands, the "read after write" JOINS that pre-save GET — and before the fix its
 * landing rewrote nav.barLayout.v1 with the pre-save layout while the live bar showed the saved one:
 * the next launch drew the OLD bar.
 *
 * Unlike AdminConfig.test.jsx, nothing here is stubbed at the module edge: the real PrefsProvider,
 * NavPrefsProvider, fetchNotificationPrefs (with its latch) and saveBarLayout run, and only `fetch`
 * is faked. The latch is the mechanism under test, so stubbing the client would test nothing.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The prefs client reads its base URL at module load, so it is set before any import runs, and put
// back afterwards so no later file in this worker inherits it.
const { prevBase } = vi.hoisted(() => {
  const prevBase = process.env.VITE_API_CRITTERS
  process.env.VITE_API_CRITTERS = 'https://critter.test'
  return { prevBase }
})
afterAll(() => {
  if (prevBase === undefined) delete process.env.VITE_API_CRITTERS
  else process.env.VITE_API_CRITTERS = prevBase
})

vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'dave' } }) }))
vi.mock('../lib/api.js', async (orig) => ({
  ...(await orig()),
  useApiFetch: () => ({ fetch: vi.fn(), getToken: async () => 'token' }),
}))

import AdminConfig from '../pages/AdminConfig.jsx'
import { PrefsProvider } from '../context/PrefsContext.jsx'
import { NavPrefsProvider, BAR_LAYOUT_CACHE_KEY, useNavLayout } from '../context/NavPrefsContext.jsx'
import { fetchNotificationPrefs, __resetPrefsFlight } from '../lib/notificationPrefsClient.js'
import { DEFAULT_NAV_TABS } from '../lib/navConfig.js'

const PRE_SAVE = { bar_layout: null, more_pins: null, can_edit_bar: true }
const SAVED = { order: [...DEFAULT_NAV_TABS], hidden: ['garden'] }

// The far side of the wire, with STATE: a PATCH changes the stored row, and a GET answers with the row
// as it stood when that GET was ISSUED — which is what makes a GET that left before the Save a
// pre-save body. Every GET is counted; `hold()` parks the NEXT GET until release().
let server
let gets = 0
let patches = []
let held = null
// A NEW object per parse, as res.json() gives: handing back one shared object would make every
// landing look like the one already folded, and the provider would (rightly) skip it.
const ok = (body) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) })
function hold() {
  let release
  held = new Promise(r => { release = r })
  return () => release()
}
beforeEach(() => {
  server = { ...PRE_SAVE }
  gets = 0
  patches = []
  held = null
  __resetPrefsFlight()
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    if (!String(url).endsWith('/api/notifications/prefs')) throw new Error(`unexpected ${url}`)
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body)
      patches.push(body)
      server = { ...server, ...body }
      return ok(server)
    }
    gets += 1
    const snapshot = JSON.parse(JSON.stringify(server))     // the row as of THIS request
    if (held) { const h = held; held = null; await h }
    return ok(snapshot)
  }))
})

function BarProbe() {
  return <span data-testid="live-bar">{useNavLayout().bar.map(t => t.key).join(',')}</span>
}
async function renderEditor() {
  await act(async () => {
    render(
      <MemoryRouter>
        <PrefsProvider><NavPrefsProvider><AdminConfig /><BarProbe /></NavPrefsProvider></PrefsProvider>
      </MemoryRouter>
    )
  })
}
const cachedLayout = () => JSON.parse(localStorage.getItem(BAR_LAYOUT_CACHE_KEY)).layout

describe('M5 — the editor’s re-read joins a GET that left before the Save', () => {
  // KILLING MUTATION: drop NavPrefsContext's barTouched guard (landings rewrite nav.barLayout.v1
  // after applyLayout). RESULT: RED — the cache holds the pre-save layout (null).
  it('the joined pre-save body does not put the old bar back in the launch cache', async () => {
    await renderEditor()
    expect(gets).toBe(1)                                       // the boot read
    // Another surface starts a prefs read, and it is still in flight when Dave saves.
    const release = hold()
    let other
    act(() => { other = fetchNotificationPrefs({ getToken: async () => 'token' }) })
    fireEvent.click(screen.getByLabelText('Garden in bar'))
    // The Save handler awaits its re-read, which is now parked on the held GET.
    act(() => { fireEvent.click(screen.getByText('Save')) })
    await act(async () => { await Promise.resolve() })
    expect(patches).toEqual([{ bar_layout: SAVED }])
    await act(async () => { release(); await other })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    // The re-read JOINED the in-flight GET: no third request went out. (The probe's precondition.)
    expect(gets).toBe(2)
    expect(screen.getByTestId('live-bar').textContent).toBe('today,create,harvests,put-up')
    expect(cachedLayout()).toEqual(SAVED)
    // …and the editor (QA MINOR-1's guard) still shows what was saved, not the joined pre-save row.
    // KILLING MUTATION: drop AdminConfig's savedLayout override. RESULT: RED — Garden re-ticked.
    expect(screen.getByLabelText('Garden in bar').checked).toBe(false)
    expect(screen.getByRole('status').textContent).toBe('Saved. Your tab bar has changed.')
  })

  // Negative control from the seat's probe: with nothing in flight the re-read is its own GET, issued
  // after the PATCH, so it carries the saved bar — green before and after the fix. It is what shows
  // the case above is red for the join and not for some other reason.
  it('control: with no read in flight the re-read is a fresh GET, and the saved bar is cached', async () => {
    await renderEditor()
    fireEvent.click(screen.getByLabelText('Garden in bar'))
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(gets).toBe(2)
    expect(cachedLayout()).toEqual(SAVED)
    expect(screen.getByTestId('live-bar').textContent).toBe('today,create,harvests,put-up')
  })
})
