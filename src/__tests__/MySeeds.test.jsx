// V5-SEEDSTAB-001 §5.1, redesigned by V5-SEEDCARDS-001 — the My seeds view: every packet and saved
// lot, one card each, in crop groups that fold and start folded.
//
// Mounted through a tiny host that owns a real useSeedItems() store, exactly as the Seeds shell does.
// No jest-dom (L-182). PhotoView is replaced by a probe that reports the props a card hands it — jsdom
// loads no images, so what the card ASKS for (which photo id, which tier) is what can be pinned here;
// bytes and geometry are gate:seeds-page's and phototier-bytes'.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup, within } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: () => false,
}))
vi.mock('../components/photo/PhotoView.jsx', () => ({
  default: ({ photo, tier, resolveById }) => <img data-testid="pv-probe" data-photo-id={photo?.id ?? ''} data-tier={tier} data-by-id={resolveById ? 'yes' : 'no'} alt="" />,
}))

import { MemoryRouter } from 'react-router-dom'
import MySeeds from '../pages/MySeeds.jsx'
import { useSeedItems } from '../hooks/useSeedItems.js'
import { ToastProvider } from '../context/ToastContext.jsx'
import { supplierColors } from '../lib/supplierPalette.js'
import { F2_LABEL } from '../components/seed/seedLots.js'

const SOURCES = [
  { id: 'src-fedco', name: 'Fedco' },
  { id: 'src-baker', name: 'Baker Creek' },
  { id: 'src-bi', name: 'Botanical Interests' },
  { id: 'src-sandia', name: 'Sandia Seed Company' },
]
const CROPS = [{ slug: 'tomato', display_name: 'Tomato' }, { slug: 'pepper', display_name: 'Pepper' }, { slug: 'bean', display_name: 'Bean' }]
const FILTER_KEY = 'seeds.mine.filters.v1'

const pkt = (over = {}) => ({
  id: 'p', name: 'Sungold', variety_name: 'Sungold', category: 'seeds', type: 'consumable', unit: 'packet',
  status: 'active', quantity_on_hand: 1, variety_id: 'v-sungold', crop_slug: 'tomato', seed_stage: null,
  seed_process: null, source_plant_id: null, source_kind: null, source_id: null, source: null,
  purchase_date: null, year_harvested: null, stage_entered_at: null, seed_count: null, seed_weight_g: null,
  seed_count_estimated: null, sow_archived_season: null, created_at: '2026-07-01T12:00:00Z',
  // The packet photo leaves the list as its id only (BUG-SEEDLISTSIGNING-001): no URL keys at all.
  hero_photo_id: null, featured_photo_id: null,
  // scoville_source is on every real list row (the SELECT names it), null when nobody recorded where the
  // figure came from — 55 of 103 prod peppers. Present-and-null is the branch production takes.
  scoville_min: null, scoville_max: null, scoville_source: null, origin_country: null, origin_region: null, species: null,
  days_to_maturity_min: null, days_to_maturity_max: null, dtm_basis: null, source_url: null, variety_source_url: null,
  ...over,
})
const pepper = (over = {}) => pkt({ crop_slug: 'pepper', ...over })

let rows
let putBodies
let scrolled
beforeEach(() => {
  fetchSpy.mockReset()
  putBodies = []
  scrolled = []
  try { window.sessionStorage.clear() } catch { /* jsdom */ }
  Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.getAttribute('data-lot-id')) }
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method === 'PUT') {
      putBodies.push(JSON.parse(opts.body))
      return Promise.resolve({})
    }
    if (p.startsWith('/api/inventory-items?category=seeds')) return Promise.resolve(rows)
    if (p.startsWith('/api/varieties/sources')) return Promise.resolve(SOURCES)
    if (p.startsWith('/api/varieties/crop-types')) return Promise.resolve(CROPS)
    return Promise.resolve([])
  })
})
afterEach(() => cleanup())

function Host({ highlight = null, onGoToLot = () => {} }) {
  const store = useSeedItems()
  return <MySeeds store={store} highlight={highlight} onGoToLot={onGoToLot} />
}
const mount = async (props = {}) => {
  let utils
  await act(async () => {
    utils = render(<MemoryRouter><ToastProvider><Host {...props} /></ToastProvider></MemoryRouter>)
  })
  await waitFor(() => expect(screen.getByTestId('my-seeds-view')).toBeTruthy())
  return utils
}
const rowFor = (id) => document.querySelector(`[data-lot-id="${id}"]`)
const lineOf = (id) => within(rowFor(id)).getByTestId('my-seed-line')
const headerFor = (label) => screen.queryAllByTestId('facet-group-header').find((h) => h.textContent.replace(/^[▸▾]/, '').startsWith(label))
// Open every folded crop group on screen (and Sowed previously), one header at a time.
const openAll = async () => {
  await waitFor(() => expect(screen.getAllByTestId('facet-group-header').length).toBeGreaterThan(0))
  for (const h of screen.getAllByTestId('facet-group-header')) {
    if (h.getAttribute('aria-expanded') === 'false') await act(async () => { fireEvent.click(h) })
  }
}
const expandRow = async (id) => {
  await act(async () => { fireEvent.click(within(rowFor(id)).getByRole('button', { expanded: false })) })
}
const sortBy = async (value) => {
  await act(async () => { fireEvent.change(screen.getByTestId('my-seeds-sort'), { target: { value } }) })
}

describe('My seeds — what each card says', () => {
  it('a bought packet leads with its supplier chip, then the amount and the bought year — never the order text', async () => {
    rows = [pkt({ id: 'a', quantity_on_hand: 3, source_id: 'src-fedco', source: 'Order #4411', purchase_date: '2025-02-10' })]
    await mount()
    await openAll()
    const line = lineOf('a')
    const chip = within(line).getByTestId('my-seed-supplier')
    expect(chip.textContent).toBe('Fedco')
    expect([...line.children].indexOf(chip)).toBe(0)
    expect(within(line).getByTestId('my-seed-amount').textContent).toBe('3 packets')
    expect(within(line).getByTestId('my-seed-rest').textContent).toBe(' · bought 2025')
    expect(line.textContent).not.toContain('Order')
    // The card's stripe is the supplier's designated fill.
    expect(rowFor('a').style.borderLeft).toContain('4px solid')
    expect(rowFor('a').getAttribute('data-supplier')).toBe('Fedco')
  })

  it('a curated supplier gets its short label and its own colours; the chip is a pill, not a button', async () => {
    rows = [pkt({ id: 'bi', source_id: 'src-bi' }), pkt({ id: 'sa', source_id: 'src-sandia', name: 'Stupice', variety_name: 'Stupice' })]
    await mount()
    await openAll()
    const bi = within(lineOf('bi')).getByTestId('my-seed-supplier')
    expect(bi.textContent).toBe('Botanical')
    expect(bi.getAttribute('title')).toBe('Botanical Interests')
    expect(bi.tagName).not.toBe('BUTTON')
    expect(bi.style.borderRadius).toBe('999px')
    const hex = (c) => c.replace(/\s/g, '')
    const rgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)})`
    expect(hex(bi.style.backgroundColor)).toBe(rgb(supplierColors('Botanical Interests').primary))
    const sa = within(lineOf('sa')).getByTestId('my-seed-supplier')
    expect(sa.textContent).toBe('Sandia')
    expect(hex(sa.style.backgroundColor)).not.toBe(hex(bi.style.backgroundColor))
    // The card's stripe is each supplier's OWN primary, not one accent for every card (normalised
    // through a probe element, as the detail page's stripe test does).
    for (const [id, name] of [['bi', 'Botanical Interests'], ['sa', 'Sandia Seed Company']]) {
      const probe = document.createElement('div')
      probe.style.color = supplierColors(name).primary
      expect(rowFor(id).style.borderLeftColor).toBe(probe.style.color)
    }
  })

  it('"1 packet" is not printed — every other amount is', async () => {
    rows = [pkt({ id: 'one', quantity_on_hand: 1 }), pkt({ id: 'two', name: 'Stupice', variety_name: 'Stupice', quantity_on_hand: 2 }),
      pkt({ id: 'each', name: 'Reaper', variety_name: 'Reaper', unit: 'each', quantity_on_hand: 25 })]
    await mount()
    await openAll()
    expect(within(lineOf('one')).queryByTestId('my-seed-amount')).toBeNull()
    expect(within(lineOf('two')).getByTestId('my-seed-amount').textContent).toBe('2 packets')
    expect(within(lineOf('each')).getByTestId('my-seed-amount').textContent).toBe('25 seeds')
  })

  it('saved lots: no supplier chip; seed count, origin words and harvest year; uncounted says no amount at all', async () => {
    rows = [
      pkt({ id: 's1', name: 'Big Boy — saved 2026', variety_name: 'Big Boy', source_plant_id: 'pl', seed_stage: 'stored', seed_count: 175, seed_count_estimated: true, year_harvested: 2026 }),
      pkt({ id: 's2', name: 'Cayenne — saved 2026', variety_name: 'Cayenne', crop_slug: 'pepper', source_kind: 'farm_stand', seed_stage: 'stored' }),
    ]
    await mount()
    await openAll()
    expect(within(lineOf('s1')).queryByTestId('my-seed-supplier')).toBeNull()
    expect(within(lineOf('s1')).getByTestId('my-seed-amount').textContent).toBe('approx. 175 seeds')
    expect(within(lineOf('s1')).getByTestId('my-seed-rest').textContent).toBe(' · Saved from my plant · harvested 2026')
    expect(lineOf('s2').textContent).toBe('Saved · farm stand')
    // No supplier: no stripe, and the text still starts at the same x (3px of extra padding).
    expect(rowFor('s1').style.borderLeft).not.toContain('4px')
    expect(rowFor('s1').style.paddingLeft).toBe('3px')
  })

  it('chips come from the engine: a fermenting jar at 0 stays in the list, a used-up packet goes under Sowed previously', async () => {
    rows = [
      pkt({ id: 'jar', name: 'Big Boy — saved 2026', variety_name: 'Big Boy', seed_stage: 'fermenting', source_plant_id: 'pl', quantity_on_hand: 0, stage_entered_at: new Date().toISOString() }),
      pkt({ id: 'unstarted', name: 'Lemon Drop — saved 2026', variety_name: 'Lemon Drop', source_plant_id: 'pl', quantity_on_hand: 0 }),
      pkt({ id: 'empty', name: 'Old Packet', variety_name: 'Old Packet', quantity_on_hand: 0 }),
    ]
    await mount()
    await act(async () => { fireEvent.click(headerFor('Tomato')) })
    expect(lineOf('jar').textContent).toContain('Ferment · today')
    expect(lineOf('unstarted').textContent).toContain('Not started')
    // Used up: folded by default, counted, one tap open.
    expect(rowFor('empty')).toBeNull()
    const sowed = screen.getByTestId('my-seeds-sowed')
    const toggle = within(sowed).getByTestId('facet-group-header')
    expect(toggle.textContent).toBe('▸Sowed previously1')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { fireEvent.click(toggle) })
    expect(rowFor('empty')).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('an archived packet carries its chip', async () => {
    rows = [pkt({ id: 'arch', sow_archived_season: new Date().getFullYear() })]
    await mount()
    await openAll()
    expect(lineOf('arch').textContent).toContain('Archived for this season')
  })

  it('the identical-pair ordinal is its own non-shrinking span on LINE 1, after the title', async () => {
    rows = [pkt({ id: 'd1', source_id: 'src-fedco', purchase_date: '2026-01-14' }), pkt({ id: 'd2', source_id: 'src-fedco', purchase_date: '2026-01-14' })]
    await mount()
    await openAll()
    const seen = []
    for (const id of ['d1', 'd2']) {
      const ordinal = within(rowFor(id)).getByTestId('my-seed-ordinal')
      expect(ordinal.textContent).toMatch(/^[12] of 2 identical$/)
      expect(ordinal.style.flex).toBe('0 0 auto')
      expect(lineOf(id).contains(ordinal)).toBe(false)
      expect(ordinal.previousElementSibling.textContent).toBe('Sungold')
      seen.push(ordinal.textContent)
    }
    expect(seen.sort()).toEqual(['1 of 2 identical', '2 of 2 identical'])
  })

  // Line 2's shrink order (UX spec §1.3) is geometry, measured by gate:seeds-page (g)(k)(n); these pin the
  // structure it rests on. Replaces the pins of "the amount is its own span after the chips" (V102 §12): the
  // amount outside any chip, the neutral chip in a box that shrinks (not an item of the line), and the order
  // chips box → amount → tail — plus what changed on purpose: the LIVE chip is now the line's own rigid item.
  it('line 2 gives way in order: a live chip is a rigid item of the line; neutral chips, amount and tail share the give-way flow', async () => {
    rows = [pkt({
      id: 'crowd', name: 'Big Boy — saved 2026', variety_name: 'Big Boy', seed_stage: 'fermenting', source_plant_id: 'pl',
      seed_count: 120, seed_count_estimated: true, year_harvested: 2026, stage_entered_at: new Date().toISOString(),
      sow_archived_season: new Date().getFullYear(),
    })]
    await mount()
    await openAll()
    const line = lineOf('crowd')
    const amount = within(line).getByTestId('my-seed-amount')
    const chips = within(line).getAllByTestId('my-seed-chip')
    expect(amount.textContent).toBe('approx. 120 seeds')
    expect(chips.length).toBe(2)
    expect(chips.every((c) => !c.contains(amount))).toBe(true)
    // "Ferment · today" is the lot's live state: an item of the line itself, rigid, and it says so on the chip
    // (data-tone — what the gate's (n) reads to know which chip may never be cut).
    const [liveChip, neutralChip] = chips
    expect(liveChip.textContent).toBe('Ferment · today')
    expect(liveChip.getAttribute('data-tone')).toBe('info')
    expect(liveChip.parentElement).toBe(line)
    expect(liveChip.style.flex).toBe('0 0 auto')
    // "Archived for this season" gives way: in a box with a 0 basis that shrinks, inside the same flow as the
    // facts, straight before the amount; the tail follows the amount (a tomato has no heat).
    expect(neutralChip.getAttribute('data-tone')).toBe('neutral')
    expect(neutralChip.parentElement).not.toBe(line)
    const box = neutralChip.parentElement
    expect(box.style.flexShrink).toBe('1')
    expect(box.style.flexBasis).toBe('0px')
    expect(box.nextElementSibling).toBe(amount)
    expect(amount.nextElementSibling).toBe(within(line).getByTestId('my-seed-rest'))
    expect(amount.parentElement).toBe(box.parentElement)
    expect(amount.style.flex).toBe('0 0 auto')
  })

  it('a heat that cannot fit drops WHOLE: it follows the amount in a wrapping flow and carries its own " · " — the tail goes with it', async () => {
    rows = [pepper({
      id: 'lantern', name: 'Hot Paper Lantern — saved 2026', variety_name: 'Hot Paper Lantern', seed_stage: 'drying',
      source_plant_id: 'pl', seed_count: 1200, seed_count_estimated: true, seed_weight_g: 12.5,
      scoville_min: 150000, scoville_max: 325000, stage_entered_at: new Date().toISOString(),
    })]
    await mount()
    await openAll()
    const line = lineOf('lantern')
    const amount = within(line).getByTestId('my-seed-amount')
    const heat = within(line).getByTestId('my-seed-heat')
    const rest = within(line).getByTestId('my-seed-rest')
    expect(amount.textContent).toBe('approx. 1200 seeds · 12.5 g')
    expect(heat.textContent).toBe(' · est. 150K–325K SHU')
    expect(rest.textContent.startsWith(' · ')).toBe(true)
    // amount → heat → tail, in one flow that WRAPS (what does not fit goes to a hidden second line, whole),
    // and the flow's box clips.
    expect([amount.nextElementSibling, heat.nextElementSibling]).toEqual([heat, rest])
    const flow = heat.parentElement
    expect(flow).toBe(amount.parentElement)
    expect(flow.style.flexWrap).toBe('wrap')
    expect(flow.style.position).toBe('absolute')
    expect(flow.parentElement.style.overflow).toBe('clip')
    expect(heat.style.flex).toBe('0 0 auto')
    // The Drying chip sits outside that flow: nothing the flow drops can take it.
    const live = within(line).getByTestId('my-seed-chip')
    expect(live.textContent).toBe('Drying')
    expect(live.parentElement).toBe(line)
    expect(flow.contains(live)).toBe(false)
    // The line's height comes from an invisible stand-in that adds no text.
    expect(line.lastElementChild.getAttribute('aria-hidden')).toBe('true')
    expect(line.lastElementChild.textContent).toBe('')
  })

  it('a line with nothing to print stays EMPTY — no stand-in, so the row keeps its height', async () => {
    rows = [pkt({ id: 'bare' })]
    await mount()
    await openAll()
    expect(lineOf('bare').children.length).toBe(0)
    expect(lineOf('bare').textContent).toBe('')
  })

  it('two cards that would read alike are told apart on screen', async () => {
    rows = [pkt({ id: 'd1' }), pkt({ id: 'd2' })]
    await mount()
    await openAll()
    const ords = ['d1', 'd2'].map((id) => within(rowFor(id)).getByTestId('my-seed-ordinal').textContent)
    expect(ords[0]).not.toBe(ords[1])
  })

  it('a pepper shows its heat whole; a saved pepper lot marks it "est."; a tomato shows none', async () => {
    rows = [
      pepper({ id: 'hab', name: 'Habanero', variety_name: 'Habanero', scoville_min: 100000, scoville_max: 350000 }),
      pepper({ id: 'svd', name: 'Thai Dragon — saved 2026', variety_name: 'Thai Dragon', source_plant_id: 'pl', seed_stage: 'stored', scoville_min: 50000, scoville_max: 100000 }),
      pkt({ id: 'tom' }),
    ]
    await mount()
    await openAll()
    const heat = within(lineOf('hab')).getByTestId('my-seed-heat')
    expect(heat.textContent).toBe('100K–350K SHU')
    expect(heat.style.flex).toBe('0 0 auto')
    expect(within(lineOf('svd')).getByTestId('my-seed-heat').textContent).toContain('est. 50K–100K SHU')
    expect(within(lineOf('tom')).queryByTestId('my-seed-heat')).toBeNull()
  })

  // V5-SEEDSTAB-001 slice 3 (design §2 rule 8, §5.4). Prod's four such lots, 2026-09-23: Gong Bao and
  // Ristra Cayenne II stored with a count and an estimated heat, Big Boy and Thai Dragon drying.
  // AMENDED 2026-09-24 (orchestrator decision, reported to Dave): on an F2 row the F2 chip OUTRANKS THE
  // ESTIMATED HEAT. It is an item of the LINE — shrinkable, so the amount, a live state and a supplier
  // never give way to it — and so is the amount, rigid, right after it; the heat rides the give-way box
  // and is dropped whole first. A live state keeps the first place (§16). Bought packets and non-F2 rows
  // keep the old layout exactly. Geometry is gate:seeds-page (p)(g)(k)(n); this pins the structure the
  // geometry rests on.
  const F2_ROWS = () => [
    pepper({
      id: 'gongbao', name: 'Gong Bao (Kung Pao) — saved 2026', variety_name: 'Gong Bao (Kung Pao)', source_plant_id: 'pl',
      seed_stage: 'stored', seed_count: 85, seed_count_estimated: true, year_harvested: 2026, breeding_system: 'f1',
      scoville_min: 5000, scoville_max: 12000,
    }),
    pkt({
      id: 'bigboy', name: 'Big Boy Saved seed 2026', variety_name: 'Big Boy', source_plant_id: 'pl', seed_stage: 'drying',
      stage_entered_at: new Date().toISOString(), breeding_system: 'f1',
    }),
    pkt({ id: 'sungold', name: 'Sungold F1', source_id: 'src-fedco', breeding_system: 'f1' }),
    pkt({ id: 'brandy', name: 'Brandywine — saved 2026', variety_name: 'Brandywine', source_plant_id: 'pl', seed_stage: 'stored', breeding_system: 'open_pollinated' }),
  ]
  const f2ChipOf = (id) => within(lineOf(id)).queryAllByTestId('my-seed-chip').find((c) => c.textContent === F2_LABEL) ?? null

  it('a lot saved off an F1 plant says "F2 — won’t come true" as an item of the LINE, ahead of the amount and the heat', async () => {
    rows = F2_ROWS()
    await mount()
    await openAll()
    // Stored: the F2 chip is the line's own item — neutral, SHRINKABLE (a 0 floor) — then the amount,
    // rigid, also an item of the line; the heat is left to the give-way flow behind them.
    const line = lineOf('gongbao')
    const chip = f2ChipOf('gongbao')
    expect(chip, 'the stored F2 lot carries no F2 chip').toBeTruthy()
    expect(chip.getAttribute('data-tone')).toBe('neutral')
    expect(chip.parentElement).toBe(line)
    expect([chip.style.flexGrow, chip.style.flexShrink, chip.style.minWidth]).toEqual(['0', '1', '0'])
    const amount = within(line).getByTestId('my-seed-amount')
    expect(amount.textContent).toBe('approx. 85 seeds')
    expect(chip.nextElementSibling).toBe(amount)
    expect(amount.parentElement).toBe(line)
    expect(amount.style.flex).toBe('0 0 auto')
    const heat = within(line).getByTestId('my-seed-heat')
    const flow = heat.parentElement
    expect(flow.style.flexWrap).toBe('wrap')
    expect(flow.parentElement).toBe(amount.nextElementSibling)
    expect(flow.contains(chip) || flow.contains(amount)).toBe(false)
    expect(heat.textContent).toBe(' · est. 5K–12K SHU')
    // Drying: the live state keeps the first place, rigid; F2 follows it, shrinkable — both items of the line.
    const chips = within(lineOf('bigboy')).getAllByTestId('my-seed-chip')
    expect(chips.map((c) => c.textContent)).toEqual(['Drying', F2_LABEL])
    expect(chips.map((c) => c.parentElement === lineOf('bigboy'))).toEqual([true, true])
    expect(chips[0].style.flex).toBe('0 0 auto')
    expect(chips[1].style.flexShrink).toBe('1')
    // Rule 8: never on a bought packet, and only F1 speaks.
    expect(f2ChipOf('sungold')).toBeNull()
    expect(f2ChipOf('brandy')).toBeNull()
    expect(screen.getByTestId('my-seeds-view').textContent.split(F2_LABEL).length - 1).toBe(2)
  })

  it('a bought F1 packet and every non-F2 row keep the old layout: amount and heat ride the flow, no chip on the line but a live one', async () => {
    rows = [
      pepper({ id: 'f1pkt', name: 'Megatron F1', variety_name: 'Megatron F1', source_id: 'src-fedco', breeding_system: 'f1',
        quantity_on_hand: 2, scoville_min: 2500, scoville_max: 8000, sow_archived_season: new Date().getFullYear() }),
      pepper({ id: 'oplot', name: 'Aji Charapita — saved 2026', variety_name: 'Aji Charapita', source_plant_id: 'pl',
        seed_stage: 'drying', stage_entered_at: new Date().toISOString(), breeding_system: 'open_pollinated',
        seed_count: 40, seed_count_estimated: true, scoville_min: 30000, scoville_max: 50000 }),
    ]
    await mount()
    await openAll()
    for (const id of ['f1pkt', 'oplot']) {
      const line = lineOf(id)
      const amount = within(line).getByTestId('my-seed-amount')
      const heat = within(line).getByTestId('my-seed-heat')
      expect(amount.parentElement, `${id}: the amount left the flow`).not.toBe(line)
      expect(amount.parentElement).toBe(heat.parentElement)
      expect(amount.nextElementSibling).toBe(heat)
      const onLine = within(line).queryAllByTestId('my-seed-chip').filter((c) => c.parentElement === line)
      expect(onLine.map((c) => c.getAttribute('data-tone')).every((t) => t !== 'neutral'), `${id}: a neutral chip is an item of the line`).toBe(true)
    }
    // The bought F1 packet's archive chip still gives way inside the flow, before its amount.
    const archived = within(lineOf('f1pkt')).getAllByTestId('my-seed-chip')
    expect(archived.map((c) => c.textContent)).toEqual(['Archived for this season'])
    expect(archived[0].parentElement.nextElementSibling).toBe(within(lineOf('f1pkt')).getByTestId('my-seed-amount'))
  })

  it('on an F2 row any OTHER neutral chip stays in the flow, still giving way before the heat', async () => {
    rows = [pepper({
      id: 'f2arch', name: 'Ristra Cayenne II Saved seed 2026', variety_name: 'Ristra Cayenne II', source_plant_id: 'pl',
      seed_stage: 'stored', seed_count: 175, seed_count_estimated: true, breeding_system: 'f1',
      sow_archived_season: new Date().getFullYear(), scoville_min: 25000, scoville_max: 35000,
    })]
    await mount()
    await openAll()
    const line = lineOf('f2arch')
    const [f2, archived] = within(line).getAllByTestId('my-seed-chip')
    expect([f2.textContent, archived.textContent]).toEqual([F2_LABEL, 'Archived for this season'])
    expect(f2.parentElement).toBe(line)
    const box = archived.parentElement
    expect(box).not.toBe(line)
    expect(box.style.flexBasis).toBe('0px')
    // In the flow, straight before the heat: it gives way before the heat does, as on any row.
    expect(box.nextElementSibling).toBe(within(line).getByTestId('my-seed-heat'))
  })

  it('the expanded F2 lot\'s Breeding fact says F2 from an F1 parent; the bought F1 packet keeps "F1 hybrid"', async () => {
    rows = F2_ROWS()
    await mount()
    await openAll()
    const breeding = (id) => within(rowFor(id)).getByTestId('my-seed-facts').querySelector('[data-fact="Breeding"]').textContent
    await expandRow('gongbao')
    expect(breeding('gongbao')).toBe(`${F2_LABEL} (parent F1 hybrid)`)
    await expandRow('sungold')
    expect(breeding('sungold')).toBe('F1 hybrid')
  })

  it('the thumbnail asks for the PHOTO id at the thumb tier, never the lot id, minted by id; no photo shows the sprout box', async () => {
    rows = [
      pkt({ id: 'with', hero_photo_id: 'photo-9', featured_photo_id: 'photo-9' }),
      pkt({ id: 'without', name: 'Stupice', variety_name: 'Stupice' }),
    ]
    await mount()
    await openAll()
    const probe = within(rowFor('with')).getByTestId('pv-probe')
    expect(probe.getAttribute('data-photo-id')).toBe('photo-9')
    expect(probe.getAttribute('data-photo-id')).not.toBe('with')
    expect(probe.getAttribute('data-tier')).toBe('thumb')
    // The row has no URL, so without resolveById PhotoView would draw nothing.
    expect(probe.getAttribute('data-by-id')).toBe('yes')
    const empty = within(rowFor('without')).getByTestId('my-seed-thumb')
    expect(within(rowFor('without')).queryByTestId('pv-probe')).toBeNull()
    expect(empty.querySelector('svg')).toBeTruthy()
    // Both boxes are the fixed 40x40 row thumb, so an image arriving never moves the text.
    for (const id of ['with', 'without']) {
      const box = within(rowFor(id)).getByTestId('my-seed-thumb')
      expect([box.style.width, box.style.height]).toEqual(['40px', '40px'])
    }
  })
})

describe('My seeds — folding groups', () => {
  const CROPPED = [
    pkt({ id: 't1', variety_name: 'Sungold', crop_slug: 'tomato' }),
    pkt({ id: 't2', name: 'Brandywine', variety_name: 'Brandywine', crop_slug: 'tomato', purchase_date: '2021-03-01', created_at: '2026-09-01T00:00:00Z' }),
    pkt({ id: 'p1', name: 'Gong Bao', variety_name: 'Gong Bao', crop_slug: 'pepper', year_harvested: 2019 }),
  ]

  it('starts FOLDED: headers only, each a button with its count, no card in the DOM', async () => {
    rows = CROPPED
    await mount()
    await waitFor(() => expect(screen.getAllByTestId('my-seeds-group').length).toBe(2))
    const headers = screen.getAllByTestId('facet-group-header')
    // The two biggest crops lead (the crop chips' own pins), then A→Z.
    expect(headers.map((h) => h.textContent)).toEqual(['▸Tomato2', '▸Pepper1'])
    for (const h of headers) {
      expect(h.getAttribute('role')).toBe('button')
      expect(h.getAttribute('aria-expanded')).toBe('false')
      expect(h.style.minHeight).toBe('44px')
    }
    expect(screen.queryAllByTestId('my-seed-row')).toEqual([])
    expect(screen.getByTestId('my-seeds-crop-filter')).toBeTruthy()
  })

  it('a header tap opens its group and a second tap folds it', async () => {
    rows = CROPPED
    await mount()
    await waitFor(() => expect(headerFor('Tomato')).toBeTruthy())
    await act(async () => { fireEvent.click(headerFor('Tomato')) })
    expect(headerFor('Tomato').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByTestId('my-seed-row').map((r) => r.getAttribute('data-lot-id')).sort()).toEqual(['t1', 't2'])
    expect(rowFor('p1')).toBeNull()
    await act(async () => { fireEvent.click(headerFor('Tomato')) })
    expect(screen.queryAllByTestId('my-seed-row')).toEqual([])
  })

  it('Expand all opens every section, Collapse all folds them, and the label says which', async () => {
    rows = [...CROPPED, pkt({ id: 'gone', name: 'Old', variety_name: 'Old', quantity_on_hand: 0 })]
    await mount()
    const btn = await screen.findByTestId('my-seeds-expand-all')
    expect(btn.textContent).toBe('Expand all')
    await act(async () => { fireEvent.click(btn) })
    expect(screen.getAllByTestId('my-seed-row').length).toBe(4)
    expect(btn.textContent).toBe('Collapse all')
    await act(async () => { fireEvent.click(btn) })
    expect(screen.queryAllByTestId('my-seed-row')).toEqual([])
    expect(btn.textContent).toBe('Expand all')
  })

  it('Expand all is absent under the flat sorts and with fewer than two sections', async () => {
    rows = CROPPED
    await mount()
    await screen.findByTestId('my-seeds-expand-all')
    await sortBy('oldest')
    expect(screen.queryByTestId('my-seeds-expand-all')).toBeNull()
    cleanup()
    window.sessionStorage.clear()
    rows = [CROPPED[0]]
    await mount()
    await waitFor(() => expect(headerFor('Tomato')).toBeTruthy())
    expect(screen.queryByTestId('my-seeds-expand-all')).toBeNull()
  })

  it('a search opens every group it still matches; clearing it folds them again', async () => {
    rows = [...CROPPED, pkt({ id: 'v1', name: 'Mystery', variety_name: 'Mystery', source_id: 'src-baker' })]
    await mount()
    const box = screen.getByTestId('my-seeds-search')
    await act(async () => { fireEvent.change(box, { target: { value: 'baker creek' } }) })
    await waitFor(() => expect(screen.getAllByTestId('my-seed-row').map((r) => r.getAttribute('data-lot-id'))).toEqual(['v1']))
    expect(headerFor('Tomato').getAttribute('aria-expanded')).toBe('true')
    await act(async () => { fireEvent.change(box, { target: { value: '' } }) })
    expect(screen.queryAllByTestId('my-seed-row')).toEqual([])
  })

  it('a crop chip opens that crop\'s group', async () => {
    rows = CROPPED
    await mount()
    const chips = screen.getByTestId('my-seeds-crop-filter')
    await act(async () => { fireEvent.click(within(chips).getByRole('button', { name: 'Pepper' })) })
    expect(screen.getAllByTestId('my-seed-row').map((r) => r.getAttribute('data-lot-id'))).toEqual(['p1'])
    expect(headerFor('Pepper').getAttribute('aria-expanded')).toBe('true')
  })

  it('a group folded by hand during a search stays folded until the search changes', async () => {
    rows = CROPPED
    await mount()
    const box = screen.getByTestId('my-seeds-search')
    await act(async () => { fireEvent.change(box, { target: { value: 'o' } }) })
    expect(headerFor('Tomato').getAttribute('aria-expanded')).toBe('true')
    await act(async () => { fireEvent.click(headerFor('Tomato')) })
    expect(headerFor('Tomato').getAttribute('aria-expanded')).toBe('false')
    // A new search that still finds a tomato ("go": Sungold, and Gong Bao) — so the Tomato header is
    // on the page to be read, and the hand fold must have been cleared by the change.
    await act(async () => { fireEvent.change(box, { target: { value: 'go' } }) })
    expect(headerFor('Tomato').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('My seeds — filtering and sorting', () => {
  const MIXED = [
    pkt({ id: 'b1', source_id: 'src-bi' }),
    pkt({ id: 'b2', name: 'Stupice', variety_name: 'Stupice', source_id: 'src-bi' }),
    pepper({ id: 's1', name: 'Fresno', variety_name: 'Fresno', source_id: 'src-sandia', scoville_min: 2500, scoville_max: 10000 }),
    pepper({ id: 's2', name: 'Carolina Reaper', variety_name: 'Carolina Reaper', source_id: 'src-sandia', scoville_min: 1400000, scoville_max: 2200000, scoville_source: 'vendor_catalog' }),
    pepper({ id: 'n1', name: 'Mystery Pepper', variety_name: 'Mystery Pepper' }),
  ]

  it('supplier chips: every supplier in the list, count-descending, with a swatch; "No supplier" last', async () => {
    rows = MIXED
    await mount()
    const row = await screen.findByTestId('my-seeds-supplier-filter')
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: /More/ })) })
    const labels = within(row).getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed')).map((b) => b.textContent)
    expect(labels).toEqual(['Botanical', 'Sandia', 'No supplier'])
    expect(within(row).getAllByTestId('supplier-swatch').length).toBe(3)
  })

  it('a supplier chip filters to that supplier and opens its groups; chips OR with each other', async () => {
    rows = MIXED
    await mount()
    const row = await screen.findByTestId('my-seeds-supplier-filter')
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Sandia' })) })
    expect(screen.getAllByTestId('my-seed-row').map((r) => r.getAttribute('data-lot-id')).sort()).toEqual(['s1', 's2'])
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Botanical' })) })
    expect(screen.getAllByTestId('my-seed-row').length).toBe(4)
  })

  it('the supplier row is hidden when the whole list has only one supplier value', async () => {
    rows = [MIXED[0], MIXED[1]]
    await mount()
    await waitFor(() => expect(headerFor('Tomato')).toBeTruthy())
    expect(screen.queryByTestId('my-seeds-supplier-filter')).toBeNull()
  })

  it('Hottest is offered only with heat data; it leads with Pepper, opens it, and orders hottest first', async () => {
    rows = [MIXED[0], MIXED[1]]
    await mount()
    await waitFor(() => expect(headerFor('Tomato')).toBeTruthy())
    expect([...screen.getByTestId('my-seeds-sort').options].map((o) => o.textContent)).toEqual(['Name', 'Oldest', 'Newest'])
    cleanup()
    rows = MIXED
    await mount()
    await waitFor(() => expect(headerFor('Tomato')).toBeTruthy())
    expect([...screen.getByTestId('my-seeds-sort').options].map((o) => o.textContent)).toEqual(['Name', 'Oldest', 'Newest', 'Hottest'])
    await sortBy('heat')
    const headers = screen.getAllByTestId('facet-group-header')
    expect(headers[0].textContent).toBe('▾Pepper · hottest first3')
    const pepperRows = within(headers[0].closest('[data-testid="my-seeds-group"]')).getAllByTestId('my-seed-row').map((r) => r.getAttribute('data-lot-id'))
    expect(pepperRows).toEqual(['s2', 's1', 'n1'])
    expect(screen.getByTestId('my-seeds-heat-unknown').textContent).toBe('Heat unknown (1)')
    // Tomato stays folded: Hottest orders peppers, it does not open the rest.
    expect(headerFor('Tomato').getAttribute('aria-expanded')).toBe('false')
  })

  it('Oldest puts unknown years under a labelled divider; Newest follows created_at', async () => {
    rows = [
      pkt({ id: 't1', variety_name: 'Sungold' }),
      pkt({ id: 't2', name: 'Brandywine', variety_name: 'Brandywine', purchase_date: '2021-03-01', created_at: '2026-09-01T00:00:00Z' }),
      pepper({ id: 'p1', name: 'Gong Bao', variety_name: 'Gong Bao', year_harvested: 2019 }),
    ]
    await mount()
    await sortBy('oldest')
    const order = () => screen.getAllByTestId('my-seed-row').map((r) => r.getAttribute('data-lot-id'))
    expect(order()).toEqual(['p1', 't2', 't1'])
    expect(screen.getByTestId('my-seeds-date-unknown').textContent).toBe('Date unknown (1)')
    await sortBy('newest')
    expect(order()[0]).toBe('t2')
  })

  it('search and sort share ONE line', async () => {
    rows = MIXED
    await mount()
    const sort = screen.getByTestId('my-seeds-sort')
    expect(sort.tagName).toBe('SELECT')
    expect(sort.closest('div')).toBe(screen.getByTestId('my-seeds-search').parentElement)
  })

  it('remembers search, chips, suppliers, sort and opened groups for the visit (sessionStorage), not in the URL', async () => {
    rows = MIXED
    await mount()
    await act(async () => { fireEvent.click(headerFor('Tomato')) })
    const row = await screen.findByTestId('my-seeds-supplier-filter')
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Botanical' })) })
    await sortBy('oldest')
    const blob = JSON.parse(window.sessionStorage.getItem(FILTER_KEY))
    expect(blob.suppliers).toEqual(['botanicalinterests'])
    expect(blob.openGroups).toEqual(['tomato'])
    expect(blob.sort).toBe('oldest')
    cleanup()
    await mount()
    expect(screen.getByTestId('my-seeds-sort').value).toBe('oldest')
    const again = await screen.findByTestId('my-seeds-supplier-filter')
    expect(within(again).getByRole('button', { name: 'Botanical' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a remembered supplier that is no longer in the list is dropped, not left filtering to nothing', async () => {
    window.sessionStorage.setItem(FILTER_KEY, JSON.stringify({ q: '', crops: [], suppliers: ['gonevendor'], sort: 'name', openGroups: [] }))
    rows = MIXED
    await mount()
    await waitFor(() => expect(headerFor('Tomato')).toBeTruthy())
    expect(screen.queryByTestId('my-seeds-no-match')).toBeNull()
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(FILTER_KEY)).suppliers).toEqual([]))
  })

  it('has three different empty states, and the no-match card names what excludes', async () => {
    rows = []
    await mount()
    expect(screen.getByTestId('my-seeds-empty').textContent).toContain('No seed yet')
    cleanup()
    rows = [pkt({ id: 'e', quantity_on_hand: 0 })]
    await mount()
    await waitFor(() => expect(screen.getByTestId('my-seeds-all-sowed')).toBeTruthy())
    expect(within(screen.getByTestId('my-seeds-sowed')).getByTestId('facet-group-header').getAttribute('aria-expanded')).toBe('true')
    expect(rowFor('e')).toBeTruthy()
    cleanup()
    rows = MIXED
    await mount()
    await act(async () => { fireEvent.change(screen.getByTestId('my-seeds-search'), { target: { value: 'zzzz' } }) })
    expect(screen.getByTestId('my-seeds-no-match').textContent).toContain('No seed matches “zzzz”.')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear filters' })) })
    expect(screen.queryByTestId('my-seeds-no-match')).toBeNull()
    expect(screen.getByTestId('my-seeds-search').value).toBe('')
  })
})

describe('My seeds — the expanded card (no "On hand", the seed\'s facts)', () => {
  it('no card offers the old stepper — bought, saved or archived — and nothing writes', async () => {
    rows = [
      pkt({ id: 'bought', quantity_on_hand: 2 }),
      pkt({ id: 'jar', name: 'Big Boy — saved 2026', variety_name: 'Big Boy', seed_stage: 'stored', source_plant_id: 'pl', seed_count: 175 }),
      pkt({ id: 'arch', name: 'Stupice', variety_name: 'Stupice', sow_archived_season: new Date().getFullYear() }),
    ]
    await mount()
    await openAll()
    for (const id of ['bought', 'jar', 'arch']) {
      await expandRow(id)
      const exp = within(rowFor(id)).getByTestId('my-seed-expanded')
      expect(exp.textContent).not.toContain('On hand')
      expect(within(rowFor(id)).queryByRole('button', { name: /One (fewer|more)/ })).toBeNull()
      expect(within(rowFor(id)).queryByTestId('my-seed-qty')).toBeNull()
      expect(within(rowFor(id)).getByTestId('my-seed-details').getAttribute('href')).toBe(`/inventory/${id}`)
    }
    expect(putBodies).toEqual([])
  })

  it('facts in a fixed order, absent ones left out; a pepper says when its heat is not recorded', async () => {
    rows = [
      pepper({
        id: 'hab', name: 'Habanero', variety_name: 'Habanero', source_id: 'src-sandia', purchase_date: '2025-02-01',
        scoville_min: 100000, scoville_max: 350000, scoville_source: 'inference', origin_country: 'Mexico', origin_region: 'Yucatán',
        species: 'Capsicum chinense', days_to_maturity_min: 90, days_to_maturity_max: 100, dtm_basis: 'from-transplant',
        breeding_system: 'open_pollinated',
      }),
      pepper({ id: 'bare', name: 'Mystery', variety_name: 'Mystery', breeding_system: 'unknown' }),
      pkt({ id: 'tom' }),
      // A figure nobody recorded the source of (the fixture's scoville_source: null, as prod sends it).
      pepper({ id: 'unk', name: 'Hungarian Hot Wax', variety_name: 'Hungarian Hot Wax', scoville_min: 5000, scoville_max: 15000 }),
    ]
    await mount()
    await openAll()
    await expandRow('unk')
    expect(within(rowFor('unk')).getByTestId('my-seed-facts').querySelector('[data-fact="Heat"]').textContent)
      .toBe('5,000–15,000 SHU · source not recorded')
    expect(within(lineOf('unk')).getByTestId('my-seed-heat').textContent).toBe('5K–15K SHU')
    await expandRow('hab')
    const facts = within(rowFor('hab')).getByTestId('my-seed-facts')
    expect([...facts.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['From', 'Heat', 'Country of origin', 'Species', 'Days to maturity', 'Breeding'])
    expect(facts.querySelector('[data-fact="Breeding"]').textContent).toBe('Open-pollinated')
    const val = (k) => facts.querySelector(`[data-fact="${k}"]`).textContent
    expect(val('From')).toBe('Sandia Seed Company · bought 2025')
    expect(val('Heat')).toBe('100,000–350,000 SHU · best guess')
    expect(val('Country of origin')).toBe('Mexico · Yucatán')
    expect(facts.querySelector('[data-fact="Species"] i').textContent).toBe('Capsicum chinense')
    expect(val('Days to maturity')).toBe('90–100 days from transplant')
    await expandRow('bare')
    const bare = within(rowFor('bare')).getByTestId('my-seed-facts')
    expect([...bare.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Heat'])
    expect(bare.querySelector('[data-fact="Heat"]').textContent).toBe('not recorded')
    expect(bare.textContent).not.toContain('—')
    await expandRow('tom')
    expect(within(rowFor('tom')).queryByTestId('my-seed-facts')).toBeNull()
  })

  it('the packet link names where it goes and opens in the browser; without one, the variety page is labelled as such', async () => {
    rows = [
      pkt({ id: 'own', source_url: 'https://sandiaseed.com/products/fresno' }),
      pkt({ id: 'ref', name: 'Stupice', variety_name: 'Stupice', variety_source_url: 'https://www.johnnyseeds.com/stupice' }),
      pkt({ id: 'none', name: 'Plain', variety_name: 'Plain' }),
      // Only http(s) ever becomes a link: a `javascript:` packet URL falls through to the variety page, or
      // to no link at all.
      pkt({ id: 'js', name: 'Script', variety_name: 'Script', source_url: 'javascript:alert(1)', variety_source_url: 'https://www.johnnyseeds.com/script' }),
      pkt({ id: 'jsonly', name: 'Script Only', variety_name: 'Script Only', source_url: 'javascript:alert(1)', variety_source_url: 'javascript:alert(2)' }),
    ]
    await mount()
    await openAll()
    await expandRow('own')
    const own = within(rowFor('own')).getByTestId('my-seed-packet-link')
    expect(own.getAttribute('href')).toBe('https://sandiaseed.com/products/fresno')
    expect(own.getAttribute('target')).toBe('_blank')
    expect(own.getAttribute('rel')).toBe('noopener noreferrer')
    // The visible line is hidden from a screen reader, which hears a sentence instead (named by content).
    expect(own.querySelector('[aria-hidden="true"]').textContent).toBe('Packet page · sandiaseed.com ↗')
    expect(own.hasAttribute('aria-label')).toBe(false)
    expect(own.textContent).toContain('Packet page on sandiaseed.com, opens in browser')
    await expandRow('ref')
    const ref = within(rowFor('ref')).getByTestId('my-seed-packet-link')
    expect(ref.querySelector('[aria-hidden="true"]').textContent).toBe('About this variety · johnnyseeds.com ↗')
    expect(ref.textContent).not.toMatch(/supplier/i)
    await expandRow('none')
    expect(within(rowFor('none')).queryByTestId('my-seed-packet-link')).toBeNull()
    await expandRow('js')
    const js = within(rowFor('js')).getByTestId('my-seed-packet-link')
    expect(js.getAttribute('href')).toBe('https://www.johnnyseeds.com/script')
    expect(js.querySelector('[aria-hidden="true"]').textContent).toBe('About this variety · johnnyseeds.com ↗')
    await expandRow('jsonly')
    expect(within(rowFor('jsonly')).queryByTestId('my-seed-packet-link')).toBeNull()
    expect([...document.querySelectorAll('a[href]')].some((a) => /^javascript:/i.test(a.getAttribute('href')))).toBe(false)
  })

  it('offers "Change stage in Saved seeds →" only for a lot in process, and hands the lot to the shell', async () => {
    const onGoToLot = vi.fn()
    rows = [
      pkt({ id: 'dry', name: 'Gong Bao — saved 2026', variety_name: 'Gong Bao', seed_stage: 'drying', source_plant_id: 'pl' }),
      pkt({ id: 'plain' }),
    ]
    await mount({ onGoToLot })
    await openAll()
    await expandRow('plain')
    expect(screen.queryByTestId('my-seed-change-stage')).toBeNull()
    await expandRow('dry')
    await act(async () => { fireEvent.click(screen.getByTestId('my-seed-change-stage')) })
    expect(onGoToLot).toHaveBeenCalledWith('dry')
  })
})

describe('My seeds — a write never lands out of sight (§4.3)', () => {
  function mountDriver(target) {
    function Driver() {
      const [h, setH] = useState(null)
      return (
        <>
          <button type="button" onClick={() => setH({ id: target, seq: 1 })}>outline-it</button>
          <Host highlight={h} />
        </>
      )
    }
    return act(async () => { render(<MemoryRouter><ToastProvider><Driver /></ToastProvider></MemoryRouter>) })
  }

  it('a search that would hide the outlined card is cleared, its group opens, and the page says so', async () => {
    rows = [pkt({ id: 'keep' }), pkt({ id: 'new', name: 'Cherokee Purple', variety_name: 'Cherokee Purple' })]
    await mountDriver('new')
    await waitFor(() => expect(headerFor('Tomato')).toBeTruthy())
    await act(async () => { fireEvent.change(screen.getByTestId('my-seeds-search'), { target: { value: 'sungold' } }) })
    expect(rowFor('keep')).toBeTruthy()
    expect(rowFor('new')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByText('outline-it')) })
    await waitFor(() => expect(rowFor('new')?.getAttribute('data-outlined')).toBe('true'))
    expect(screen.getByTestId('my-seeds-notice').textContent).toBe('Showing all · Cherokee Purple')
    expect(screen.getByTestId('my-seeds-search').value).toBe('')
  })

  it('only the filter that excludes it is cleared: a supplier chip goes, the search stays', async () => {
    rows = [
      pkt({ id: 'bi', name: 'Cherry Bomb', variety_name: 'Cherry Bomb', source_id: 'src-bi' }),
      pkt({ id: 'new', name: 'Cherokee Purple', variety_name: 'Cherokee Purple', source_id: 'src-sandia' }),
    ]
    await mountDriver('new')
    const row = await screen.findByTestId('my-seeds-supplier-filter')
    await act(async () => { fireEvent.change(screen.getByTestId('my-seeds-search'), { target: { value: 'cher' } }) })
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Botanical' })) })
    expect(rowFor('new')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByText('outline-it')) })
    await waitFor(() => expect(rowFor('new')?.getAttribute('data-outlined')).toBe('true'))
    expect(screen.getByTestId('my-seeds-notice').textContent).toBe('Showing all suppliers · Cherokee Purple')
    expect(screen.getByTestId('my-seeds-search').value).toBe('cher')
  })

  it('a card inside a FOLDED group: the group opens first, then the outline fires once and scrolls to it', async () => {
    rows = [pkt({ id: 'keep' }), pepper({ id: 'new', name: 'Fresno', variety_name: 'Fresno' })]
    await mountDriver('new')
    await waitFor(() => expect(headerFor('Pepper')).toBeTruthy())
    expect(headerFor('Pepper').getAttribute('aria-expanded')).toBe('false')
    expect(rowFor('new')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByText('outline-it')) })
    await waitFor(() => expect(rowFor('new')?.getAttribute('data-outlined')).toBe('true'))
    expect(headerFor('Pepper').getAttribute('aria-expanded')).toBe('true')
    expect(scrolled).toEqual(['new'])
    // Nothing else was opened for it.
    expect(headerFor('Tomato').getAttribute('aria-expanded')).toBe('false')
  })
})
