// Lane D / Phase B+C broad adoption — InventoryDetail (the edit form) now imports the
// centralized inventoryEnums (its local duplicate CATEGORIES/UNITS/CONDITIONS/STATUSES
// arrays are deleted) and routes its 4 selects through the shared EnumSelect. Guards:
// the type-filtered category list and the status/condition sets still render post-migration.
// api / useInventory / FavoriteToggle / PhotoUpload are mocked (no network).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const DURABLE_ITEM = { id: 'abc', name: 'LED Grow Light', type: 'durable', category: 'lighting', status: 'active', quantity: 2, condition: 'good' }
// Stable fetch identity — a fresh fn each render would retrigger the load effect.
const stableFetch = vi.fn(async () => DURABLE_ITEM)
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: stableFetch, getToken: vi.fn() }) }))
vi.mock('../hooks/useInventory.js', () => ({ useInventory: () => ({ updateItem: vi.fn(), deleteItem: vi.fn() }) }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => null }))

import InventoryDetail from '../pages/InventoryDetail.jsx'

const renderPage = () => render(
  <MemoryRouter initialEntries={['/inventory/abc']}>
    <Routes><Route path="/inventory/:id" element={<InventoryDetail />} /></Routes>
  </MemoryRouter>
)
const optionTexts = (sel) => within(sel).getAllByRole('option').map(o => o.textContent)
const selectWithOption = (label) => screen.getAllByRole('combobox').find(s => optionTexts(s).includes(label))

describe('InventoryDetail — selects migrated to EnumSelect + centralized enums', () => {
  it('category select shows only durable-eligible categories (filter preserved)', async () => {
    renderPage()
    await screen.findByText('Item details')        // wait for the async item load
    const opts = optionTexts(selectWithOption('Tools'))
    for (const c of ['Lighting', 'Shelving', 'Tools', 'Climate control', 'Containers', 'Other'])
      expect(opts, `durable should offer ${c}`).toContain(c)
    for (const c of ['Seeds', 'Growing media', 'Pest control'])
      expect(opts, `durable must not offer ${c}`).not.toContain(c)
  })

  it('status select offers the centralized inventory status set', async () => {
    renderPage()
    await screen.findByText('Item details')
    const st = optionTexts(selectWithOption('depleted'))
    for (const s of ['active', 'depleted', 'retired', 'missing']) expect(st).toContain(s)
  })

  it('condition select (durable) offers the centralized condition set', async () => {
    renderPage()
    await screen.findByText('Item details')
    const cond = optionTexts(selectWithOption('excellent'))
    for (const c of ['excellent', 'good', 'fair', 'poor']) expect(cond).toContain(c)
  })
})
