// Two defects on /seeds/saved, both reachable the moment a lot is actually tracked.
//
// BUG-SEEDPROCFORCED-001 — "Track a saved-seed lot" offered exactly one action and it hard-coded
// `fermenting`. The POST it fires writes a PERMANENT row into seed_lot_stage_log, so the only way to
// track a dry-cleaned lot was to assert a ferment that never happened. Dave's founding case is a
// melon lot cleaned dry; so are beans, peas, lettuce and every brassica. The process is now chosen,
// and the entry stage follows from it.
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

const lot = (over = {}) => ({
  id: 'inv-1', name: 'Green Flesh Honeydew', variety_name: 'Green Flesh Honeydew',
  category: 'seeds', variety_id: 'v-melon', seed_stage: 'drying', seed_process: null,
  source_plant_id: null,
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

  it('offers exactly the live seed_process vocabulary — wet and dry, nothing invented', async () => {
    // inventory_items_seed_process_check on prod, read 2026-09-02:
    //   seed_process IS NULL OR seed_process = ANY (ARRAY['wet','dry'])
    // A third option here would 400 at the handler and 23514 at the DB.
    await mount([untracked])
    await click('track-a-lot')
    await click('track-candidate')
    const opts = screen.getAllByTestId(/^start-process-(wet|dry)$/)
    expect(opts).toHaveLength(2)
    expect(opts.map((b) => b.getAttribute('data-testid')))
      .toEqual(['start-process-wet', 'start-process-dry'])
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
    await click('stage-save')

    const w = writes()
    expect(w).toHaveLength(1)
    const body = JSON.parse(w[0][1].body)
    expect(Object.prototype.hasOwnProperty.call(body, 'seed_process')).toBe(false)
    expect(body.stage).toBe('stored')
  })
})

describe('BUG-SEEDELAPSEDUPDATED-001 — elapsed measures the stage, not the last edit', () => {
  it('reads stage_entered_at even when the row was updated seconds ago', async () => {
    await mount([lot()])
    const card = screen.getByTestId('seed-lot-card').textContent
    // updated_at is ~15 minutes old in this fixture; reading it would render "today".
    expect(card).toContain('4 days in drying')
    expect(card).not.toContain('today')
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
