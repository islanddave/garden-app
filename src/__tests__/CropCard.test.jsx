// V4-PLANTINGUI-001 — CropCard: maturity band + cultivar attrs (projected chips inert w/o tags API).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))

import CropCard from '../components/planting/CropCard.jsx'

beforeEach(() => { apiFetchSpy.mockReset(); apiFetchSpy.mockResolvedValue(null) })

describe('CropCard', () => {
  it('renders nothing when there is no maturity, no chips, and no attrs', () => {
    const { container } = render(<CropCard planting={{ id: 'p', variety_ref: null }} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the age band and a harvest window when dates + DTM exist', () => {
    const planting = {
      id: 'p', sown_at: '2026-03-01', transplanted_at: '2026-04-01',
      variety_ref: { days_to_maturity_min: 60, days_to_maturity_max: 75, sun_requirements: 'Full sun' },
    }
    render(<CropCard planting={planting} />)
    expect(screen.getByText(/^Day \d+/)).toBeTruthy()
    expect(screen.getByText('Full sun')).toBeTruthy()
    expect(screen.getByText('Sun')).toBeTruthy()
    expect(screen.getByText('60–75 days')).toBeTruthy()
  })

  // V4-MATURITYBASIS-001 Slice A
  it('names the basis when the window was anchored on the transplant date', () => {
    const planting = {
      id: 'p', sown_at: '2026-04-20', transplanted_at: '2026-06-23',
      variety_ref: { days_to_maturity_min: 70, days_to_maturity_max: 80, dtm_basis: 'from-transplant' },
    }
    render(<CropCard planting={planting} />)
    expect(screen.getByText('(from transplant)')).toBeTruthy()
  })

  it('does not name a basis when the crop type is uncurated (NULL)', () => {
    const planting = {
      id: 'p', sown_at: '2026-04-20', transplanted_at: '2026-06-23',
      variety_ref: { days_to_maturity_min: 70, days_to_maturity_max: 80, dtm_basis: null },
    }
    render(<CropCard planting={planting} />)
    expect(screen.queryByText(/\(from /)).toBeNull()
  })

  // D3 + the "add transplant date" affordance: the suppressed window slot is no longer a dead
  // static label — it carries the tappable prompt that fills the missing date.
  it('D3: the suppressed window slot renders the add-transplant-date prompt', () => {
    const planting = {
      id: 'p', sown_at: '2026-04-20',
      variety_ref: { days_to_maturity_min: 70, days_to_maturity_max: 80, dtm_basis: 'from-transplant' },
    }
    render(<CropCard planting={planting} />)
    expect(screen.getByTestId('add-transplant-date')).toBeTruthy()
    expect(screen.getByText('add transplant date')).toBeTruthy()
    // No fabricated date, and no basis parenthetical on a window that does not exist.
    expect(screen.queryByText(/Est\. harvest [A-Z]/)).toBeNull()
    expect(screen.queryByText(/\(from /)).toBeNull()
  })

  it('does NOT render the prompt once a transplant date exists', () => {
    const planting = {
      id: 'p', sown_at: '2026-04-20', transplanted_at: '2026-06-23',
      variety_ref: { days_to_maturity_min: 70, days_to_maturity_max: 80, dtm_basis: 'from-transplant' },
    }
    render(<CropCard planting={planting} />)
    expect(screen.queryByTestId('add-transplant-date')).toBeNull()
  })

  it('does NOT render the prompt for a from-sow crop missing a transplant date', () => {
    const planting = {
      id: 'p', sown_at: '2026-04-20',
      variety_ref: { days_to_maturity_min: 70, days_to_maturity_max: 80, dtm_basis: 'from-sow' },
    }
    render(<CropCard planting={planting} />)
    expect(screen.queryByTestId('add-transplant-date')).toBeNull()
  })
})
