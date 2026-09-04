// V5-SEEDSTAGEONEPLACE-001 — the correction door on /seeds/saved.
//
// WHY IT EXISTS. /inventory/:id lost its seed_stage <select> in the same commit, so this page is now
// the ONLY place a lot's stage changes and every change writes a seed_lot_stage_log row. That is
// only safe if this page can go BACKWARDS: seed_lot_stage_log has no DELETE route, so if the only
// movement available here stayed `nextStage()` — one step right, `stored` terminal — a mis-tapped
// stage would be permanently unfixable, and a `stored` lot would have no stage control anywhere in
// the app at all. The repair capability MOVED here; it was not deleted.
//
// THE DATE IS THE CRUX, not the stage list. A correction logged with `entered_at = now()` would make
// stage_entered_at the moment the mistake was NOTICED rather than the day the lot entered the stage
// — and this page orders its entire queue by that number and leads every card with it
// (BUG-SEEDELAPSEDUPDATED-001). That is precisely the defect the old off-log repair path existed to
// avoid, so trading it for a logged-but-wrongly-dated row would be a lateral move, not a fix. The
// handler already accepts entered_at and documents itself BACKDATABLE ON PURPOSE
// (lambda/inventory-items/index.js:395-405); this door opens the field BLANK and refuses it empty,
// so the date cannot be satisfied by a default nobody chose.
//
// BACKDATABLE, NOT FORWARD-DATABLE, and that half is unchanged from the advance door: a lot dated
// 2027 reads "0 days in drying" forever and quietly leaves the list of things that need checking.
//
// DATES ARE FIXED ZONELESS LITERALS. '2026-08-24' typed in, '2026-08-24T12:00:00' on the wire,
// asserted whole rather than by substring — the local-noon convention is what stops a date typed on
// an Eastern phone landing on the previous UTC day, and a `toContain('2026-08-24')` would pass on a
// body carrying midnight instead. Nothing here is derived from Date.now(), so the CI re-run under
// TZ=America/New_York has something to bite on.
// No jest-dom (L-182).
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
import { todayLocalISO } from '../lib/dateLocal.js'

// A DRYING lot as the list endpoint returns it — every column plus the two the list query derives.
// quantity_on_hand is 8 so the count field prefills and does not block the assertions that are about
// the date; the count's own arm is SavedSeeds.storedCount.test.jsx.
const DRYING = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: 8, unit: 'packet', reorder_threshold: null,
  reorder_quantity: null, notes: 'From the 2026 melon', source: 'Self-saved', source_url: null,
  purchase_date: null, unit_cost: null, quantity_purchased: null, location_text: 'Seed tin',
  brand: null, model: null, tags: ['melon'], metadata: { sku: 'GF-2026' },
  variety_id: 'v-melon', source_plant_id: 'pl-melon',
  seed_stage: 'drying', seed_process: 'wet', featured_photo_id: 'ph-1',
  variety_name: 'Green Flesh', stage_entered_at: '2026-08-25T12:00:00Z',
  year_harvested: 2026,
}

// The shape of all three live lots: pointer on `stored`, which is terminal, so it gets no advance
// button. Before this change that meant no stage control at all once /inventory/:id lost its own.
const STORED = {
  ...DRYING, id: 'inv-2', name: 'Sugar Baby', variety_name: 'Sugar Baby',
  seed_stage: 'stored', stage_entered_at: null,
}

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

const click = async (el) => { await act(async () => { fireEvent.click(el) }) }
const clickId = async (testId) => click(screen.getByTestId(testId))
const change = async (testId, value) => {
  await act(async () => { fireEvent.change(screen.getByTestId(testId), { target: { value } }) })
}
const writes = () => fetchSpy.mock.calls.filter(([, o]) => o?.method)
const stagePosts = (id = 'inv-1') => writes().filter(
  ([p, o]) => String(p) === `/api/inventory-items/${id}/seed-stage` && o.method === 'POST')
const stageBody = (id = 'inv-1') => {
  const posts = stagePosts(id)
  expect(posts, 'no stage POST was issued').toHaveLength(1)
  return JSON.parse(posts[0][1].body)
}

beforeEach(() => { fetchSpy.mockReset() })

describe('SavedSeeds — the correction door (V5-SEEDSTAGEONEPLACE-001)', () => {
  it('gives every lot a stage control, including a terminal `stored` one with no advance button', async () => {
    await mount([DRYING, STORED])
    // The positive: the drying lot still has its one-tap advance, so this is not a page that failed
    // to render its buttons.
    expect(screen.getAllByTestId('advance-stage')).toHaveLength(1)
    // …and the correction door is on BOTH cards, which is the half that was missing: `stored` is
    // terminal, so nextStage() offers it nothing.
    expect(screen.getAllByTestId('change-stage')).toHaveLength(2)
  })

  it('offers ANY stage, not just the next one right, defaulting to where the lot is now', async () => {
    await mount([DRYING])
    await clickId('change-stage')
    const select = screen.getByTestId('stage-select')
    // The full DB CHECK vocabulary in process order, asserted whole. A subset would let a control
    // that only offered `drying`/`stored` — forward-only wearing a picker — pass.
    expect([...select.options].map(o => o.value)).toEqual(['fermenting', 'drying', 'stored'])
    expect(select.value).toBe('drying')
  })

  it('POSTs a BACKWARD stage with the date the user typed, at local noon', async () => {
    await mount([DRYING])
    await clickId('change-stage')
    await change('stage-select', 'fermenting')
    await change('stage-date', '2026-08-24')
    await clickId('stage-save')

    const body = stageBody()
    expect(body.stage).toBe('fermenting')
    // The whole literal. `T12:00:00` is the zoneless local-noon convention the advance door already
    // uses, and it is what keeps an Eastern evening from landing on the previous UTC day.
    expect(body.entered_at).toBe('2026-08-24T12:00:00')
    // seed_process is omitted, never null: the handler reads it by PRESENCE, so `null` would WIPE
    // the process a correction has no business touching. Only the start door sets it.
    expect(Object.prototype.hasOwnProperty.call(body, 'seed_process')).toBe(false)
    // "Corrected to", not "Moved to". The lot did not go back into a jar — a wrong record was
    // repaired, and the confirmation has to say which of the two just happened.
    expect(await screen.findByText('✓ Corrected to fermenting')).toBeTruthy()
  })

  it('opens the date BLANK on a correction and refuses to submit without one', async () => {
    // The crux. A correction is a statement about the past, so a field pre-filled with today would
    // let the commonest path write stage_entered_at = the moment the mistake was noticed — the exact
    // number this page counts elapsed days from.
    await mount([DRYING])
    await clickId('change-stage')
    expect(screen.getByTestId('stage-date').value).toBe('')
    await clickId('stage-save')
    expect(screen.getByTestId('stage-date-error').textContent)
      .toBe('Say when the lot actually entered this stage — that is the date the list counts from.')
    // Refused BEFORE the request, not after: the stage POST has no undo, so an ordering that landed
    // the stage and then complained is the one that cannot be backed out.
    expect(writes()).toEqual([])

    // …and the same submit succeeds once the date is given, which is what proves the refusal is the
    // date's and not a submit button that never worked.
    await change('stage-date', '2026-08-24')
    expect(screen.queryByTestId('stage-date-error')).toBeNull()
    await clickId('stage-save')
    expect(stageBody().entered_at).toBe('2026-08-24T12:00:00')
  })

  it('is backdatable but NOT forward-datable', async () => {
    // A mistyped year reads "0 days in drying" forever and the lot quietly leaves the list of things
    // that need checking, on the one page whose entire job is to produce that list. `max` is the
    // native picker's own guard; the handler's 48h tolerance is the separate server-side half.
    await mount([DRYING])
    await clickId('change-stage')
    expect(screen.getByTestId('stage-date').getAttribute('max')).toBe(todayLocalISO())
  })

  it('re-logs the CURRENT stage with a real date — the repair the three live lots need', async () => {
    // All three staged lots in prod point at `stored` with no `stored` row in the log, so the
    // LATERAL that derives stage_entered_at matches nothing and every card renders with no elapsed
    // time. Choosing the stage the lot is already on is therefore NOT a no-op: it appends the
    // correctly-dated entry that was never written.
    await mount([STORED])
    await clickId('change-stage')
    expect(screen.getByTestId('stage-select').value).toBe('stored')
    await change('stage-date', '2026-08-30')
    await clickId('stage-save')

    const body = stageBody('inv-2')
    expect(body.stage).toBe('stored')
    expect(body.entered_at).toBe('2026-08-30T12:00:00')
  })

  it('still demands a count when a correction lands on `stored`', async () => {
    // BUG-SEEDZEROSOWABLE-001's guarantee, which used to be held by two surfaces and is now held by
    // this one alone. A lot on 0 at `stored` is read as depleted by sowEngine.isDepleted(), and
    // `stored` is terminal so nothing later asks again.
    await mount([{ ...DRYING, quantity_on_hand: 0 }])
    await clickId('change-stage')
    await change('stage-select', 'stored')
    await change('stage-date', '2026-08-30')
    expect(screen.getByTestId('seed-count-required')).toBeTruthy()
    await clickId('stage-save')
    expect(screen.getByTestId('seed-count-error').textContent)
      .toBe('Enter how much you got — 0 is a real answer if none of it was viable.')
    expect(writes()).toEqual([])
  })

  it('leaves the ADVANCE door seeded to today, and sends no stage picker with it', async () => {
    // The two doors share one sheet, so this is the regression half: an advance happens NOW, its
    // date is a convenience rather than a question, and the stage was already named by the button
    // that was pressed. Offering a picker there would let a `wet` start be re-routed into drying.
    await mount([DRYING])
    await clickId('advance-stage')
    expect(screen.getByTestId('stage-date').value).toBe(todayLocalISO())
    expect(screen.queryByTestId('stage-select')).toBeNull()
    expect(screen.queryByTestId('stage-date-help')).toBeNull()
    await clickId('stage-save')
    expect(stageBody().stage).toBe('stored')
  })
})
