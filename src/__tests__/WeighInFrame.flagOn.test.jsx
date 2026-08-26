// V4-WEIGHFRAME-001 — the fixed weigh-in frame, flag ON.
//
// SCOPE, stated so nothing here is read as more than it is: jsdom has NO layout engine, so this
// file can pin STRUCTURE (which track a thing is in, which CSS properties carry the mechanism,
// which scroll calls no longer fire, what the ledger says, what the drawer does, what mirrors) and
// cannot pin a single pixel. Every geometric claim — per-entry vertical travel, the 390x500 fit —
// is measured in real Chrome through tests/harness and recorded in the lane report, not here.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, deleteCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  deleteCalls: [],
  dataRef: { projects: [], locations: [], plants: [] },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null,
    reset: vi.fn(),
  }),
}))

vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
  WEIGH_IN_FRAME_ENABLED: true,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (<a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>),
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { SAVE_BAND_MIN_CLEARANCE_PX, FRAME_SAVE_HEIGHT_PX } from '../lib/saveBandLayout.js'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return Promise.resolve({ id: `evt-${postCalls.length}`, updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] })
    }
    if (options.method === 'DELETE' && path.startsWith('/api/events/')) {
      deleteCalls.push(path)
      return Promise.resolve({ ok: true })
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
}

async function renderSession(query = 'session=harvest') {
  searchParamsRef.current = new URLSearchParams(query)
  const r = render(<ToastProvider><EventNew /></ToastProvider>)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  return r
}

async function saveHarvest({ qty, weight }) {
  fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: qty } })
  if (weight != null) fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: weight } })
  await act(async () => { fireEvent.click(screen.getByText('Save')) })
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  deleteCalls.length = 0
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = []
  localStorage.clear()
  document.documentElement.style.removeProperty('--bottom-nav-height')
  wireApiFetch()
})

describe('V4-WEIGHFRAME-001 — the three-track frame', () => {
  it('is a non-scrolling 3-track grid, and the middle track is the only scroller', async () => {
    const { container } = await renderSession()
    const form = screen.getByTestId('weigh-frame')
    expect(form.style.display).toBe('grid')
    // The mechanism, pinned literally: auto / 1fr / auto is what makes an IME show-hide change ONLY
    // the middle track's height, leaving Save's distance from the bottom edge and the chooser's from
    // the top invariant.
    expect(form.style.gridTemplateRows).toBe('auto 1fr auto')
    // The outer shell must be a fixed height with overflow hidden. A minHeight would leave the
    // document scrollable and quietly restore everything the frame deletes.
    const shell = container.firstElementChild
    expect(shell.style.height).toBe('calc(100dvh - 52px)')
    expect(shell.style.overflow).toBe('hidden')
    expect(shell.style.minHeight).toBe('')
  })

  it('seats the chooser in track 1, the two fields and both pads in track 2, ledger+Save in track 3', async () => {
    await renderSession()
    const t1 = screen.getByTestId('weigh-frame-chooser')
    const t2 = screen.getByTestId('weigh-frame-body')
    const t3 = screen.getByTestId('weigh-frame-track3')

    expect(t1.contains(screen.getByTestId('evtnew-planting'))).toBe(true)
    expect(t2.contains(screen.getByLabelText('Harvest quantity'))).toBe(true)
    expect(t2.contains(screen.getByLabelText('Harvest weight'))).toBe(true)
    expect(t2.contains(screen.getByLabelText('Harvest quantity quick pick'))).toBe(true)
    expect(t2.contains(screen.getByLabelText('Harvest weight keypad'))).toBe(true)
    expect(within(t3).getByText('Save')).toBeTruthy()

    // Track 2 is the scroller and it bottom-aligns its own second row. `align-content: end` on the
    // track itself is NOT used and must not be reintroduced: measured in Chrome 151, a
    // `display:grid; align-content:end; overflow-y:auto` box whose content overflows reports
    // scrollHeight === clientHeight and swallows the overflow unreachably. `minmax(0,1fr) auto`
    // gives the identical picture when it fits and degrades to a real scroller when it does not.
    expect(t2.style.overflowY).toBe('auto')
    expect(t2.style.gridTemplateRows).toBe('minmax(0, 1fr) auto')
    expect(t2.style.alignContent).toBe('')
  })

  it('deletes the two scroll anchors: neither quantity focus nor a save calls scrollIntoView', async () => {
    // A non-vacuous guard needs the call to be POSSIBLE. jsdom does not implement scrollIntoView at
    // all, so anchorSectionToTop's own guard would make this pass whatever the source said. Install
    // one, then assert it is never reached.
    const scrollIntoView = vi.fn()
    const proto = window.HTMLElement.prototype
    const had = Object.prototype.hasOwnProperty.call(proto, 'scrollIntoView')
    const prev = proto.scrollIntoView
    proto.scrollIntoView = scrollIntoView
    try {
      await renderSession()
      fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
      fireEvent.focus(screen.getByLabelText('Harvest quantity'))
      expect(scrollIntoView).not.toHaveBeenCalled()
      await saveHarvest({ qty: '4', weight: '210' })
      await act(async () => { await new Promise(r => setTimeout(r, 0)) })
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      if (had) proto.scrollIntoView = prev; else delete proto.scrollIntoView
    }
  })

  it('MUTATION GUARD for the case above: the same probe DOES fire with the frame off', async () => {
    // Without this the test above is unfalsifiable — it would pass on a build where scrollIntoView
    // simply never existed. Re-import EventNew with the flag false and prove the probe catches the
    // shipped anchor.
    vi.resetModules()
    vi.doMock('../lib/featureFlags.js', async (importActual) => ({
      ...(await importActual()),
      PROJECTS_HIDDEN: false, PLANTING_REQUIRED_ENABLED: false, WEIGH_IN_FRAME_ENABLED: false,
    }))
    const { default: EventNewOff } = await import('../pages/EventNew.jsx')
    // ToastProvider must come from the SAME fresh module graph: resetModules gives the re-imported
    // EventNew a new ToastContext object, and the provider imported at the top of this file would
    // be a different context entirely ("useToast must be used within <ToastProvider>").
    const { ToastProvider: FreshToastProvider } = await import('../context/ToastContext.jsx')
    const scrollIntoView = vi.fn()
    const proto = window.HTMLElement.prototype
    const had = Object.prototype.hasOwnProperty.call(proto, 'scrollIntoView')
    const prev = proto.scrollIntoView
    proto.scrollIntoView = scrollIntoView
    try {
      searchParamsRef.current = new URLSearchParams('session=harvest')
      render(<FreshToastProvider><EventNewOff /></FreshToastProvider>)
      await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
      await act(async () => { await Promise.resolve() })
      fireEvent.focus(screen.getByLabelText('Harvest quantity'))
      expect(scrollIntoView).toHaveBeenCalled()
    } finally {
      if (had) proto.scrollIntoView = prev; else delete proto.scrollIntoView
      vi.doUnmock('../lib/featureFlags.js')
      vi.resetModules()
    }
  })

  it('drops the 120px spacer and the sticky band entirely', async () => {
    await renderSession()
    expect(screen.queryByTestId('save-sticky')).toBeNull()
    expect(screen.queryByTestId('harvest-session-strip')).toBeNull()
    const t3 = screen.getByTestId('weigh-frame-track3')
    // A real grid track, not a sticky overlay — which is why the static-bottom-inset bug
    // (BUG-SAVEBANDDEADINSET-001) cannot recur on it: there is no `bottom` to desync.
    expect(t3.style.position).toBe('')
    expect(t3.style.bottom).toBe('')
  })

  it('hides BottomNav for the session and restores it on unmount, paint and inset together', async () => {
    const { unmount } = await renderSession()
    const injected = document.getElementById('weigh-frame-nav-suppress')
    expect(injected).toBeTruthy()
    expect(injected.textContent).toContain('visibility:hidden')
    expect(document.documentElement.style.getPropertyValue('--bottom-nav-height')).toBe('0px')
    unmount()
    expect(document.getElementById('weigh-frame-nav-suppress')).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--bottom-nav-height')).toBe('')
  })

  it('leaves BottomNav alone outside a weigh-in session', async () => {
    await renderSession('event_type=harvest')
    expect(document.getElementById('weigh-frame-nav-suppress')).toBeNull()
  })
})

describe('V4-WEIGHFRAME-001 — the one-line ledger', () => {
  it('is present from entry zero and does not grow across four saves', async () => {
    await renderSession()
    const t3 = screen.getByTestId('weigh-frame-track3')
    expect(t3.style.height).toBe('48px')
    expect(screen.getByTestId('weigh-frame-log-toggle').textContent).toBe('Weigh-in — nothing logged yet')

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await saveHarvest({ qty: '12', weight: '340' })
    await saveHarvest({ qty: '5', weight: '860' })
    await saveHarvest({ qty: '3', weight: '120' })
    await saveHarvest({ qty: '7', weight: '210' })
    // Same node, same height, after the point where the shipped band has reached 202px.
    expect(screen.getByTestId('weigh-frame-track3').style.height).toBe('48px')
  })

  // V4-WEIGHLEDGERLAST-001 — this test was INVERTED on 2026-08-26. It used to require the running
  // count and the rolled-up kg total; Dave's directive that day was "Remove the session totals",
  // because the totals were crowding the one thing he reads off this row — the entry he just logged.
  // The negative assertions are the load-bearing half: without them this passes just as happily with
  // the totals restored, since the last entry would still be present in the string.
  it('names the last entry — date, plant, count and weight — and carries NO session total', async () => {
    await renderSession()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await saveHarvest({ qty: '12', weight: '340' })
    await saveHarvest({ qty: '5', weight: '860' })
    const summary = screen.getByTestId('weigh-frame-log-toggle').textContent
    // The entry: which day it lands on, which planting, how many, how heavy. Count AND weight — the
    // shipped label showed weight OR count, dropping the number being read off the scale.
    expect(summary).toContain('Today')
    expect(summary).toContain('Tomatoes 2026')
    expect(summary).toContain('5 count')
    expect(summary).toContain('860 g')
    // NOT the session count, and NOT the running total (12+5 rows; 340+860 = 1.2 kg).
    expect(summary).not.toContain('2 ·')
    expect(summary).not.toContain('1.2 kg')
    expect(summary).not.toContain('1200 g')
  })

  it('undoes the most recent entry from a control that never moves, with a distinguishable name', async () => {
    await renderSession()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await saveHarvest({ qty: '12', weight: '340' })
    await saveHarvest({ qty: '5', weight: '860' })
    const undo = screen.getByTestId('weigh-frame-undo')
    // The shipped strip gives all three of its Undo buttons the identical accessible name. This one
    // names the row it will destroy — now including the date it was filed under, since with a sticky
    // date the row being destroyed may not belong to today.
    expect(undo.getAttribute('aria-label')).toBe('Undo Today Tomatoes 2026 5 count  ·  860 g, most recent entry')
    await act(async () => { fireEvent.click(undo) })
    expect(deleteCalls).toEqual(['/api/events/evt-2'])
    // Undone rows leave the totals but stay in the record; the summary falls back to the row before.
    await waitFor(() => expect(screen.getByTestId('weigh-frame-log-toggle').textContent).toContain('340 g'))
  })

  it('the summary is the history disclosure — the first build in which that exists', async () => {
    await renderSession()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await saveHarvest({ qty: '12', weight: '340' })
    const toggle = screen.getByTestId('weigh-frame-log-toggle')
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe('weigh-frame-log')
    expect(screen.queryByTestId('weigh-frame-log')).toBeNull()

    fireEvent.click(toggle)
    const drawer = screen.getByTestId('weigh-frame-log')
    expect(drawer.textContent).toContain('Tomatoes 2026 — 12 count · 340 g')
    // Absolute, so it costs the standing layout zero px.
    expect(drawer.style.position).toBe('absolute')
    expect(screen.getByTestId('weigh-frame-log-toggle').getAttribute('aria-expanded')).toBe('true')
  })

  it('the drawer caps at the last 10 rows and its Undo buttons carry ordinals', async () => {
    await renderSession()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    for (let i = 1; i <= 12; i++) await saveHarvest({ qty: String(i), weight: '100' })
    fireEvent.click(screen.getByTestId('weigh-frame-log-toggle'))
    const drawer = screen.getByTestId('weigh-frame-log')
    const undos = within(drawer).getAllByRole('button', { name: /^Undo / })
    expect(undos.length).toBe(10)
    // Entry 3 is the oldest of the last ten of twelve, entry 12 the newest.
    expect(undos[0].getAttribute('aria-label')).toContain('entry 3')
    expect(undos[9].getAttribute('aria-label')).toContain('entry 12')
  })

  it('the disclosure is inert with nothing logged rather than promising rows it has not got', async () => {
    await renderSession()
    expect(screen.getByTestId('weigh-frame-log-toggle').disabled).toBe(true)
    expect(screen.queryByTestId('weigh-frame-undo')).toBeNull()
  })
})

describe('V4-WEIGHFRAME-001 — handedness mirrors task controls, never chrome', () => {
  async function ledgerOrder(hand) {
    localStorage.setItem('ui.handedness', hand)
    await renderSession()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await saveHarvest({ qty: '4', weight: '210' })
    const t3 = screen.getByTestId('weigh-frame-track3')
    // DOM order, which is also visual order — the mirror reorders the array rather than using
    // `flex-direction: row-reverse`, so tab order and reading order never disagree.
    return [...t3.querySelectorAll('button')]
      .map(b => b.dataset.testid || (b.textContent || '').trim())
      .filter(Boolean)
  }

  it('right-handed: Save on the far side, Undo at the row start', async () => {
    expect(await ledgerOrder('right')).toEqual(['weigh-frame-undo', 'weigh-frame-log-toggle', 'Save'])
  })

  it('left-handed: Save and the Undo column both flip', async () => {
    expect(await ledgerOrder('left')).toEqual(['Save', 'weigh-frame-log-toggle', 'weigh-frame-undo'])
  })

  it('an unset preference is right-handed, and a bad value is not adopted', async () => {
    localStorage.setItem('ui.handedness', 'sideways')
    await renderSession()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await saveHarvest({ qty: '4', weight: '210' })
    const t3 = screen.getByTestId('weigh-frame-track3')
    expect([...t3.querySelectorAll('button')].map(b => b.dataset.testid || (b.textContent || '').trim()).filter(Boolean))
      .toEqual(['weigh-frame-undo', 'weigh-frame-log-toggle', 'Save'])
  })
})

// ── V4-WEIGHFRAME-001 R1 — the pad-to-Save clearance, reconstructed from the markup ─────────────
//
// The real guard is scripts/layout-gate/save-band-clearance.mjs, which measures Chrome's rects at a
// true 390x500. This block exists because that gate runs in one CI job and takes ~90s, while the
// five inline styles it depends on can be edited by anyone in a second — and four of the five look
// like cosmetic padding.
//
// It is NOT a restatement of the constants. jsdom cannot lay out, but it CAN read inline styles, so
// the clearance is RECOMPUTED here from the rendered DOM — track 3's height and border, Save's
// height, the pad's own margin, the group's padding — and compared against the same policy floor the
// legacy arm uses. Any one of those five drifting fails this. What it cannot see is height added
// somewhere ELSE in the harvest row pushing the pad back down; that is the gate's job, and the two
// are complementary rather than redundant.
describe('V4-WEIGHFRAME-001 R1 — 20px between the weight pad and Save', () => {
  const px = v => parseFloat(v || '0') || 0

  async function geometry() {
    await renderSession()
    const t3 = screen.getByTestId('weigh-frame-track3')
    const save = within(t3).getByText('Save')
    const wtPad = screen.getByLabelText('Harvest weight keypad')
    const wtGroup = wtPad.parentElement
    const qtyPad = screen.getByLabelText('Harvest quantity quick pick')
    return { t3, save, wtPad, wtGroup, qtyPad, qtyWrap: qtyPad.parentElement }
  }

  it('the rendered styles add up to at least the legacy arm’s floor', async () => {
    const { t3, save, wtPad, wtGroup } = await geometry()
    // Save is bottom-aligned in the track, so everything from the pad's bottom edge to Save's top
    // edge is: the space below the pad inside track 2, plus track 3's border, plus the height the
    // button gives up at the top of the track.
    const belowPad = px(wtPad.style.marginBottom) + px(wtGroup.style.paddingBottom)
    const clearance = belowPad + px(t3.style.borderTop) + px(t3.style.height) - px(save.style.height)
    expect(clearance).toBeGreaterThanOrEqual(SAVE_BAND_MIN_CLEARANCE_PX)
  })

  it('the space below the pad is really below it — padding, not a margin that collapses out', async () => {
    const { wtPad, wtGroup } = await geometry()
    // Structural premise of the sum above. The group is the last child of a block with no padding or
    // border of its own, so a bottom MARGIN here collapses through and lands on the grid item
    // instead of growing it: the pad would not move and the gate would read the old 1px.
    expect(wtGroup.lastElementChild).toBe(wtPad)
    expect(px(wtGroup.style.paddingBottom)).toBeGreaterThan(0)
    expect(wtGroup.style.marginBottom).toBe('')
  })

  it('Save is bottom-aligned, because centring silently halves the gap', async () => {
    const { t3, save } = await geometry()
    // MEASURED: track 3 is `alignItems: center`, so a 44px Save in a 48px row centres at y402-446 —
    // 2px above and 2px wasted below a button whose bottom edge is the frame's. 18px, not 20px.
    expect(save.style.alignSelf).toBe('flex-end')
    expect(t3.style.alignItems).toBe('center')
    expect(px(save.style.height)).toBe(FRAME_SAVE_HEIGHT_PX)
    // The height was bought from a tap target, so the floor it landed on is asserted, not assumed.
    expect(px(save.style.height)).toBeGreaterThanOrEqual(44)
    expect(px(save.style.minWidth)).toBeGreaterThanOrEqual(44)
  })

  it('the quantity pad’s own 8px is cancelled — that is where 8 of the 20 came from', async () => {
    const { qtyPad, qtyWrap } = await geometry()
    // Track 2 measured 347/347 before this change: the gap could not be inserted, only funded. This
    // pad's margin was the largest unspent padding in the harvest row. Restoring it without taking
    // the 8px back out of the gap would push the pad down again, so the netting is pinned.
    expect(px(qtyPad.style.marginBottom)).toBeGreaterThan(0)
    expect(px(qtyWrap.style.marginBottom) + px(qtyPad.style.marginBottom)).toBe(0)
  })
})

// ── V4-WEIGHDATEREACH-001 + V4-WEIGHSESSIONCLOSE-001 (Dave directives, 2026-08-26) ─────────────
// Same SCOPE caveat as the head of this file: jsdom has no layout engine, so these pin STRUCTURE
// and BEHAVIOUR — which track the controls sit in, what the date does to the POST, where Close
// goes. The geometric claim they cannot make (that two 44px controls beside the chooser still leave
// track 1 at 52px and track 2 whole) is measured in real Chrome via tests/harness.

const ymdOffset = n => {
  const d = new Date(); d.setDate(d.getDate() + n)
  const p = x => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

describe('V4-WEIGHDATEREACH-001 — the date is reachable without scrolling', () => {
  it('lives in TRACK 1 beside the chooser, and is NOT left behind in the collapsed disclosure', async () => {
    await renderSession()
    const dateInput = screen.getByTestId('weigh-frame-date')
    // In track 1 — the whole point of the directive. Being merely "present somewhere" is what the
    // shipped build already was: it was in the collapsed "Photo, notes & date" body all along.
    expect(screen.getByTestId('weigh-frame-chooser').contains(dateInput)).toBe(true)
    expect(dateInput.getAttribute('type')).toBe('date')

    // ...and not ALSO in the disclosure. Two controls bound to one field is how a user sets a date
    // and watches the other one silently win.
    expect(screen.getByTestId('harvest-more-toggle').textContent).not.toMatch(/date/i)
    fireEvent.click(screen.getByTestId('harvest-more-toggle'))
    const body = screen.getByTestId('harvest-more-body')
    expect(within(body).queryByLabelText('Event date')).toBeNull()
    expect(screen.getAllByDisplayValue(ymdOffset(0)).length).toBe(1)
  })

  it('reads Today / Yesterday rather than a raw date, and the label tracks the value', async () => {
    await renderSession()
    // The chip is what makes this glanceable; the raw `08/26/2026` a native input paints is what
    // Dave has to stop and parse. aria-label carries the same phrase for the same reason.
    expect(screen.getByTestId('weigh-frame-date').getAttribute('aria-label')).toBe('Event date — Today')
    fireEvent.change(screen.getByTestId('weigh-frame-date'), { target: { value: ymdOffset(-1) } })
    expect(screen.getByTestId('weigh-frame-date').getAttribute('aria-label')).toBe('Event date — Yesterday')
    fireEvent.change(screen.getByTestId('weigh-frame-date'), { target: { value: '2026-03-04' } })
    expect(screen.getByTestId('weigh-frame-date').getAttribute('aria-label')).toBe('Event date — Mar 4')
  })

  it('actually changes the date the harvest is FILED UNDER, not just the label', async () => {
    await renderSession()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByTestId('weigh-frame-date'), { target: { value: ymdOffset(-1) } })
    await saveHarvest({ qty: '4', weight: '200' })
    // The POST body is the only thing that settles this — a control that repaints a chip and sends
    // today's date is exactly the bug Dave is trying to escape.
    expect(postCalls[0].event_date).toBe(ymdOffset(-1))
  })

  it('KEEPS the date across saves in a session — the sticky half of the directive', async () => {
    await renderSession()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByTestId('weigh-frame-date'), { target: { value: ymdOffset(-1) } })
    await saveHarvest({ qty: '4', weight: '200' })
    await saveHarvest({ qty: '6', weight: '300' })
    await saveHarvest({ qty: '2', weight: '100' })
    // Without this, working through yesterday's picking means re-setting the date on every entry —
    // the "major PITA" restated as a per-entry tax.
    expect(postCalls.map(c => c.event_date)).toEqual([ymdOffset(-1), ymdOffset(-1), ymdOffset(-1)])
    expect(screen.getByTestId('weigh-frame-date').getAttribute('aria-label')).toBe('Event date — Yesterday')
  })

  it('MUTATION GUARD: the stickiness is SESSION-scoped — the ordinary log form still resets to today', async () => {
    // Without this, `event_date: f.event_date` unconditionally would pass every test above while
    // silently backdating an unrelated event the user logs an hour later on the normal form.
    await renderSession('event_type=harvest')       // no session=harvest -> not a weigh-in session
    expect(screen.queryByTestId('weigh-frame')).toBeNull()
    expect(screen.queryByTestId('weigh-frame-date')).toBeNull()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    // Off the frame the date is back where it has always been — inside the collapsed disclosure,
    // which is itself the thing Dave was complaining about and which is deliberately NOT changed
    // for the ordinary log form.
    fireEvent.click(screen.getByTestId('harvest-more-toggle'))
    fireEvent.change(screen.getByLabelText('Event date'), { target: { value: ymdOffset(-1) } })
    await saveHarvest({ qty: '4', weight: '200' })
    await saveHarvest({ qty: '6', weight: '300' })
    expect(postCalls[0].event_date).toBe(ymdOffset(-1))
    expect(postCalls[1].event_date).toBe(ymdOffset(0))
  })

  it('the ledger names the day the row was filed under, not the day it was typed', async () => {
    await renderSession()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByTestId('weigh-frame-date'), { target: { value: ymdOffset(-1) } })
    await saveHarvest({ qty: '4', weight: '200' })
    // A backdated row logged minutes ago must not read "Today" — that is the one case where the
    // ledger's whole job (let Dave verify what just went in) turns into misinformation.
    const ledger = screen.getByTestId('weigh-frame-log-toggle').textContent
    expect(ledger).toContain('Yesterday')
    expect(ledger).not.toContain('Today')
  })
})

describe('V4-WEIGHSESSIONCLOSE-001 — the session has a way out', () => {
  it('offers a labelled Close in track 1', async () => {
    await renderSession()
    const close = screen.getByTestId('weigh-frame-close')
    expect(close.getAttribute('aria-label')).toBe('Close weigh-in session')
    // 44px floor — this sits beside the chooser at the top of the screen, and the frame suppresses
    // BottomNav, so it is the only deliberate exit on the surface.
    expect(close.style.minHeight).toBe('44px')
    expect(close.style.minWidth).toBe('44px')
    expect(screen.getByTestId('weigh-frame-chooser').contains(close)).toBe(true)
  })

  it('goes BACK when the session was opened from inside the app', async () => {
    window.history.replaceState({ idx: 3 }, '')
    await renderSession()
    fireEvent.click(screen.getByTestId('weigh-frame-close'))
    expect(navigateSpy).toHaveBeenCalledWith(-1)
  })

  it('falls back to /harvests on a cold start, rather than leaving the app', async () => {
    // idx 0 / absent is a PWA shortcut or a shared link — there is no app entry behind this one, so
    // navigate(-1) would walk out of the app entirely.
    window.history.replaceState(null, '')
    await renderSession()
    fireEvent.click(screen.getByTestId('weigh-frame-close'))
    expect(navigateSpy).toHaveBeenCalledWith('/harvests')
  })

  it('confirms before discarding a weight already typed, and stays put when refused', async () => {
    window.history.replaceState({ idx: 3 }, '')
    await renderSession()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '9' } })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      fireEvent.click(screen.getByTestId('weigh-frame-close'))
      expect(confirmSpy).toHaveBeenCalled()
      expect(navigateSpy).not.toHaveBeenCalled()   // refusing the confirm keeps the entry alive
      confirmSpy.mockReturnValue(true)
      fireEvent.click(screen.getByTestId('weigh-frame-close'))
      expect(navigateSpy).toHaveBeenCalledWith(-1)
    } finally { confirmSpy.mockRestore() }
  })

  it('does NOT confirm on an untouched form — the guard is about typed content, not about closing', async () => {
    window.history.replaceState({ idx: 3 }, '')
    await renderSession()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      fireEvent.click(screen.getByTestId('weigh-frame-close'))
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(navigateSpy).toHaveBeenCalledWith(-1)
    } finally { confirmSpy.mockRestore() }
  })
})
