// V4-PROJHIDE-001 — Harvests with PROJECTS_HIDDEN mocked TRUE. Pins the flag-ON behaviors:
// (1) the Project filter pill + its picker sheet are gone (crop is the only axis), and
// (2) an unassigned (plantless) harvest is NOT a bare-project link — the card is inert, never a
// link into the hidden /projects/:id page. Flag-OFF behavior (both pills, project deep-links) is
// covered by Harvests.test.jsx. importActual spread so other flags keep their values. No jest-dom.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const { fetchSpy, searchParamsRef } = vi.hoisted(() => ({ fetchSpy: vi.fn(), searchParamsRef: { current: new URLSearchParams() } }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useSearchParams: () => [searchParamsRef.current, () => {}],
}))
// Flag ON — spread the real module so every other flag keeps its value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

import Harvests from '../pages/Harvests.jsx'

beforeEach(() => {
  fetchSpy.mockReset()
  searchParamsRef.current = new URLSearchParams()
  fetchSpy.mockResolvedValue({ entries: [], aggregates: { crops: [], other: [] }, cursor: null })
})

// V4-HARVDEFAULT-001: a bare arrival lands on TOTALS, so the Log-scoped pins below first toggle to
// the Log tab (design §2a: insert a toggle step, never weaken an assertion). The filter pills only
// render on the Log tab (Harvests.jsx FilterControls is view-gated), which is what moved these.
const toLog = () => fireEvent.click(screen.getByRole('radio', { name: 'Log' }))
const TOMATO_CROP = { crop_type_slug: 'tomato', crop_name: 'Tomato', units: [{ unit: 'count', unit_key: 'count', total: 3, count: 1 }], unquantified: 0, varieties: [] }

describe('Harvests — PROJHIDE', () => {
  it('hides the Project filter pill and keeps the Crop filter', async () => {
    render(<Harvests />)
    toLog()
    await waitFor(() => expect(screen.getByRole('button', { name: /filter by crop/i })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /filter by project/i })).toBeNull()
  })

  it('labels the filter group without "project"', async () => {
    render(<Harvests />)
    toLog()
    await waitFor(() => expect(screen.getByRole('group', { name: 'Filter by crop' })).toBeTruthy())
    expect(screen.queryByRole('group', { name: 'Filter by crop or project' })).toBeNull()
  })

  it('an unassigned (plantless) harvest is not a bare-project link', async () => {
    fetchSpy.mockResolvedValue({
      entries: [{
        event_id: 'e9', day_key: '2026-07-20', event_date: '2026-07-20T12:00:00Z',
        plant_id: null, project_id: 'pr9', crop_name: 'Tomato', variety_name: null, planting_name: null,
        quantity: 3, unit: 'count', quality_rating: null, harvest_log_id: 'h9', photos: [],
      }],
      aggregates: { crops: [], other: [] },
      cursor: null,
    })
    render(<Harvests />)
    toLog()
    await waitFor(() => expect(screen.getByText('Tomato')).toBeTruthy())
    // Card is a plain <div>, not an <a> into the hidden project page.
    expect(screen.getByText('Tomato').closest('a')).toBeNull()
  })

  // ── V4-HARVDEFAULT-001 arrival pins, duplicated in the FLAG-ON arm (design §2a / §6-S4) ─────────
  // Harvests.test.jsx mocks PROJECTS_HIDDEN:false; prod runs flag-ON, so the arrival default gets
  // pinned in BOTH arms. Same both-halves shape: a Totals-only element PRESENT and a Log-only element
  // ABSENT — or a blank page would pass. Mutation: revert the view init to unconditional 'log' → the
  // bare pin fails; init 'totals' under ?crop= → the ?crop= pin fails.
  it('a BARE arrival lands on Totals (flag-ON arm)', async () => {
    fetchSpy.mockResolvedValue({
      entries: [{ event_id: 'e1', day_key: '2026-07-20', event_date: '2026-07-20T12:00:00Z', plant_id: 'p1', project_id: 'pr1', crop_type_slug: 'tomato', crop_name: 'Tomato', variety_name: 'Sungold', quantity: 3, unit: 'count', quality_rating: null, harvest_log_id: 'h1', photos: [] }],
      aggregates: { crops: [TOMATO_CROP], other: [] },
      cursor: null,
    })
    render(<Harvests />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Tomato/ })).toBeTruthy()) // Totals crop row
    expect(screen.queryByText('Sungold')).toBeNull() // Log-only entry text absent
    expect(screen.queryByRole('button', { name: /filter by crop/i })).toBeNull() // Log-only control absent
    expect(screen.getByRole('radio', { name: 'Totals' }).getAttribute('aria-checked')).toBe('true')
  })

  it('a ?crop= arrival lands on the Log with the crop pill (flag-ON arm)', async () => {
    searchParamsRef.current = new URLSearchParams('crop=tomato')
    fetchSpy.mockImplementation((url) => {
      const u = String(url)
      if (u === '/api/projects') return Promise.resolve([])
      if (u.includes('include=aggregates') && !u.includes('entries')) {
        return Promise.resolve({ aggregates: { crop_list: [{ crop_type_slug: 'tomato', display_name: 'Tomato' }], crops: [], other: [], first_pick: [] } })
      }
      return Promise.resolve({
        entries: [{ event_id: 'e1', day_key: '2026-07-20', event_date: '2026-07-20T12:00:00Z', plant_id: 'p1', project_id: 'pr1', crop_type_slug: 'tomato', crop_name: 'Tomato', variety_name: 'Sungold', quantity: 3, unit: 'count', quality_rating: null, harvest_log_id: 'h1', photos: [] }],
        aggregates: { crops: [TOMATO_CROP], other: [] },
        cursor: null,
      })
    })
    render(<Harvests />)
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy()) // Log entry visible
    expect(screen.getByRole('radio', { name: 'Log' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('button', { name: /clear crop filter/i })).toBeTruthy() // the dismissible pill
  })
})
