// PlantingSelectCropRank.test.jsx — V4-CROPLISTORDER-001 (BD-010), spec §5 tests 14-16.
//
// The rank REFRESH contract: the ledger is read once per picker-OPEN (rankNonce), mirroring
// EventNew's logone.lastPlant read-at-open — never on mount, never mid-open, and never on
// resetNonce. The stakes are spatial memory: a chip row that reshuffles under the user's thumb
// (mid-open) or resorts between burst saves (resetNonce) trades a stable scan target for a
// marginally fresher order, the exact trade the consult rejected.
//
// Ledger writes here use the REAL module against real "today" — the component reads with its
// own new Date(), so fixture days are expressed relative to now (a today-mark is in ANY 60d
// window; no midnight flake because only day-0 keys are used).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: vi.fn(() => Promise.resolve([])), getToken: vi.fn() }),
}))

import PlantingSelect, { CROP_CHIPS_AUTO } from '../components/forms/PlantingSelect.jsx'
import { recordCropLog } from '../lib/cropLogLedger.js'
import { etDay } from '../lib/harvestSummary.js'

const p = (id, name, slug) => ({
  id, name, quantity: 1, project_name: 'Beds',
  variety_id: slug ? `v-${slug}` : null,
  variety_ref: slug ? { id: `v-${slug}`, name: `${name} type`, crop_type_slug: slug } : null,
  sown_at: null, succession_order: null,
})

// tomato 4 > pepper 3 (pins) > squash 2 > kale 1, lettuce 1. Cold tail (label-alpha):
// Kale, Lettuce, Squash. A ranked squash moves to the recents band: Squash, Kale, Lettuce.
const PLANTS = [
  p('pl-t1', 'Sungold', 'tomato'), p('pl-t2', 'Cherokee', 'tomato'),
  p('pl-t3', 'Roma', 'tomato'), p('pl-t4', 'Brandywine', 'tomato'),
  p('pl-p1', 'Jalapeño', 'pepper'), p('pl-p2', 'Anaheim', 'pepper'), p('pl-p3', 'Shishito', 'pepper'),
  p('pl-s1', 'Zucchini', 'squash'), p('pl-s2', 'Delicata', 'squash'),
  p('pl-k1', 'Lacinato', 'kale'), p('pl-l1', 'Buttercrunch', 'lettuce'),
]
const TODAY = etDay(new Date())
const CROP_LABELS = ['Tomato', 'Pepper', 'Squash', 'Kale', 'Lettuce']

const chip = name => screen.getByRole('button', { name })
// Crop-chip labels in DOM order (More/Less/Clear excluded) — the observable band order.
const chipOrder = () =>
  [...screen.getByTestId('ps-crop-chips').querySelectorAll('button')]
    .map(b => b.textContent)
    .filter(t => CROP_LABELS.includes(t))

beforeEach(() => { localStorage.clear() })

describe('V4-CROPLISTORDER-001 — rank refresh contract', () => {
  // Test 14. Read at OPEN, not mount: a ledger write that lands between mount and the first
  // open must be visible on that open. (Implementation-wise: rankNonce 0 = never opened = no
  // read at all; the first open performs the first read.)
  it('reads the ledger at picker-open, not at mount', () => {
    render(<PlantingSelect plants={PLANTS} value="" onChange={() => {}} cropChips={CROP_CHIPS_AUTO} />)
    recordCropLog('squash', TODAY)                 // AFTER mount, BEFORE open
    fireEvent.focus(screen.getByRole('combobox'))
    fireEvent.click(chip('More ▾'))
    expect(chipOrder()).toEqual(['Tomato', 'Pepper', 'Squash', 'Kale', 'Lettuce'])
  })

  // Test 15. Frozen while open: a mid-open write must NOT reshuffle the row the user is
  // scanning; the next OPEN picks it up.
  it('freezes the order while open and re-ranks on the next open', () => {
    render(<PlantingSelect plants={PLANTS} value="" onChange={() => {}} cropChips={CROP_CHIPS_AUTO} />)
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.click(chip('More ▾'))
    expect(chipOrder()).toEqual(['Tomato', 'Pepper', 'Kale', 'Lettuce', 'Squash'])   // cold
    recordCropLog('squash', TODAY)                 // lands while the picker is OPEN
    fireEvent.change(input, { target: { value: 'z' } })                              // re-render
    expect(chipOrder()).toEqual(['Tomato', 'Pepper', 'Kale', 'Lettuce', 'Squash'])   // frozen
    fireEvent.keyDown(input, { key: 'Escape' })    // close…
    fireEvent.focus(input)                         // …reopen → rankNonce bumps → fresh read
    fireEvent.click(chip('More ▾'))
    expect(chipOrder()).toEqual(['Tomato', 'Pepper', 'Squash', 'Kale', 'Lettuce'])
  })

  // Test 16. Survives resetNonce (mirrors PlantingSelectCropChips.test.jsx:239): resetForNext
  // clears `touched`, not the rank — a six-tomato burst keeps one stable chip order throughout,
  // exactly like chipSelection survives.
  it('keeps the open-time order across the host reset after a save (resetNonce)', () => {
    const { rerender } = render(
      <PlantingSelect plants={PLANTS} value="" onChange={() => {}} cropChips={CROP_CHIPS_AUTO} resetNonce={0} />,
    )
    fireEvent.focus(screen.getByRole('combobox'))
    fireEvent.click(chip('More ▾'))
    expect(chipOrder()).toEqual(['Tomato', 'Pepper', 'Kale', 'Lettuce', 'Squash'])   // cold
    recordCropLog('squash', TODAY)                 // the in-burst save's ledger write
    rerender(
      <PlantingSelect plants={PLANTS} value="" onChange={() => {}} cropChips={CROP_CHIPS_AUTO} resetNonce={1} />,
    )
    fireEvent.focus(screen.getByRole('combobox'))
    expect(chipOrder()).toEqual(['Tomato', 'Pepper', 'Kale', 'Lettuce', 'Squash'])   // unchanged
  })
})
