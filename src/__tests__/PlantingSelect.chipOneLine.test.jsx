// BUG-FRAMEPADOCCLUDE-001 — the selected-planting chip is ONE LINE.
//
// READ THIS BEFORE ADDING A HEIGHT ASSERTION HERE. What actually went wrong is measured in pixels
// and jsdom cannot see any of it: getBoundingClientRect() returns zeros, so "the chip is 44px tall"
// and "the chip is three lines tall" are the same run here. The pixels are gated by
// scripts/layout-gate/save-band-clearance.mjs in real Chrome at a true 390x500.
//
// WHAT THIS FILE PINS INSTEAD is the four style declarations that make the one-line cap possible,
// because each of them is individually deletable by someone tidying up, and deleting ANY of them
// silently restores the bug:
//   · whiteSpace: nowrap        — without it the label wraps, which IS the defect
//   · overflow + textOverflow   — without them nowrap overflows the box instead of ellipsising
//   · minWidth: 0 on the chip   — an inline-flex box is min-width:auto, so it refuses to shrink
//                                 below its content and the ellipsis can never engage
// The last one is the subtle one and the reason this file exists rather than a comment: with the
// first three present and `minWidth: 0` missing, the chip still renders one line in a WIDE column
// and still wraps in a narrow one — so every other test in the repo, and a casual look at the app,
// would show a fixed chip while the weigh-in frame stayed broken.
//
// THE CONSEQUENCE, for anyone weighing whether this is worth a file: in the weigh-in frame track 1
// is `auto` and track 2 is the `1fr` that pays for it. A two-line chip took 41px out of the keypad's
// track (chooser 62 -> 103px on pick, track 2 347 -> 296 against 345px of content), which pushed the
// weight pad's bottom row 34px BELOW track 3's top edge and to -29px of Save. A low press on the
// bottom row then COMMITTED the harvest instead of typing a digit. It shipped in v4.51.0 and was
// live in prod.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }), apiFetch: (...a) => fetchSpy(...a) }))

import PlantingSelect from '../components/forms/PlantingSelect.jsx'

const PLANTS = [
  { id: 'pl-1', name: 'Lemon Thyme (Golden Variegated) — Bag Area row 3', project_id: 'p1', project_name: 'Herbs', variety_ref: { name: 'Lemon Thyme' } },
]

beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation(() => Promise.resolve(PLANTS))
})

async function renderSelected() {
  const out = await act(async () =>
    render(<PlantingSelect plants={PLANTS} value="pl-1" onChange={() => {}} data-testid="evtnew-planting" />)
  )
  await act(async () => { await Promise.resolve() })
  return out
}

describe('PlantingSelect — the selected chip cannot grow to a second line', () => {
  it('renders the chip at all, or every assertion below is vacuous', async () => {
    await renderSelected()
    expect(screen.getByTestId('evtnew-planting-chip')).not.toBeNull()
  })

  it('the label is nowrap + ellipsised, so a long planting name cannot wrap', async () => {
    await renderSelected()
    const chip = screen.getByTestId('evtnew-planting-chip')
    // The label span is the chip's first element child — the one carrying the planting name.
    const label = chip.querySelector('span')
    expect(label).not.toBeNull()
    expect(label.textContent).toContain('Lemon Thyme')
    expect(label.style.whiteSpace).toBe('nowrap')
    expect(label.style.overflow).toBe('hidden')
    expect(label.style.textOverflow).toBe('ellipsis')
  })

  it('the chip declares minWidth 0 — without it the ellipsis can never engage', async () => {
    await renderSelected()
    // Asserted separately from the label rules above, deliberately: this is the one that looks
    // redundant in a wide container and is the only one that matters in a narrow one.
    // '0', not '0px': React serialises a unitless 0 verbatim for min-width.
    expect(screen.getByTestId('evtnew-planting-chip').style.minWidth).toBe('0')
  })

  it('the full name stays reachable rather than being lost to the ellipsis', async () => {
    await renderSelected()
    const label = screen.getByTestId('evtnew-planting-chip').querySelector('span')
    expect(label.getAttribute('title')).toContain('Lemon Thyme')
  })
})
