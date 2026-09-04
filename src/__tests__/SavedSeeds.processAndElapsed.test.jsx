// Two defects on /seeds/saved, both reachable the moment a lot is actually tracked.
//
// BUG-SEEDPROCFORCED-001 — "Track a saved-seed lot" offered exactly one action and it hard-coded
// `fermenting`. The POST it fires writes a PERMANENT row into seed_lot_stage_log, so the only way to
// track a lot that was never fermented was to assert a ferment that never happened. The dry cases
// are beans, peas, lettuce and every brassica — seed threshed from a pod dried on the plant. The
// process is now chosen, and the entry stage follows from it.
//
// CORRECTED 2026-09-02: this header used to name melon as the founding dry-cleaned case. Melon is a
// WET extraction — the seed is washed out of the pulp — so it belonged on the other side of the very
// distinction this test file exists to defend. The fixture below still uses a 'v-melon' variety id
// with seed_stage 'drying', which is harmless as an opaque string but is not a horticultural claim.
//
// BUG-SEEDELAPSEDUPDATED-001 — the card led with elapsed(item.updated_at), and set_updated_at is a
// BEFORE UPDATE ROW trigger that fires on EVERY write to the row. So attaching a parent plant reset
// "4 days in drying" to "today" with no stage change at all. Elapsed now comes from the server's
// stage_entered_at (the lot's latest seed_lot_stage_log entry for its CURRENT stage).
//
// TIME IS REAL HERE, NOT FAKED. The fixtures are built as offsets from Date.now() at render, so the
// assertions read the same divergence a user sees and no timer mock can make them pass vacuously —
// updated_at is deliberately NEWER than stage_entered_at in every case, which is exactly the shape
// the trigger produces. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
}))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString()

// `status` is on the fixture because it is on every real row and because the untracked-packet
// picker now filters on it — V4-SEEDSTOREDQTY-001.
const lot = (over = {}) => ({
  id: 'inv-1', name: 'Green Flesh Honeydew', variety_name: 'Green Flesh Honeydew',
  category: 'seeds', variety_id: 'v-melon', seed_stage: 'drying', seed_process: null,
  status: 'active', source_plant_id: null,
  // The trigger's signature: the row was touched a moment ago, the STAGE was entered days ago.
  updated_at: daysAgo(0.01),
  stage_entered_at: daysAgo(4.2),
  ...over,
})

const mount = async (items) => {
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([])
    if (p.startsWith('/api/inventory-items')) return Promise.resolve(items)
    return Promise.resolve([])
  })
  await act(async () => { render(<ToastProvider><SavedSeeds /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
}

const writes = () => fetchSpy.mock.calls.filter(([, o]) => o?.method)
const click = async (testId) => {
  await act(async () => { fireEvent.click(screen.getByTestId(testId)) })
}

beforeEach(() => { fetchSpy.mockReset() })

describe('BUG-SEEDPROCFORCED-001 — starting a lot no longer asserts a ferment', () => {
  const untracked = lot({ id: 'inv-new', seed_stage: null, stage_entered_at: null })

  it('asks for the process instead of dropping straight into fermenting', async () => {
    await mount([untracked])
    await click('track-a-lot')
    await click('track-candidate')
    // The old flow went picker -> advance sheet titled "Move to fermenting" with no question asked.
    expect(screen.getByTestId('start-process-step')).toBeTruthy()
    expect(screen.queryByTestId('stage-save')).toBeNull()
  })

  it('RENDERS exactly the declared seed_process vocabulary, in order — nothing dropped, nothing invented', async () => {
    // THE MATCHER MUST STAY OPEN. This assertion previously read
    //   getAllByTestId(/^start-process-(wet|dry)$/) ... toHaveLength(2)
    // and it went silently vacuous the moment `fresh` was added to PROCESS_ENTRY: the alternation
    // could not see `start-process-fresh`, so the length stayed 2, the toEqual stayed satisfied, and
    // the test kept passing with THREE buttons on screen under a title claiming there were two. A
    // filtering regex cannot detect the thing it filters out. `/^start-process-/` can.
    //
    // This test owns exactly one link in the chain: RENDER matches DECLARATION. It deliberately does
    // not re-check the declaration against the database — seedFreshProcess.test.js already pins
    // PROCESS_ENTRY to both Lambda SEED_PROCESSES copies and to the migration's widened CHECK by
    // source-text scrape, and pins this same wet -> fresh -> dry order in both mirrors. But every one
    // of those reads source text and none of them renders, so nothing there would notice if the
    // chooser at SavedSeeds.jsx:961 started filtering or slicing what it maps. That gap is this test.
    //
    // Order is asserted, not just the set: it reads wettest to driest, which is the sequence a
    // gardener scans. A set comparison would let the two mirrors drift in order invisibly.
    await mount([untracked])
    await click('track-a-lot')
    await click('track-candidate')

    // Two testids under this prefix are STRUCTURE, not vocabulary: the step container (a div) and
    // the back button. They are named here rather than pattern-excluded so that a THIRD structural
    // testid lands in `options` below and reds this test — noisy, but the safe polarity. The failure
    // that must never recur is the silent one, where a new value slips past the matcher unseen.
    const STRUCTURAL = ['start-process-step', 'start-process-back']
    const rendered = screen.getAllByTestId(/^start-process-/).map((el) => el.getAttribute('data-testid'))

    // Instrument check FIRST. Without it every assertion below is satisfiable by a sheet that
    // rendered nothing at all — `[].filter(...)` deep-equals `[]`, and an empty page would pass a
    // bare set comparison silently. This is the same guard candidatePicker.test.jsx:88-92 uses.
    for (const id of STRUCTURAL) expect(rendered, `sheet did not render ${id}`).toContain(id)

    const options = rendered.filter((id) => !STRUCTURAL.includes(id))
    expect(options).toEqual(['start-process-wet', 'start-process-fresh', 'start-process-dry'])
  })

  it('a DRY lot enters at drying and records the dry process — never a fermenting row', async () => {
    await mount([untracked])
    await click('track-a-lot')
    await click('track-candidate')
    await click('start-process-dry')
    await click('stage-save')

    const w = writes()
    expect(w).toHaveLength(1)
    expect(`${w[0][1].method} ${w[0][0]}`).toBe('POST /api/inventory-items/inv-new/seed-stage')
    const body = JSON.parse(w[0][1].body)
    expect(body.stage).toBe('drying')
    expect(body.seed_process).toBe('dry')
    // The whole point. A permanent seed_lot_stage_log row saying `fermenting` for a lot that was
    // never fermented is the false record this defect was about.
    expect(body.stage).not.toBe('fermenting')
  })

  it('calls a first stage a START, not a move', async () => {
    // Copy, but not cosmetic: "Move to drying" on a lot that has never had a stage asserts a step
    // before it — for a dry lot that step would be the ferment this whole fix exists to not claim.
    await mount([untracked])
    await click('track-a-lot')
    await click('track-candidate')
    await click('start-process-dry')
    expect(document.body.textContent).toContain('Start in drying')
    expect(document.body.textContent).not.toContain('Move to drying')
  })

  it('a WET lot still enters at fermenting, and now says so', async () => {
    await mount([untracked])
    await click('track-a-lot')
    await click('track-candidate')
    await click('start-process-wet')
    await click('stage-save')

    const w = writes()
    expect(w).toHaveLength(1)
    const body = JSON.parse(w[0][1].body)
    expect(body.stage).toBe('fermenting')
    expect(body.seed_process).toBe('wet')
  })

  it('a plain ADVANCE omits seed_process entirely, so it cannot clear one', async () => {
    // The handler guards on presence, so an explicit null would WIPE a recorded process. The key
    // must be absent, not null — `toEqual(expect.not.objectContaining)` would pass on null.
    await mount([lot({ seed_process: 'dry' })])
    await click('advance-stage')
    // BUG-SEEDZEROSOWABLE-001 (2026-09-02): this fixture advances drying -> stored, and that
    // transition now REFUSES a blank count before issuing any request. The count is typed here so
    // the assertion below still exercises what it is about — the shape of the stage POST — rather
    // than silently becoming a test that nothing is sent at all.
    await act(async () => {
      fireEvent.change(screen.getByTestId('seed-count-input'), { target: { value: '12' } })
    })
    await click('stage-save')

    const w = writes()
    // V5-SEEDQTY-001 split the second write in two. Three now: the stage POST, then the NARROW
    // /seed-measure PUT carrying the typed count, then the wide PUT that still exists on this page
    // solely to carry year_harvested. The count no longer rides the wide body at all.
    expect(w).toHaveLength(3)
    const body = JSON.parse(w[0][1].body)
    expect(w[0][1].method).toBe('POST')
    expect(Object.prototype.hasOwnProperty.call(body, 'seed_process')).toBe(false)
    expect(body.stage).toBe('stored')
  })
})

describe('BUG-SEEDELAPSEDUPDATED-001 — elapsed measures the stage, not the last edit', () => {
  it('reads stage_entered_at even when the row was updated seconds ago', async () => {
    await mount([lot()])
    const card = screen.getByTestId('seed-lot-card').textContent
    // updated_at is ~15 minutes old in this fixture; reading it would render "today".
    //
    // BOUNDED, not `toContain`. This assertion read `toContain('4 days in drying')` until
    // 2026-09-04, and `'14 days in drying'.includes('4 days in drying')` is `true` — so it passed on
    // a value ten days wrong, on the one line the page exists to be read for. The leading boundary
    // is the entire fix; the trailing one keeps a future "4 days in dryingish" from sneaking past.
    expect(card).toMatch(/(?:^|\D)4 days in drying(?:\D|$)/)
    expect(card).not.toContain('today')
  })

  // A SECOND AGE, because one age cannot tell a correct duration from an off-by-N one — an
  // `elapsedDays` that added a constant, or that dropped the leading digit, survives any
  // single-point test. This pair is also what proves the boundary above is real rather than
  // decorative: under the old `toContain` assertion, BOTH of these cases passed either way.
  it('renders the whole number, not a suffix of it, at two digits', async () => {
    await mount([lot({ stage_entered_at: daysAgo(14.2) })])
    const card = screen.getByTestId('seed-lot-card').textContent
    expect(card).toMatch(/(?:^|\D)14 days in drying(?:\D|$)/)
    expect(card).not.toMatch(/(?:^|\D)4 days in drying(?:\D|$)/)
  })

  it('renders no duration at all when the lot has no stage entry — never a fabricated one', async () => {
    // No fallback to updated_at: that is what produced the wrong number, and a plausible wrong
    // duration is worse than an absent one on a page whose job is to say what needs checking.
    await mount([lot({ stage_entered_at: null })])
    const card = screen.getByTestId('seed-lot-card').textContent
    expect(card).toContain('In drying')
    expect(card).not.toContain('today')
    expect(card).not.toMatch(/\d+ days? in/)
  })

  it('sorts a stage by how long each lot has sat, not by which was edited last', async () => {
    // updated_at order is the REVERSE of stage_entered_at order here, so a sort keyed on the wrong
    // column produces the wrong list rather than accidentally the right one.
    await mount([
      lot({ id: 'a', name: 'Recently entered', variety_name: 'Recently entered',
            stage_entered_at: daysAgo(1), updated_at: daysAgo(9) }),
      lot({ id: 'b', name: 'Oldest in stage', variety_name: 'Oldest in stage',
            stage_entered_at: daysAgo(11), updated_at: daysAgo(0.01) }),
      lot({ id: 'c', name: 'Unknown entry', variety_name: 'Unknown entry',
            stage_entered_at: null, updated_at: daysAgo(5) }),
    ])
    const cards = screen.getAllByTestId('seed-lot-card')
    expect(cards).toHaveLength(3)
    // Oldest-in-stage first; the lot with no measurable duration sorts LAST rather than claiming
    // the top of a "check this" list.
    expect(cards.map((c) => c.textContent.split(' ')[0]))
      .toEqual(['Oldest', 'Recently', 'Unknown'])
  })
})
