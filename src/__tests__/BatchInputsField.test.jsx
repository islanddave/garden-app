// V5-INFLIGHTBATCH-001 item A — BatchInputsField, and this file is its OWN sweep.
//
// ⚠ WHY THIS FILE EXISTS SEPARATELY FROM PutUpGoingNow.test.jsx. Every food-safety and readiness
// sweep in this lane is scoped to `getByTestId('going-now-view')`. The moment copy moves to a new
// surface those sweeps go on passing while guarding nothing — the assertion does not break, it stops
// being ABOUT anything. So this surface gets its own file, its own root testid
// (`batch-inputs-field`), and a green control on every absence arm.
//
// TEST-SHAPE RULES, inherited and each one earned:
//   • FULL LITERALS, both bounds and every separator. '14 days in drying'.includes('4 days in
//     drying') is true and this repo shipped exactly that, so every window, count and net line below
//     is asserted whole.
//   • EVERY not.toMatch / queryBy…toBeNull PAIRED with a positive assertion over the SAME query on
//     the SAME render.
//   • FIXED ZONELESS LOCAL DATE LITERALS, never Date.now() offsets — a ms offset is TZ-invariant by
//     construction and the blocking TZ=America/New_York re-run would have nothing to bite on.
//   • `nowMs` INJECTED, never the wall clock. It is what pins the window in the POST body to a
//     literal instead of to whenever the test happened to run.
//   • BOTH FIXTURE SIZES, 139 and 12. One count is a spot-check.
//
// CI LANE: `npm test` (vitest run --coverage) plus the blocking TZ re-run. No database.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import { P } from '../lib/constants.js'
import BatchInputsField from '../components/putup/BatchInputsField.jsx'
import { WHOLE_PICK_NOTICE, ALL_TIME_REFUSAL, INSERT_NONE_NEW } from '../components/putup/batchInputs.js'

const BATCH = '11111111-1111-4111-8111-111111111111'
// Noon LOCAL, so the ET civil day is 2026-09-04 under both TZ=UTC and TZ=America/New_York.
const NOW = new Date('2026-09-04T12:00:00').getTime()

const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const mkRow = (i) => ({
  id: uuid(i), harvest_log_id: uuid(i), quantity: '1', unit: 'count',
  weight_grams: String(20 + (i % 5) * 5),
  weight_basis: i % 3 === 0 ? 'cultivar_sample' : 'measured',
})
const PREDICATE_139 = Array.from({ length: 139 }, (_, i) => mkRow(i + 1))
const PREDICATE_12 = Array.from({ length: 12 }, (_, i) => mkRow(i + 1))

// GET /:id inputs[], exactly the 12 keys the route returns. Predicate-created rows carry a null
// label and a null qty pair by construction, so the fixture does too.
const inputRow = (i, over = {}) => ({
  id: `in-${i}`, batch_id: BATCH, input_kind: 'harvest', harvest_log_id: uuid(i),
  label: null, qty: null, qty_unit: null, is_byproduct: false,
  added_at: '2026-09-04T12:00:00.000Z', note: null,
  created_by: 'user_dave', created_at: '2026-09-04T12:00:00.000Z', ...over,
})

// 159 slugs exist in crop_types and only 32 have ever produced a harvest. This stands in for that
// ratio: five in the catalogue, two of them picked in the window.
const CROP_TYPES = [
  { slug: 'pepper', display_name: 'Pepper' },
  { slug: 'tomato', display_name: 'Tomato' },
  { slug: 'kohlrabi', display_name: 'Kohlrabi' },
  { slug: 'salsify', display_name: 'Salsify' },
  { slug: 'skirret', display_name: 'Skirret' },
]
const WINDOW_CROPS = [
  { crop_type_slug: 'pepper', display_name: 'Pepper' },
  { crop_type_slug: 'tomato', display_name: 'Tomato' },
]

// ── the fetch router ─────────────────────────────────────────────────────────────────────────────
let state
function installRouter(over = {}) {
  state = {
    inputs: [],
    preview: { matched: 139 },
    insert: { inserted: 139 },
    windowCrops: WINDOW_CROPS,
    failInsert: false,
    failDetail: false,
    ...over,
  }
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method ?? 'GET'
    if (path === '/api/varieties/crop-types') return Promise.resolve(CROP_TYPES)
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    if (path.startsWith('/api/harvests')) {
      return Promise.resolve({ aggregates: { crop_list: state.windowCrops } })
    }
    if (path === `/api/kitchen-batches/${BATCH}` && method === 'GET') {
      return state.failDetail
        ? Promise.reject(new Error('nope'))
        : Promise.resolve({ id: BATCH, inputs: state.inputs })
    }
    if (path === `/api/kitchen-batches/${BATCH}/inputs` && method === 'POST') {
      const body = JSON.parse(options.body)
      if (body.preview === true) return Promise.resolve(state.preview)
      if (state.failInsert) return Promise.reject(new Error('dropped'))
      return Promise.resolve(state.insert)
    }
    if (method === 'DELETE') return Promise.resolve({ ok: true })
    return Promise.reject(new Error(`unrouted ${method} ${path}`))
  })
}

const renderField = (props = {}) => render(
  <BatchInputsField batchId={BATCH} onChanged={props.onChanged} nowMs={props.nowMs ?? NOW} />,
)
const root = () => screen.getByTestId('batch-inputs-field')
const openPicks = async () => {
  fireEvent.click(screen.getByTestId('batch-inputs-open-picks'))
  await screen.findByTestId('batch-inputs-picks')
}
const postsTo = (suffix) => fetchMock.mock.calls.filter(
  ([p, o]) => p === `/api/kitchen-batches/${BATCH}/${suffix}` && (o?.method ?? 'GET') === 'POST',
)

beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); installRouter() })

// ── what is already in ───────────────────────────────────────────────────────────────────────────

describe('BatchInputsField — what is already in the batch', () => {
  it('says nothing is written down when nothing is', async () => {
    renderField()
    expect((await screen.findByTestId('batch-inputs-count')).textContent).toBe('Nothing written down yet.')
    // Paired positive on the same testid: it DOES count when there is something, so the copy above
    // is a state and not a stuck string.
    expect(screen.queryByTestId('batch-inputs-reveal')).toBeNull()
  })

  it('counts, and pluralises', async () => {
    installRouter({ inputs: [inputRow(1)] })
    renderField()
    expect((await screen.findByTestId('batch-inputs-count')).textContent).toBe('1 thing written down.')
  })

  it('NEVER renders the rows until a deliberate second tap', async () => {
    // The whole point of the design: a five-week pepper window is 152 rows today and rising, and a
    // scrollable wall of them is the discoverability failure this feature exists to avoid.
    installRouter({ inputs: PREDICATE_139.map((_, i) => inputRow(i + 1)) })
    renderField()
    expect((await screen.findByTestId('batch-inputs-count')).textContent).toBe('139 things written down.')
    expect(screen.queryByTestId('batch-inputs-list')).toBeNull()
    // Green control over the SAME query on the SAME surface: the door exists and opens.
    fireEvent.click(screen.getByTestId('batch-inputs-reveal'))
    expect(within(screen.getByTestId('batch-inputs-list')).getAllByRole('listitem')).toHaveLength(139)
  })

  it('the reveal names the count, and closes again', async () => {
    installRouter({ inputs: [inputRow(1), inputRow(2)] })
    renderField()
    const reveal = await screen.findByTestId('batch-inputs-reveal')
    expect(reveal.textContent).toBe('Show all 2')
    fireEvent.click(reveal)
    expect(screen.getByTestId('batch-inputs-reveal').textContent).toBe('Hide the list')
    fireEvent.click(screen.getByTestId('batch-inputs-reveal'))
    expect(screen.queryByTestId('batch-inputs-list')).toBeNull()
  })

  it('a predicate-created row says it claims the WHOLE pick, and never shows a bare uuid alone', async () => {
    installRouter({ inputs: [inputRow(1)] })
    renderField()
    fireEvent.click(await screen.findByTestId('batch-inputs-reveal'))
    const row = within(screen.getByTestId('batch-inputs-list')).getAllByRole('listitem')[0]
    expect(row.textContent).toBe('A pick from the garden — the whole pickTake it out')
    expect(row.textContent).not.toContain(uuid(1))
  })

  it('takes a row out by id, through DELETE', async () => {
    const onChanged = vi.fn()
    installRouter({ inputs: [inputRow(7)] })
    renderField({ onChanged })
    fireEvent.click(await screen.findByTestId('batch-inputs-reveal'))
    state.inputs = []
    fireEvent.click(screen.getByTestId('batch-inputs-remove-in-7'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/kitchen-batches/${BATCH}/inputs/in-7`, { method: 'DELETE' },
    ))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('says so when the batch cannot be read, rather than showing an empty batch', async () => {
    installRouter({ failDetail: true })
    renderField()
    expect((await screen.findByTestId('batch-inputs-detail-error')).textContent)
      .toBe("Couldn't read what is in this batch.")
  })
})

// ── the window ───────────────────────────────────────────────────────────────────────────────────

describe('BatchInputsField — the window comes from the chip row, not from a range picker', () => {
  it('renders the shared timeframe chips and no from/to inputs', async () => {
    renderField()
    await openPicks()
    const picks = screen.getByTestId('batch-inputs-picks')
    expect(within(picks).getByRole('group', { name: 'Which picks' })).toBeTruthy()
    for (const label of ['Today', 'Yesterday', 'All time', 'Last 7 days', 'This month']) {
      expect(within(picks).getByRole('button', { name: label })).toBeTruthy()
    }
    // The absence, paired with the presence above on the same subtree: no date inputs were minted.
    expect(picks.querySelectorAll('input[type="date"]')).toHaveLength(0)
  })

  it('states the window as a full literal, both bounds', async () => {
    renderField()
    await openPicks()
    expect(screen.getByTestId('batch-inputs-window').textContent)
      .toBe('Picks from 2026-08-29 through 2026-09-04.')
  })

  it('follows the chip — every arm, as a full literal', async () => {
    renderField()
    await openPicks()
    const tap = (name) => fireEvent.click(screen.getByRole('button', { name }))
    tap('Today')
    expect(screen.getByTestId('batch-inputs-window').textContent).toBe('Picks on 2026-09-04.')
    tap('Yesterday')
    expect(screen.getByTestId('batch-inputs-window').textContent).toBe('Picks on 2026-09-03.')
    tap('This month')
    expect(screen.getByTestId('batch-inputs-window').textContent)
      .toBe('Picks from 2026-09-01 through 2026-09-04.')
    tap('Last 7 days')
    expect(screen.getByTestId('batch-inputs-window').textContent)
      .toBe('Picks from 2026-08-29 through 2026-09-04.')
  })

  it('REFUSES "All time" instead of composing a sweep-everything window', async () => {
    renderField()
    await openPicks()
    fireEvent.click(screen.getByRole('button', { name: 'All time' }))
    expect(screen.queryByTestId('batch-inputs-window')).toBeNull()
    expect(screen.getByTestId('batch-inputs-window-refusal').textContent).toBe(ALL_TIME_REFUSAL)
    expect(screen.getByTestId('batch-inputs-preview').disabled).toBe(true)
    // Green control on the SAME render: a bounded chip restores both the window line and the button,
    // so the refusal is about "All time" and not about the surface being broken.
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }))
    expect(screen.queryByTestId('batch-inputs-window-refusal')).toBeNull()
    expect(screen.getByTestId('batch-inputs-window').textContent)
      .toBe('Picks from 2026-08-29 through 2026-09-04.')
    expect(screen.getByTestId('batch-inputs-preview').disabled).toBe(false)
  })

  it('reads the window off the injected nowMs, not off the wall clock', async () => {
    renderField({ nowMs: new Date('2026-07-04T12:00:00').getTime() })
    await openPicks()
    expect(screen.getByTestId('batch-inputs-window').textContent)
      .toBe('Picks from 2026-06-28 through 2026-07-04.')
  })
})

// ── the crop list ────────────────────────────────────────────────────────────────────────────────

describe('BatchInputsField — the crop list comes from harvests in the window, not the catalogue', () => {
  it('offers only crops with a pick in the window, named from the garden vocabulary', async () => {
    renderField()
    await openPicks()
    const select = await screen.findByLabelText('Crop')
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBe(3))
    expect([...select.options].map((o) => o.textContent))
      .toEqual(['— Any crop —', 'Pepper', 'Tomato'])
    // The absence, paired with the presence above: three catalogue crops that produced no harvest
    // are NOT offered, even though useCropTypes returned all five.
    for (const dead of ['Kohlrabi', 'Salsify', 'Skirret']) {
      expect(select.textContent).not.toContain(dead)
    }
  })

  it('asks the harvests endpoint for the CHOSEN window and never narrows by the chosen crop', async () => {
    renderField()
    await openPicks()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/harvests?include=aggregates&timeframe=7d',
    ))
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/harvests?include=aggregates&timeframe=today',
    ))
    // Passing the crop back into this call would collapse crop_list to that one crop and strand the
    // user on it. No call may carry a crop filter.
    const harvestCalls = fetchMock.mock.calls.filter(([p]) => p.startsWith('/api/harvests'))
    expect(harvestCalls.length).toBeGreaterThan(0)
    for (const [p] of harvestCalls) expect(p).not.toMatch(/[?&]crop=/)
  })

  it('says why when nothing was picked in the window, rather than showing a dead list', async () => {
    installRouter({ windowCrops: [] })
    renderField()
    await openPicks()
    expect((await screen.findByTestId('batch-inputs-no-crops')).textContent)
      .toBe('Nothing was picked in this window, so there is no crop to narrow to.')
    expect(screen.getByLabelText('Crop').disabled).toBe(true)
  })
})

// ── the dry run ──────────────────────────────────────────────────────────────────────────────────

describe('BatchInputsField — dry run before commit', () => {
  it('sends preview:true with the exact predicate, and inserts nothing', async () => {
    renderField()
    await openPicks()
    fireEvent.change(await screen.findByLabelText('Crop'), { target: { value: 'pepper' } })
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-preview-result')
    expect(postsTo('inputs')).toHaveLength(1)
    expect(JSON.parse(postsTo('inputs')[0][1].body)).toEqual({
      predicate: { from: '2026-08-29', to: '2026-09-04', crop_type_slug: 'pepper' },
      preview: true,
    })
  })

  it('renders the net-count line as a full literal, aria-live, for the 139 fixture', async () => {
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    const net = await screen.findByTestId('batch-inputs-net-count')
    expect(net.textContent).toBe('139 matched − 0 skipped → 139 will be added')
    expect(net.getAttribute('aria-live')).toBe('polite')
  })

  it('renders the same line for the 12 fixture — one count is a spot-check', async () => {
    installRouter({ preview: { matched: 12 } })
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    expect((await screen.findByTestId('batch-inputs-net-count')).textContent)
      .toBe('12 matched − 0 skipped → 12 will be added')
    expect(screen.getByTestId('batch-inputs-commit').textContent).toBe('Add 12 picks')
  })

  it('states the whole-pick claim beside the count, because nothing else in the system will', async () => {
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    expect((await screen.findByTestId('batch-inputs-whole-pick')).textContent).toBe(WHOLE_PICK_NOTICE)
  })

  it('does NOT list the matched rows until a second tap, then lists them', async () => {
    installRouter({ preview: { matched: PREDICATE_139 } })
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    expect(screen.queryByTestId('batch-inputs-chooser')).toBeNull()
    // Green control on the same render: the second tap is there and it opens.
    expect(screen.getByTestId('batch-inputs-choose').textContent).toBe('Look at the 139')
    fireEvent.click(screen.getByTestId('batch-inputs-choose'))
    expect(within(screen.getByTestId('batch-inputs-chooser')).getAllByRole('listitem')).toHaveLength(139)
  })

  it('a bare count offers no chooser at all — there is nothing to key a decision to', async () => {
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    expect(screen.queryByTestId('batch-inputs-choose')).toBeNull()
    // Paired positive: the count itself did arrive, so the absence is about rows and not about a
    // failed preview.
    expect(screen.getByTestId('batch-inputs-commit').textContent).toBe('Add 139 picks')
  })

  it('unticking a row moves the net line and the button together', async () => {
    installRouter({ preview: { matched: PREDICATE_12 } })
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    fireEvent.click(screen.getByTestId('batch-inputs-choose'))
    fireEvent.click(screen.getByTestId(`batch-inputs-pick-${uuid(3)}`))
    expect(screen.getByTestId('batch-inputs-net-count').textContent)
      .toBe('12 matched − 1 skipped → 11 will be added')
    expect(screen.getByTestId('batch-inputs-commit').textContent).toBe('Add 11 picks')
    fireEvent.click(screen.getByTestId(`batch-inputs-pick-${uuid(4)}`))
    expect(screen.getByTestId('batch-inputs-net-count').textContent)
      .toBe('12 matched − 2 skipped → 10 will be added')
  })

  it('sums weight_grams for the roll-up, and says the total is partly estimated', async () => {
    installRouter({ preview: { matched: PREDICATE_139 } })
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    expect((await screen.findByTestId('batch-inputs-rollup')).textContent)
      .toBe('About 4.18 kg in total — 46 of 139 weights are estimated from a cultivar sample, not weighed.')
    // Every fixture row is quantity '1', so a quantity-summing roll-up would read 139 — a plausible
    // wrong number rather than a crash. Asserted as an absence beside the positive above.
    expect(screen.getByTestId('batch-inputs-rollup').textContent).not.toContain('0.14 kg')
  })

  it('shows no roll-up when the arm returned only a count, and says so by omission', async () => {
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    expect(screen.queryByTestId('batch-inputs-rollup')).toBeNull()
    // Green control over the same testid, other branch: with rows, the roll-up does render.
    installRouter({ preview: { matched: PREDICATE_12 } })
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await waitFor(() => expect(screen.getByTestId('batch-inputs-rollup').textContent)
      .toBe('About 0.35 kg in total — 4 of 12 weights are estimated from a cultivar sample, not weighed.'))
  })

  it('says so when the count cannot be read, and never reports zero matches', async () => {
    installRouter({ preview: { matched: 'lots' } })
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    expect((await screen.findByTestId('batch-inputs-preview-error')).textContent)
      .toBe("Couldn't read that count — try again.")
    expect(screen.queryByTestId('batch-inputs-net-count')).toBeNull()
  })

  it('refuses to preview an impossible date rather than letting it reach a 500', async () => {
    // The chips cannot produce one, so this proves the guard from the other side: the same body
    // builder the surface calls refuses it before any request goes out.
    renderField()
    await openPicks()
    fireEvent.click(screen.getByRole('button', { name: 'All time' }))
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await waitFor(() => expect(postsTo('inputs')).toHaveLength(0))
  })
})

// ── the commit ───────────────────────────────────────────────────────────────────────────────────

describe('BatchInputsField — committing', () => {
  it('sends the predicate WITHOUT the preview flag, and reports the served count', async () => {
    const onChanged = vi.fn()
    renderField({ onChanged })
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    state.inputs = PREDICATE_139.map((_, i) => inputRow(i + 1))
    fireEvent.click(screen.getByTestId('batch-inputs-commit'))
    expect((await screen.findByTestId('batch-inputs-result')).textContent).toBe('139 picks added.')
    const commit = postsTo('inputs')[1]
    expect(JSON.parse(commit[1].body)).toEqual({ predicate: { from: '2026-08-29', to: '2026-09-04' } })
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(commit[1].body), 'preview')).toBe(false)
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('inserted:0 reads as "already here", never as "nothing happened"', async () => {
    // ON CONFLICT DO NOTHING makes a re-run safe but silent. Saying nothing was added would send the
    // user straight back to add them again.
    installRouter({ insert: { inserted: 0 }, preview: { matched: 139 } })
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    fireEvent.click(screen.getByTestId('batch-inputs-commit'))
    const res = await screen.findByTestId('batch-inputs-result')
    expect(res.textContent).toBe(INSERT_NONE_NEW)
    expect(res.textContent).not.toMatch(/nothing was added/i)
  })

  it('a DROPPED response re-reads GET /:id and reports the TRUE total, never a delta', async () => {
    installRouter({ failInsert: true, preview: { matched: 139 } })
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    // The write in fact committed; only the response was lost. The server would report inserted:0
    // on a retry, which is the lie this guard exists to refuse.
    state.inputs = PREDICATE_139.map((_, i) => inputRow(i + 1))
    fireEvent.click(screen.getByTestId('batch-inputs-commit'))
    const err = await screen.findByTestId('batch-inputs-error')
    expect(err.textContent)
      .toBe('That did not come back cleanly. Some may have gone in anyway — this batch now holds 139 inputs.')
    expect(err.textContent).not.toMatch(/\b0 (picks|inputs)\b/)
    // …and the count on the surface was refreshed from that same re-read.
    await waitFor(() => expect(screen.getByTestId('batch-inputs-count').textContent)
      .toBe('139 things written down.'))
  })

  it('a CLEAN write refreshes the count from a re-read, never from the number it just posted', async () => {
    // The re-read is not only for the dropped-response path. `inserted` is a DELTA: 139 went in, but
    // the batch already held a jar of salt, so a count taken from the response says 139 where the
    // batch holds 140. Only GET /:id can answer the question that line asks.
    installRouter({ preview: { matched: 139 }, insert: { inserted: 139 } })
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    state.inputs = [
      ...PREDICATE_139.map((_, i) => inputRow(i + 1)),
      inputRow(140, { input_kind: 'pantry', label: 'Kosher salt', harvest_log_id: null }),
    ]
    fireEvent.click(screen.getByTestId('batch-inputs-commit'))
    // Green control on the same render: the SERVED count is reported as served…
    expect((await screen.findByTestId('batch-inputs-result')).textContent).toBe('139 picks added.')
    // …and the count line is the re-read total, which is a different number on purpose.
    await waitFor(() => expect(screen.getByTestId('batch-inputs-count').textContent)
      .toBe('140 things written down.'))
  })

  it('a failed write PRESERVES the entered selections — there is no offline queue', async () => {
    installRouter({ failInsert: true, preview: { matched: 139 } })
    renderField()
    await openPicks()
    fireEvent.click(screen.getByRole('button', { name: 'This month' }))
    fireEvent.change(await screen.findByLabelText('Crop'), { target: { value: 'tomato' } })
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    fireEvent.change(screen.getByLabelText('Total weight'), { target: { value: '11' } })
    fireEvent.click(screen.getByTestId('batch-inputs-commit'))
    await screen.findByTestId('batch-inputs-error')
    const stash = JSON.parse(sessionStorage.getItem(`gardenApp.draft.putup.batch.${BATCH}.inputs`))
    expect(stash.data).toMatchObject({ chip: 'month', cropSlug: 'tomato', weightAmount: '11', weightUnit: 'lb' })
  })

  it('a subset commit goes out through the EXPLICIT form, carrying only the ticked ids', async () => {
    // The predicate cannot express a subset, so the moment a row is unticked the same set goes out
    // by harvest_log_id instead. Skipping is honoured, never silently discarded.
    installRouter({ preview: { matched: PREDICATE_12 }, insert: { inserted: 11, requested: 11 } })
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    fireEvent.click(screen.getByTestId('batch-inputs-choose'))
    fireEvent.click(screen.getByTestId(`batch-inputs-pick-${uuid(3)}`))
    fireEvent.click(screen.getByTestId('batch-inputs-commit'))
    await screen.findByTestId('batch-inputs-result')
    const body = JSON.parse(postsTo('inputs')[1][1].body)
    expect(Object.prototype.hasOwnProperty.call(body, 'predicate')).toBe(false)
    expect(body.inputs).toHaveLength(11)
    expect(body.inputs.map((r) => r.harvest_log_id)).not.toContain(uuid(3))
    expect(body.inputs.every((r) => r.input_kind === 'harvest')).toBe(true)
  })

  it('writes the batch-level total weight as its own row when one was typed', async () => {
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    fireEvent.change(screen.getByLabelText('Total weight'), { target: { value: '11' } })
    fireEvent.click(screen.getByTestId('batch-inputs-commit'))
    await screen.findByTestId('batch-inputs-result')
    expect(postsTo('inputs')).toHaveLength(3)
    expect(JSON.parse(postsTo('inputs')[2][1].body)).toEqual({
      inputs: [{ input_kind: 'other', label: 'Total weight that went in', qty: 11, qty_unit: 'lb' }],
    })
  })

  it('writes no weight row when none was typed', async () => {
    renderField()
    await openPicks()
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    fireEvent.click(screen.getByTestId('batch-inputs-commit'))
    await screen.findByTestId('batch-inputs-result')
    expect(postsTo('inputs')).toHaveLength(2)
  })
})

// ── the non-harvest add ──────────────────────────────────────────────────────────────────────────

describe('BatchInputsField — adding something that did not come from the garden', () => {
  it('offers no "harvest" kind, because a harvest input needs an id this form has no way to get', async () => {
    renderField()
    fireEvent.click(await screen.findByTestId('batch-inputs-open-other'))
    const kinds = [...(await screen.findByLabelText('What kind')).options].map((o) => o.value)
    expect(kinds).toEqual(['purchased', 'pantry', 'other'])
    expect(kinds).not.toContain('harvest')
  })

  it('posts the explicit form with a label and a paired quantity', async () => {
    renderField()
    fireEvent.click(await screen.findByTestId('batch-inputs-open-other'))
    fireEvent.change(await screen.findByLabelText('What was it'), { target: { value: 'Kosher salt' } })
    fireEvent.change(screen.getByLabelText('How much'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'cup' } })
    fireEvent.click(screen.getByTestId('batch-inputs-other-save'))
    await screen.findByTestId('batch-inputs-result')
    expect(JSON.parse(postsTo('inputs')[0][1].body)).toEqual({
      inputs: [{ input_kind: 'pantry', label: 'Kosher salt', qty: 2, qty_unit: 'cup' }],
    })
  })

  it('GUARDS DOUBLE SUBMIT INSIDE ONE FRAME — the disabled attribute is not the guard', async () => {
    // uq_kbi_batch_harvest is partial over harvest_log_id IS NOT NULL, so a repeated pantry POST
    // inserts a second row every time and the server cannot dedupe it.
    //
    // THE SHAPE OF THIS TEST IS LOAD-BEARING. Both clicks are dispatched inside ONE act() block, so
    // React never commits between them and `disabled={busy}` is still false for the second — exactly
    // the ordinary Android double-tap. A test that clicked twice through fireEvent would be stopped
    // by the disabled attribute and would pass with the in-handler guard deleted; measured, that is
    // precisely what happened (mutation M17 SURVIVED on the first pass). The synchronous ref is the
    // only thing that can close this window, and this is the only shape that proves it.
    let resolveInsert
    fetchMock.mockImplementation((path, options = {}) => {
      const method = options.method ?? 'GET'
      if (path === '/api/varieties/crop-types') return Promise.resolve(CROP_TYPES)
      if (path.startsWith('/api/plants')) return Promise.resolve([])
      if (path === `/api/kitchen-batches/${BATCH}` && method === 'GET') {
        return Promise.resolve({ id: BATCH, inputs: [] })
      }
      if (path === `/api/kitchen-batches/${BATCH}/inputs` && method === 'POST') {
        return new Promise((res) => { resolveInsert = () => res({ inserted: 1, requested: 1 }) })
      }
      return Promise.reject(new Error(`unrouted ${method} ${path}`))
    })
    renderField()
    fireEvent.click(await screen.findByTestId('batch-inputs-open-other'))
    fireEvent.change(await screen.findByLabelText('What was it'), { target: { value: 'Kosher salt' } })
    const save = screen.getByTestId('batch-inputs-other-save')
    await act(async () => {
      save.click()
      expect(save.disabled).toBe(false)   // React has not committed — the attribute cannot help
      save.click()
      save.click()
    })
    expect(postsTo('inputs')).toHaveLength(1)
    resolveInsert()
    // Green control: once it settles the button is live again, so the guard is a lock and not a
    // permanent disable that would look identical in a static assertion.
    await waitFor(() => expect(screen.getByTestId('batch-inputs-other-save').disabled).toBe(false))
  })

  it('a DROPPED response on THIS form re-reads GET /:id and reports the TRUE total too', async () => {
    // The same rule as the predicate commit's, on the arm that needs it more: this row carries no
    // harvest_log_id, so uq_kbi_batch_harvest does not cover it and a retry inserts a SECOND copy.
    // The count therefore has to come from a re-read and never from "well, one was requested".
    installRouter({ failInsert: true })
    renderField()
    fireEvent.click(await screen.findByTestId('batch-inputs-open-other'))
    fireEvent.change(await screen.findByLabelText('What was it'), { target: { value: 'Kosher salt' } })
    // The write in fact committed; only the response was lost.
    state.inputs = [inputRow(1, { input_kind: 'pantry', label: 'Kosher salt', harvest_log_id: null })]
    fireEvent.click(screen.getByTestId('batch-inputs-other-save'))
    expect((await screen.findByTestId('batch-inputs-other-error')).textContent)
      .toBe('That did not come back cleanly. Some may have gone in anyway — this batch now holds 1 input.')
    await waitFor(() => expect(screen.getByTestId('batch-inputs-count').textContent)
      .toBe('1 thing written down.'))
  })

  it('refuses a blank label without a round trip, in the Lambda words', async () => {
    renderField()
    fireEvent.click(await screen.findByTestId('batch-inputs-open-other'))
    fireEvent.click(await screen.findByTestId('batch-inputs-other-save'))
    expect((await screen.findByTestId('batch-inputs-other-error')).textContent)
      .toBe("an input of kind 'pantry' needs a label — name what went in")
    expect(postsTo('inputs')).toHaveLength(0)
  })

  it('refuses a half-set quantity pair without a round trip', async () => {
    renderField()
    fireEvent.click(await screen.findByTestId('batch-inputs-open-other'))
    fireEvent.change(await screen.findByLabelText('What was it'), { target: { value: 'Vinegar' } })
    fireEvent.change(screen.getByLabelText('How much'), { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('batch-inputs-other-save'))
    expect((await screen.findByTestId('batch-inputs-other-error')).textContent)
      .toBe('qty and qty_unit must both be set, or both be empty')
    expect(postsTo('inputs')).toHaveLength(0)
  })

  it('offers no unit the CHECK would reject — prod jars carry "quarts", which chk_kbi_qty_unit does not allow', async () => {
    renderField()
    fireEvent.click(await screen.findByTestId('batch-inputs-open-other'))
    const units = [...(await screen.findByLabelText('Unit')).options].map((o) => o.value)
    expect(units).not.toContain('quarts')
    expect(units).not.toContain('cups')
    // Paired positive over the same list: the singular forms the CHECK does allow ARE offered.
    expect(units).toContain('qt')
    expect(units).toContain('cup')
  })
})

// ── the sweeps, on THIS surface, with a green control on every arm ───────────────────────────────

describe('batch-inputs-field — the eight inherited rulings, guarded HERE', () => {
  // The whole reason this describe exists: every sweep in this lane is scoped to
  // getByTestId('going-now-view'), and none of them would notice a single word on this surface.
  const renderEverything = async () => {
    installRouter({
      inputs: [inputRow(1), inputRow(2, { input_kind: 'pantry', label: 'Kosher salt', qty: '2', qty_unit: 'cup', harvest_log_id: null })],
      preview: { matched: PREDICATE_12 },
    })
    renderField()
    await openPicks()
    fireEvent.click(await screen.findByTestId('batch-inputs-reveal'))
    fireEvent.click(screen.getByTestId('batch-inputs-preview'))
    await screen.findByTestId('batch-inputs-net-count')
    fireEvent.click(screen.getByTestId('batch-inputs-choose'))
    return root().innerHTML
  }

  it('renders no countdown, no due date, no remaining-days figure and no progress element', async () => {
    const html = await renderEverything()
    expect(html).not.toMatch(/\bdue\b|\bremaining\b|\boverdue\b|\bready\b|\bdays left\b|\blate\b/i)
    expect(root().querySelector('progress')).toBeNull()
    expect(html).not.toMatch(/role="progressbar"/)
    // GREEN CONTROL. The sweep is over a surface that really did render, with the roll-up, the
    // chooser and the input list all open — not over an empty string or an unmounted node.
    expect(html).toMatch(/139|12 matched/)
    expect(root().querySelectorAll('li').length).toBeGreaterThan(10)
  })

  it('says nothing about acidification, safety, shelf stability or spoilage', async () => {
    const html = await renderEverything()
    expect(html).not.toMatch(/acidif|shelf.stab|\bsafe\b|\bsafety\b|botul|spoil/i)
    // Green control: the surface is there and is full of copy, so the absence is a property of the
    // words chosen rather than of an empty render.
    // Re-pointed at integration 20260904: this control used to be the field's own <h3> "What went
    // into this?", which was removed because the host Section already renders that heading. A
    // control anchored to a heading that a LAYOUT change can delete is a control that fails silently
    // — this one is anchored to the count line, which is the one thing this field always renders.
    expect(html).toContain('written down')
    expect(html.length).toBeGreaterThan(2000)
  })

  it('carries no acid line, in any of the spellings the evidence base circulates', async () => {
    const html = await renderEverything()
    expect(html).not.toMatch(/(?<![\d.])(4\.60|4\.6|4\.4|4\.2|4\.1|4\.0|3\.8|3\.3|5\.0)(?!\d)(?!\.\d)/)
    // Green control with teeth: the surface DOES render a decimal figure (the roll-up), so the
    // regex is running over text that contains numbers of that shape.
    expect(html).toMatch(/0\.35 kg/)
  })

  it('never renders a raw machine value — no input_kind slug reaches the DOM', async () => {
    const html = await renderEverything()
    // A raw enum in the DOM is how a machine value ends up being asserted about by a copy sweep
    // written about claims. `discarded_spoiled` contains `spoil`; the same class applies here.
    for (const slug of ['"harvest"', '>harvest<', 'input_kind', 'harvest_log_id', 'crop_type_slug']) {
      expect(html).not.toContain(slug)
    }
    // Green control on the same html: the LABELS for those kinds are present, so the absence is
    // about the slug and not about the rows failing to render.
    expect(html).toContain('A pick from the garden')
    expect(html).toContain('Kosher salt')
  })

  it('paints no alarm ink — a preservation process is not late, and nothing here is urgent', async () => {
    const html = await renderEverything()
    const toRgb = (hex) => {
      const n = parseInt(hex.replace('#', ''), 16)
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
    }
    // jsdom normalises every inline colour to rgb(), so a regex over the HEX values matches nothing
    // and passes whatever colour the element is — a vacuity this repo has been bitten by once.
    for (const ink of [P.terra, P.warnBorder, P.severityUrgent].map(toRgb)) {
      expect(html).not.toContain(ink)
    }
    // Green control: the converter works and the surface really does carry inline rgb() colours, so
    // the four absences above are over strings of the right shape.
    expect(toRgb(P.terra)).toBe('rgb(183, 83, 42)')
    expect(html).toContain(toRgb(P.green))
  })

  it('asks questions and never issues a verdict about the food', async () => {
    const html = await renderEverything()
    // Control re-pointed at integration (see the sweep above). The `?` assertion below is NOT
    // decoration and is the ruling itself: this surface asks, it never pronounces. It survives the
    // heading removal because the questions it was really about are the field labels — "From which
    // planting?", "How much went in altogether?", "What kind?", "What was it?" — not the heading.
    expect(html).toContain('written down')
    expect(html).not.toMatch(/\bshould\b|\bmust be\b|\bis done\b|\blooks (good|bad)\b/i)
    expect(html).toMatch(/\?/)
  })
})

// ── the source guard, over THIS lane's own files ─────────────────────────────────────────────────
//
// PutUpPhReading.test.jsx carries a LANE_SOURCES list for the pH lane and these two files belong on
// it — but that file is owned by another lane in this build, so the same guard is run here instead.
// INTEGRATOR: fold these two paths into that list when the lanes merge, and delete this block.
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../..')
const LANE_SOURCES = [
  ['src/components/putup/batchInputs.js', 'PREDICATE_MAX_SPAN_DAYS'],
  ['src/components/putup/BatchInputsField.jsx', 'batch-inputs-field'],
]
const ACID_LINE_NUMBERS = ['4.60', '4.6', '4.4', '4.2', '4.1', '4.0', '3.8', '3.3', '5.0']
const acidRe = (n) => new RegExp(`(?<![\\d.])${n.replace('.', '\\.')}(?!\\d)(?!\\.\\d)`)

describe('the acid line appears nowhere in this lane\'s source', () => {
  it.each(LANE_SOURCES)('%s', (rel, sentinel) => {
    const src = readFileSync(resolve(REPO, rel), 'utf8')
    // THE GREEN CONTROL, and it is not decoration: a typo'd path or a moved file would make every
    // assertion below pass over an empty string.
    expect(src).toContain(sentinel)
    for (const n of ACID_LINE_NUMBERS) {
      expect(`${rel} contains ${n}: ${acidRe(n).test(src)}`).toBe(`${rel} contains ${n}: false`)
    }
  })

  it('the regex matches a real threshold and ignores a dotted version string', () => {
    expect(acidRe('4.6').test('if (Number(ph) < 4.6) return "low"')).toBe(true)
    expect(acidRe('4.6').test('-- a drop below 4.6.')).toBe(true)
    expect(acidRe('4.6').test('v4.6.0-inflightbatch')).toBe(false)
    expect(acidRe('4.0').test('4.00')).toBe(false)
  })

  it('neither source derives, scores or gates on anything about the food', () => {
    for (const [rel] of LANE_SOURCES) {
      const src = readFileSync(resolve(REPO, rel), 'utf8')
      // Deliberately over `src`, comments included: a comment that names a threshold is how the
      // next session learns one exists.
      expect(src).not.toMatch(/shelf.stab|botulinum|\bis safe\b|acidified/i)
      expect(src).toContain('whole')
    }
  })
})
