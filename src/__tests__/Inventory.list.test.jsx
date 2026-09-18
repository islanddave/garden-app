/**
 * src/__tests__/Inventory.list.test.jsx
 * HG-4.2 — regression lock for the Inventory LIST redesign (uiux-homogenization-master-plan §4.1).
 *
 * The redesign shipped at 2b16b27 with no test of its own: nothing pinned the category grouping,
 * the at-a-glance row, the low-stock channel, or the tap-target floor, and nothing proved the
 * pre-existing behaviours (filters, sort, inline ±, cost summary, undo, empty/no-match) survived
 * the re-skin. Per the master plan §HG-6 that is the program's stated top risk — "you cannot
 * measure whether a re-skin regresses anything." This file is that measurement.
 *
 * V5-SEEDSTAB-001 — SEED LEFT THIS LIST for the Seeds page. The seed pins this file used to carry (a
 * Seeds section, a Seeds category option, the Add seeds / Sow now chips, a seed row's − / + and undo)
 * were REWRITTEN, not deleted: each now pins the absence, and the behaviour they exercised moved to a
 * non-seed row so the page keeps its coverage. The fixture still carries seed rows on purpose — they
 * are what proves the exclusion, and each one holds a field that would move a number if it leaked.
 *
 * Strategy: mock the WIRE (useApiFetch), not the hook. useInventory's real filter/sort/group,
 * optimistic adjustQuantity, and undo-toast logic all execute, so a regression in the page's
 * data path fails here rather than passing against a stubbed hook.
 *
 * jsdom has NO layout engine (every getBoundingClientRect is zero), so the 44px assertions read
 * the AUTHORED style value. That is the right level for this check: the defect it guards is
 * someone typing a smaller number, and the real-browser geometry is covered by the layout gate.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor, fireEvent, act } from '@testing-library/react'
import { T } from '../components/forms/formStyles.js'
import { INVENTORY_CATEGORY_OPTIONS } from '../lib/inventoryEnums.js'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import Inventory from '../pages/Inventory.jsx'

// ── Fixture ────────────────────────────────────────────────────────────────────────────────────
// Shaped to exercise every branch the page forks on, not to look realistic:
//   · ARRAY ORDER IS DELIBERATELY THE REVERSE OF CATEGORY_ORDER — tools(8), containers(4),
//     fertilizer(1), growing_media(0). A first draft listed them in canonical order, which made the
//     grouping assertion VACUOUS: swapping the page to plain insertion-order grouping still
//     passed, because for that fixture the two orders were identical. Mutation-tested since.
//   · both low-stock states (at threshold, and zero → "Out") plus a consumable with a null
//     threshold, which must get NO badge;
//   · a durable (quantity, not quantity_on_hand — adjustQuantity picks the column by type);
//   · an item with no cost, which feeds the "N items without cost" line;
//   · a RETIRED item, which the default status filter ('active') must hide;
//   · THREE SEED ROWS, first in the array, which this page must never list, total, or count toward
//     restock — only count, on the Seeds pointer row. Sungold is at zero stock under its threshold
//     WITH a cost (restock +1, totals +$35), Zinnia has no cost (without-cost +1), and Basil is
//     DEPLETED with a cost and a threshold (totals +$8, restock +1). Basil is also what makes "seed
//     rows passing Status=Active" (2) differ from "all seed rows" (3), so the pointer's count rule
//     is observable rather than coincidental.
//   Pro-Mix HP and Vermiculite took over the two low-stock states and the stepper that Sungold and
//   Zinnia used to carry, with the same numbers, so the non-seed totals below did not move.
const ITEMS = [
  { id: 's-sungold', name: 'Sungold Tomato', type: 'consumable', category: 'seeds', status: 'active',
    quantity_on_hand: 0, reorder_threshold: 1, unit: 'packet', unit_cost: 3.5, quantity_purchased: 10,
    purchase_date: '2026-03-01' },
  { id: 's-zinnia', name: 'Zinnia Mix', type: 'consumable', category: 'seeds', status: 'active',
    quantity_on_hand: 3, reorder_threshold: null, unit: 'packet', unit_cost: null, quantity_purchased: null,
    purchase_date: '2026-01-15' },
  { id: 's-basil', name: 'Genovese Basil', type: 'consumable', category: 'seeds', status: 'depleted',
    quantity_on_hand: 0, reorder_threshold: 2, unit: 'packet', unit_cost: 4, quantity_purchased: 2,
    purchase_date: '2025-04-01' },
  { id: 'i-hori', name: 'Hori Hori Knife', type: 'durable', category: 'tools', status: 'active',
    quantity: 1, condition: 'excellent', unit_cost: 30, quantity_purchased: 1, purchase_date: '2026-04-10' },
  { id: 'i-old', name: 'Retired Sprayer', type: 'durable', category: 'tools', status: 'retired',
    quantity: 1, unit_cost: 15, quantity_purchased: 1, purchase_date: '2025-06-01' },
  { id: 'i-bag', name: 'Grow Bag 5gal', type: 'durable', category: 'containers', status: 'active',
    quantity: 20, condition: 'good', unit_cost: null, quantity_purchased: null, purchase_date: '2026-02-02' },
  { id: 'i-fish', name: 'Fish Emulsion', type: 'consumable', category: 'fertilizer', status: 'active',
    quantity_on_hand: 4, reorder_threshold: null, unit: 'qt', unit_cost: 12, quantity_purchased: 2,
    purchase_date: '2026-05-20' },
  { id: 'i-verm', name: 'Vermiculite', type: 'consumable', category: 'growing_media', status: 'active',
    quantity_on_hand: 0, reorder_threshold: 1, unit: 'bag', unit_cost: 2, quantity_purchased: 4,
    purchase_date: '2026-01-15' },
  { id: 'i-promix', name: 'Pro-Mix HP', type: 'consumable', category: 'growing_media', status: 'active',
    quantity_on_hand: 2, reorder_threshold: 5, unit: 'bag', unit_cost: 3.5, quantity_purchased: 10,
    purchase_date: '2026-03-01' },
]

// Cost bar reads every NON-SEED item, not the filtered set (it is a total-inventory-value reading),
// so the retired sprayer counts and the seed rows do not. total = 35 + 8 + 24 + 0 + 30 + 15.
const TOTAL = '$112.00'
const CONSUMABLE_TOTAL = '$67.00'   // 3.5*10 + 2*4 + 12*2
const DURABLE_TOTAL = '$45.00'      // 30*1 + 15*1  (grow bag has no cost)
// What the same bar would read with the seed rows leaked back in: + Sungold 3.5*10 + Basil 4*2.
const LEAKED_TOTAL = '$155.00'
const LEAKED_CONSUMABLE_TOTAL = '$110.00'

const SEED_NAMES = ITEMS.filter(i => i.category === 'seeds').map(i => i.name)

const clone = () => ITEMS.map(i => ({ ...i }))

function mockList(items = clone()) {
  fetchSpy.mockImplementation(async (path, opts) => {
    if (!opts || (opts.method ?? 'GET') === 'GET') return items
    if (opts.method === 'PUT') return JSON.parse(opts.body)
    throw new Error('unexpected ' + opts.method + ' ' + path)
  })
}

async function renderList() {
  const utils = render(<Inventory />)
  await screen.findByRole('heading', { name: 'Inventory' })
  return utils
}

const sectionLabels = () =>
  screen.queryAllByTestId('inv-section').map(el => el.getAttribute('data-category'))

const rowNames = () =>
  screen.queryAllByTestId('inv-row').map(r => r.querySelector('button').textContent)

const seedsPointer = () => screen.queryByTestId('inv-seeds-pointer')

// The pointer's count line exactly as it reads. getByText matches an element's OWN text nodes, so
// this is always the meta line and never the "Seeds" label beside it.
const pointerLine = () =>
  within(screen.getByTestId('inv-seeds-pointer')).getByText(/open →$/).textContent

// A control's authored tap size, whichever axis it declares it on.
const tapHeight = el => {
  const s = el.style
  return parseFloat(s.minHeight || s.height || '0')
}

beforeEach(() => {
  fetchSpy.mockReset()
  mockList()
})

// ── The redesign's own claims ──────────────────────────────────────────────────────────────────
describe('Inventory list — HG-4.2 redesign structure', () => {
  it('gives every row a leading category coin (the §4.1 "thumbnail/Icon per row")', async () => {
    await renderList()
    const rows = screen.getAllByTestId('inv-row')
    expect(rows).toHaveLength(5)                       // the retired item is filtered out; seed never lists
    // Non-vacuity: a coin per row, each carrying its own category, not one shared element.
    const rowCoins = rows.map(row => within(row).getByTestId('inv-coin'))
    expect(new Set(rowCoins).size).toBe(rows.length)
    expect(rowCoins.map(c => c.getAttribute('data-category')))
      .toEqual(['growing_media', 'growing_media', 'fertilizer', 'containers', 'tools'])
    // The page's one other coin is the Seeds pointer's, and it leads, where the Seeds section's did.
    const coins = screen.getAllByTestId('inv-coin')
    expect(coins).toHaveLength(rows.length + 1)
    expect(coins.map(c => c.getAttribute('data-category')))
      .toEqual(['seeds', 'growing_media', 'growing_media', 'fertilizer', 'containers', 'tools'])
    expect(within(seedsPointer()).getByTestId('inv-coin')).toBe(coins[0])
  })

  it('renders the coin as registry SVG where one exists and a monogram where none does', async () => {
    await renderList()
    const mediaCoin = screen.getAllByTestId('inv-coin').find(c => c.dataset.category === 'growing_media')
    expect(mediaCoin.querySelector('svg')).toBeTruthy()
    // The pointer's seeds coin keeps its registry glyph too.
    expect(within(seedsPointer()).getByTestId('inv-coin').querySelector('svg')).toBeTruthy()
    // The three categories with no registry anchor fall back to a monogram in the same frame.
    const mediaItem = ITEMS.find(i => i.id === 'i-promix')
    mockList([{ ...mediaItem, id: 'i-am', name: 'Azomite', category: 'amendment' }])
    const { unmount } = render(<Inventory />)
    const mono = await screen.findByText('Am')
    expect(mono).toBeTruthy()
    unmount()
  })

  it('shows quantity in the COLLAPSED row — the "no qty at a glance" complaint', async () => {
    await renderList()
    const promix = screen.getAllByTestId('inv-row').find(r => r.textContent.includes('Pro-Mix'))
    // Collapsed: the expanded panel's "Qty on hand:" label is absent, but the number is not.
    expect(within(promix).queryByText('Qty on hand:')).toBeNull()
    expect(promix.textContent).toContain('2')
    expect(promix.textContent).toContain('bag')
    expect(promix.textContent).toContain('$3.50 ea')
    // Durables read their own column and carry condition.
    const bag = screen.getAllByTestId('inv-row').find(r => r.textContent.includes('Grow Bag'))
    expect(bag.textContent).toContain('Qty 20')
    expect(bag.textContent).toContain('Good')
  })

  it('conveys low-stock by shape AND text AND colour, never colour alone (WCAG 1.4.1)', async () => {
    await renderList()
    const low = screen.getByLabelText('Low stock')
    const out = screen.getByLabelText('Out of stock')
    // On the non-seed rows that now carry the two states (the seed rows that used to are not listed).
    expect(low.closest('[data-testid="inv-row"]').textContent).toContain('Pro-Mix HP')
    expect(out.closest('[data-testid="inv-row"]').textContent).toContain('Vermiculite')
    // Text channel.
    expect(low.textContent).toContain('Low')
    expect(out.textContent).toContain('Out')
    // Shape channel — a registry SVG, and the two states are DIFFERENT shapes, not one shape
    // recoloured. severity.high adds the bang stroke + dot that severity.med has not.
    const lowSvg = low.querySelector('svg')
    const outSvg = out.querySelector('svg')
    expect(lowSvg).toBeTruthy()
    expect(outSvg).toBeTruthy()
    expect(outSvg.innerHTML).not.toBe(lowSvg.innerHTML)
    // Colour channel is present but additive.
    expect(low.style.backgroundColor).not.toBe('')
    expect(out.style.backgroundColor).not.toBe(low.style.backgroundColor)
    // And a consumable with NO threshold gets no badge at all.
    const fish = screen.getAllByTestId('inv-row').find(r => r.textContent.includes('Fish Emulsion'))
    expect(within(fish).queryByLabelText(/stock/i)).toBeNull()
  })

  it('groups into category sections in canonical order, not insertion order', async () => {
    await renderList()
    // Fixture insertion order puts tools first and growing_media last; CATEGORY_ORDER, with seeds
    // gone from it, is growing_media(0) < fertilizer(1) < containers(4) < tools(8). Sections must
    // follow the latter.
    expect(sectionLabels()).toEqual(['growing_media', 'fertilizer', 'containers', 'tools'])
    expect(screen.getByLabelText('Growing media (2) — collapse')).toBeTruthy()
    expect(screen.getByLabelText('Tools (1) — collapse')).toBeTruthy()
  })

  it('collapses and re-expands a section without dropping its rows', async () => {
    await renderList()
    expect(rowNames().filter(n => n.includes('Pro-Mix'))).toHaveLength(1)
    fireEvent.click(screen.getByLabelText('Growing media (2) — collapse'))
    expect(screen.getByLabelText('Growing media (2) — expand').getAttribute('aria-expanded')).toBe('false')
    expect(rowNames().some(n => n.includes('Pro-Mix'))).toBe(false)
    expect(rowNames().some(n => n.includes('Fish Emulsion'))).toBe(true)  // other sections unaffected
    fireEvent.click(screen.getByLabelText('Growing media (2) — expand'))
    expect(rowNames().some(n => n.includes('Pro-Mix'))).toBe(true)
  })

  it('replaces the |-pipe cost bar with a stat row', async () => {
    await renderList()
    expect(screen.getByText(TOTAL)).toBeTruthy()
    expect(screen.getByText(CONSUMABLE_TOTAL)).toBeTruthy()
    expect(screen.getByText(DURABLE_TOTAL)).toBeTruthy()
    expect(screen.getByText('Total')).toBeTruthy()
    expect(screen.getByText('1 item without cost')).toBeTruthy()
  })

  it('renders an Icon empty state, not a raw 📦', async () => {
    mockList([])
    render(<Inventory />)
    const empty = await screen.findByText('Nothing here yet')
    expect(empty).toBeTruthy()
    expect(document.body.textContent).not.toContain('📦')
    expect(screen.queryAllByTestId('inv-section')).toHaveLength(0)
    // The pointer still offers the way to Seeds on an empty inventory, at its 0-state.
    expect(pointerLine()).toBe('None yet · open →')
  })

  it('shows a skeleton while loading, never a static "Loading…"', async () => {
    let release
    fetchSpy.mockImplementation(() => new Promise(r => { release = () => r(clone()) }))
    render(<Inventory />)
    expect(screen.queryByText(/Loading/i)).toBeNull()
    await waitFor(() => expect(release).toBeTypeOf('function'))
    await act(async () => { release() })
    await screen.findByRole('heading', { name: 'Inventory' })
  })
})

// ── The 44px floor ─────────────────────────────────────────────────────────────────────────────
describe('Inventory list — tap targets', () => {
  it('holds every interactive control at T.tapMinHeight or above', async () => {
    await renderList()
    // Expand a consumable AND a durable so both ± pairs are mounted and measured.
    fireEvent.click(screen.getByLabelText(/Pro-Mix HP — expand details/))
    fireEvent.click(screen.getByLabelText(/Hori Hori Knife — expand details/))

    const controls = [
      ...screen.getAllByLabelText('Decrease quantity'),
      ...screen.getAllByLabelText('Increase quantity'),
      ...screen.getAllByTestId('inv-section'),
      ...screen.getAllByRole('combobox'),
      screen.getByRole('link', { name: /\+ Add/ }),
      screen.getByTestId('inv-seeds-pointer'),
      screen.getByRole('button', { name: /need restock/ }),
    ]
    // Non-vacuity: an empty or short list would make the loop below pass for free. 4 ± buttons
    // (2 consumable + 2 durable), 4 sections, 3 selects, 2 links, 1 restock = 14. It was 15 before
    // V5-SEEDSTAB-001: the Add seeds and Sow now chips (-2) left with the seed rows, and the Seeds
    // pointer row (+1), the whole of which is one tap target, took the Seeds section's place. The
    // section count held at 4 only because the fixture's growing_media section replaced the seeds one.
    expect(controls).toHaveLength(14)
    const undersized = controls
      .map(el => ({ el, h: tapHeight(el) }))
      .filter(({ h }) => !(h >= T.tapMinHeight))
    expect(undersized.map(({ el }) => (el.getAttribute('aria-label') || el.textContent).slice(0, 40))).toEqual([])
  })

  it('sizes the qty ± buttons on BOTH axes, not height alone', async () => {
    await renderList()
    fireEvent.click(screen.getByLabelText(/Pro-Mix HP — expand details/))
    const minus = screen.getByLabelText('Decrease quantity')
    expect(parseFloat(minus.style.width)).toBeGreaterThanOrEqual(T.tapMinHeight)
    expect(parseFloat(minus.style.height)).toBeGreaterThanOrEqual(T.tapMinHeight)
  })

  it('holds the toast Undo and dismiss controls at the floor too', async () => {
    await renderList()
    fireEvent.click(screen.getByLabelText(/Pro-Mix HP — expand details/))
    fireEvent.click(screen.getByLabelText('Increase quantity'))
    const undo = await screen.findByRole('button', { name: 'Undo' })
    const dismiss = screen.getByLabelText('Dismiss notification')
    expect(tapHeight(undo)).toBeGreaterThanOrEqual(T.tapMinHeight)
    expect(tapHeight(dismiss)).toBeGreaterThanOrEqual(T.tapMinHeight)
    expect(parseFloat(dismiss.style.minWidth)).toBeGreaterThanOrEqual(T.tapMinHeight)
  })
})

// ── Everything the redesign had to NOT break ───────────────────────────────────────────────────
describe('Inventory list — preserved behaviours', () => {
  it('filters by type', async () => {
    await renderList()
    fireEvent.click(screen.getByRole("radio", { name: "Durable" }))
    expect(sectionLabels()).toEqual(['containers', 'tools'])
    fireEvent.click(screen.getByRole("radio", { name: "Consumable" }))
    expect(sectionLabels()).toEqual(['growing_media', 'fertilizer'])
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(sectionLabels()).toEqual(['growing_media', 'fertilizer', 'containers', 'tools'])
  })

  it('filters by category', async () => {
    await renderList()
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'growing_media' } })
    expect(sectionLabels()).toEqual(['growing_media'])
    expect(screen.getAllByTestId('inv-row')).toHaveLength(2)
  })

  it('filters by status, and hides non-active items by default', async () => {
    await renderList()
    expect(rowNames().some(n => n.includes('Retired Sprayer'))).toBe(false)
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'retired' } })
    expect(rowNames().some(n => n.includes('Retired Sprayer'))).toBe(true)
    expect(screen.getAllByTestId('inv-row')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } })
    expect(screen.getAllByTestId('inv-row')).toHaveLength(6)   // every NON-seed row; seed never lists
  })

  it('sorts WITHIN each section and leaves the section order alone', async () => {
    await renderList()
    const mediaRows = () => screen.getAllByTestId('inv-row')
      .map(r => r.textContent).filter(t => t.includes('Pro-Mix') || t.includes('Vermiculite'))

    expect(mediaRows()[0]).toContain('Pro-Mix')                      // name_asc
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'name_desc' } })
    expect(mediaRows()[0]).toContain('Vermiculite')
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'qty_asc' } })
    expect(mediaRows()[0]).toContain('Vermiculite')                  // 0 before 2
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'date_desc' } })
    expect(mediaRows()[0]).toContain('Pro-Mix')                      // 2026-03 before 2026-01
    expect(sectionLabels()).toEqual(['growing_media', 'fertilizer', 'containers', 'tools'])
  })

  // The − / + stays on this page for every NON-seed consumable; the seed packet's moved to My seeds
  // with the rows. These four cases used to drive a seed row (Sungold) and now drive Pro-Mix HP.
  it('adjusts a CONSUMABLE inline against quantity_on_hand', async () => {
    await renderList()
    fireEvent.click(screen.getByLabelText(/Pro-Mix HP — expand details/))
    fireEvent.click(screen.getByLabelText('Increase quantity'))
    await waitFor(() => {
      const put = fetchSpy.mock.calls.find(c => c[1]?.method === 'PUT')
      expect(put).toBeTruthy()
      expect(put[0]).toBe('/api/inventory-items/i-promix')
      expect(JSON.parse(put[1].body).quantity_on_hand).toBe(3)
    })
  })

  it('adjusts a DURABLE against quantity, not quantity_on_hand', async () => {
    await renderList()
    fireEvent.click(screen.getByLabelText(/Hori Hori Knife — expand details/))
    fireEvent.click(screen.getByLabelText('Increase quantity'))
    await waitFor(() => {
      const put = fetchSpy.mock.calls.find(c => c[1]?.method === 'PUT')
      expect(put).toBeTruthy()
      const body = JSON.parse(put[1].body)
      expect(body.quantity).toBe(2)
      expect(body.quantity_on_hand).toBeUndefined()
    })
  })

  it('offers undo on the toast and sends a reversing write', async () => {
    await renderList()
    fireEvent.click(screen.getByLabelText(/Pro-Mix HP — expand details/))
    await act(async () => { fireEvent.click(screen.getByLabelText('Increase quantity')) })
    const undo = await screen.findByRole('button', { name: 'Undo' })
    expect(screen.getByText('Quantity changed to 3')).toBeTruthy()
    await act(async () => { fireEvent.click(undo); await new Promise(r => setTimeout(r, 50)) })
    const puts = fetchSpy.mock.calls.filter(c => c[1]?.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(puts.map(c => c[0])).toEqual(['/api/inventory-items/i-promix', '/api/inventory-items/i-promix'])
    // The first write raised the count, the second lowers it...
    expect(JSON.parse(puts[1][1].body).quantity_on_hand)
      .toBeLessThan(JSON.parse(puts[0][1].body).quantity_on_hand)
    // ...and lands back on the ORIGINAL 2, not on 2 - delta. Folded in from the
    // characterization test that used to pin `1` here (BUG-INVUNDOQTY-001), per that
    // block's own instruction to flip the value and merge once the hook was repaired.
    expect(JSON.parse(puts[1][1].body).quantity_on_hand).toBe(2)
  })

  it('dismisses the toast', async () => {
    await renderList()
    fireEvent.click(screen.getByLabelText(/Pro-Mix HP — expand details/))
    fireEvent.click(screen.getByLabelText('Increase quantity'))
    await screen.findByRole('button', { name: 'Undo' })
    fireEvent.click(screen.getByLabelText('Dismiss notification'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull())
  })

  it('shows the no-match state with a working Clear filters, distinct from the empty state', async () => {
    await renderList()
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'lighting' } })
    expect(screen.getByText('No items match these filters.')).toBeTruthy()
    expect(screen.queryByText('Nothing here yet')).toBeNull()     // NOT the empty state
    expect(seedsPointer()).toBeNull()                              // a chosen category is never seed
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(sectionLabels()).toEqual(['growing_media', 'fertilizer', 'containers', 'tools'])
    expect(seedsPointer()).not.toBeNull()
  })

  it('jumps to the low-stock consumables from the restock button', async () => {
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: /2 need restock/ }))
    expect(sectionLabels()).toEqual(['growing_media', 'fertilizer'])
  })

  it('surfaces a load error instead of an empty list', async () => {
    fetchSpy.mockRejectedValue(new Error('inventory is down'))
    render(<Inventory />)
    expect(await screen.findByText('inventory is down')).toBeTruthy()
    expect(screen.queryByText('Nothing here yet')).toBeNull()
  })

  it('keeps the expanded detail cells and the edit link', async () => {
    await renderList()
    fireEvent.click(screen.getByLabelText(/Pro-Mix HP — expand details/))
    const row = screen.getAllByTestId('inv-row').find(r => r.textContent.includes('Pro-Mix'))
    expect(within(row).getByText('Qty on hand:')).toBeTruthy()
    expect(within(row).getByText('Unit cost:')).toBeTruthy()
    expect(within(row).getByRole('link', { name: /Edit item/ }).getAttribute('href'))
      .toBe('/inventory/i-promix')
  })
})

// ── V5-SEEDSTAB-001: seed lives on the Seeds page now ─────────────────────────────────────────
describe('Inventory list — seed left for the Seeds page (V5-SEEDSTAB-001)', () => {
  it('puts ONE Seeds pointer row where the Seeds section was — first, linking to My seeds', async () => {
    await renderList()
    expect(screen.getAllByTestId('inv-seeds-pointer')).toHaveLength(1)
    const pointer = seedsPointer()
    expect(pointer.tagName).toBe('A')
    expect(pointer.getAttribute('href')).toBe('/seeds?view=mine')
    expect(within(pointer).getByText('Seeds')).toBeTruthy()
    expect(pointerLine()).toBe('2 packets and saved lots · open →')
    expect(within(pointer).getByTestId('inv-coin').dataset.category).toBe('seeds')
    // First: ahead of every section and so of every row, as the Seeds section was.
    const [firstSection] = screen.getAllByTestId('inv-section')
    expect(pointer.compareDocumentPosition(firstSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('counts the seed rows that pass the Status filter, not every seed row', async () => {
    await renderList()
    // Status defaults to Active: Sungold + Zinnia. The depleted Basil is what makes All differ.
    expect(pointerLine()).toBe('2 packets and saved lots · open →')
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } })
    expect(pointerLine()).toBe('3 packets and saved lots · open →')
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'depleted' } })
    expect(pointerLine()).toBe('1 packet or saved lot · open →')
    // Zero passing the filter, while seed exists in other statuses, says so — never "None yet",
    // which on a filtered view would read as "you have no seed".
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'retired' } })
    expect(pointerLine()).toBe('None with this status · open →')
    // Type never moves the count: it only decides whether the row shows at all (next case).
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'active' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Consumable' }))
    expect(pointerLine()).toBe('2 packets and saved lots · open →')
  })

  it('reads "None yet" when there is no seed at all, and still leads to the Seeds page', async () => {
    mockList(clone().filter(i => i.category !== 'seeds'))
    await renderList()
    expect(pointerLine()).toBe('None yet · open →')
    expect(seedsPointer().getAttribute('href')).toBe('/seeds?view=mine')
  })

  it('shows the pointer only where the list could have held seed: Type All or Consumable, no Category', async () => {
    await renderList()
    expect(seedsPointer()).not.toBeNull()                                       // Type All
    fireEvent.click(screen.getByRole('radio', { name: 'Durable' }))
    expect(seedsPointer()).toBeNull()                                           // seed is never durable
    fireEvent.click(screen.getByRole('radio', { name: 'Consumable' }))
    expect(seedsPointer()).not.toBeNull()
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'fertilizer' } })
    expect(seedsPointer()).toBeNull()                                           // a specific category
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(seedsPointer()).toBeNull()                                           // ...under Type All too
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'all' } })
    expect(seedsPointer()).not.toBeNull()
  })

  it('offers no Seeds option in the Category select, and every other category still', async () => {
    await renderList()
    const options = [...screen.getByLabelText('Category').querySelectorAll('option')]
    expect(options.map(o => o.value)).not.toContain('seeds')
    expect(options.map(o => o.textContent)).not.toContain('Seeds')
    // Surgical, not a truncated list: "All categories" plus each vocabulary category except seed, in
    // the vocabulary's own order.
    expect(options.map(o => o.value))
      .toEqual(['all', ...INVENTORY_CATEGORY_OPTIONS.map(([v]) => v).filter(v => v !== 'seeds')])
    expect(options).toHaveLength(INVENTORY_CATEGORY_OPTIONS.length)
  })

  it('lists no seed row under any Status, in any section', async () => {
    await renderList()
    const statuses = [...screen.getByLabelText('Status').querySelectorAll('option')].map(o => o.value)
    expect(statuses).toEqual(['active', 'depleted', 'retired', 'missing', 'all'])
    for (const status of statuses) {
      fireEvent.change(screen.getByLabelText('Status'), { target: { value: status } })
      expect(rowNames().filter(n => SEED_NAMES.some(s => n.includes(s)))).toEqual([])
      expect(sectionLabels()).not.toContain('seeds')
      // ...nor in the leftover bucket, which is where a seed row lands if it gets past the page's
      // filter while CATEGORY_ORDER still leaves seeds out.
      expect(sectionLabels()).not.toContain('other')
    }
    // Under All every non-seed row IS listed, so "no seed row" is not "no row".
    expect(screen.getAllByTestId('inv-row')).toHaveLength(6)
  })

  it('leaves seed rows out of the cost totals, the without-cost line and the restock count', async () => {
    await renderList()
    // Each seed row carries the field that would move one of these numbers if it leaked back in.
    expect(screen.getByText(TOTAL)).toBeTruthy()
    expect(screen.getByText(CONSUMABLE_TOTAL)).toBeTruthy()
    expect(screen.getByText(DURABLE_TOTAL)).toBeTruthy()
    expect(screen.queryByText(LEAKED_TOTAL)).toBeNull()
    expect(screen.queryByText(LEAKED_CONSUMABLE_TOTAL)).toBeNull()
    expect(screen.getByText('1 item without cost')).toBeTruthy()           // the grow bag, not Zinnia
    // Pro-Mix HP + Vermiculite, not Sungold (0 of 1) or the depleted Basil (0 of 2).
    expect(screen.getByRole('button', { name: /^2 need restock$/ })).toBeTruthy()
    // The bar is a whole-inventory reading, so widening Status must not pull seed in either.
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } })
    expect(screen.getByText(TOTAL)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^2 need restock$/ })).toBeTruthy()
  })

  it('shows an inventory of only seed as the pointer alone — no empty state, no no-match, a $0 bar', async () => {
    mockList(clone().filter(i => i.category === 'seeds'))
    await renderList()
    expect(pointerLine()).toBe('2 packets and saved lots · open →')
    expect(screen.queryAllByTestId('inv-row')).toHaveLength(0)
    expect(screen.queryAllByTestId('inv-section')).toHaveLength(0)
    // Nothing is missing and no filter excluded anything, so neither "nothing here" state applies.
    expect(screen.queryByText('Nothing here yet')).toBeNull()
    expect(screen.queryByText('No items match these filters.')).toBeNull()
    expect(screen.getAllByText('$0.00')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /need restock/ })).toBeNull()
    expect(screen.queryByText(/without cost/)).toBeNull()
  })

  it('keeps "+ Add" as the header\'s one action — the Add seeds / Saved seeds / Sow now chips are gone', async () => {
    await renderList()
    expect(screen.getByRole('link', { name: '+ Add' }).getAttribute('href')).toBe('/inventory/add')
    for (const name of [/Add seeds/, /Saved seeds/, /Sow now/]) {
      expect(screen.queryByRole('link', { name })).toBeNull()
    }
    // Pinned by destination as well, so a chip that came back under a new label still reds here: the
    // collapsed page's whole link census is + Add, then the Seeds pointer.
    expect(screen.getAllByRole('link').map(a => a.getAttribute('href')))
      .toEqual(['/inventory/add', '/seeds?view=mine'])
  })
})
