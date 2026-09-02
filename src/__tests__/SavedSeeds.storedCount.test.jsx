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
// The /inventory/:id half is src/__tests__/InventoryDetail.storedCount.test.jsx, and it is
// DELIBERATELY ASYMMETRIC — dismissible there. That panel appears only AFTER its stage write has
// landed, so "required" could only mean nagging until satisfied, and the row cannot tell an
// answered 0 ("none of it was viable") from an unanswered one. It would nag forever on exactly the
// lots whose owner did answer. That asymmetry was implemented, reverted, and is recorded here so it
// is not re-attempted as an oversight.
//
// THE PAYLOAD IS THE SUBJECT, not the click, and for the same reason InventoryDetail's stage tests
// give: there is no narrow quantity route, so the count rides PUT /api/inventory-items/:id — the
// wide PUT, where every column in the SET list is assigned unconditionally. A short body there is
// not a partial update, it is a wipe with a 200 on it. And the key that would BITE is `seed_stage`:
// the row this page holds is the LIST row, carrying the stage as it was BEFORE the advance, so
// echoing it back would silently revert the move the sheet is titled for.
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

import SavedSeeds, { countPayloadFrom, parseCountInput } from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// A DRYING lot exactly as the list endpoint returns it: every inventory_items column, plus the two
// the list query derives (variety_name from the cultivar join, stage_entered_at from the LATERAL).
// `metadata` is here on purpose — the wide PUT's SET list deliberately never names it, which makes
// it a clean marker for "the whole row was round-tripped" rather than a projection of it.
const LOT = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: 0, unit: 'packet', reorder_threshold: null,
  reorder_quantity: null, notes: 'From the 2026 melon', source: 'Self-saved', source_url: null,
  purchase_date: null, unit_cost: null, quantity_purchased: null, location_text: 'Seed tin',
  brand: null, model: null, tags: ['melon'], metadata: { sku: 'GF-2026' },
  variety_id: 'v-melon', source_plant_id: 'pl-melon',
  seed_stage: 'drying', seed_process: 'wet', featured_photo_id: 'ph-1',
  variety_name: 'Green Flesh', stage_entered_at: '2026-08-25T12:00:00Z',
  updated_at: '2026-08-30T12:00:00Z',
}

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
const putBody = () => {
  const puts = writes().filter(([p, o]) => String(p) === '/api/inventory-items/inv-1' && o.method === 'PUT')
  expect(puts, 'no count PUT was issued').toHaveLength(1)
  return JSON.parse(puts[0][1].body)
}

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
    await mount([{ ...LOT, seed_stage: 'fermenting' }])
    await click('advance-stage')       // fermenting -> drying
    await click('stage-save')
    expect(writes()).toHaveLength(1)
    expect(`${writes()[0][1].method} ${writes()[0][0]}`)
      .toBe('POST /api/inventory-items/inv-1/seed-stage')
  })

  it('REFUSES the move into stored when the count is blank, before any request', async () => {
    // The ordering is the point, not just the refusal. seed_lot_stage_log has no DELETE route and
    // this page cannot repair a stage, so a submit that landed the stage and then rejected the count
    // would leave the lot somewhere it cannot be moved back from. Nothing may go out.
    await mount()
    await click('advance-stage')       // drying -> stored
    await click('stage-save')
    expect(writes(), 'a request went out despite the refusal').toHaveLength(0)
    expect(screen.getByTestId('seed-count-error')).toBeTruthy()
    // The sheet stays open on the field that blocked it.
    expect(screen.getByTestId('stage-save')).toBeTruthy()
  })

  it('clears the refusal and goes through once a number is typed', async () => {
    await mount()
    await click('advance-stage')
    await click('stage-save')
    expect(screen.getByTestId('seed-count-error')).toBeTruthy()
    await typeCount('9')
    expect(screen.queryByTestId('seed-count-error'), 'stale refusal left on screen').toBeNull()
    await click('stage-save')
    expect(writes().map(([p, o]) => `${o.method} ${p}`)).toEqual([
      'POST /api/inventory-items/inv-1/seed-stage',
      'PUT /api/inventory-items/inv-1',
    ])
  })

  it('prefills from the count the lot already holds, so the field is an UPDATE', async () => {
    // Dave: "Each step needs to be able to set/update that count." Re-asking from blank each time
    // would make a running number look like a fresh capture, and the likeliest edit — nudging 40 to
    // 38 after cleaning — would mean retyping it.
    await mount([{ ...LOT, seed_stage: 'fermenting', quantity_on_hand: 40 }])
    await click('advance-stage')
    expect(screen.getByTestId('seed-count-input').value).toBe('40')
  })

  it('prefills BLANK from a zero, so a stored move cannot satisfy itself', async () => {
    // 0 is the create-time placeholder for "nobody has counted this yet". Rendering it as an answer
    // would let the required field at `stored` be satisfied by a number no human typed — which is
    // the whole defect, reintroduced through the prefill.
    await mount()                      // LOT.quantity_on_hand is 0
    await click('advance-stage')
    expect(screen.getByTestId('seed-count-input').value).toBe('')
  })

  it('writes the count as a SECOND request once one is entered', async () => {
    await mount()
    await click('advance-stage')
    await typeCount('14')
    await click('stage-save')

    const seq = writes().map(([p, o]) => `${o.method} ${p}`)
    expect(seq).toEqual([
      'POST /api/inventory-items/inv-1/seed-stage',
      'PUT /api/inventory-items/inv-1',
    ])
    expect(putBody().quantity_on_hand).toBe(14)
  })

  it('accepts a genuine zero — "I counted, and there is none"', async () => {
    // Distinct from blank, and the distinction matters: a lot that yielded nothing is a measured
    // fact worth recording, and `>= 0` rather than `> 0` is what makes it expressible.
    await mount()
    await click('advance-stage')
    await typeCount('0')
    await click('stage-save')
    expect(putBody().quantity_on_hand).toBe(0)
  })

  it('sends a COMPLETE body — the wide PUT nulls every column it does not name', async () => {
    await mount()
    await click('advance-stage')
    await typeCount('14')
    await click('stage-save')
    const body = putBody()
    for (const [k, v] of Object.entries({
      name: 'Green Flesh Honeydew', type: 'consumable', category: 'seeds', status: 'active',
      unit: 'packet', notes: 'From the 2026 melon', source: 'Self-saved', location_text: 'Seed tin',
    })) expect(body[k], `${k} missing from the count PUT — the handler would NULL it`).toBe(v)
    expect(body.tags).toEqual(['melon'])
    // Not a form projection: metadata is a column no edit form on this app renders or returns.
    expect(body.metadata).toEqual({ sku: 'GF-2026' })
    // `type` is the one that would fail QUIETLY: the handler writes
    // `quantity_on_hand = ${isConsumable ? … : null}`, so a body without it nulls the very column
    // this request exists to set.
    expect(body.type).toBe('consumable')
  })

  it('OMITS seed_stage, so the count cannot revert the advance that just landed', async () => {
    // THE hazard of round-tripping the LIST row: it carries `drying`, the stage as it was before the
    // POST. Mentioning that key is an assignment (the handler reads it by presence), so echoing it
    // would undo the move with a 200. Omitted, the freshly-written `stored` is left alone.
    await mount()
    await click('advance-stage')
    await typeCount('14')
    await click('stage-save')
    const body = putBody()
    expect(Object.prototype.hasOwnProperty.call(body, 'seed_stage')).toBe(false)
    expect(body).not.toHaveProperty('seed_process')
    expect(body).not.toHaveProperty('variety_id')
    expect(body).not.toHaveProperty('featured_photo_id')
    // List-only projections, not columns.
    expect(body).not.toHaveProperty('variety_name')
    expect(body).not.toHaveProperty('stage_entered_at')
  })

  it('a failed COUNT does not report the stage move as failed', async () => {
    // Two independent facts with two independent failures, the same contract the parent-plant link
    // beside it keeps: the lot reached stored whether or not the number also landed.
    fetchSpy.mockImplementation((path, opts) => {
      const p = String(path)
      if (opts?.method === 'PUT') return Promise.reject(new Error('Network unreachable'))
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
    await mount([LOT, { ...LOT, id: 'inv-2', name: 'Sungold', variety_name: 'Sungold' }])
    const advanceButtons = () => screen.getAllByTestId('advance-stage')
    await act(async () => { fireEvent.click(advanceButtons()[0]) })
    await typeCount('14')
    await act(async () => { fireEvent.click(screen.getByLabelText('Close')) })
    await act(async () => { fireEvent.click(advanceButtons()[1]) })
    expect(screen.getByTestId('seed-count-input').value).toBe('')
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

  it('takes a fraction as given — seed is not always counted in whole units', () => {
    expect(parseCountInput('0.5', 'stored')).toEqual({ value: 0.5, error: null })
  })
})

describe('countPayloadFrom — the strip list, and its agreement with InventoryDetail', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

  it('strips the derived and presence-guarded keys and applies the count', () => {
    const body = countPayloadFrom(LOT, 7)
    expect(body.quantity_on_hand).toBe(7)
    expect(body.name).toBe('Green Flesh Honeydew')
    for (const k of ['seed_stage', 'seed_process', 'variety_id', 'featured_photo_id',
                     'variety_name', 'stage_entered_at']) {
      expect(Object.prototype.hasOwnProperty.call(body, k), `${k} should be stripped`).toBe(false)
    }
  })

  it('tolerates a null row rather than throwing on one', () => {
    expect(countPayloadFrom(null, 3)).toEqual({ quantity_on_hand: 3 })
  })

  it('strips at least everything InventoryDetail strips', () => {
    // The two lists are separate copies (a page must not import another page's module), so this is
    // the seam. Asserted as a SUBSET in the safe direction: a key added to InventoryDetail's lists
    // and not to this page's would otherwise start riding a body it was excluded from for a reason.
    // Same source-text-scrape idiom as seedStageVocabulary.test.js, and it asserts its own match
    // first so a rename cannot make it pass vacuously.
    const detail = readFileSync(resolve(ROOT, 'src/pages/InventoryDetail.jsx'), 'utf8')
    const saved = readFileSync(resolve(ROOT, 'src/pages/SavedSeeds.jsx'), 'utf8')
    const arrayOf = (src, name, where) => {
      const m = src.match(new RegExp(`\\b${name}\\s*=\\s*\\[([^\\]]*)\\]`))
      expect(m, `${name} not found in ${where} — renamed, moved, or reformatted across lines`).toBeTruthy()
      return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1])
    }
    const theirs = [
      ...arrayOf(detail, 'PUT_DERIVED_KEYS', 'InventoryDetail.jsx'),
      ...arrayOf(detail, 'PUT_PRESENCE_GUARDED_KEYS', 'InventoryDetail.jsx'),
    ]
    const ours = arrayOf(saved, 'LIST_ROW_PUT_STRIP', 'SavedSeeds.jsx')
    expect(theirs.length).toBeGreaterThan(4)
    expect(theirs.filter(k => !ours.includes(k))).toEqual([])
  })
})
