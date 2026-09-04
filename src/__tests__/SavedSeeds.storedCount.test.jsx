// V4-SEEDSTOREDQTY-001 — the count on the /seeds/saved advance sheet.
// BUG-SEEDZEROSOWABLE-001 (2026-09-02) — WIDENED to every stage, and made REQUIRED at `stored`.
//
// THE ORIGINAL DECISION, and the half of it that stands. At "Save seed" the seed is still wet and
// unthreshed; the packet-count field that used to sit on that sheet DEFAULTED TO 1 and stored a
// guess as though it were measured. Removing it was right, and nothing below fabricates a count:
// every field is blank-by-default and a blank still writes nothing.
//
// THE HALF THAT DID NOT STAND, and why these assertions were re-authored rather than deleted. The
// original concluded that because the count is unknowable at save time it is knowable ONLY at
// `stored`, so it asked there and nowhere else. Dave 2026-09-02: "I might save 10 seeds and know it
// from the first moment, or I might have saved dozens/hundreds and not know how many potentially
// viable ones I'll save in the end. Each step needs to be able to set/update that count." Knowing is
// a fact about the gardener, not about the stage. So the field is offered at every stage and the
// ANSWER stays optional — except at `stored`.
//
// `stored` REFUSES A BLANK, which is the fix for the silent half of BUG-SEEDZEROSOWABLE-001: a lot
// that completed the whole process with the count skipped sat at 0, and sowEngine.isDepleted()
// cannot distinguish that from genuinely empty, so a finished packet on the shelf was filed under
// "Sowed previously — none of these left". `stored` is terminal, so nothing later asks again. The
// answer is therefore demanded BEFORE the stage write lands, which is what makes the rule free:
// no lot can reach `stored` unanswered, so from here on a 0 there genuinely means zero. Prod
// carries no lots at any seed_stage today, so the invariant holds with no backfill.
//
// THE /inventory/:id HALF IS GONE (V5-SEEDSTAGEONEPLACE-001, 2026-09-04). That page carried a
// second, DELIBERATELY ASYMMETRIC count prompt — dismissible, because it appeared only AFTER its
// stage write had landed, so "required" could only have meant nagging until satisfied. Its stage
// control was removed so that a lot's stage changes in exactly one place and every change logs, and
// the prompt went with it: it existed solely because that control could reach `stored`.
//
// So the guarantee it was there for now rests ENTIRELY on the arm below. No path anywhere in the app
// can set `stored` without answering the count, because this sheet is the only path and it refuses a
// blank before the request goes out.
//
// THE COUNT IS NOT A QUANTITY (V5-SEEDQTY-001, 2026-09-04). Everything above described a count that
// travelled the WIDE PUT into `quantity_on_hand`, and that was the defect, not the mechanism: that
// column means CONTAINERS, so the three real saved lots came out of this page reading `185.000
// packet`, `175.000 packet`, `121.000 packet`. `seed_count` / `seed_weight_g` /
// `seed_count_estimated` are now their own columns with their own narrow route,
// PUT /api/inventory-items/:id/seed-measure, and that route is their ONLY writer in the app.
//
// THE PAYLOAD IS STILL THE SUBJECT, not the click. Two payloads now, and the split is the assertion:
//   · the narrow one must carry the count and NOT `quantity_on_hand` — put it back and the backfill
//     is undone on the next stage advance;
//   · the wide one (still opened for `year_harvested`, which has no narrow route) must carry the
//     whole row and NONE of the three new columns. The wide PUT assigns every column in its SET list
//     unconditionally, so a short body is a wipe with a 200 on it — and the key that would BITE is
//     `seed_stage`: the row this page holds is the LIST row, carrying the stage as it was BEFORE the
//     advance, so echoing it back would silently revert the move the sheet is titled for. The three
//     new columns are the same hazard one release later: they ride `i.*` onto every list row, so an
//     echoed stale value would revert a count written minutes earlier through /seed-measure.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
}))

import SavedSeeds, { listRowPutBody, parseCountInput } from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// A DRYING lot exactly as the list endpoint returns it: every inventory_items column, plus the three
// the list query derives (variety_name from the cultivar join, stage_entered_at from the LATERAL,
// crop_slug from the cultivar's crop type).
//
// LIFTED FROM PROD, not composed to be convenient. The scalar values below are the live
// `Green Flesh Honeydew` row (2d6df841-…) read 2026-09-04: `notes: 'Saved from 2026'`,
// `source: 'Gardens at Mathews'`, empty `location_text`, empty `tags`, null `metadata`. The previous
// version of this fixture said `quantity_on_hand: 0` with `unit: 'packet'` and invented a seed tin, a
// melon tag and an SKU; the real row is `100.000 each` — which is this defect, not an edge case: a
// seed count sitting in the containers column wearing the containers noun.
//
// The QUANTITY fields are the row as it will read AFTER the V5-SEEDQTY-001 backfill, because that is
// the state every assertion below is about: one packet on the shelf, 185 seeds in it. 185 is the
// live `1884 — saved 2026` lot's count (69832d29-…), which is the row this whole change exists for.
//
// `metadata: null` is a deliberate round-trip marker and not laziness. The wide PUT's SET list never
// names that column, so it can only appear in a body that carried the whole row — and `null` is the
// value that would read as "present" to a sloppy assertion, so it is checked for presence explicitly
// rather than for truthiness.
const LOT = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: '1.000', unit: 'packet', reorder_threshold: null,
  reorder_quantity: null, notes: 'Saved from 2026', source: 'Gardens at Mathews', source_url: '',
  purchase_date: null, unit_cost: null, quantity_purchased: null, location_text: '',
  brand: null, model: null, tags: [], metadata: null,
  seed_count: 185, seed_weight_g: null, seed_count_estimated: false,
  variety_id: 'v-melon', source_plant_id: 'pl-melon',
  seed_stage: 'drying', seed_process: 'wet', featured_photo_id: 'ph-1',
  variety_name: 'Green Flesh', stage_entered_at: '2026-08-25T12:00:00Z', crop_slug: 'melon',
  updated_at: '2026-08-30T12:00:00Z',
}
// The same lot before anyone has counted it. NULL, not 0 — that distinction is the entire reason
// `seed_count` is a new nullable column rather than a re-reading of `quantity_on_hand`, which is NOT
// NULL for a consumable and could therefore only say "uncounted" by saying 0.
const UNCOUNTED = { ...LOT, seed_count: null, seed_count_estimated: null }

const mount = async (items = [LOT]) => {
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

const click = async (testId) => {
  await act(async () => { fireEvent.click(screen.getByTestId(testId)) })
}
const typeCount = async (v) => {
  await act(async () => { fireEvent.change(screen.getByTestId('seed-count-input'), { target: { value: v } }) })
}
const writes = () => fetchSpy.mock.calls.filter(([, o]) => o?.method)
const bodyOf = (path, label) => {
  const hits = writes().filter(([p, o]) => String(p) === path && o.method === 'PUT')
  expect(hits, `no ${label} was issued`).toHaveLength(1)
  return JSON.parse(hits[0][1].body)
}
// The NARROW route — the only writer of seed_count / seed_weight_g / seed_count_estimated anywhere.
const measureBody = () => bodyOf('/api/inventory-items/inv-1/seed-measure', 'seed-measure PUT')
// The WIDE PUT, which this page now opens for `year_harvested` alone.
const widePutBody = () => bodyOf('/api/inventory-items/inv-1', 'wide PUT')
const widePuts = () =>
  writes().filter(([p, o]) => String(p) === '/api/inventory-items/inv-1' && o.method === 'PUT')

beforeEach(() => { fetchSpy.mockReset() })

describe('BUG-SEEDZEROSOWABLE-001 — the advance sheet asks at every stage', () => {
  // RE-AUTHORED 2026-09-02, inverting the assertion this file opened with ("shows the count field
  // for stored and for no other stage"). That pin was correct for V4-SEEDSTOREDQTY-001's reading and
  // is wrong under Dave's — see the file header. Kept as a live assertion of the NEW rule rather
  // than deleted, so the widening stays covered in both directions.
  it('shows the count field on an in-flight stage too, marked optional', async () => {
    await mount([{ ...LOT, seed_stage: 'fermenting' }])
    await click('advance-stage')       // fermenting -> drying
    expect(screen.getByTestId('seed-count')).toBeTruthy()
    expect(screen.queryByTestId('seed-count-required'), 'drying must not demand a count').toBeNull()
  })

  it('shows it on drying -> stored, marked required', async () => {
    await mount()
    await click('advance-stage')       // drying -> stored
    expect(screen.getByTestId('seed-count')).toBeTruthy()
    expect(screen.getByTestId('seed-count-required')).toBeTruthy()
    // The consequence, on the field that causes it: a lot left on 0 reads as depleted on Sow now.
    expect(screen.getByTestId('seed-count').textContent).toMatch(/Sow now/i)
  })

  it('writes NOTHING extra when an IN-FLIGHT stage is left blank', async () => {
    // "Still haven't counted" is a real answer on fermenting/drying, not a skipped field. Writing 0
    // for it would manufacture the exact ambiguous value this change exists to eliminate, one stage
    // early — a 0 nobody typed is indistinguishable afterwards from a 0 somebody measured.
    await mount([{ ...UNCOUNTED, seed_stage: 'fermenting' }])
    await click('advance-stage')       // fermenting -> drying
    await click('stage-save')
    expect(writes()).toHaveLength(1)
    expect(`${writes()[0][1].method} ${writes()[0][0]}`)
      .toBe('POST /api/inventory-items/inv-1/seed-stage')
    // Said by name, because the tempting shortcut is the destructive one: /seed-measure reads its
    // keys BY PRESENCE, so a blank field sending `seed_count: 0` would not be a no-op — it would
    // record "I counted, and the pod was empty" on a lot nobody has looked at, which is the exact
    // fabrication this whole change exists to end. No key, no request.
    expect(writes().some(([p]) => String(p).endsWith('/seed-measure')),
      'a blank field opened the measure route').toBe(false)
  })

  it('refuses a FRACTION before the request, not after the API 400s on it', async () => {
    // `seed_count` is an integer column and /seed-measure returns
    // `400 seed_count must be a whole number of seeds, or null`. That refusal would arrive after the
    // stage POST had already landed — seed_lot_stage_log has no DELETE route — so the lot would move
    // and the count would be dropped onto a toast over a sheet that has closed. Nothing goes out.
    await mount([UNCOUNTED])
    await click('advance-stage')       // drying -> stored
    await typeCount('20.5')
    await click('stage-save')
    expect(writes(), 'a request went out on a fractional count').toHaveLength(0)
    expect(screen.getByTestId('seed-count-error').textContent)
      .toBe('A seed count is a whole number of seeds.')

    // The green control on the same submit button: the refusal is the fraction's, not a Save that
    // never worked.
    await typeCount('20')
    await click('stage-save')
    expect(writes().map(([p, o]) => `${o.method} ${p}`)).toContain(
      'PUT /api/inventory-items/inv-1/seed-measure')
  })

  it('offers a WHOLE-NUMBER keypad, not a decimal one', async () => {
    // A hint, not a guard — parseCountInput still refuses a pasted fraction — but advertising a
    // decimal point on a field whose column is an integer is teaching an answer the API refuses.
    await mount([UNCOUNTED])
    await click('advance-stage')
    expect(screen.getByTestId('seed-count-input').getAttribute('inputmode')).toBe('numeric')
  })

  it('REFUSES the move into stored when the count is blank, before any request', async () => {
    // The ordering is the point, not just the refusal. seed_lot_stage_log has no DELETE route and
    // this page cannot repair a stage, so a submit that landed the stage and then rejected the count
    // would leave the lot somewhere it cannot be moved back from. Nothing may go out.
    await mount([UNCOUNTED])
    await click('advance-stage')       // drying -> stored
    await click('stage-save')
    expect(writes(), 'a request went out despite the refusal').toHaveLength(0)
    expect(screen.getByTestId('seed-count-error')).toBeTruthy()
    // The sheet stays open on the field that blocked it.
    expect(screen.getByTestId('stage-save')).toBeTruthy()
  })

  it('clears the refusal and goes through once a number is typed', async () => {
    await mount([UNCOUNTED])
    await click('advance-stage')
    await click('stage-save')
    expect(screen.getByTestId('seed-count-error')).toBeTruthy()
    await typeCount('9')
    expect(screen.queryByTestId('seed-count-error'), 'stale refusal left on screen').toBeNull()
    await click('stage-save')
    expect(writes().map(([p, o]) => `${o.method} ${p}`)).toEqual([
      'POST /api/inventory-items/inv-1/seed-stage',
      'PUT /api/inventory-items/inv-1/seed-measure',
      // year_harvested, which is the only thing left that opens the wide PUT from this page.
      'PUT /api/inventory-items/inv-1',
    ])
  })

  it('prefills from SEED_COUNT, not from the packet count beside it', async () => {
    // V5-SEEDQTY-001, and the fixture IS the assertion: `quantity_on_hand: '1.000'` is what the
    // backfill leaves on a saved lot — one packet — while `seed_count: 185` is what the gardener
    // actually counted. Reading the old column here would offer "1" to someone amending a lot of
    // 185, and the retyped 185 would go straight back into the containers column on the next
    // advance, undoing the backfill one lot at a time.
    //
    // Dave: "Each step needs to be able to set/update that count." Re-asking from blank each time
    // would make a running number look like a fresh capture, and the likeliest edit — nudging 185 to
    // 180 after cleaning — would mean retyping it.
    await mount([{ ...LOT, seed_stage: 'fermenting' }])
    await click('advance-stage')
    expect(screen.getByTestId('seed-count-input').value).toBe('185')
  })

  it('prefills BLANK from a lot nobody has counted, so a stored move cannot satisfy itself', async () => {
    // `seed_count: null` is "nobody has counted this yet". Rendering anything as an answer would let
    // the required field at `stored` be satisfied by a number no human typed — the whole defect,
    // reintroduced through the prefill. UNCOUNTED still carries `quantity_on_hand: '1.000'`, so this
    // also fails the moment the prefill is pointed back at that column: it would read "1".
    await mount([UNCOUNTED])
    await click('advance-stage')
    expect(screen.getByTestId('seed-count-input').value).toBe('')
  })

  it('prefills a measured ZERO as 0, because null is what "uncounted" means now', async () => {
    // The `> 0` guard this replaces was correct for `quantity_on_hand`, which is NOT NULL for a
    // consumable (consumable_requires_quantity_on_hand) and could therefore only say "uncounted" by
    // saying 0. `seed_count` is nullable, so 0 goes back to meaning a lot that was counted and
    // yielded nothing — and blanking it here would re-create the exact conflation the new column
    // exists to end. Paired with the test above: null blanks, 0 does not.
    await mount([{ ...LOT, seed_stage: 'fermenting', seed_count: 0 }])
    await click('advance-stage')
    expect(screen.getByTestId('seed-count-input').value).toBe('0')
  })

  it('writes the count to the NARROW route, and never as a quantity', async () => {
    // THE FIX, asserted from both sides. `quantity_on_hand` means containers; putting the count there
    // is what made prod read `185.000 packet`, and it is what the backfill undoes. The three seed
    // columns are reachable only through PUT /:id/seed-measure, whose body is exactly these keys.
    await mount()
    await click('advance-stage')
    await typeCount('14')
    await click('stage-save')

    const seq = writes().map(([p, o]) => `${o.method} ${p}`)
    expect(seq).toEqual([
      'POST /api/inventory-items/inv-1/seed-stage',
      'PUT /api/inventory-items/inv-1/seed-measure',
      'PUT /api/inventory-items/inv-1',
    ])
    const body = measureBody()
    expect(body.seed_count).toBe(14)
    // `seed_count_estimated: false` on everything this page writes: a count typed on the step where
    // the gardener is holding the seed is a counted number, never a vendor's "approx. 25 seeds".
    expect(body.seed_count_estimated).toBe(false)
    // The narrow route reads BY PRESENCE, so an extra key is an assignment, not a no-op. A
    // `quantity_on_hand` here would be the original defect wearing the new route.
    expect(Object.keys(body).sort()).toEqual(['seed_count', 'seed_count_estimated'])
  })

  it('accepts a genuine zero — "I counted, and there is none"', async () => {
    // Distinct from blank, and the distinction matters: a lot that yielded nothing is a measured
    // fact worth recording, and `>= 0` rather than `> 0` is what makes it expressible.
    await mount()
    await click('advance-stage')
    await typeCount('0')
    await click('stage-save')
    expect(measureBody().seed_count).toBe(0)
  })

  it('opens NO wide PUT when the only thing to write is the count', async () => {
    // The green control for the wide-PUT assertions below, and a guard in its own right: the wide PUT
    // round-trips a LIST ROW READ AT MOUNT, so every avoidable one is an avoidable chance to
    // re-assert a stale value over an edit made elsewhere (BUG-INVLOSTUPDATE-001). It is opened for
    // `year_harvested` and nothing else, so an in-flight advance must not open one at all.
    await mount([{ ...UNCOUNTED, seed_stage: 'fermenting' }])
    await click('advance-stage')       // fermenting -> drying, no year to write
    await typeCount('14')
    await click('stage-save')
    expect(widePuts(), 'a wide PUT went out with nothing to say').toHaveLength(0)
    expect(measureBody().seed_count).toBe(14)
  })

  it('sends a COMPLETE body — the wide PUT nulls every column it does not name', async () => {
    await mount()
    await click('advance-stage')
    await typeCount('14')
    await click('stage-save')
    const body = widePutBody()
    for (const [k, v] of Object.entries({
      name: 'Green Flesh Honeydew', type: 'consumable', category: 'seeds', status: 'active',
      unit: 'packet', notes: 'Saved from 2026', source: 'Gardens at Mathews', location_text: '',
    })) expect(body[k], `${k} missing from the wide PUT — the handler would NULL it`).toBe(v)
    expect(body.tags).toEqual([])
    // Not a form projection: metadata is a column no edit form on this app renders or returns, so
    // its presence is what proves the WHOLE row was round-tripped. Checked for PRESENCE first — the
    // live value is null, and `expect(body.metadata).toBeFalsy()` would pass on a body that never
    // carried the key at all.
    expect(Object.prototype.hasOwnProperty.call(body, 'metadata'),
      'metadata absent — this is a projection of the row, not the row').toBe(true)
    expect(body.metadata).toBe(null)
    // `quantity_on_hand` is round-tripped UNCHANGED, which is the other half of the fix: the wide PUT
    // still has to send it (the handler assigns it unconditionally) but must no longer overwrite it
    // with a seed count. '1.000' in, '1.000' out — one packet, still one packet.
    expect(body.quantity_on_hand).toBe('1.000')
    // `type` is the one that would fail QUIETLY: the handler writes
    // `quantity_on_hand = ${isConsumable ? … : null}`, so a body without it nulls that column.
    expect(body.type).toBe('consumable')
    // The reason this wide PUT exists at all, now that the count has left it.
    expect(body.year_harvested).toBe(2026)
  })

  it('OMITS seed_stage and the three seed-measure columns from the wide PUT', async () => {
    // THE hazard of round-tripping the LIST row: it carries `drying`, the stage as it was before the
    // POST. Mentioning that key is an assignment (the handler reads it by presence), so echoing it
    // would undo the move with a 200. Omitted, the freshly-written `stored` is left alone.
    //
    // V5-SEEDQTY-001 adds three more of exactly that shape. They are real columns, so `i.*` puts them
    // on every list row this page holds; the handler does not name them in its SET list TODAY, so
    // they would ride through inert — and the day one is added, this body would re-assert the value
    // the row held AT MOUNT over a count written since through /seed-measure, and answer 200. A
    // presence guard on the handler would not save it (useInventory's `{ ...current, ...payload }`
    // re-inserts the stale value, so hasOwnProperty is TRUE). Absence is the only safe encoding.
    await mount()
    await click('advance-stage')
    await typeCount('14')
    await click('stage-save')
    const body = widePutBody()
    expect(Object.prototype.hasOwnProperty.call(body, 'seed_stage')).toBe(false)
    expect(body).not.toHaveProperty('seed_process')
    expect(body).not.toHaveProperty('variety_id')
    expect(body).not.toHaveProperty('featured_photo_id')
    for (const k of ['seed_count', 'seed_weight_g', 'seed_count_estimated']) {
      expect(Object.prototype.hasOwnProperty.call(body, k),
        `${k} in a wide-PUT body — this page must reach it only through /seed-measure`).toBe(false)
    }
    // List-only projections, not columns.
    expect(body).not.toHaveProperty('variety_name')
    expect(body).not.toHaveProperty('stage_entered_at')
    expect(body).not.toHaveProperty('crop_slug')
  })

  it('a failed COUNT does not report the stage move as failed', async () => {
    // Two independent facts with two independent failures, the same contract the parent-plant link
    // beside it keeps: the lot reached stored whether or not the number also landed. Scoped to the
    // /seed-measure path so this stays a test about the COUNT — the year_harvested PUT beside it has
    // its own failure and its own message.
    fetchSpy.mockImplementation((path, opts) => {
      const p = String(path)
      if (opts?.method === 'PUT' && p.endsWith('/seed-measure')) {
        return Promise.reject(new Error('Network unreachable'))
      }
      if (opts?.method) return Promise.resolve({ ok: true })
      if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([])
      if (p.startsWith('/api/inventory-items')) return Promise.resolve([LOT])
      return Promise.resolve([])
    })
    await act(async () => { render(<ToastProvider><SavedSeeds /></ToastProvider>) })
    await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
    await click('advance-stage')
    await typeCount('14')
    await click('stage-save')
    // The sheet closes and the stage POST is not retried — the move happened.
    await waitFor(() => expect(screen.queryByTestId('stage-save')).toBeNull())
    expect(document.body.textContent).toContain('Network unreachable')
  })

  it('forgets the typed count between lots', async () => {
    // The sheet is re-opened per lot; a number left over from the previous one would be written
    // against a packet nobody counted.
    await mount([UNCOUNTED, { ...UNCOUNTED, id: 'inv-2', name: 'Sungold', variety_name: 'Sungold' }])
    const advanceButtons = () => screen.getAllByTestId('advance-stage')
    await act(async () => { fireEvent.click(advanceButtons()[0]) })
    await typeCount('14')
    await act(async () => { fireEvent.click(screen.getByLabelText('Close')) })
    await act(async () => { fireEvent.click(advanceButtons()[1]) })
    expect(screen.getByTestId('seed-count-input').value).toBe('')
  })
})

describe('V5-SEEDQTY-001 — the count stays ON SCREEN once it leaves quantity_on_hand', () => {
  // The picker's second line is where a packet's contents are read before a permanent stage-log row
  // is written against it (BUG-SEEDCANDIDATEAMBIG-001). It rendered `${formatQty(qty)} ${unit}`, so
  // a saved lot read "185 packet" — the number was right for the wrong reason. After the backfill
  // that same row reads "1 packet", and without a seed segment here the count Dave typed simply
  // stops being anywhere on this page.
  //
  // An UNTRACKED packet, because that is the only kind this list offers: `seed_stage` null is what
  // makes a row a candidate. Shape and scalars from the live `Green Flesh Honeydew` row
  // (2d6df841-…), quantities as the backfill will leave a saved lot.
  const PACKET = {
    id: 'inv-9', name: 'Green Flesh Honeydew', variety_name: 'Green Flesh', category: 'seeds',
    type: 'consumable', unit: 'packet', status: 'active', quantity_on_hand: '1.000',
    variety_id: 'v-melon', seed_stage: null, seed_process: null, source_plant_id: null,
    source: 'Gardens at Mathews', purchase_date: null, stage_entered_at: null,
    seed_count: 185, seed_weight_g: null, seed_count_estimated: false,
  }
  const detailFor = async (over) => {
    await mount([LOT, { ...PACKET, ...over }])
    await click('track-a-lot')
    return screen.getByTestId('track-candidate-detail').textContent
  }

  it('renders the seed count BESIDE the packet count, not instead of it', async () => {
    const text = await detailFor({})
    expect(text).toContain('185 seeds')
    // The green control on the same string: the packet count is still there, so this is a widening
    // and not a swap. "1 packet" is the post-backfill truth and it is worth saying out loud.
    expect(text).toContain('1 packet')
    expect(text).toContain('Gardens at Mathews')
  })

  it('says nothing at all about seeds when nobody has counted them', async () => {
    // The must-fail arm, paired with the green above so a picker that stopped rendering its detail
    // line entirely cannot read as a pass. Absent facts are DROPPED on this line, never rendered as
    // a dash — and "0 seeds" for an uncounted lot would be a fabricated measurement.
    const text = await detailFor({ seed_count: null })
    expect(text).not.toMatch(/seeds?\b/)
    expect(text).toContain('1 packet')
  })

  it('renders a measured zero, because a lot that yielded nothing is worth seeing first', async () => {
    expect(await detailFor({ seed_count: 0 })).toContain('0 seeds')
  })

  // `seed_weight_g` is numeric(10,3), and the pg driver hands numerics back as STRINGS — '0.500',
  // never 0.5 (src/lib/format.js:2). Every weight fixture below is therefore a string, which is also
  // why formatSeedWeight does the coercion and nothing on this page compares the raw value.
  // `seed_count` is a plain integer column and DOES arrive as a number; only the weight is a string.
  it('renders the WEIGHT through formatSeedWeight, never through formatQty', async () => {
    // formatQty is String(Math.round(n)) with no unit, so it would render '0.500' as the bare "1" —
    // a wrong number wearing no noun, sitting next to a seed count. Half a gram is a real lot of
    // small seed (lettuce, brassica) and this is the surface it is read on before a permanent
    // stage-log row is written against the packet.
    expect(await detailFor({ seed_weight_g: '0.500' })).toContain('0.5 g')
  })

  it('drops to milligrams below a tenth of a gram, rather than rounding a real lot to nothing', async () => {
    // The lower half of format.js's own boundary pair. '0.099' is the value that separates `>=` from
    // `>` — a slip there renders "0.1 g" for both and the distinction is invisible.
    expect(await detailFor({ seed_weight_g: '0.099' })).toContain('99 mg')
  })

  it('says nothing about weight when nobody has weighed it', async () => {
    // The green control for the pair above: an unweighed lot is every lot in prod today, and a
    // stray "0 g" there would assert a scale reading that never happened.
    const text = await detailFor({ seed_weight_g: null })
    expect(text).not.toMatch(/\b(g|mg)\b/)
    expect(text).toContain('185 seeds')
  })

  it('says "1 seed", not "1 seeds"', async () => {
    const text = await detailFor({ seed_count: 1 })
    expect(text).toContain('1 seed ')
    expect(text).not.toContain('1 seeds')
  })
})

describe('parseCountInput — the rule the whole fix turns on', () => {
  // The asymmetry between stages IS the fix, so it is asserted directly rather than only through
  // the sheet: the rendered tests above can only reach one stage per mount.
  it('lets a blank through on an in-flight stage, writing nothing', () => {
    for (const stage of ['fermenting', 'drying']) {
      expect(parseCountInput('', stage)).toEqual({ value: null, error: null })
      expect(parseCountInput('   ', stage)).toEqual({ value: null, error: null })
    }
  })

  it('refuses a blank on stored', () => {
    const out = parseCountInput('', 'stored')
    expect(out.value).toBeNull()
    expect(out.error).toBeTruthy()
    // The refusal has to name zero as the way out, or it reads as "you must have some seed" and the
    // honest answer to a failed lot becomes unreachable.
    expect(out.error).toMatch(/\b0\b/)
  })

  it('accepts an explicit zero on stored — the answer the blank was hiding', () => {
    expect(parseCountInput('0', 'stored')).toEqual({ value: 0, error: null })
  })

  it('refuses negatives and non-numbers rather than coercing them', () => {
    // Number('') is 0 and Number('abc') is NaN, so a bare Number() here would turn a blank into a
    // hard zero and a typo into a silent no-op — on the one field that decides sowability.
    for (const stage of ['drying', 'stored']) {
      expect(parseCountInput('-1', stage).error).toBeTruthy()
      expect(parseCountInput('abc', stage).error).toBeTruthy()
      expect(parseCountInput('-1', stage).value).toBeNull()
      expect(parseCountInput('abc', stage).value).toBeNull()
    }
  })

  it('refuses a FRACTION, because seed_count is an integer column', () => {
    // INVERTED at V5-SEEDQTY-001, and the inversion is the schema change rather than a change of
    // mind. The old rule ("takes a fraction as given") was right while the count lived in
    // `quantity_on_hand numeric(10,3)`, where half a packet is a coherent quantity. `seed_count` is
    // an `integer`, and /seed-measure answers a non-integer with
    // `400 seed_count must be a whole number of seeds, or null` — which arrives AFTER the stage POST
    // has landed, so an unguarded 20.5 moves the lot and drops the count onto a toast. Refused
    // before any request, the way every other rule in this function is.
    for (const raw of ['0.5', '20.5', '185.001']) {
      const out = parseCountInput(raw, 'stored')
      expect(out.value, `${raw} must not reach the request`).toBeNull()
      expect(out.error).toBe('A seed count is a whole number of seeds.')
    }
  })

  it('still accepts a whole number written with a decimal point', () => {
    // The green control for the pair above. `Number('185.0')` is 185 and Number.isInteger(185) is
    // true, so a keypad that appends a trailing zero is not a refusal — the rule is about the VALUE
    // being a whole number of seeds, not about the spelling.
    expect(parseCountInput('185.0', 'stored')).toEqual({ value: 185, error: null })
    expect(parseCountInput('185', 'stored')).toEqual({ value: 185, error: null })
  })
})

describe('listRowPutBody — the strip list, and its agreement with the handler', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

  it('strips the derived and presence-guarded keys and touches no quantity', () => {
    const body = listRowPutBody(LOT)
    expect(body.name).toBe('Green Flesh Honeydew')
    // WAS `countPayloadFrom(row, count)`, which returned `{ ...out, quantity_on_hand: count }` — the
    // single line that put a seed count in the containers column. The row's own value now rides
    // through untouched.
    expect(body.quantity_on_hand).toBe('1.000')
    for (const k of ['seed_stage', 'seed_process', 'variety_id', 'featured_photo_id',
                     'variety_name', 'stage_entered_at', 'crop_slug',
                     'seed_count', 'seed_weight_g', 'seed_count_estimated']) {
      expect(Object.prototype.hasOwnProperty.call(body, k), `${k} should be stripped`).toBe(false)
    }
  })

  it('tolerates a null row rather than throwing on one', () => {
    expect(listRowPutBody(null)).toEqual({})
  })

  it('strips every key the handler reads by PRESENCE', () => {
    // RE-ANCHORED, V5-SEEDSTAGEONEPLACE-001. This used to scrape PUT_DERIVED_KEYS +
    // PUT_PRESENCE_GUARDED_KEYS out of InventoryDetail.jsx. Those constants were deleted with that
    // page's stage control and count prompt — its only wide-PUT writers — so the old scrape now
    // finds nothing, and re-creating them there to keep this green would be a guard citing code
    // nothing runs.
    //
    // The replacement anchor is STRONGER, not a downgrade: it reads the AUTHORITY rather than a
    // second hand-maintained copy. `Object.prototype.hasOwnProperty.call(body, 'x')` is the handler's
    // own presence idiom, and every key written that way is one where OMITTING is the guaranteed
    // no-op and MENTIONING is an assignment. This page round-trips a LIST row into the wide PUT, so
    // any such key it echoes back is a stale value asserted as an edit — `seed_stage` most of all,
    // where it would revert the move the sheet was titled for.
    //
    // Whole-file rather than PUT-arm-only, deliberately: the sub-routes use the same idiom for
    // source_plant_id / source_kind, and those two are in our strip list as a DELAY FUSE for the day
    // they join the PUT's SET list. Scoping the scrape to the PUT arm would let them silently fall
    // out of the list before that day arrives.
    const handler = readFileSync(resolve(ROOT, 'lambda/inventory-items/index.js'), 'utf8')
    const saved = readFileSync(resolve(ROOT, 'src/pages/SavedSeeds.jsx'), 'utf8')
    const m = saved.match(/\bLIST_ROW_PUT_STRIP\s*=\s*\[([^\]]*)\]/)
    expect(m, 'LIST_ROW_PUT_STRIP not found in SavedSeeds.jsx — renamed, moved, or reformatted').toBeTruthy()
    const ours = [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1])
    const guarded = [...new Set(
      [...handler.matchAll(/hasOwnProperty\.call\(body, '([^']+)'\)/g)].map(x => x[1]),
    )].sort()
    // NAMED KEYS + CONTAINMENT, no longer an exact-equality literal (V5-SEEDQTY-001). The literal was
    // there to stop a regex that silently stopped matching from reporting an empty set as agreement,
    // and that job is done just as completely by requiring each known key BY NAME: an empty `guarded`
    // reds on the first one. What the literal ALSO did was red on every legitimate widening — and
    // /seed-measure adds three presence-guarded keys at once, so a frozen list would have had to be
    // hand-bumped in the same breath as the widening it was supposed to police. Named-plus-
    // containment is strictly stronger on the property that matters: any key the handler starts
    // reading by presence must be in our strip list, forever, without anyone remembering to say so.
    //
    // V5-SOURCEPICKER-001 added source_id / acquired_from_source_id. They differ in kind from
    // source_plant_id/source_kind, which sit in the strip list as a DELAY FUSE for a day that has not
    // come: those two ARE in the PUT's SET list already, so for them omitting is the no-op and
    // mentioning is a live assignment against a column the backfill populated on every inventory row.
    for (const k of ['acquired_from_source_id', 'featured_photo_id', 'seed_process', 'seed_stage',
                     'source_id', 'source_kind', 'source_plant_id', 'variety_id']) {
      expect(guarded, `${k} is presence-guarded in the handler and the scrape lost it`).toContain(k)
    }
    expect(guarded.filter(k => !ours.includes(k)),
      'the handler reads these by presence and this page does not strip them').toEqual([])
    // The GET-DERIVED half has no such idiom to scrape — these are columns the id-GET and the list
    // query ADD, not columns on inventory_items — so they are named. Inert in the SET list today
    // (it reads only the keys it names), stripped because a PUT body carrying a germination summary
    // or a cultivar join is an invitation to wire one of them up.
    for (const k of ['germination', 'featured_photo_view_url', 'variety_name', 'featured_is_explicit',
                     'stage_entered_at', 'crop_slug']) {
      expect(ours, `${k} must stay in LIST_ROW_PUT_STRIP`).toContain(k)
    }
  })
})
