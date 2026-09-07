// V5-SEEDCOUNTCARD-001 — the seed count on the card of a lot that is already TRACKED.
//
// THE GAP. V5-SEEDQTY-001 put `seed_count` / `seed_weight_g` on screen in exactly one place: the
// candidate picker's detail line (asserted in SavedSeeds.storedCount.test.jsx, "the count stays ON
// SCREEN once it leaves quantity_on_hand"). That picker lists UNTRACKED lots only — `seed_stage`
// null is what makes a row a candidate — so the count was visible only in the seconds before a lot
// was tracked and never again. Every lot Dave holds is at `stored`, which means the number the
// advance sheet REFUSED to let him past without typing was rendered nowhere on the page he opens.
//
// WHAT THIS FILE CANNOT DO, said out loud because it is the reason the previous lane stopped. jsdom
// returns 0 from every getBoundingClientRect(), so nothing here can tell "the measure line fits in
// the text column beside a 44-character variety name" from "it does not" — this suite would be green
// at a 0x0 viewport. CONTENT is what is asserted below: the right number, the right noun, and
// counted-vs-estimated. CLEARANCE is scripts/layout-gate/seeds-saved-clearance.mjs at 390x844, and
// nothing in this file may be cited for it. The one geometry-adjacent claim here is STRUCTURAL and
// is honest as such: the line is a descendant of the card's text column, which is what keeps it away
// from the advance button. Whether it then FITS is the gate's question.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, within } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
}))

import SavedSeeds, { lotMeasure } from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// A STORED lot, because that is where all three of Dave's real lots sit and it is the case with the
// least on screen: `stored` is terminal, so the card carries no advance button and no ferment badge.
// Scalars follow the live `1884 — saved 2026` shape the sibling suite works from — one packet on the
// shelf, 185 seeds in it — which is the pair this line has to keep straight.
const LOT = {
  id: 'inv-1', name: '1884 packet', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: '1.000', unit: 'packet',
  notes: null, source: 'Gardens at Mathews', purchase_date: null,
  seed_count: 185, seed_weight_g: null, seed_count_estimated: false,
  variety_id: 'v-tom', source_plant_id: null,
  seed_stage: 'stored', seed_process: null, featured_photo_id: null,
  variety_name: '1884', stage_entered_at: '2026-08-25T12:00:00Z', crop_slug: 'tomato',
  updated_at: '2026-08-30T12:00:00Z',
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

// The card, fetched by the id the layout gate measures, so a redesign that renames it breaks both
// instruments together rather than leaving this suite green over a card the gate can no longer find.
const card = () => screen.getByTestId('seed-lot-card')
// queryBy, not getBy: "there is no line" is a real expected state here and has to be assertable
// without throwing.
const measureLine = () => within(card()).queryByTestId('lot-seed-measure')
const measureText = async (over) => {
  await mount([{ ...LOT, ...over }])
  return measureLine()?.textContent ?? null
}

beforeEach(() => { fetchSpy.mockReset() })

describe('V5-SEEDCOUNTCARD-001 — the count reaches the TRACKED card, not just the picker', () => {
  it('renders the seed count on a stored lot, where nothing showed a quantity before', async () => {
    expect(await measureText({})).toContain('185 seeds')
  })

  it('renders it on an in-flight lot too, not only on stored ones', async () => {
    // The stage is not what makes a measurement worth showing — a lot counted at drying keeps that
    // count through every later stage, and gating on `stored` would hide it exactly while the
    // gardener is still working the seed.
    expect(await measureText({ seed_stage: 'drying', seed_process: 'wet' })).toContain('185 seeds')
  })

  it('says NOTHING about seeds when nobody has counted them', async () => {
    // The must-fail arm for every green above. `seed_count` is nullable precisely so that absent and
    // zero are different facts, and a card that renders "0 seeds" over a NULL asserts a measurement
    // that never happened. Paired with a positive assertion so a card that stopped rendering
    // entirely — or a page that failed to mount — cannot pass as "correctly silent".
    await mount([{ ...LOT, seed_count: null, seed_weight_g: null, seed_count_estimated: null }])
    expect(card().textContent).toContain('1884')
    expect(measureLine()).toBeNull()
    expect(card().textContent).not.toMatch(/seeds?\b/)
  })

  it('renders a measured ZERO, because a lot that yielded nothing is the one worth seeing', async () => {
    expect(await measureText({ seed_count: 0 })).toContain('0 seeds')
  })

  it('says "1 seed", not "1 seeds"', async () => {
    const text = await measureText({ seed_count: 1 })
    expect(text).toContain('1 seed')
    expect(text).not.toContain('1 seeds')
  })
})

describe('V5-SEEDCOUNTCARD-001 — seeds are not packets', () => {
  it('renders the SEED count, never the containers column', async () => {
    // The defect V5-SEEDQTY-001 shipped to fix, one surface further on: `quantity_on_hand` is
    // CONTAINERS and reads '1.000' on every saved lot after the backfill. A card that took its
    // number from there would say "1" — right-looking, wrong column, wrong noun.
    const text = await measureText({ quantity_on_hand: '1.000', seed_count: 185 })
    expect(text).toContain('185 seeds')
    expect(text).not.toMatch(/\b1 seed\b/)
  })

  it('does not put the packet count on the card wearing any noun at all', async () => {
    // Deliberately absent rather than merely un-relabelled: the picker prints "1 packet" to tell 260
    // near-identical rows apart, and this card has nothing to disambiguate. Asserted on the whole
    // card, not just the measure line, so moving the packet count somewhere else on the card is
    // still caught.
    await mount([LOT])
    expect(measureLine().textContent).toContain('185 seeds')
    expect(card().textContent).not.toMatch(/packet/i)
  })
})

describe('V5-SEEDCOUNTCARD-001 — a vendor estimate is distinguishable from a hand count', () => {
  it('marks an estimated count as approximate', async () => {
    // `seed_count_estimated` true means a number off the back of a packet ("approx. 25 seeds"), and
    // the column says nothing at all if the two read identically on screen.
    expect(await measureText({ seed_count_estimated: true })).toContain('approx. 185 seeds')
  })

  it('leaves a hand-counted number unqualified', async () => {
    const text = await measureText({ seed_count_estimated: false })
    expect(text).toContain('185 seeds')
    expect(text).not.toMatch(/approx/i)
  })

  it('treats a null flag as unqualified rather than as an estimate', async () => {
    // Every lot this page writes gets `false`, but rows predating the column carry NULL and are not
    // estimates — they are counts whose provenance nobody recorded. Calling them approximate would
    // be a claim the data does not support.
    const text = await measureText({ seed_count_estimated: null })
    expect(text).not.toMatch(/approx/i)
    expect(text).toContain('185 seeds')
  })
})

describe('V5-SEEDCOUNTCARD-001 — weight goes through formatSeedWeight, never formatQty', () => {
  it('renders a sub-gram lot as grams, not as a bare rounded integer', async () => {
    // formatQty is String(Math.round(n)) with no unit, so '0.500' through it is the bare "1" — a
    // wrong number wearing no noun, beside a seed count.
    expect(await measureText({ seed_weight_g: '0.500' })).toContain('0.5 g')
  })

  it('drops to milligrams below a tenth of a gram', async () => {
    expect(await measureText({ seed_weight_g: '0.099' })).toContain('99 mg')
  })

  it('renders a weight on a lot nobody has counted, rather than needing both', async () => {
    const text = await measureText({ seed_count: null, seed_weight_g: '2.000' })
    expect(text).toContain('2 g')
    expect(text).not.toMatch(/seeds?\b/)
  })

  it('says nothing about weight when nobody has weighed it', async () => {
    const text = await measureText({ seed_weight_g: null })
    expect(text).toContain('185 seeds')
    expect(text).not.toMatch(/\b(g|mg)\b/)
  })

  it('renders both facts on one line, count first', async () => {
    const text = await measureText({ seed_count: 185, seed_weight_g: '12.500' })
    expect(text).toBe('185 seeds · 12.5 g')
  })
})

describe('V5-SEEDCOUNTCARD-001 — where the line sits (STRUCTURE, not clearance)', () => {
  it('renders inside the card text column, the flex child the advance button is not in', async () => {
    // This is containment, which jsdom CAN answer, and it is the property that keeps the line out of
    // the advance button's flex track. Whether the text then FITS beside that button at 390px is
    // geometry, is unanswerable here, and belongs to gate:seeds-saved.
    await mount([{ ...LOT, seed_stage: 'drying', seed_process: 'dry' }])
    const column = card().firstElementChild
    expect(column.contains(measureLine())).toBe(true)
    expect(column.contains(screen.getByTestId('advance-stage'))).toBe(false)
  })

  it('keeps the measurement out of the way of the ferment warning it is not part of', async () => {
    // A fermenting lot that is overdue carries a badge and a note. The measure line is a fact about
    // the jar, not about the ferment, so it renders after that block — asserted by document order so
    // a refactor cannot quietly interleave them.
    await mount([{
      ...LOT, seed_stage: 'fermenting', seed_process: 'wet',
      stage_entered_at: new Date(Date.now() - 6 * 86400000).toISOString(),
    }])
    const badge = screen.getByTestId('ferment-urgency')
    expect(measureLine()).toBeTruthy()
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: the measure line comes after the badge.
    expect(badge.compareDocumentPosition(measureLine()) & 4).toBeTruthy()
  })
})

describe('lotMeasure — the pure rule, asserted without a render', () => {
  it('drops absent facts rather than rendering a placeholder', () => {
    expect(lotMeasure({ seed_count: null, seed_weight_g: null })).toBe('')
    expect(lotMeasure({})).toBe('')
    // A row this page never receives, but the card maps over whatever the list returns.
    expect(lotMeasure(null)).toBe('')
  })

  it('keeps a measured zero', () => {
    expect(lotMeasure({ seed_count: 0 })).toBe('0 seeds')
  })

  it('refuses to render a non-numeric count as a count', () => {
    expect(lotMeasure({ seed_count: 'lots' })).toBe('')
  })

  it('renders the estimate marker as a word, so it survives being read aloud', () => {
    expect(lotMeasure({ seed_count: 25, seed_count_estimated: true })).toBe('approx. 25 seeds')
  })
})
