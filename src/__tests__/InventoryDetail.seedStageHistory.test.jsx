// V4-SEEDHISTORY-001 — the seed-lot processing chain, rendered on /inventory/:id.
//
// WHAT THIS FILE EXISTS TO PROVE. GET /api/inventory-items/:id/seed-stage shipped with the write
// path and had ZERO consumers: the log was written on every advance and read by nothing, anywhere.
// A user who fermented, dried and stored a lot over two weeks got nothing back from the app for it.
// So the populated render is the headline assertion here, not a formality.
//
// THE THREE STATES ARE ASSERTED SEPARATELY AND AGAINST EACH OTHER. An empty list and a failed
// request are different facts, and a component that renders them the same way makes a claim it
// cannot support — "this lot has no history" when what actually happened is that the request was
// rejected. That is the shape BUG-PLANTFETCHSILENT-001 catalogued one card up on this same page, so
// the error test asserts BOTH that the failure is said out loud AND that the empty copy is absent.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, itemRef, historyRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  itemRef: { current: null },
  historyRef: { current: null },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useParams: () => ({ id: 'inv-1' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span data-testid="photo-upload" /> }))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({
    updateItem: vi.fn().mockResolvedValue({ item: {} }),
    deleteItem: vi.fn().mockResolvedValue({ ok: true }),
  }),
}))
// Stubbed rather than driven: the picker's own behaviour is covered by
// InventoryDetail.sourcePlant.test.jsx, and what this file needs from it is the ONE thing that
// reaches the chain — onChange(id, planting), whose second argument is where the parent's name
// comes from without a second request.
vi.mock('../components/forms/PlantingSelect.jsx', () => ({
  default: ({ value, onChange }) => (
    <button
      type="button"
      data-testid="planting-select"
      data-value={value ?? ''}
      onClick={() => onChange('pl-melon-2', { id: 'pl-melon-2', name: 'Green Flesh #2' })}
    >
      pick a planting
    </button>
  ),
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// The Green Flesh Honeydew lot from the design. seed_stage is the DENORMALISED current stage on the
// row; the log rows below are how it got there.
const LOT = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: 1, unit: 'packet', variety_id: 'v-melon',
  source_plant_id: null, seed_stage: 'stored', seed_process: 'wet',
}

// Newest first, exactly as the route orders them (ORDER BY entered_at DESC, created_at DESC).
// entered_at is pinned to NOON because that is what SavedSeeds writes — `${when}T12:00:00` — so the
// rendered calendar day is the same from either side of UTC.
const HISTORY = [
  { id: 'log-3', stage: 'stored',     entered_at: '2026-08-30T12:00:00.000Z', note: 'Packeted into a coin envelope', created_by: 'dave', created_at: '2026-08-30T12:01:00.000Z' },
  { id: 'log-2', stage: 'drying',     entered_at: '2026-08-24T12:00:00.000Z', note: null,                            created_by: 'dave', created_at: '2026-08-24T12:01:00.000Z' },
  { id: 'log-1', stage: 'fermenting', entered_at: '2026-08-20T12:00:00.000Z', note: 'Three days in the jar',         created_by: 'dave', created_at: '2026-08-20T12:01:00.000Z' },
]

const HISTORY_PATH = '/api/inventory-items/inv-1/seed-stage'

beforeEach(() => {
  fetchSpy.mockReset()
  itemRef.current = { ...LOT }
  historyRef.current = HISTORY
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (p === HISTORY_PATH) {
      return historyRef.current instanceof Error
        ? Promise.reject(historyRef.current)
        : Promise.resolve(historyRef.current)
    }
    if (p === '/api/inventory-items/inv-1' && !opts) return Promise.resolve(itemRef.current)
    return Promise.resolve([])
  })
})

const renderPage = async () => {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText(itemRef.current.name)).toBeTruthy())
}

const entries = () => screen.queryAllByTestId('seed-stage-entry')

describe('InventoryDetail — seed stage history (V4-SEEDHISTORY-001)', () => {
  it('reads the endpoint that had no consumers, once, for this lot', async () => {
    await renderPage()
    await waitFor(() => expect(entries().length).toBe(3))
    const calls = fetchSpy.mock.calls.filter(([p]) => String(p) === HISTORY_PATH)
    expect(calls).toHaveLength(1)
    // A GET: no options object at all, so no method, no body.
    expect(calls[0][1]).toBeUndefined()
  })

  it('renders every stage with its date and its note, newest first', async () => {
    await renderPage()
    await waitFor(() => expect(entries().length).toBe(3))
    const rows = entries()
    // Order is the server's, and it is the order the user thinks in — what happened last, first.
    expect(rows.map(r => r.dataset.stage)).toEqual(['stored', 'drying', 'fermenting'])
    expect(rows[0].textContent).toContain('Stored')
    expect(rows[0].textContent).toContain('Aug 30, 2026')
    // The note is the half that carries what the date cannot. Dropping it would leave a chain of
    // bare dates, which is a log rather than a record.
    expect(rows[0].textContent).toContain('Packeted into a coin envelope')
    expect(rows[2].textContent).toContain('Fermenting')
    expect(rows[2].textContent).toContain('Aug 20, 2026')
    expect(rows[2].textContent).toContain('Three days in the jar')
    // A stage entered with no note renders the stage and the date and nothing else — not the
    // string "null", which is what a missing null-guard looks like on screen.
    expect(rows[1].textContent).not.toContain('null')
  })

  it('says "undated" rather than rendering an empty slot', async () => {
    // entered_at is NOT NULL in the table, so this is the malformed/unparseable case rather than a
    // missing one — and a blank where a date belongs reads as a layout bug, not as a fact.
    historyRef.current = [{ ...HISTORY[0], entered_at: null }]
    await renderPage()
    await waitFor(() => expect(entries().length).toBe(1))
    expect(entries()[0].textContent).toContain('undated')
  })

  it('marks the entry the lot is actually sitting on', async () => {
    await renderPage()
    await waitFor(() => expect(entries().length).toBe(3))
    const marks = screen.getAllByTestId('seed-stage-entry-current')
    expect(marks).toHaveLength(1)
    expect(entries()[0].textContent).toContain('current')
  })

  it('says so when the current stage has no entry behind it — the repair case', async () => {
    // inventory_items.seed_stage can be set without a log row: the wide PUT and the create INSERT
    // both assign the column and append nothing, and only the /seed-stage CTE logs. That is the
    // shape of all three live staged lots. The newest entry and where the lot is now then
    // legitimately disagree, and leaving the user to notice that is how a correct record reads as a
    // broken one. (The client's own non-logging writer, the <select> that used to sit on this page,
    // was removed by V5-SEEDSTAGEONEPLACE-001 — the server-side two remain.)
    itemRef.current = { ...LOT, seed_stage: 'drying' }
    historyRef.current = [HISTORY[0]]  // one `stored` entry, lot corrected back to drying
    await renderPage()
    await waitFor(() => expect(screen.getByTestId('seed-stage-off-log')).toBeTruthy())
    expect(screen.getByTestId('seed-stage-off-log').textContent).toContain('Drying')
    expect(screen.queryAllByTestId('seed-stage-entry-current')).toHaveLength(0)
  })

  it('says so when the current stage is LOGGED but not the newest entry — the corrected-backwards case', async () => {
    // BUG-SEEDSTAGEHEADSHIP-001. The case above uses a ONE-ROW history, where "is the current stage
    // anywhere in the log" (membership) and "is it the newest entry" (headship) always agree — so it
    // passes under either predicate and cannot tell a working detector from a broken one.
    //
    // This is the fixture that separates them. Full history [stored, drying, fermenting] with the lot
    // corrected back to `drying`: the stage IS in the log at index 1, so the shipped `currentIdx ===
    // -1` test found no divergence and rendered nothing — leaving a CURRENT badge on the middle row
    // with a newer `stored` entry above it and no explanation. Correcting a stage BACKWARDS is the
    // commonest repair there is — /seeds/saved's correction door now logs one, dated to when the lot
    // actually entered it — so this was the detector's own central case.
    //
    // Mutation that must turn this red: `stageBehindLog = currentIdx > 0` → `= false`, or reverting
    // stageOffLog to `stageNotLogged` alone. Both leave every other test in this file green.
    itemRef.current = { ...LOT, seed_stage: 'drying' }
    historyRef.current = HISTORY
    await renderPage()
    await waitFor(() => expect(screen.getByTestId('seed-stage-off-log')).toBeTruthy())
    const notice = screen.getByTestId('seed-stage-off-log').textContent
    // The wording has to distinguish the two facts: this history goes FURTHER than the lot does,
    // which is the opposite complaint from "there is no entry for it".
    expect(notice).toContain('Drying')
    expect(notice).toContain('later entry')
    expect(notice).not.toContain('no processing entry')
    // The badge still marks where the lot actually is — the notice explains it, it does not replace it.
    expect(screen.getAllByTestId('seed-stage-entry-current')).toHaveLength(1)
    expect(entries()[1].textContent).toContain('current')
  })

  it('stays silent when the current stage IS the newest entry — the ordinary case', async () => {
    // The negative half. Without it, `stageOffLog = true` unconditionally would satisfy every
    // positive assertion in this file, and a notice that always fires is noise, not a detector.
    itemRef.current = { ...LOT, seed_stage: 'stored' }   // index 0, the head
    historyRef.current = HISTORY
    await renderPage()
    await waitFor(() => expect(screen.getByTestId('seed-stage-entries')).toBeTruthy())
    expect(screen.queryByTestId('seed-stage-off-log')).toBeNull()
  })

  it('says "none recorded yet" for a lot that was never staged', async () => {
    historyRef.current = []
    await renderPage()
    await waitFor(() => expect(screen.getByTestId('seed-stage-panel')).toBeTruthy())
    await waitFor(() => expect(screen.getByText(/No processing stages recorded yet/)).toBeTruthy())
    expect(entries()).toHaveLength(0)
  })

  it('a FAILED request reads as a failure, never as an empty history', async () => {
    // The whole point of the file. An empty list after a rejection asserts something the client
    // does not know — and it is indistinguishable from the truthful empty case above, so the user
    // would file a real chain as "nothing was ever recorded".
    historyRef.current = new Error('Network unreachable')
    await renderPage()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toContain('Network unreachable')
    expect(entries()).toHaveLength(0)
    expect(screen.queryByText(/No processing stages recorded yet/)).toBeNull()
  })

  it('retries on demand rather than stranding the user on the error', async () => {
    historyRef.current = new Error('Network unreachable')
    await renderPage()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    historyRef.current = HISTORY
    await act(async () => { fireEvent.click(screen.getByText('Retry')) })
    await waitFor(() => expect(entries().length).toBe(3))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does NOT render for a non-seed item', async () => {
    // Gated exactly like the Plant-from-packet CTA and the "Saved from" card. A hori-hori has no
    // processing chain, and an empty history block on every tool in the shed is clutter that also
    // implies the concept applies there.
    itemRef.current = {
      ...LOT, name: 'Hori hori knife', category: 'tools', type: 'durable',
      variety_id: null, seed_stage: null, seed_process: null, quantity: 1,
    }
    await renderPage()
    expect(screen.queryByTestId('seed-stage-panel')).toBeNull()
    expect(screen.queryByTestId('seed-stage-history')).toBeNull()
    // …and the endpoint is not called at all for it.
    expect(fetchSpy.mock.calls.some(([p]) => String(p) === HISTORY_PATH)).toBe(false)
  })

  it('links the parent planting, and names it once the page knows the name', async () => {
    itemRef.current = { ...LOT, source_plant_id: 'pl-melon' }
    await renderPage()
    const origin = await screen.findByTestId('seed-history-origin')
    // Loaded-with-the-item: the id is known and the name is not, because PlantingSelect exposes the
    // row only through onChange. The link still works — only the label degrades.
    expect(origin.querySelector('a').getAttribute('href')).toBe('/plantings/pl-melon')
    expect(origin.textContent).toContain('the parent planting')

    // Re-pointed in this session: the picker hands the row along with the id, so the chain can name
    // the new parent with no second request — and the link follows it.
    await act(async () => { fireEvent.click(screen.getByTestId('planting-select')) })
    await waitFor(() =>
      expect(screen.getByTestId('seed-history-origin').textContent).toContain('Green Flesh #2'))
    expect(screen.getByTestId('seed-history-origin').querySelector('a').getAttribute('href'))
      .toBe('/plantings/pl-melon-2')
  })

  it('shows the chain for a linked lot that has no stages yet', async () => {
    // Not the AsyncRegion empty branch: that short-circuits children, and routing this case through
    // it would hide the provenance the page has just recorded.
    itemRef.current = { ...LOT, source_plant_id: 'pl-melon', seed_stage: null }
    historyRef.current = []
    await renderPage()
    await waitFor(() => expect(screen.getByTestId('seed-history-origin')).toBeTruthy())
    expect(screen.getByTestId('seed-stage-none-yet')).toBeTruthy()
  })
})
