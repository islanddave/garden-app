// V4-HARVWEIGHTSURF-001 — CropWeightLine, now that it is shared between the Harvests Totals tab and
// the Garden's crop groups rather than living inside one page. Pinned directly because "these two
// surfaces say the same thing" is only true while this component's branches hold: the ≈ that marks an
// inferred total, the qualifier that stops a bare number claiming it was all weighed, the ratchet copy
// for a crop with nothing weighable, and the ABSENT-weight case (an older harvests Lambda), which must
// render nothing rather than zero.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import CropWeightLine from '../components/CropWeightLine.jsx'
import { NO_WEIGHT_COPY } from '../lib/harvestWeight.js'

const weight = (o = {}) => ({
  grams: 0, measured_grams: 0, estimated_grams: 0, measured: 0, estimated: 0, unweighed: 0, ...o,
})

describe('CropWeightLine', () => {
  // V4-HARVCROPTABLE-001 — the visible "3 weighed · 12 estimated" line is gone. The honesty it
  // carried has to survive somewhere or its removal was a regression, so this asserts BOTH: the
  // count line is absent, and the ≈ plus the full aria-label sentence still mark the total as
  // partly modelled. Absence alone would pass against a component that dropped everything.
  it('marks a total containing estimates with ≈ and an explicit label, without a count line', () => {
    render(<CropWeightLine weight={weight({ grams: 2400, measured_grams: 400, estimated_grams: 2000, measured: 3, estimated: 12 })} />)
    expect(screen.getByTestId('crop-weight').textContent).toBe('≈ 2.4 kg')
    expect(screen.getByTestId('crop-weight').getAttribute('aria-label')).toBe('Estimated total harvest weight: 2.4 kg')
    expect(screen.queryByTestId('crop-weight-basis')).toBeNull()
    expect(screen.queryByText(/weighed/)).toBeNull()
  })

  it('renders inline on request without changing what it says', () => {
    render(<CropWeightLine inline weight={weight({ grams: 2400, measured_grams: 400, estimated_grams: 2000, measured: 3, estimated: 12 })} />)
    const el = screen.getByTestId('crop-weight')
    expect(el.textContent).toBe('≈ 2.4 kg')
    expect(el.getAttribute('aria-label')).toBe('Estimated total harvest weight: 2.4 kg')
    expect(el.style.display).not.toBe('block')
  })

  it('leaves a fully measured total unmarked — the ratchet has to look like it works', () => {
    render(<CropWeightLine weight={weight({ grams: 900, measured_grams: 900, measured: 2 })} />)
    expect(screen.getByTestId('crop-weight').textContent).toBe('900 g')
    expect(screen.getByTestId('crop-weight').getAttribute('aria-label')).toBe('Total harvest weight: 900 g')
  })

  // Was: "counts the unweighed picks alongside the number rather than dropping them." That count is
  // no longer rendered anywhere on this component. Note what this costs, deliberately accepted:
  // with unweighed picks and every WEIGHED pick measured, the total carries no ≈ and the surface no
  // longer says 5 picks contributed nothing to it. The number is still true for what it covers.
  // Recorded here rather than in a comment nobody reads, because if that silence ever bites, this
  // is the test that would have caught it.
  it('does not render a count line for unweighed picks, and does not fake an ≈ for them', () => {
    render(<CropWeightLine weight={weight({ grams: 900, measured_grams: 900, measured: 2, unweighed: 5 })} />)
    expect(screen.queryByTestId('crop-weight-basis')).toBeNull()
    expect(screen.getByTestId('crop-weight').textContent).toBe('900 g')
  })

  it('says "no weight yet" — never 0 g — for a crop with picks but nothing weighable', () => {
    render(<CropWeightLine weight={weight({ unweighed: 4 })} />)
    const none = screen.getByTestId('crop-weight-none')
    expect(none.textContent).toBe('no weight yet')
    expect(none.getAttribute('title')).toBe(NO_WEIGHT_COPY)
    expect(screen.queryByTestId('crop-weight')).toBeNull()
  })

  it('renders nothing at all when there is neither a weight nor an unweighed pick to report', () => {
    const { container } = render(<CropWeightLine weight={weight()} />)
    expect(container.innerHTML).toBe('')
  })

  // An older harvests Lambda omits `weight` entirely. That response cannot tell "no weight recorded"
  // apart from "this API doesn't compute weight", and only the first is safe to state.
  it('renders nothing when the wire carries no weight object', () => {
    const { container } = render(<CropWeightLine weight={undefined} />)
    expect(container.innerHTML).toBe('')
  })
})
