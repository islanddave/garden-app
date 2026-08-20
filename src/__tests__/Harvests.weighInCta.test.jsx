// V4-WEIGHINCTA-001 (CHECKIN PLAN B5, Dave GO 2026-08-18) — the weigh-in session is the PRIMARY CTA
// on the Harvests root, promoted from the secondary outline chip V4-HARVSESSION-001 shipped.
//
// The link itself has existed since 2026-08-14 (69aaca7) with ZERO test coverage, which is how it sat
// as an outline chip for six days while B5 asked for a primary one. So these assert the PROMOTION,
// not the presence: filled-vs-outline is the entire delta, and a test that only found the testid
// would have passed identically before and after this change.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { fetchSpy, searchParamsRef } = vi.hoisted(() => ({ fetchSpy: vi.fn(), searchParamsRef: { current: new URLSearchParams() } }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useSearchParams: () => [searchParamsRef.current, () => {}],
}))

import Harvests from '../pages/Harvests.jsx'
import { P } from '../lib/constants.js'

beforeEach(() => {
  fetchSpy.mockReset()
  searchParamsRef.current = new URLSearchParams()
  fetchSpy.mockResolvedValue({ entries: [], aggregates: { crops: [], other: [], first_pick: [], crop_list: [] }, cursor: null })
})

const cta = () => screen.getByTestId('weigh-in-session-link')

describe('Harvests root — weigh-in session CTA (V4-WEIGHINCTA-001 / B5)', () => {
  it('is a FILLED primary: green ground, white ink — not the outline chip it replaced', () => {
    render(<Harvests />)
    const s = cta().style
    // The reverted-chip shape was backgroundColor:P.white + color:P.green. Both halves pinned so a
    // half-revert (ground filled, ink left green) fails too rather than reading as "still primary".
    expect(s.backgroundColor).toBe('rgb(45, 106, 79)') // P.green #2d6a4f
    expect(s.color).toBe('rgb(255, 255, 255)') // P.white
    expect(P.green).toBe('#2d6a4f')
    expect(P.white).toBe('#ffffff')
  })

  it('spans the column and clears the 48px tap floor — the chip was 9px padding and inline width', () => {
    render(<Harvests />)
    const s = cta().style
    expect(s.display).toBe('flex') // was inline-flex: an inline chip is only as wide as its label
    expect(s.minHeight).toBe('48px')
    expect(s.justifyContent).toBe('center')
  })

  // 390px (Dave's Chrome/Android width) horizontal-overflow guard. jsdom does no layout, so this
  // does NOT measure pixels — it pins the two properties that are the only ways a block-level flex
  // child of a `max-width:700; padding:0 16px` column can push past the viewport: an explicit width
  // and an unbreakable label. Absent both, the CTA is width-constrained by its parent at any
  // viewport. Stated this way rather than as a passing pixel claim nobody re-measures.
  it('cannot force horizontal page scroll: no explicit width, no nowrap label', () => {
    render(<Harvests />)
    const s = cta().style
    expect(s.width).toBe('')
    expect(s.minWidth).toBe('')
    expect(s.whiteSpace).toBe('')
  })

  it('targets ?session=harvest — ?event_type=harvest would open the plain form, no session ledger', () => {
    render(<Harvests />)
    const href = cta().getAttribute('href')
    expect(href).toBe('/log?session=harvest')
    expect(new URLSearchParams(href.split('?')[1]).get('session')).toBe('harvest')
  })

  it('reads "Weigh-in session" and sits ABOVE the Log/Totals toggle, on the default (Totals) arrival', () => {
    const { container } = render(<Harvests />)
    expect(cta().textContent).toContain('Weigh-in session')
    // V4-HARVDEFAULT-001 lands a bare arrival on Totals. The CTA must not be behind the Log tab, and
    // must precede the view toggle in document order — "primary" is a position claim as much as a
    // style one. compareDocumentPosition FOLLOWING === the toggle comes after the CTA.
    const toggle = container.querySelector('[role="radiogroup"]')
    expect(toggle).toBeTruthy()
    expect(cta().compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
