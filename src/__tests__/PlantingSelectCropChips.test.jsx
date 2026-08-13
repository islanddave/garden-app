// PlantingSelectCropChips.test.jsx — V4-CROPFILTER-001 (design harvest-logging-ux-design-V100
// -20260812 §1b, test list §6-S2).
//
// The picker is the required field on the app's highest-frequency form, and in August it lists
// ~275 live plantings. Crop chips are the fast narrowing mechanism; the thing that makes them
// DANGEROUS rather than merely useful is that chip state survives resetForNext (adjudicated — a
// six-tomato burst taps the chip once), so a filter can be active on a form the user did not just
// configure. Hence the two halves this file pins with equal weight: the filtering works, AND the
// filter is never invisible ("N hidden", the filtered-to-empty exit, no persistence past unmount).
//
// Chips are also OPT-IN: absent `cropChips`, every one of the other render sites must be
// byte-identical. That is pinned here as an absence assertion and, structurally, by the untouched
// PlantingSelect/PutUp suites.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: vi.fn(() => Promise.resolve([])), getToken: vi.fn() }),
}))

import PlantingSelect, { CROP_CHIPS_AUTO } from '../components/forms/PlantingSelect.jsx'

const p = (id, name, slug, extra = {}) => ({
  id, name, quantity: 1, project_name: 'Beds',
  variety_id: slug ? `v-${slug}` : null,
  variety_ref: slug ? { id: `v-${slug}`, name: `${name} type`, crop_type_slug: slug } : null,
  sown_at: null, succession_order: null, ...extra,
})

// 10 rows / 3 resolvable crops + one slug-less. Counts: tomato 4 > pepper 3 > squash 2, so the
// data-driven pins are tomato + pepper and squash lives behind More ▾. Deliberately mirrors the
// live shape: 273/276 plantings resolve a crop slug, a handful never will.
const PLANTS = [
  p('pl-t1', 'Sungold', 'tomato'), p('pl-t2', 'Cherokee', 'tomato'),
  p('pl-t3', 'Roma', 'tomato'), p('pl-t4', 'Brandywine', 'tomato'),
  p('pl-p1', 'Jalapeño', 'pepper'), p('pl-p2', 'Anaheim', 'pepper'), p('pl-p3', 'Shishito', 'pepper'),
  p('pl-s1', 'Zucchini', 'squash'), p('pl-s2', 'Delicata', 'squash'),
  p('pl-x1', 'Mystery start', null),
]

function open(props = {}) {
  const utils = render(
    <PlantingSelect plants={PLANTS} value="" onChange={() => {}} cropChips={CROP_CHIPS_AUTO} {...props} />,
  )
  fireEvent.focus(screen.getByRole('combobox'))
  return utils
}
const chip = name => screen.getByRole('button', { name })
const optionCount = () => screen.queryAllByRole('option').length

beforeEach(() => { window.localStorage?.clear?.() })

describe('V4-CROPFILTER-001 — data-driven pins and row eligibility', () => {
  it('pins the top two crop types by live-planting count and trays the rest', () => {
    open()
    expect(chip('Tomato')).toBeTruthy()
    expect(chip('Pepper')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Squash' })).toBeNull()
    fireEvent.click(chip('More ▾'))
    expect(chip('Squash')).toBeTruthy()
  })

  it('breaks pin ties toward pepper then tomato — the August distribution without freezing it', () => {
    // Three crops at three plantings each. Alphabetically 'apple' would win a naive sort; the
    // tie-break exists so a shoulder-season list with flat counts still pins what Dave harvests.
    const tied = [
      p('a1', 'A1', 'apple'), p('a2', 'A2', 'apple'), p('a3', 'A3', 'apple'),
      p('p1', 'P1', 'pepper'), p('p2', 'P2', 'pepper'), p('p3', 'P3', 'pepper'),
      p('t1', 'T1', 'tomato'), p('t2', 'T2', 'tomato'), p('t3', 'T3', 'tomato'),
    ]
    render(<PlantingSelect plants={tied} value="" onChange={() => {}} cropChips={CROP_CHIPS_AUTO} />)
    fireEvent.focus(screen.getByRole('combobox'))
    expect(chip('Pepper')).toBeTruthy()
    expect(chip('Tomato')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Apple' })).toBeNull()
  })

  it('hides an explicit pin that matches nothing — a dead-end tap is worse than no chip', () => {
    open({ cropChips: { pinned: ['pepper', 'kale'] } })
    expect(chip('Pepper')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kale' })).toBeNull()
  })

  it('suppresses the whole row when fewer than two crops discriminate', () => {
    const oneCrop = Array.from({ length: 9 }, (_, i) => p(`t${i}`, `T${i}`, 'tomato'))
    render(<PlantingSelect plants={oneCrop} value="" onChange={() => {}} cropChips={CROP_CHIPS_AUTO} />)
    fireEvent.focus(screen.getByRole('combobox'))
    expect(screen.queryByTestId('ps-crop-chips')).toBeNull()
    expect(optionCount()).toBe(9)
  })

  it('suppresses the row on a short list, where scanning beats filtering', () => {
    render(<PlantingSelect plants={PLANTS.slice(0, 7)} value="" onChange={() => {}} cropChips={CROP_CHIPS_AUTO} />)
    fireEvent.focus(screen.getByRole('combobox'))
    expect(screen.queryByTestId('ps-crop-chips')).toBeNull()
  })

  it('renders no chips at all without the opt-in prop (every legacy render site)', () => {
    render(<PlantingSelect plants={PLANTS} value="" onChange={() => {}} />)
    fireEvent.focus(screen.getByRole('combobox'))
    expect(screen.queryByTestId('ps-crop-chips')).toBeNull()
    expect(optionCount()).toBe(10)
  })

  it('hides chips when the consumer already pins scope (the PutUp contract)', () => {
    const { rerender } = render(
      <PlantingSelect plants={PLANTS} value="" onChange={() => {}} cropChips={CROP_CHIPS_AUTO} cropSlug="tomato" />,
    )
    fireEvent.focus(screen.getByRole('combobox'))
    expect(screen.queryByTestId('ps-crop-chips')).toBeNull()
    expect(optionCount()).toBe(4)
    rerender(<PlantingSelect plants={PLANTS} value="" onChange={() => {}} cropChips={CROP_CHIPS_AUTO} varietyId="v-pepper" />)
    expect(screen.queryByTestId('ps-crop-chips')).toBeNull()
    expect(optionCount()).toBe(3)
  })
})

describe('V4-CROPFILTER-001 — filtering semantics', () => {
  it('one chip narrows to that crop; a second ORs the two; clear restores the full list', () => {
    open()
    expect(optionCount()).toBe(10)
    fireEvent.click(chip('Pepper'))
    expect(optionCount()).toBe(3)
    fireEvent.click(chip('Tomato'))
    expect(optionCount()).toBe(7)          // OR, not AND — an AND of two crops is always empty
    fireEvent.click(chip('Clear'))
    expect(optionCount()).toBe(10)
  })

  it('ANDs the chip filter with the typeahead', () => {
    open()
    fireEvent.click(chip('Tomato'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'roma' } })
    expect(optionCount()).toBe(1)
    // Same query under a chip that excludes it: both filters apply, so nothing survives.
    fireEvent.click(chip('Tomato'))
    fireEvent.click(chip('Pepper'))
    expect(optionCount()).toBe(0)
  })

  it('makes the crop slug searchable so typing "pepper" narrows without any chip', () => {
    // No pepper planting carries the word in its name, variety, or project — the slug is the only
    // place it appears, which is exactly what the looseIncludes haystack rider added.
    open()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pepper' } })
    expect(optionCount()).toBe(3)
  })

  it('keeps a slug-less planting reachable chips-off and excludes it under a chip, by design', () => {
    open()
    expect(screen.getByTestId('ps-opt-pl-x1')).toBeTruthy()
    fireEvent.click(chip('Tomato'))
    expect(screen.queryByTestId('ps-opt-pl-x1')).toBeNull()
  })

  it('ranks the recent planting first WITHIN the filtered set, and drops it when filtered out', () => {
    open({ recentPlantId: 'pl-t4' })                    // Brandywine — last alphabetically
    expect(screen.getAllByRole('option')[0].textContent).toContain('Brandywine')
    fireEvent.click(chip('Tomato'))
    expect(screen.getAllByRole('option')[0].textContent).toContain('Brandywine')
    // Filters win: an excluded recent row is simply absent — never shown-but-dimmed, and the
    // "recent" marker goes with it rather than floating over a row that is no longer there.
    fireEvent.click(chip('Tomato'))
    fireEvent.click(chip('Pepper'))
    expect(screen.queryByTestId('ps-opt-pl-t4')).toBeNull()
    expect(screen.queryByText('recent')).toBeNull()
  })

  it('does not touch the current selection when a chip excludes it', () => {
    const onChange = vi.fn()
    render(<PlantingSelect plants={PLANTS} value="pl-t1" onChange={onChange} cropChips={CROP_CHIPS_AUTO} />)
    expect(screen.getByText(/Sungold/)).toBeTruthy()          // chip mode, at rest
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    fireEvent.click(chip('Pepper'))
    expect(screen.queryByTestId('ps-opt-pl-t1')).toBeNull()   // filtered out of the list…
    expect(onChange).not.toHaveBeenCalled()                   // …but the VALUE is untouched
  })
})

describe('V4-CROPFILTER-001 — the filter can never be invisible', () => {
  it('reports how many rows the chips are hiding whenever the filter is on', () => {
    open()
    expect(screen.queryByTestId('ps-chip-filter-note')).toBeNull()
    fireEvent.click(chip('Pepper'))
    expect(screen.getByTestId('ps-chip-filter-note').textContent).toBe('7 hidden')
  })

  it('names the chips as the cause when the filter empties the list, with a one-tap exit', () => {
    open()
    fireEvent.click(chip('Pepper'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'roma' } })
    expect(optionCount()).toBe(0)
    expect(screen.getByText(/No plantings match/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('ps-chips-clear-empty'))
    expect(optionCount()).toBe(1)                             // the query alone still applies
  })

  it('keeps a tray-selected chip visible after the tray collapses', () => {
    open()
    fireEvent.click(chip('More ▾'))
    fireEvent.click(chip('Squash'))
    // V4-CROPFILTERLAYOUT-001 (BD-011) collapse-on-select rider: selecting a tray-only chip now
    // collapses the tray ITSELF — the manual 'Less ▴' tap this test used to perform. The
    // invariant pinned here is unchanged and still the point: the ACTIVE filter chip must stay
    // visible after the collapse (the §1b invisible-filter trap).
    expect(chip('More ▾')).toBeTruthy()
    expect(chip('Squash').getAttribute('aria-pressed')).toBe('true')
  })

  it('marks the selected chip in a non-color-only channel (aria-pressed + weight)', () => {
    open()
    expect(chip('Tomato').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(chip('Tomato'))
    expect(chip('Tomato').getAttribute('aria-pressed')).toBe('true')
    expect(chip('Tomato').style.fontWeight).toBe('700')
  })

  it('keeps chips out of the listbox — never options, never keyboard-highlight targets', () => {
    open()
    expect(optionCount()).toBe(10)
    for (const el of screen.getAllByRole('button')) expect(el.getAttribute('role')).not.toBe('option')
  })
})

describe('V4-CROPFILTER-001 — chip state lifetime', () => {
  it('writes nothing to localStorage on a chip tap, and a fresh mount starts clear', () => {
    // Asserts on STORAGE CONTENT, not on a spy. setup.ts swaps localStorage for a plain in-memory
    // object on Node ≥26, so a `Storage.prototype.setItem` spy silently never fires there — the
    // first draft of this pin passed against a deliberately persisting mutant. Content works in
    // both environments and catches persistence under any key or write path.
    expect(window.localStorage.length).toBe(0)
    const { unmount } = open()
    fireEvent.click(chip('Pepper'))
    expect(optionCount()).toBe(3)
    expect(window.localStorage.length).toBe(0)
    unmount()
    open()
    expect(chip('Pepper').getAttribute('aria-pressed')).toBe('false')
    expect(optionCount()).toBe(10)
  })

  it('survives the host reset after a save — a six-tomato burst taps the chip once', () => {
    // resetNonce is EventNew's resetForNext signal. It clears `touched`; it must NOT clear the
    // filter, or burst logging pays the narrowing cost again on every single entry.
    const { rerender } = render(
      <PlantingSelect plants={PLANTS} value="" onChange={() => {}} cropChips={CROP_CHIPS_AUTO} resetNonce={0} />,
    )
    fireEvent.focus(screen.getByRole('combobox'))
    fireEvent.click(chip('Tomato'))
    expect(optionCount()).toBe(4)
    rerender(<PlantingSelect plants={PLANTS} value="" onChange={() => {}} cropChips={CROP_CHIPS_AUTO} resetNonce={1} />)
    fireEvent.focus(screen.getByRole('combobox'))
    expect(chip('Tomato').getAttribute('aria-pressed')).toBe('true')
    expect(optionCount()).toBe(4)
  })
})
