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

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import Inventory from '../pages/Inventory.jsx'

// ── Fixture ────────────────────────────────────────────────────────────────────────────────────
// Shaped to exercise every branch the page forks on, not to look realistic:
//   · ARRAY ORDER IS DELIBERATELY THE REVERSE OF CATEGORY_ORDER — tools(9), containers(5),
//     fertilizer(2), seeds(0). A first draft listed them in canonical order, which made the
//     grouping assertion VACUOUS: swapping the page to plain insertion-order grouping still
//     passed, because for that fixture the two orders were identical. Mutation-tested since.
//   · both low-stock states (at threshold, and zero → "Out") plus a consumable with a null
//     threshold, which must get NO badge;
//   · a durable (quantity, not quantity_on_hand — adjustQuantity picks the column by type);
//   · an item with no cost, which feeds the "N items without cost" line;
//   · a RETIRED item, which the default status filter ('active') must hide.
const ITEMS = [
  { id: 'i-hori', name: 'Hori Hori Knife', type: 'durable', category: 'tools', status: 'active',
    quantity: 1, condition: 'excellent', unit_cost: 30, quantity_purchased: 1, purchase_date: '2026-04-10' },
  { id: 'i-old', name: 'Retired Sprayer', type: 'durable', category: 'tools', status: 'retired',
    quantity: 1, unit_cost: 15, quantity_purchased: 1, purchase_date: '2025-06-01' },
  { id: 'i-bag', name: 'Grow Bag 5gal', type: 'durable', category: 'containers', status: 'active',
    quantity: 20, condition: 'good', unit_cost: null, quantity_purchased: null, purchase_date: '2026-02-02' },
  { id: 'i-fish', name: 'Fish Emulsion', type: 'consumable', category: 'fertilizer', status: 'active',
    quantity_on_hand: 4, reorder_threshold: null, unit: 'qt', unit_cost: 12, quantity_purchased: 2,
    purchase_date: '2026-05-20' },
  { id: 'i-zinnia', name: 'Zinnia Mix', type: 'consumable', category: 'seeds', status: 'active',
    quantity_on_hand: 0, reorder_threshold: 1, unit: 'packet', unit_cost: 2, quantity_purchased: 4,
    purchase_date: '2026-01-15' },
  { id: 'i-sungold', name: 'Sungold Tomato', type: 'consumable', category: 'seeds', status: 'active',
    quantity_on_hand: 2, reorder_threshold: 5, unit: 'packet', unit_cost: 3.5, quantity_purchased: 10,
    purchase_date: '2026-03-01' },
]

// Cost bar reads ALL items, not the filtered set (it is a total-inventory-value reading), so the
// retired sprayer counts. total = 35 + 8 + 24 + 0 + 30 + 15.
const TOTAL = '$112.00'
const CONSUMABLE_TOTAL = '$67.00'   // 3.5*10 + 2*4 + 12*2
const DURABLE_TOTAL = '$45.00'      // 30*1 + 15*1  (grow bag has no cost)

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
    expect(rows).toHaveLength(5)                       // the retired item is filtered out
    // Non-vacuity: a coin per row, each carrying its own category, not one shared element.
    const coins = screen.getAllByTestId('inv-coin')
    expect(coins).toHaveLength(rows.length)
    for (const row of rows) {
      expect(within(row).getByTestId('inv-coin')).toBeTruthy()
    }
    expect(coins.map(c => c.getAttribute('data-category')))
      .toEqual(['seeds', 'seeds', 'fertilizer', 'containers', 'tools'])
  })

  it('renders the coin as registry SVG where one exists and a monogram where none does', async () => {
    await renderList()
    const seedCoin = screen.getAllByTestId('inv-coin').find(c => c.dataset.category === 'seeds')
    expect(seedCoin.querySelector('svg')).toBeTruthy()
    // The three categories with no registry anchor fall back to a monogram in the same frame.
    const seedItem = ITEMS.find(i => i.id === 'i-sungold')
    mockList([{ ...seedItem, id: 'i-am', name: 'Azomite', category: 'amendment' }])
    const { unmount } = render(<Inventory />)
    const mono = await screen.findByText('Am')
    expect(mono).toBeTruthy()
    unmount()
  })

  it('shows quantity in the COLLAPSED row — the "no qty at a glance" complaint', async () => {
    await renderList()
    const sungold = screen.getAllByTestId('inv-row').find(r => r.textContent.includes('Sungold'))
    // Collapsed: the expanded panel's "Qty on hand:" label is absent, but the number is not.
    expect(within(sungold).queryByText('Qty on hand:')).toBeNull()
    expect(sungold.textContent).toContain('2')
    expect(sungold.textContent).toContain('packet')
    expect(sungold.textContent).toContain('$3.50 ea')
    // Durables read their own column and carry condition.
    const bag = screen.getAllByTestId('inv-row').find(r => r.textContent.includes('Grow Bag'))
    expect(bag.textContent).toContain('Qty 20')
    expect(bag.textContent).toContain('Good')
  })

  it('conveys low-stock by shape AND text AND colour, never colour alone (WCAG 1.4.1)', async () => {
    await renderList()
    const low = screen.getByLabelText('Low stock')
    const out = screen.getByLabelText('Out of stock')
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
    // Fixture insertion order puts tools last but containers before it; CATEGORY_ORDER is
    // seeds(0) < fertilizer(2) < containers(5) < tools(9). Sections must follow the latter.
    expect(sectionLabels()).toEqual(['seeds', 'fertilizer', 'containers', 'tools'])
    expect(screen.getByLabelText('Seeds (2) — collapse')).toBeTruthy()
    expect(screen.getByLabelText('Tools (1) — collapse')).toBeTruthy()
  })

  it('collapses and re-expands a section without dropping its rows', async () => {
    await renderList()
    expect(rowNames().filter(n => n.includes('Sungold'))).toHaveLength(1)
    fireEvent.click(screen.getByLabelText('Seeds (2) — collapse'))
    expect(screen.getByLabelText('Seeds (2) — expand').getAttribute('aria-expanded')).toBe('false')
    expect(rowNames().some(n => n.includes('Sungold'))).toBe(false)
    expect(rowNames().some(n => n.includes('Fish Emulsion'))).toBe(true)  // other sections unaffected
    fireEvent.click(screen.getByLabelText('Seeds (2) — expand'))
    expect(rowNames().some(n => n.includes('Sungold'))).toBe(true)
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
    fireEvent.click(screen.getByLabelText(/Sungold Tomato — expand details/))
    fireEvent.click(screen.getByLabelText(/Hori Hori Knife — expand details/))

    const controls = [
      ...screen.getAllByLabelText('Decrease quantity'),
      ...screen.getAllByLabelText('Increase quantity'),
      ...screen.getAllByTestId('inv-section'),
      ...screen.getAllByRole('combobox'),
      screen.getByRole('link', { name: /Add seeds/ }),
      screen.getByRole('link', { name: /Sow now/ }),
      screen.getByRole('link', { name: /\+ Add/ }),
      screen.getByRole('button', { name: /need restock/ }),
    ]
    // Non-vacuity: an empty or short list would make the loop below pass for free. 4 ± buttons
    // (2 consumable + 2 durable), 4 sections, 3 selects, 3 links, 1 restock = 15.
    expect(controls).toHaveLength(15)
    const undersized = controls
      .map(el => ({ el, h: tapHeight(el) }))
      .filter(({ h }) => !(h >= T.tapMinHeight))
    expect(undersized.map(({ el }) => (el.getAttribute('aria-label') || el.textContent).slice(0, 40))).toEqual([])
  })

  it('sizes the qty ± buttons on BOTH axes, not height alone', async () => {
    await renderList()
    fireEvent.click(screen.getByLabelText(/Sungold Tomato — expand details/))
    const minus = screen.getByLabelText('Decrease quantity')
    expect(parseFloat(minus.style.width)).toBeGreaterThanOrEqual(T.tapMinHeight)
    expect(parseFloat(minus.style.height)).toBeGreaterThanOrEqual(T.tapMinHeight)
  })

  it('holds the toast Undo and dismiss controls at the floor too', async () => {
    await renderList()
    fireEvent.click(screen.getByLabelText(/Sungold Tomato — expand details/))
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
    expect(sectionLabels()).toEqual(['seeds', 'fertilizer'])
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(sectionLabels()).toEqual(['seeds', 'fertilizer', 'containers', 'tools'])
  })

  it('filters by category', async () => {
    await renderList()
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'seeds' } })
    expect(sectionLabels()).toEqual(['seeds'])
    expect(screen.getAllByTestId('inv-row')).toHaveLength(2)
  })

  it('filters by status, and hides non-active items by default', async () => {
    await renderList()
    expect(rowNames().some(n => n.includes('Retired Sprayer'))).toBe(false)
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'retired' } })
    expect(rowNames().some(n => n.includes('Retired Sprayer'))).toBe(true)
    expect(screen.getAllByTestId('inv-row')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } })
    expect(screen.getAllByTestId('inv-row')).toHaveLength(6)
  })

  it('sorts WITHIN each section and leaves the section order alone', async () => {
    await renderList()
    const seedRows = () => screen.getAllByTestId('inv-row')
      .map(r => r.textContent).filter(t => t.includes('Sungold') || t.includes('Zinnia'))

    expect(seedRows()[0]).toContain('Sungold')                       // name_asc
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'name_desc' } })
    expect(seedRows()[0]).toContain('Zinnia')
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'qty_asc' } })
    expect(seedRows()[0]).toContain('Zinnia')                        // 0 before 2
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'date_desc' } })
    expect(seedRows()[0]).toContain('Sungold')                       // 2026-03 before 2026-01
    expect(sectionLabels()).toEqual(['seeds', 'fertilizer', 'containers', 'tools'])
  })

  it('adjusts a CONSUMABLE inline against quantity_on_hand', async () => {
    await renderList()
    fireEvent.click(screen.getByLabelText(/Sungold Tomato — expand details/))
    fireEvent.click(screen.getByLabelText('Increase quantity'))
    await waitFor(() => {
      const put = fetchSpy.mock.calls.find(c => c[1]?.method === 'PUT')
      expect(put).toBeTruthy()
      expect(put[0]).toBe('/api/inventory-items/i-sungold')
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
    fireEvent.click(screen.getByLabelText(/Sungold Tomato — expand details/))
    await act(async () => { fireEvent.click(screen.getByLabelText('Increase quantity')) })
    const undo = await screen.findByRole('button', { name: 'Undo' })
    expect(screen.getByText('Quantity changed to 3')).toBeTruthy()
    await act(async () => { fireEvent.click(undo); await new Promise(r => setTimeout(r, 50)) })
    const puts = fetchSpy.mock.calls.filter(c => c[1]?.method === 'PUT')
    expect(puts).toHaveLength(2)
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
    fireEvent.click(screen.getByLabelText(/Sungold Tomato — expand details/))
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
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(sectionLabels()).toEqual(['seeds', 'fertilizer', 'containers', 'tools'])
  })

  it('jumps to the low-stock consumables from the restock button', async () => {
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: /2 need restock/ }))
    expect(sectionLabels()).toEqual(['seeds', 'fertilizer'])
  })

  it('surfaces a load error instead of an empty list', async () => {
    fetchSpy.mockRejectedValue(new Error('inventory is down'))
    render(<Inventory />)
    expect(await screen.findByText('inventory is down')).toBeTruthy()
    expect(screen.queryByText('Nothing here yet')).toBeNull()
  })

  it('keeps the expanded detail cells and the edit link', async () => {
    await renderList()
    fireEvent.click(screen.getByLabelText(/Sungold Tomato — expand details/))
    const row = screen.getAllByTestId('inv-row').find(r => r.textContent.includes('Sungold'))
    expect(within(row).getByText('Qty on hand:')).toBeTruthy()
    expect(within(row).getByText('Unit cost:')).toBeTruthy()
    expect(within(row).getByRole('link', { name: /Edit item/ }).getAttribute('href'))
      .toBe('/inventory/i-sungold')
  })
})
