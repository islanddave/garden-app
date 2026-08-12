// V4-PLANTINGUI-001 — CropCard: maturity band + cultivar attrs (projected chips inert w/o tags API).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
// V4-RIPENESSCUES-001: CropCard lazy-loads the colour-window resolver in an effect — stub it to
// the sync no-window resolver so nothing async mutates state mid-test (no act() churn; absence
// assertions race-free). Window rendering is covered in CropCard.window*.test.jsx.
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

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

// ── V4-RIPECUE-001 — researched ripeness cues on the card ─────────────────────────────────────
// The crucible killed the maturity-window section (11.8% calibration) and put the cues here
// instead, for reach: 100% of plantings vs 6%. These tests pin the two behaviours that make that
// trade honest — a sourced cue reaches the card even on a bare record, and an unsourced crop
// renders NOTHING rather than a guess.
describe('CropCard — ripeness cues (V4-RIPECUE-001)', () => {
  it('renders the crop-level mechanic for a sourced crop', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'tomato', name: 'Big Boy' } }} />)
    expect(screen.getByText(/When it.s ripe/i)).toBeTruthy()
    expect(screen.getByText(/90% of its ripe colour/i)).toBeTruthy()
  })

  it('leads with the cultivar target-state when one exists, and keeps the mechanic under it', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'pepper', name: 'Pick-N-Pop Yellow' } }} />)
    expect(screen.getByText(/bright canary yellow/i)).toBeTruthy()
    expect(screen.getByText(/full size while firm/i)).toBeTruthy()
  })

  it('renders NOTHING for a crop with no sourced cue — a blank is the correct outcome', () => {
    const { container } = render(
      <CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'fittonia', name: 'Nerve Plant' } }} />,
    )
    // No cue, no maturity, no chips, no attrs -> the whole card stays away.
    expect(container.firstChild).toBeNull()
  })

  it('a sourced cue alone is enough to render the card on an otherwise bare cultivar record', () => {
    // Without this the cue would be silently dropped from exactly the sparsest records.
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'pepper', name: 'No Such Cultivar' } }} />)
    expect(screen.getByText(/When it.s ripe/i)).toBeTruthy()
  })

  it('attributes the cue to a checkable source — the verifiability half of the downgrade path', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'tomato', name: 'Big Boy' } }} />)
    const link = screen.getByRole('link', { name: /Extension/i })
    expect(link.getAttribute('href')).toMatch(/^https:\/\//)
    expect(link.getAttribute('rel')).toContain('noopener')
  })
})

// Batch-2 crop mechanics + the low-confidence caveat channel.
describe('CropCard — crop-mechanic breadth and derived-cue honesty (V4-RIPECUE-001)', () => {
  it('renders the crop mechanic for a non-pepper/tomato crop', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'garlic', name: 'Music' } }} />)
    expect(screen.getByText(/lower leaves have browned/i)).toBeTruthy()
  })

  it('summer squash gets the pierces-easily half, not the winter-squash half', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'squash', name: 'Dark Green Zucchini' } }} />)
    expect(screen.getByText(/should pierce easily/i)).toBeTruthy()
    expect(screen.queryByText(/cured for storage/i)).toBeNull()
  })

  it('shows the caveat on the derived wineberry cue, so it cannot pass as a quoted instruction', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'wineberry', name: 'Wild Wineberry' } }} />)
    expect(screen.getByText(/bristly calyx/i)).toBeTruthy()
    expect(screen.getByText(/neither source gives an actual harvest instruction/i)).toBeTruthy()
  })

  it('a high-confidence cue renders no caveat line', () => {
    render(<CropCard planting={{ id: 'p', variety_ref: { crop_type_slug: 'broccoli', name: 'Calabrese' } }} />)
    expect(screen.queryByText(/Derived from/i)).toBeNull()
  })
})
