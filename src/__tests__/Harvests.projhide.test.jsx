// V4-PROJHIDE-001 — Harvests with PROJECTS_HIDDEN mocked TRUE. Pins the flag-ON behaviors:
// (1) the Project filter pill + its picker sheet are gone (crop is the only axis), and
// (2) an unassigned (plantless) harvest is NOT a bare-project link — the card is inert, never a
// link into the hidden /projects/:id page. Flag-OFF behavior (both pills, project deep-links) is
// covered by Harvests.test.jsx. importActual spread so other flags keep their values. No jest-dom.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

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

describe('Harvests — PROJHIDE', () => {
  it('hides the Project filter pill and keeps the Crop filter', async () => {
    render(<Harvests />)
    await waitFor(() => expect(screen.getByRole('button', { name: /filter by crop/i })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /filter by project/i })).toBeNull()
  })

  it('labels the filter group without "project"', async () => {
    render(<Harvests />)
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
    await waitFor(() => expect(screen.getByText('Tomato')).toBeTruthy())
    // Card is a plain <div>, not an <a> into the hidden project page.
    expect(screen.getByText('Tomato').closest('a')).toBeNull()
  })
})
