// V4-PLANTINGMETA-001 (BD-029) — the app-added date in the planting page's harvest-window area.
//
// WHY. 69 of 255 live plantings carry NO sown_at, transplanted_at or planted_out_at. Sugar Rush
// Peach is the named case (all three NULL on prod, created_at 2026-05-31): the maturity band renders
// the set-at-transplant prompt and no date at all, so nothing on the page says the plant has been
// here since spring. garden_node.created_at is a within-days proxy for that — a planting is added
// when it goes in — and it is the only date the record has.
//
// The two things this guard has to pin are the two ways the change could go wrong:
//   (a) DISPLAY ONLY. computeMaturity deliberately refuses to project a window off a guessed anchor
//       (design D3). The line must be labelled as the app-added date and must not restate itself as
//       "sown"/"transplanted" or move any computed date.
//   (b) CONDITIONAL. It renders only where there is no real anchor, and it does NOT earn the card —
//       created_at is non-null on every row, so a card gated on it would appear on every sparse
//       planting in the garden. Both directions are asserted; either mutation goes red.
//
// Harness mirrors CropCard.test.jsx (lazy window resolver stubbed sync). No jest-dom (L-182).

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import CropCard from '../components/planting/CropCard.jsx'

// The live prod shape, column for column: every lifecycle date NULL, a from-transplant crop with a
// catalogue DTM, so computeMaturity takes the awaitingTransplant branch and the band shows a prompt.
const SUGAR_RUSH_PEACH = {
  id: 'p1', name: 'Sugar Rush Peach',
  sown_at: null, transplanted_at: null, planted_out_at: null,
  created_at: '2026-05-31T05:24:25.844174+00:00',
  variety_ref: {
    name: 'Sugar Rush Peach', species: 'Capsicum baccatum',
    days_to_maturity_min: 90, days_to_maturity_max: 120, dtm_basis: 'from-transplant',
  },
}

beforeEach(() => { apiFetchSpy.mockReset(); apiFetchSpy.mockResolvedValue(null) })

describe('CropCard — app-added date when the record has no lifecycle anchor', () => {
  it('surfaces the added date on the planting that has no other date', () => {
    render(<CropCard planting={SUGAR_RUSH_PEACH} />)
    expect(screen.getByTestId('planting-added-date').textContent).toBe('Added to the app May 31, 2026')
  })

  // (a) display-only: it names itself as the app-added date and never borrows the growth vocabulary
  // the real anchors use, so it cannot be read as "this is when it was planted".
  it('does not present itself as a growth anchor', () => {
    render(<CropCard planting={SUGAR_RUSH_PEACH} />)
    const text = screen.getByTestId('planting-added-date').textContent
    expect(text).toContain('Added to the app')
    expect(text).not.toContain('sown')
    expect(text).not.toContain('transplanted')
    // The suppressed-window affordance is UNCHANGED — the added date sits beside the
    // add-a-transplant-date prompt, never replaces it and never satisfies it.
    expect(screen.getByRole('button', { name: /Add a transplant date/ })).toBeTruthy()
    // And no age band was invented from it.
    expect(screen.queryByText(/^Day \d+/)).toBeNull()
  })

  // (b) conditional, direction 1: a planting with a real anchor gains nothing. Differs from the
  // fixture above ONLY in transplanted_at, so a "render it always" mutation fails right here.
  it('adds nothing to a planting that has a real lifecycle date', () => {
    render(<CropCard planting={{ ...SUGAR_RUSH_PEACH, transplanted_at: '2026-05-20' }} />)
    expect(screen.queryByTestId('planting-added-date')).toBeNull()
    expect(screen.getByText(/^Day \d+/)).toBeTruthy()
  })

  // A sown-only planting is the other real anchor shape and takes a different branch of
  // computeMaturity, so it gets its own case rather than riding on the transplant one.
  it('adds nothing to a sown-only planting', () => {
    render(<CropCard planting={{ ...SUGAR_RUSH_PEACH, sown_at: '2026-04-02' }} />)
    expect(screen.queryByTestId('planting-added-date')).toBeNull()
  })

  // (b) conditional, direction 2: the card's own emptiness rule is untouched. created_at is non-null
  // on EVERY row, so if it ever reaches the hasMaturity/early-return test this renders a card on all
  // 255 live plantings. A bare record must still render nothing at all.
  it('does not earn the card on its own', () => {
    const { container } = render(
      <CropCard planting={{ id: 'p2', variety_ref: null, created_at: '2026-05-31T05:24:25.844174+00:00' }} />,
    )
    expect(container.firstChild).toBeNull()
  })

  // A record with no created_at (an older cached payload, or a shape the API stops returning) must
  // degrade to the pre-change render, not to "Added to the app undefined".
  it('renders nothing when created_at is absent', () => {
    const { created_at, ...noCreated } = SUGAR_RUSH_PEACH
    render(<CropCard planting={noCreated} />)
    expect(screen.queryByTestId('planting-added-date')).toBeNull()
    expect(screen.getByRole('button', { name: /Add a transplant date/ })).toBeTruthy()
  })
})
