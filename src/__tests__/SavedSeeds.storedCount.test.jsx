// V4-SEEDSTOREDQTY-001 — the count is asked when the lot is STORED, not when it is saved.
//
// THE DECISION. At "Save seed" the seed is still wet and unthreshed; nobody knows how much there is,
// and the packet-count field that used to sit on that sheet collected a guess and stored it as
// though it were measured. The first moment anyone knows is when the lot is packeted and put away.
// So SaveSeedSheet creates the lot on 0 and every path INTO `stored` asks. This file covers the
// /seeds/saved half — the advance sheet; the /inventory/:id half is
// src/__tests__/InventoryDetail.storedCount.test.jsx.
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

import SavedSeeds, { countPayloadFrom } from '../pages/SavedSeeds.jsx'
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
  await act(async () => { fireEvent.change(screen.getByTestId('stored-count-input'), { target: { value: v } }) })
}
const writes = () => fetchSpy.mock.calls.filter(([, o]) => o?.method)
const putBody = () => {
  const puts = writes().filter(([p, o]) => String(p) === '/api/inventory-items/inv-1' && o.method === 'PUT')
  expect(puts, 'no count PUT was issued').toHaveLength(1)
  return JSON.parse(puts[0][1].body)
}

beforeEach(() => { fetchSpy.mockReset() })

describe('V4-SEEDSTOREDQTY-001 — the advance sheet asks on the way into stored', () => {
  it('shows the count field for stored and for no other stage', async () => {
    // A ferment or a dry has the same unanswerable question the create sheet just stopped asking;
    // re-posing it there would collect the same guess one screen later.
    await mount([{ ...LOT, seed_stage: 'fermenting' }])
    await click('advance-stage')       // fermenting -> drying
    expect(screen.queryByTestId('stored-count')).toBeNull()
  })

  it('shows it on drying -> stored', async () => {
    await mount()
    await click('advance-stage')       // drying -> stored
    expect(screen.getByTestId('stored-count')).toBeTruthy()
    // The consequence, on the field that causes it: a lot left on 0 reads as depleted on Sow now.
    expect(screen.getByTestId('stored-count').textContent).toMatch(/Sow now/i)
  })

  it('writes NOTHING extra when the count is left blank', async () => {
    // "Still haven't counted" is a real answer, not a skipped field. Writing 0 (or anything) for it
    // would fabricate a measurement, which is the defect this whole change exists to remove.
    await mount()
    await click('advance-stage')
    await click('stage-save')
    expect(writes()).toHaveLength(1)
    expect(`${writes()[0][1].method} ${writes()[0][0]}`)
      .toBe('POST /api/inventory-items/inv-1/seed-stage')
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
    expect(screen.getByTestId('stored-count-input').value).toBe('')
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
