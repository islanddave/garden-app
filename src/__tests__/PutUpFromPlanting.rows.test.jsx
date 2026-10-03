// Put-Up UX pass R1, lane D (F21, D13) — the planting page's put-up rows, in the Pantry's words:
// src/components/planting/PutUpFromPlanting.jsx, PlantingKitchen.jsx and plantingKitchen.js.
//
// WHAT THIS FILE HOLDS:
//   • the discard-date sentence is jarWords.discardWords' — "discard by … · <where the date came from>", and
//     "use by" ONLY for cured and cellared produce; a house date says so even on a row with no stored basis;
//   • a soon or past row's sentence is tinted (soonTint.js) and no other row's is; the words do not change;
//   • every row still there says how many are left — grams for a weighed bag, as the Pantry does;
//   • THE SECTION'S OWN READ IS KEPT: it asks for the consumed rows, and a finished jar is listed;
//   • the two buttons that open the door HERE (Put-Up R2a, lane K): 48 px, their words, no navigation, and
//     the planting, its crop and its variety as the door's What;
//   • a link to a batch is 48 px and carries where it came from — withFrom(null, { label: <planting name> }) —
//     and nothing of this page's own route state; stored "Next time (…)" lines are read through nextTimeWords;
//   • no banned word, no total, nothing that counts.
// MUTATIONS (each run, each red here):
//   the read without include_consumed=1                     -> "a finished jar is still listed: the section asks for the consumed rows"
//   the tint on every row / on none                         -> "a soon or past row's date line is tinted, and no other is"
//   a local "use by" template in place of discardWords      -> "the date sentence is the Pantry's"
//   the house fallback dropped                              -> "a house date says so even when the row stores no basis"
//   "N left" only where it differs from the package count   -> "every row still there says how many are left"
//   the origin dropped from a batch link                    -> "a batch link carries the planting as where it came from"
//   a stored Next-time line printed raw                     -> "a stored Next time line is read, not printed raw"
//   the buttons back at 44 px, or the old words             -> "the two buttons are 48 px tall and say their words"
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

vi.mock('../components/PutUpPhotoThumb.jsx', () => ({
  default: ({ photoId, alt }) => (photoId ? <img alt={alt} data-testid="putup-thumb" /> : null),
}))
// Put-Up R2a, lane K: the section's buttons open the Pantry's door on this page. A stand-in here, showing what
// it was opened with; the REAL door on this host is PutUpR2K.host.test.jsx.
vi.mock('../components/pantry/PutSomethingUpSheet.jsx', () => ({
  default: ({ open, initialWhat, stockRows, onStartBatchInstead }) => (open
    ? <div role="dialog" data-testid="door-stub">{JSON.stringify({ initialWhat, stockRows, startBatch: typeof onStartBatchInstead })}</div>
    : null),
}))

import PutUpFromPlanting from '../components/planting/PutUpFromPlanting.jsx'
import PlantingKitchen from '../components/planting/PlantingKitchen.jsx'
import {
  leftWords, plantingDiscardWords, isSoonOrPast, isUsedUp, batchLinkState, plantingBatchesPath,
} from '../components/planting/plantingKitchen.js'
import { discardWords } from '../components/putup/jarWords.js'
import { SOON_CHIP_STYLE } from '../components/putup/soonTint.js'
import { readFrom, backLabel } from '../components/putup/origin.js'
import { P, T } from '../lib/tokens.js'

const NOW = new Date(2026, 9, 1, 12, 0, 0)                 // Oct 1, 2026
const PLANTING = { id: 'pl-1', name: 'Ristra Cayenne', variety_id: 'var-rc', variety_ref: { id: 'var-rc', name: 'Ristra Cayenne', crop_type_slug: 'pepper' } }
const rgb = (hex) => `rgb(${[0, 1, 2].map(i => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)).join(', ')})`

// One whats-put-up record, as jarRules.js projectRow sends it.
const rec = (over) => ({
  id: 'j', plant_id: 'pl-1', label: null, container_label: null, method: 'whole_freeze', method_other_text: null,
  quantity_value: null, quantity_unit: null, package_count: 1, remaining_count: 1, remaining_amount: null, stock_mode: 'counted',
  preserved_at: '2026-09-01', preserved_at_approx: null, preserved_at_precision: 'day',
  use_by_target: null, use_by_basis: null, use_by_status: null, storage_kind: 'deep_freezer', notes: null, photo_id: null, ...over,
})
const FINE = rec({ id: 'fine', label: 'Cayenne, frozen whole', package_count: 2, remaining_count: 2, preserved_at: '2026-09-06',
  use_by_target: '2027-09-06', use_by_basis: 'table', use_by_status: 'ok' })
const SOON = rec({ id: 'soon', label: 'Roasted cayenne', method: 'roast_freeze', package_count: 3, remaining_count: 1, preserved_at: '2026-05-04',
  use_by_target: '2026-10-09', use_by_basis: 'typed', use_by_status: 'use_soon' })
const PAST = rec({ id: 'past', label: 'Cayenne hot sauce', method: 'hot_sauce', storage_kind: 'fridge', package_count: 4, remaining_count: 4, preserved_at: '2026-03-20',
  use_by_target: '2026-09-20', use_by_basis: 'table', use_by_status: 'past_use_by' })
const CURED = rec({ id: 'cured', label: 'Ristra, hung', method: 'cure_store', storage_kind: 'cold_storage', package_count: 1, remaining_count: 1, preserved_at: '2026-09-10',
  use_by_target: '2026-12-10', use_by_basis: 'table', use_by_status: 'ok' })
const BAG = rec({ id: 'bag', label: 'Bag of cayenne', quantity_value: '412', quantity_unit: 'g', stock_mode: 'weighed', remaining_count: null, preserved_at: '2026-08-20' })
const GONE = rec({ id: 'gone', label: 'Cayenne powder', method: 'powder', storage_kind: 'pantry', package_count: 2, remaining_count: 0, preserved_at: '2026-06-01',
  use_by_target: '2026-10-05', use_by_basis: 'table', use_by_status: 'use_soon' })
const RECORDS = [FINE, SOON, PAST, CURED, BAG, GONE]

// The endpoint, as the Lambda answers it: grouped by place, and a finished jar ONLY when it is asked for.
const whatsPutUp = (records) => vi.fn((path) => {
  const url = new URL(path, 'http://x')
  if (url.pathname !== '/api/preservation/whats-put-up') return Promise.resolve(null)
  const keep = url.searchParams.get('include_consumed') === '1'
  const rows = records.filter(r => r.plant_id === url.searchParams.get('plant_id') && (keep || r.remaining_count == null || Number(r.remaining_count) > 0))
  return Promise.resolve({ group_by: 'storage', groups: [{ group_key: 'loc-1', label: 'Chest Freezer 2', records: rows }] })
})

// Where a link lands, and the router state it carried.
function Landed() {
  const loc = useLocation()
  return <pre data-testid="landed">{JSON.stringify({ path: loc.pathname + loc.search, state: loc.state })}</pre>
}
const landed = () => JSON.parse(screen.getByTestId('landed').textContent)
function mountSection(records = RECORDS, { planting = PLANTING, entry = '/planting' } = {}) {
  const fetch = whatsPutUp(records)
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/planting" element={<PutUpFromPlanting planting={planting} fetch={fetch} now={NOW} />} />
        <Route path="/put-up" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  )
  return fetch
}
const rows = () => screen.findAllByTestId('putup-from-planting-row')
const rowOf = (label) => screen.getAllByTestId('putup-from-planting-row').find(r => r.textContent.includes(label))
const within = (label, id) => rowOf(label).querySelector(`[data-testid="${id}"]`)

afterEach(cleanup)

describe('plantingKitchen.js — the words of a put-up row', () => {
  it('the date sentence is the Pantry\'s: discardWords over the row\'s own date, basis, method, place and status', () => {
    for (const r of [FINE, SOON, PAST, CURED]) {
      expect(plantingDiscardWords(r, NOW)).toBe(discardWords({ date: r.use_by_target, basis: r.use_by_basis, method: r.method, kind: r.storage_kind, status: r.use_by_status, now: NOW }))
    }
    expect(plantingDiscardWords(FINE, NOW)).toBe('discard by Sep 6, 2027 · general figure: whole freeze, deep freezer')
    expect(plantingDiscardWords(SOON, NOW)).toBe('discard by Oct 9 · set by hand · soon')
    expect(plantingDiscardWords(PAST, NOW)).toBe('discard date passed Sep 20 · general figure: hot sauce, fridge')
    expect(plantingDiscardWords(rec({ use_by_target: '2026-10-16', use_by_basis: 'recipe' }), NOW)).toBe('discard by Oct 16 · from the recipe')
  })

  it('cured and cellared produce keep "use by", by rule; nothing else says it', () => {
    expect(plantingDiscardWords(CURED, NOW)).toBe('use by Dec 10 · general figure: cure & store, cellar')
    expect(plantingDiscardWords(rec({ method: 'cold_store', storage_kind: 'cold_storage', use_by_target: '2026-09-20', use_by_basis: 'table', use_by_status: 'past_use_by' }), NOW))
      .toBe('use-by passed Sep 20 · general figure: cold store, cellar')
    for (const r of [FINE, SOON, PAST]) expect(plantingDiscardWords(r, NOW)).not.toMatch(/use.by/)
  })

  it('a row with no date says so only when someone said so; a row nobody dated says nothing', () => {
    expect(plantingDiscardWords(rec({ use_by_basis: 'none' }), NOW)).toBe('no date — check it before using')
    expect(plantingDiscardWords(rec({ use_by_basis: 'typed' }), NOW)).toBe('no date · set by hand')
    expect(plantingDiscardWords(rec({}), NOW)).toBeNull()
    expect(plantingDiscardWords(null, NOW)).toBeNull()
  })

  it('a house date says so even when the row stores no basis (a jar written before a basis was kept)', () => {
    const candy = { method: 'candy', storage_kind: 'pantry', use_by_target: '2026-11-01' }
    expect(plantingDiscardWords(rec({ ...candy, use_by_basis: 'house' }), NOW)).toBe('discard by Nov 1 · house estimate')
    expect(plantingDiscardWords(rec({ ...candy, use_by_basis: null }), NOW)).toBe('discard by Nov 1 · house estimate')
    // …and only a house-sourced method is given that word: any other undated-basis row says the date alone.
    expect(plantingDiscardWords(rec({ method: 'blanch_freeze', use_by_target: '2027-07-10', use_by_basis: null }), NOW)).toBe('discard by Jul 10, 2027')
    expect(plantingDiscardWords(rec({ method: 'candy', use_by_target: null, use_by_basis: null }), NOW)).toBeNull()
  })

  it('a used-up row has no date sentence and is never soon, whatever the server classified', () => {
    expect(isUsedUp(GONE)).toBe(true)
    expect(plantingDiscardWords(GONE, NOW)).toBeNull()
    expect(isSoonOrPast(GONE)).toBe(false)
    expect([FINE, SOON, PAST, CURED, BAG].map(isSoonOrPast)).toEqual([false, true, true, false, false])
    // NULL is "never tracked", not "gone".
    expect([isUsedUp(rec({ remaining_count: null })), isUsedUp(rec({ remaining_count: '0' })), isUsedUp(rec({ remaining_count: 1 }))]).toEqual([false, true, false])
  })

  it('how many are left: a count, or grams for a weighed bag — what was last weighed, else what it held', () => {
    expect(leftWords(FINE)).toBe('2 left')
    expect(leftWords(rec({ package_count: 3, remaining_count: null }))).toBe('3 left')
    expect(leftWords(rec({ package_count: '4', remaining_count: '1' }))).toBe('1 left')
    expect(leftWords(BAG)).toBe('about 412 g left')
    expect(leftWords({ ...BAG, remaining_amount: '92.40' })).toBe('about 92 g left')
    expect(leftWords({ ...BAG, quantity_value: '1', quantity_unit: 'lb' })).toBe('about 454 g left')
    // A weighed row whose grams cannot be said falls back to its count; a row with neither says nothing.
    expect(leftWords({ ...BAG, quantity_value: null })).toBe('1 left')
    expect(leftWords(rec({ package_count: null, remaining_count: null }))).toBeNull()
    expect(leftWords(null)).toBeNull()
    for (const r of RECORDS) expect(String(leftWords(r))).not.toMatch(/null|undefined|NaN/)
  })

  it('the state a batch link carries: the planting\'s name as its origin, or nothing', () => {
    expect(batchLinkState(PLANTING)).toEqual({ from: { label: 'Ristra Cayenne' } })
    expect(batchLinkState({ id: 'pl-1', name: '  Ristra Cayenne  ' })).toEqual({ from: { label: 'Ristra Cayenne' } })
    for (const p of [{ id: 'pl-1' }, { id: 'pl-1', name: '   ' }, null, undefined]) expect(batchLinkState(p)).toBeNull()
    expect(backLabel(batchLinkState(PLANTING), 'Going now')).toBe('Ristra Cayenne')
  })
})

describe('the put-up rows on the planting page', () => {
  it('the date sentence is the Pantry\'s, row by row; a used row and an undated row have none', async () => {
    mountSection()
    await rows()
    const said = Object.fromEntries(RECORDS.map(r => [r.id, within(r.label, 'putup-from-planting-discard')?.textContent ?? null]))
    expect(said).toEqual({
      fine: 'discard by Sep 6, 2027 · general figure: whole freeze, deep freezer',
      soon: 'discard by Oct 9 · set by hand · soon',
      past: 'discard date passed Sep 20 · general figure: hot sauce, fridge',
      cured: 'use by Dec 10 · general figure: cure & store, cellar',
      bag: null,
      gone: null,
    })
  })

  it('a soon or past row\'s date line is tinted, and no other is; the tint changes no word', async () => {
    mountSection()
    await rows()
    for (const label of [SOON.label, PAST.label]) {
      const line = within(label, 'putup-from-planting-discard')
      expect(line.dataset.soon).toBe('true')
      expect([line.style.backgroundColor, line.style.color, line.style.fontWeight, line.style.padding, line.style.borderRadius])
        .toEqual([rgb(SOON_CHIP_STYLE.backgroundColor), rgb(SOON_CHIP_STYLE.color), '600', '2px 8px', '999px'])
      expect(line.style.display).toBe('inline-block')           // it hugs its words, it is not a bar across the card
    }
    for (const label of [FINE.label, CURED.label]) {
      const line = within(label, 'putup-from-planting-discard')
      expect(line.dataset.soon).toBeUndefined()
      expect([line.style.backgroundColor, line.style.color, line.style.fontWeight]).toEqual(['', rgb(P.mid), ''])
    }
    // The old cue is gone: no "N use soon" anywhere.
    expect(document.body.textContent).not.toMatch(/use soon/i)
  })

  it('every row still there says how many are left; the used one says "all used"', async () => {
    mountSection()
    await rows()
    const detail = Object.fromEntries(RECORDS.map(r => [r.id, within(r.label, 'putup-from-planting-detail').textContent]))
    expect(detail).toEqual({
      fine: 'Chest Freezer 2 · 2 left · put up Sep 6, 2026',
      soon: 'Chest Freezer 2 · 1 left · put up May 4, 2026',
      past: 'Chest Freezer 2 · 4 left · put up Mar 20, 2026',
      cured: 'Chest Freezer 2 · 1 left · put up Sep 10, 2026',
      bag: 'Chest Freezer 2 · about 412 g left · put up Aug 20, 2026',
      gone: 'Chest Freezer 2 · all used · put up Jun 1, 2026',
    })
  })

  it('a finished jar is still listed: the section asks for the consumed rows', async () => {
    const fetch = mountSection()
    const shown = await rows()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(shown).toHaveLength(RECORDS.length)
    const gone = rowOf(GONE.label)
    expect([gone.dataset.used, gone.style.opacity]).toEqual(['true', '0.62'])
    expect(shown[shown.length - 1]).toBe(gone)                  // what is still there first, then what was used
    // INSTRUMENT: the stand-in endpoint really does drop a finished jar unless asked.
    const unasked = await whatsPutUp(RECORDS)('/api/preservation/whats-put-up?plant_id=pl-1')
    expect(unasked.groups[0].records.map(r => r.id)).not.toContain('gone')
  })

  it('a planting whose only put-up is finished shows it — not the "nothing yet" line', async () => {
    mountSection([GONE])
    expect(await rows()).toHaveLength(1)
    expect(screen.queryByText(/Nothing put up from this planting yet\./)).toBeNull()
    expect(within(GONE.label, 'putup-from-planting-detail').textContent).toBe('Chest Freezer 2 · all used · put up Jun 1, 2026')
  })

  it('an estimated put-up day still reads "around", and the row\'s type sizes are tokens', async () => {
    mountSection([rec({ id: 'est', label: 'Walk find', preserved_at: '2026-08-01', preserved_at_approx: true, package_count: 2, remaining_count: 2 })])
    await rows()
    expect(within('Walk find', 'putup-from-planting-detail').textContent).toBe('Chest Freezer 2 · 2 left · put up around Aug 1, 2026')
    expect(within('Walk find', 'putup-from-planting-head').style.fontSize).toBe(T.type.base)
    expect(within('Walk find', 'putup-from-planting-detail').style.fontSize).toBe(T.type.sm)
    cleanup()
    mountSection([SOON])
    await rows()
    expect(within(SOON.label, 'putup-from-planting-discard').style.fontSize).toBe(T.type.sm)
  })

  it('the first row has no rule above it now that no headline sits there', async () => {
    mountSection()
    const shown = await rows()
    expect(shown[0].getAttribute('style')).not.toMatch(/border-top:\s*1px/)
    for (const r of shown.slice(1)) expect(r.getAttribute('style')).toMatch(/border-top:\s*1px solid/)
  })
})

describe('the two buttons that open the door here — 48 px, their words, and no navigation', () => {
  const WHAT = { source: 'planting', name: 'Ristra Cayenne', plant_id: 'pl-1', crop_type_slug: 'pepper', variety_id: 'var-rc' }
  const door = () => JSON.parse(screen.getByTestId('door-stub').textContent)

  it('the two buttons are 48 px tall and say their words', async () => {
    mountSection([])
    const empty = await screen.findByRole('button', { name: 'Put something up from this planting' })
    expect([empty.style.minHeight, empty.style.display, empty.tagName, empty.getAttribute('href')]).toEqual(['48px', 'inline-flex', 'BUTTON', null])
    cleanup()
    mountSection()
    await rows()
    const more = screen.getByRole('button', { name: 'Put up more from this planting' })
    expect([more.style.minHeight, more.style.display, more.tagName, more.getAttribute('href')]).toEqual(['48px', 'inline-flex', 'BUTTON', null])
    expect(more.style.minHeight).toBe(`${T.buttonMinHeight}px`)
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('"Put something up from this planting" opens the door here, with this planting, its crop and its variety as its What', async () => {
    mountSection([])
    fireEvent.click(await screen.findByRole('button', { name: 'Put something up from this planting' }))
    expect(door()).toEqual({ initialWhat: WHAT, stockRows: null, startBatch: 'undefined' })
    expect(screen.queryByTestId('landed')).toBeNull()                   // nothing navigated
  })

  it('"Put up more from this planting" opens the same door with the same What', async () => {
    mountSection()
    await rows()
    fireEvent.click(screen.getByRole('button', { name: 'Put up more from this planting' }))
    expect(door()).toEqual({ initialWhat: WHAT, stockRows: null, startBatch: 'undefined' })
    expect(screen.queryByTestId('landed')).toBeNull()
  })
})

// ── PlantingKitchen: the batch links and the Next-time lines ───────────────────────────────────────────────
const JAR = rec({ id: 'j-1', label: 'Megatron plain', method: 'hot_sauce', package_count: 2, remaining_count: 2, preserved_at: '2026-09-08',
  notes: 'Bottled warm.\nNext time (2026-09-02): less basil\nNext time (2025-12-30): more salt\nOct 8 · Next time: more garlic' })
const SINGLE = { id: 'kb-1', label: 'Megatron mash', single_planting: true, output_ids: ['j-1'], used_via: 'garden', next_time: [{ id: 'n1', note: 'more carrot' }] }
const MIXED = { id: 'kb-2', label: 'Party salsa', single_planting: false, output_ids: [], used_via: 'jar', next_time: [{ id: 'n2', note: 'Next time (2026-08-30): char the onions' }] }
const FRESH = { id: 'it-1', name: 'Cayenne (fresh)', place_label: 'Fridge', used_up_at: null, next_time: ['Next time (2026-09-15): pick earlier'] }

function mountKitchen({ planting = PLANTING, entry = '/planting' } = {}) {
  const fetch = vi.fn((path) => {
    if (String(path).startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ groups: [{ label: 'Fridge', records: [JAR] }] })
    if (path === plantingBatchesPath(planting.id)) return Promise.resolve({ plant_id: planting.id, batches: [SINGLE, MIXED], kept_fresh: [FRESH] })
    return Promise.resolve(null)
  })
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/planting" element={<PlantingKitchen planting={planting} fetch={fetch} now={NOW} />} />
        <Route path="/put-up" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('PlantingKitchen — a link to a batch says where it came from', () => {
  it('a batch link carries the planting as where it came from: the "from <batch> →" on a jar row', async () => {
    mountKitchen()
    const link = await screen.findByTestId('planting-jar-batch-j-1')
    expect([link.textContent, link.getAttribute('href'), link.style.minHeight]).toEqual(['from Megatron mash →', '/put-up?batch=kb-1', '48px'])
    fireEvent.click(link)
    const at = landed()
    expect(at).toEqual({ path: '/put-up?batch=kb-1', state: { from: { label: 'Ristra Cayenne' } } })
    // The page reads it back through putup/origin.js: a label, no kind, no id — so its Back says "← Ristra Cayenne".
    expect(readFrom(at.state)).toEqual({ label: 'Ristra Cayenne' })
    expect(backLabel(at.state, 'Going now')).toBe('Ristra Cayenne')
  })

  it('a batch link carries the planting as where it came from: a row of "Went into batches"', async () => {
    mountKitchen()
    await waitFor(() => expect(screen.getByTestId('planting-batch-kb-2')).toBeTruthy())
    const link = screen.getByTestId('planting-batch-kb-2').querySelector('a')
    expect([link.textContent, link.getAttribute('href'), link.style.minHeight]).toEqual(['Party salsa →', '/put-up?batch=kb-2', '48px'])
    fireEvent.click(link)
    expect(landed()).toEqual({ path: '/put-up?batch=kb-2', state: { from: { label: 'Ristra Cayenne' } } })
  })

  it('it never hands /put-up this page\'s own route state: only the origin travels', async () => {
    mountKitchen({ entry: { pathname: '/planting', state: { background: { pathname: '/today' }, prefill: { plant_id: 'x' }, from: { label: 'Somewhere else' } } } })
    fireEvent.click(await screen.findByTestId('planting-jar-batch-j-1'))
    expect(landed().state).toEqual({ from: { label: 'Ristra Cayenne' } })
  })

  it('a planting with no name sends no origin, and the link still opens the batch', async () => {
    mountKitchen({ planting: { id: 'pl-1' } })
    fireEvent.click(await screen.findByTestId('planting-jar-batch-j-1'))
    expect(landed()).toEqual({ path: '/put-up?batch=kb-1', state: null })
  })

  it('a stored Next time line is read, not printed raw — on a jar, a batch and a kept-fresh item', async () => {
    mountKitchen()
    await waitFor(() => expect(screen.getByTestId('planting-batch-kb-2')).toBeTruthy())
    expect([...screen.getByTestId('planting-jar-next-j-1').querySelectorAll('li')].map(li => li.textContent)).toEqual([
      'more carrot',                                  // the batch's own noted row, as it was written
      'Next time: less basil · Sep 2',
      'Next time: more salt · Dec 30, 2025',          // another year says its year
      'Oct 8 · Next time: more garlic',               // any other shape is left exactly as it is
    ])
    expect([...screen.getByTestId('planting-batch-next-kb-2').querySelectorAll('li')].map(li => li.textContent)).toEqual(['Next time: char the onions · Aug 30'])
    expect([...screen.getByTestId('planting-fresh-next-it-1').querySelectorAll('li')].map(li => li.textContent)).toEqual(['Next time: pick earlier · Sep 15'])
    expect(screen.getByTestId('planting-kitchen').textContent).not.toMatch(/\(\d{4}-\d{2}-\d{2}\)/)
  })
})

describe('words — the planting section counts nothing and says nothing banned', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
  it('INSTRUMENT: the patterns catch what they are for', () => {
    expect('How long it keeps').toMatch(BANNED)
    expect('7 containers · 2 put-ups · 40% · 3 batches in total').toMatch(/%|\btotal\b|\d+ batches|\bcontainers?\b|\bput-ups?\b/i)
  })

  it('the put-up rows in every state, with the batches and the kept-fresh list', async () => {
    mountSection()
    await rows()
    const section = document.body.textContent
    cleanup()
    mountKitchen()
    await waitFor(() => expect(screen.getByTestId('planting-batch-kb-2')).toBeTruthy())
    const kitchen = screen.getByTestId('planting-kitchen').textContent
    for (const text of [section, kitchen]) {
      expect(text).not.toMatch(BANNED)
      expect(text).not.toMatch(/%|\btotal\b|\d+ batches|\bcontainers?\b|\bput-ups?\b/i)
      expect(text).not.toMatch(/null|undefined|NaN|\[object/)
    }
    expect(section).toContain('general figure: hot sauce, fridge')      // INSTRUMENT: the sentences were really on screen
  })

  it('the empty section', async () => {
    mountSection([])
    await screen.findByRole('button', { name: 'Put something up from this planting' })
    expect(document.body.textContent).not.toMatch(BANNED)
  })
})
