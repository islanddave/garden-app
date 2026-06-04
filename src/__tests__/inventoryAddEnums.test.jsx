// Lane D / Phase B+C broad adoption — InventoryAdd category/unit/condition selects now
// route through the shared EnumSelect (canonical chrome + single-humanizer label +
// alpha sort). This guards the ENTANGLED path the handoff flagged: the category options
// are filtered by the selected type (visibleCategories) and fed to EnumSelect — a wiring
// regression would let a consumable-only category show under "Durable" (or vice-versa),
// or break the type-first gating. useInventory + VarietyPicker are mocked (no network).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../hooks/useInventory.js', () => ({ useInventory: () => ({ createItem: vi.fn() }) }))
vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => null }))

import InventoryAdd from '../pages/InventoryAdd.jsx'

const renderPage = () => render(<MemoryRouter><InventoryAdd /></MemoryRouter>)
const categorySelect = () => screen.getByLabelText('Category')
const optionTexts = (sel) => within(sel).getAllByRole('option').map(o => o.textContent)

describe('InventoryAdd — category EnumSelect (type-gated, filtered)', () => {
  it('category starts disabled and prompts for type first', () => {
    renderPage()
    const sel = categorySelect()
    expect(sel.disabled).toBe(true)
    expect(optionTexts(sel)).toContain('— Select type first —')
  })

  it('selecting Durable enables category and shows ONLY durable categories', () => {
    renderPage()
    fireEvent.click(screen.getByText('Durable'))
    const sel = categorySelect()
    expect(sel.disabled).toBe(false)
    const opts = optionTexts(sel)
    expect(opts).toContain('— Select category —')
    // durable-eligible (INVENTORY_CATEGORIES types includes 'durable')
    for (const c of ['Lighting', 'Shelving', 'Tools', 'Climate control', 'Containers', 'Other'])
      expect(opts, `durable should offer ${c}`).toContain(c)
    // consumable-only must NOT leak in
    for (const c of ['Seeds', 'Growing media', 'Nutrients & amendments', 'Pest control'])
      expect(opts, `durable must not offer ${c}`).not.toContain(c)
  })

  it('selecting Consumable shows ONLY consumable categories + a unit EnumSelect', () => {
    renderPage()
    fireEvent.click(screen.getByText('Consumable'))
    const opts = optionTexts(categorySelect())
    for (const c of ['Seeds', 'Growing media', 'Nutrients & amendments', 'Pest control', 'Containers', 'Other'])
      expect(opts, `consumable should offer ${c}`).toContain(c)
    for (const c of ['Lighting', 'Shelving', 'Climate control'])
      expect(opts, `consumable must not offer ${c}`).not.toContain(c)
    // consumable path renders the Unit EnumSelect with the canonical unit set
    const unit = screen.getByLabelText('Unit')
    const u = optionTexts(unit)
    for (const x of ['each', 'packet', 'oz', 'lb', 'bag']) expect(u).toContain(x)
  })
})
