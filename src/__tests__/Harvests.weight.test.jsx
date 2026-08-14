// V4-HARVWEIGHTREAD-001 — the harvest weight on the Harvests log.
//
// Weight has been derived server-side for months and rendered in exactly one place: the EventDetail
// EDIT form. These pin the fan-out's contract at the surface Dave actually reads, and specifically
// the distinctions that a plausible implementation collapses:
//   * an estimate must be visibly an estimate, and carry WHY
//   * a measured weight must not be dressed as an estimate (or the ratchet never looks like it works)
//   * a row with no derivable weight must read as "not yet", not as zero and not as an error
//   * the native-unit amount stays the headline — grams are a second axis, not a replacement
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const { fetchSpy, searchParamsRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), searchParamsRef: { current: new URLSearchParams() },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useSearchParams: () => [searchParamsRef.current, () => {}],
}))

import Harvests from '../pages/Harvests.jsx'
import { ESTIMATE_SOURCE_COPY, ESTIMATE_SOURCE_SHORT, ESTIMATE_SOURCE_SHORT_FALLBACK, MEASURED_SHORT } from '../lib/harvestWeight.js'
import { formatEntry } from '../lib/harvestSummary.js'

beforeEach(() => { fetchSpy.mockReset(); searchParamsRef.current = new URLSearchParams() })

const BASE = {
  event_id: 'e1', day_key: '2026-07-20', event_date: '2026-07-20T12:00:00Z',
  plant_id: 'p1', project_id: 'pr1', crop_name: 'Tomato', variety_name: 'Sungold',
  quantity: 4, unit: 'count', quality_rating: 4, harvest_log_id: 'h1', photos: [],
}

// V4-HARVDEFAULT-001: a bare arrival now lands on TOTALS, and the weight chip is a LOG-row element —
// so every case toggles to the Log tab right after render (design §2a: insert a toggle step, never
// weaken an assertion). Folded into the shared helper because all 7 cases need it identically.
// NOTE: this suite is NOT in the design's §2a enumerated re-anchor set — it is the same class of
// bare-render Log-scoped suite and needs the same one-line edit. Flagged in the build report.
function renderWith(overrides) {
  fetchSpy.mockResolvedValue({
    entries: [{ ...BASE, ...overrides }],
    aggregates: { crops: [], other: [] },
    cursor: null,
  })
  const r = render(<Harvests />)
  fireEvent.click(screen.getByRole('radio', { name: 'Log' }))
  return r
}

describe('Harvests — weight chip', () => {
  it('marks an ESTIMATE with ≈ and carries the provenance sentence', async () => {
    renderWith({ weight_grams: 492, weight_estimated: true, weight_basis: 'cultivar' })
    const chip = await screen.findByTestId('harvest-weight')
    expect(chip.textContent).toBe('≈ 492 g')
    expect(chip.getAttribute('title')).toBe(ESTIMATE_SOURCE_COPY.cultivar)
    expect(chip.getAttribute('aria-label')).toMatch(/^Estimated weight: 492 g$/)
  })

  it('renders a MEASURED weight without the ≈, and does not call it an estimate', async () => {
    renderWith({ weight_grams: 337, weight_estimated: false, weight_basis: 'measured' })
    const chip = await screen.findByTestId('harvest-weight')
    expect(chip.textContent).toBe('337 g')
    expect(chip.textContent).not.toContain('≈')
    expect(chip.getAttribute('aria-label')).toMatch(/^Weighed: 337 g$/)
  })

  it('a sample-backed estimate says it came from YOUR weighings — the ratchet payoff', async () => {
    renderWith({ weight_grams: 150, weight_estimated: true, weight_basis: 'cultivar_sample' })
    const chip = await screen.findByTestId('harvest-weight')
    expect(chip.getAttribute('title')).toBe(ESTIMATE_SOURCE_COPY.cultivar_sample)
    expect(chip.getAttribute('title')).toMatch(/your own weighings/i)
  })

  it('an unknown/future weight_basis degrades to generic copy, never prints undefined', async () => {
    renderWith({ weight_grams: 200, weight_estimated: true, weight_basis: 'tier_9_from_the_future' })
    const chip = await screen.findByTestId('harvest-weight')
    expect(chip.getAttribute('title')).toBe('Currently estimated.')
    expect(chip.getAttribute('title')).not.toMatch(/undefined/)
  })

  it('a quantified row with NO derivable weight reads as "not yet", never 0 g', async () => {
    renderWith({ weight_grams: null, weight_estimated: null, weight_basis: null })
    const none = await screen.findByTestId('harvest-weight-none')
    expect(none.textContent).toBe('no weight yet')
    expect(screen.queryByTestId('harvest-weight')).toBeNull()
    expect(screen.queryByText(/0 g/)).toBeNull()
  })

  it('suppresses the no-weight chip on a row that has no amount either — no double negative', async () => {
    renderWith({ harvest_log_id: null, quantity: null, weight_grams: null })
    await screen.findByText(/no amount recorded/)
    expect(screen.queryByTestId('harvest-weight-none')).toBeNull()
    expect(screen.queryByTestId('harvest-weight')).toBeNull()
  })

  it('keeps the native-unit amount as the headline alongside the weight', async () => {
    renderWith({ weight_grams: 492, weight_estimated: true, weight_basis: 'cultivar' })
    const chip = await screen.findByTestId('harvest-weight')
    // The amount is whatever the shipped formatter produces — asserted against formatEntry itself
    // rather than a hand-copied string, so a change to the format is not silently "still passing".
    const amount = formatEntry({ quantity: 4, unit: 'count' }, 'Tomato')
    expect(screen.getByText(amount)).toBeTruthy()
    // Both axes on screen at once is the actual claim: grams are additive, not a replacement.
    expect(chip.textContent).toBe('≈ 492 g')
  })
})

// ── V4-HARVWEIGHTSURF-001 — the basis has to be VISIBLE, not hoverable ───────────────────────────
//
// The suite above pins title= and aria-label, and both were satisfied while the feature was, in
// practice, broken: `title` is a hover affordance, there is no hover on a touch screen, and this app
// is read on Chrome for Android. So the provenance behind ~63% of the numbers on this page reached
// Dave's screen reader and his desktop, and never his eyes.
//
// These assert the basis is in the DOM as rendered text — deliberately not via getAttribute, which
// is what let the gap ship. They are written against the exported vocabulary rather than hand-copied
// strings so a copy change cannot leave them "still passing" against wording nobody ships.
describe('Harvests — the weight basis renders as text, not as a tooltip', () => {
  it('shows WHERE a catalogue-backed estimate came from, on screen', async () => {
    renderWith({ weight_grams: 492, weight_estimated: true, weight_basis: 'cultivar' })
    const basis = await screen.findByTestId('harvest-weight-basis')
    expect(basis.textContent).toBe(ESTIMATE_SOURCE_SHORT.cultivar)
    // The claim is visibility, so assert it as page TEXT and not merely as an attribute.
    expect(screen.getByText(ESTIMATE_SOURCE_SHORT.cultivar)).toBeTruthy()
  })

  it('says a sample-backed estimate came from YOUR weighings — visibly, the ratchet payoff', async () => {
    renderWith({ weight_grams: 150, weight_estimated: true, weight_basis: 'cultivar_sample' })
    const basis = await screen.findByTestId('harvest-weight-basis')
    expect(basis.textContent).toBe(ESTIMATE_SOURCE_SHORT.cultivar_sample)
    expect(basis.textContent).toMatch(/your/i)
    // The distinction that matters most: Dave's own data must not read like a generic crop number.
    expect(basis.textContent).not.toBe(ESTIMATE_SOURCE_SHORT.crop_type)
  })

  it('names a crop-level estimate as a crop-level estimate', async () => {
    renderWith({ weight_grams: 300, weight_estimated: true, weight_basis: 'crop_type' })
    expect((await screen.findByTestId('harvest-weight-basis')).textContent).toBe(ESTIMATE_SOURCE_SHORT.crop_type)
  })

  it('labels a MEASURED weight "weighed" instead of relying on an absent ≈', async () => {
    renderWith({ weight_grams: 337, weight_estimated: false, weight_basis: 'measured' })
    const basis = await screen.findByTestId('harvest-weight-basis')
    expect(basis.textContent).toBe(MEASURED_SHORT)
    // …and the number itself is unchanged: the label is additive, not a rewrite of the value.
    expect((await screen.findByTestId('harvest-weight')).textContent).toBe('337 g')
  })

  it('degrades an unknown/future basis to generic wording on screen, never "undefined"', async () => {
    renderWith({ weight_grams: 200, weight_estimated: true, weight_basis: 'tier_9_from_the_future' })
    const basis = await screen.findByTestId('harvest-weight-basis')
    expect(basis.textContent).toBe(ESTIMATE_SOURCE_SHORT_FALLBACK)
    expect(basis.textContent).not.toMatch(/undefined/)
  })

  it('renders no basis chip on a row with no derivable weight — nothing to attribute', async () => {
    renderWith({ weight_grams: null, weight_estimated: null, weight_basis: null })
    await screen.findByTestId('harvest-weight-none')
    expect(screen.queryByTestId('harvest-weight-basis')).toBeNull()
  })

  // Reward UX: this is informational chrome on a surface opened deliberately. It must be ambient —
  // no button, no dialog, nothing with a dismiss. Pinned structurally so a later "make it tappable"
  // refactor fails here rather than in review.
  it('is ambient chrome — not a control, not a dialog, nothing to dismiss', async () => {
    renderWith({ weight_grams: 492, weight_estimated: true, weight_basis: 'cultivar' })
    const basis = await screen.findByTestId('harvest-weight-basis')
    expect(basis.tagName).toBe('SPAN')
    expect(basis.getAttribute('role')).toBeNull()
    expect(basis.closest('button')).toBeNull()
    expect(basis.closest('[role="dialog"]')).toBeNull()
    expect(basis.querySelector('button, a, input')).toBeNull()
  })

  // The 390px budget, as far as jsdom can carry it: jsdom does no layout, so what is falsifiable
  // here is that the LABEL is wrappable. A prior harvest-row change overflowed horizontally at
  // exactly this viewport because an unbreakable string set the row's min-content to 399px. The
  // NUMBER must still never wrap mid-value.
  it('lets the label wrap but never the number — the 390px min-content guard', async () => {
    renderWith({ weight_grams: 12500, weight_estimated: true, weight_basis: 'cultivar' })
    const chip = await screen.findByTestId('harvest-weight')
    const basis = await screen.findByTestId('harvest-weight-basis')
    expect(chip.style.whiteSpace).toBe('nowrap')
    expect(basis.style.whiteSpace).toBe('')
  })
})
