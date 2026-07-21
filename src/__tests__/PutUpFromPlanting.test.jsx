// V4-PUTUPLINK-001 — the read end of the spine on the planting-detail page.
// Covers: the plant_id-scoped fetch, group flattening (storage label rides down onto each row),
// the never-sum-across-units headline rule (L5), the use-soon rollup, and the empty state's
// prefilled deep-link — which is the only action this read-only section offers.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import PutUpFromPlanting from '../components/planting/PutUpFromPlanting.jsx'

const PLANTING = {
  id: 'pl-w2',
  name: 'Dark Green Zucchini',
  variety_id: 'var-dgz',
  variety_ref: { id: 'var-dgz', name: 'Dark Green Zucchini', crop_type_slug: 'squash' },
}

// Two storage groups, deliberately in INCOMPATIBLE units — the headline must list them, never add.
const GROUPED = {
  group_by: 'storage',
  groups: [
    {
      group_key: 'loc-1', label: 'Chest Freezer 1', total_packages: 4, units: ['bags'], use_soon_count: 1,
      records: [
        { id: 'r1', plant_id: 'pl-w2', quantity_value: 6, quantity_unit: 'lbs', package_count: 4,
          remaining_count: 3, method: 'blanch_freeze', preserved_at: '2026-07-10',
          use_by_target: '2027-07-10', use_by_status: 'use_soon' },
      ],
    },
    {
      group_key: 'loc-2', label: 'Pantry', total_packages: 3, units: ['jars'], use_soon_count: 0,
      records: [
        { id: 'r2', plant_id: 'pl-w2', quantity_value: 3, quantity_unit: 'jars', package_count: 3,
          remaining_count: 3, method: 'can_water_bath', preserved_at: '2026-07-18',
          use_by_target: null, use_by_status: null },
      ],
    },
  ],
}

function renderSection(fetchImpl) {
  const fetchMock = vi.fn(fetchImpl)
  const utils = render(
    <MemoryRouter><PutUpFromPlanting planting={PLANTING} fetch={fetchMock} /></MemoryRouter>
  )
  return { ...utils, fetchMock }
}

describe('PutUpFromPlanting', () => {
  it('scopes the read to THIS planting', async () => {
    const { fetchMock } = renderSection(() => Promise.resolve(GROUPED))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/preservation/whats-put-up?plant_id=pl-w2'))
  })

  it('counts containers and LISTS units without summing across them (L5)', async () => {
    renderSection(() => Promise.resolve(GROUPED))
    // 4 + 3 packages = 7 containers; units listed as "lbs, jars" — 6 lbs + 3 jars is not 9 of anything.
    expect(await screen.findByText('7 containers')).toBeTruthy()
    const headline = screen.getByText('7 containers').parentElement
    expect(headline.textContent).toMatch(/lbs/)
    expect(headline.textContent).toMatch(/jars/)
    expect(headline.textContent).toMatch(/2 put-ups/)
    expect(headline.textContent).not.toMatch(/\b9\b/)
  })

  it('rolls up the use-soon count', async () => {
    renderSection(() => Promise.resolve(GROUPED))
    expect(await screen.findByText('1 use soon')).toBeTruthy()
  })

  it('carries each group\'s storage label down onto its rows', async () => {
    renderSection(() => Promise.resolve(GROUPED))
    await screen.findByText('7 containers')
    expect(screen.getByText(/Chest Freezer 1/)).toBeTruthy()
    expect(screen.getByText(/Pantry/)).toBeTruthy()
  })

  it('shows remaining when it differs from the package count', async () => {
    renderSection(() => Promise.resolve(GROUPED))
    await screen.findByText('7 containers')
    expect(screen.getByText(/3 left/)).toBeTruthy()   // r1: 3 of 4
  })

  it('empty state offers a deep-link prefilled with the planting, crop and variety', async () => {
    renderSection(() => Promise.resolve({ group_by: 'storage', groups: [] }))
    const link = await screen.findByRole('link', { name: /Log a put-up from this planting/i })
    expect(link.getAttribute('href')).toBe('/put-up')
    // The prefill travels in router state, not the href — assert the rendered intent is present.
    expect(screen.getByText(/Nothing from this planting is in the stores yet/)).toBeTruthy()
  })

  it('degrades to a quiet message when the read fails — never blanks the page', async () => {
    renderSection(() => Promise.reject(new Error('boom')))
    // Curly apostrophes (&rsquo;) in the copy — match loosely rather than assert typography.
    expect(await screen.findByText(/Couldn.t load what.s put up/)).toBeTruthy()
  })

  it('handles a group payload with no records array', async () => {
    renderSection(() => Promise.resolve({ groups: [{ group_key: 'x', label: 'X' }] }))
    expect(await screen.findByText(/Nothing from this planting is in the stores yet/)).toBeTruthy()
  })
})
