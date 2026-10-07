// V5-SEEDMULTIPARENT-001 release 2b — SEED_MULTI_PARENT OFF is the release's forward undo, and the
// "Your mix" tag was the one flag-gated surface with no flag-off pin. A mix row the server still lists
// (release 2a stays live either way) is drawn as any other variety row was before this release: its
// name and its crop tag, and no tag of its own.
//
// The flag is held off by a static top-level mock, for the whole file. The flag-on tag is pinned in
// VarietyPicker.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()), SEED_MULTI_PARENT: false,
}))

import VarietyPicker from '../components/VarietyPicker.jsx'

const ALASKA = { id: 'n-1', name: 'Alaska Mix', crop_type_slug: 'pepper', variety_rank: 'cultivar' }
const MIX = { id: 'n-2', name: 'Alaska Mix + Jewel Mix Nasturtium', crop_type_slug: 'pepper', variety_rank: 'blend' }

beforeEach(() => { fetchSpy.mockReset() })

describe('VarietyPicker — SEED_MULTI_PARENT off', () => {
  it('a blend row is listed with its crop tag and carries no "Your mix" tag', async () => {
    fetchSpy.mockImplementation((path) => Promise.resolve(path === '/api/varieties/crop-types'
      ? [{ slug: 'pepper', display_name: 'Pepper', default_lifecycle: 'tender_perennial', category: 'vegetable', sort_order: 0 }]
      : [ALASKA, MIX]))
    render(<VarietyPicker onChange={vi.fn()} />)
    fireEvent.focus(screen.getByRole('combobox'))

    // The row itself is there, fully drawn: the crop tag arrives last, after the crop types load.
    const row = await waitFor(() => {
      const found = screen.getAllByRole('option').find((o) => o.textContent.includes(MIX.name))
      expect(found).toBeTruthy()
      expect(found.querySelector('[title="Crop type"]')).toBeTruthy()
      return found
    })
    expect(row.querySelector('[data-testid="variety-your-mix"]')).toBeNull()
    expect(screen.queryByTestId('variety-your-mix')).toBeNull()
    expect(row.textContent).not.toContain('Your mix')
  })
})
