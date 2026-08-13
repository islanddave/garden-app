// PlantingSelectChooserLayout.test.jsx — V4-CROPFILTERLAYOUT-001 (BD-011), spec §5 tests 17-19
// and 21-23. (Test 20, the computePlacement regression pin, lives in
// PlantingSelectPlacement.test.jsx with the rest of the placement arithmetic; test 24 IS the
// existing formsPrimitivesFreeze suite staying green; test 25 is the untouched existing suites.)
//
// jsdom cannot observe layout outcomes (zero rects), but every BD-011 mechanism is a STYLE
// CONTRACT — the tray cap, the listbox floor, the finite panel bound — and styles are exactly
// what jsdom renders faithfully. The on-device outcome (≥3 rows with the keyboard up, both flip
// directions) is the device pass on the ledger item, not claimed here.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: vi.fn(() => Promise.resolve([])), getToken: vi.fn() }),
}))

import PlantingSelect, { CROP_CHIPS_AUTO } from '../components/forms/PlantingSelect.jsx'
import FilterChipRow from '../components/forms/FilterChipRow.jsx'

const p = (id, name, slug) => ({
  id, name, quantity: 1, project_name: 'Beds',
  variety_id: slug ? `v-${slug}` : null,
  variety_ref: slug ? { id: `v-${slug}`, name: `${name} type`, crop_type_slug: slug } : null,
  sown_at: null, succession_order: null,
})
const PLANTS = [
  p('pl-t1', 'Sungold', 'tomato'), p('pl-t2', 'Cherokee', 'tomato'),
  p('pl-t3', 'Roma', 'tomato'), p('pl-t4', 'Brandywine', 'tomato'),
  p('pl-p1', 'Jalapeño', 'pepper'), p('pl-p2', 'Anaheim', 'pepper'), p('pl-p3', 'Shishito', 'pepper'),
  p('pl-s1', 'Zucchini', 'squash'), p('pl-s2', 'Delicata', 'squash'),
]

const OPTS = [
  { value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' }, { value: 'd', label: 'Delta' }, { value: 'e', label: 'Epsilon' },
]
const chip = name => screen.getByRole('button', { name })

beforeEach(() => { localStorage.clear() })

describe('BD-011 — FilterChipRow tray scrollport (trayMaxHeight)', () => {
  // Test 17. The cap applies to the EXPANDED tray only: the collapsed row is 1-2 lines by
  // construction (pinned ∪ selected) and capping it would clip the always-visible chips.
  it('applies maxHeight/overflow/overscroll only while expanded', () => {
    render(
      <FilterChipRow options={OPTS} selected={new Set()} onToggle={() => {}}
        pinned={['a']} trayMaxHeight={184} aria-label="Crops" />,
    )
    const row = screen.getByRole('group', { name: 'Crops' })
    expect(row.style.maxHeight).toBe('')                     // collapsed: unbounded
    expect(row.style.overflowY).toBe('')
    fireEvent.click(chip('More ▾'))
    expect(row.style.maxHeight).toBe('184px')                // expanded: bounded scrollport
    expect(row.style.overflowY).toBe('auto')
    // Mandatory, same reason as the listbox: an end-of-tray flick must not chain to the Sheet.
    expect(row.style.overscrollBehavior).toBe('contain')
    fireEvent.click(chip('Less ▴'))
    expect(row.style.maxHeight).toBe('')                     // collapse restores the plain row
  })
})

describe('BD-011 — bounded panel, floored listbox (PlantingSelect)', () => {
  function openPicker(props = {}) {
    render(<PlantingSelect plants={PLANTS} value="" onChange={() => {}} {...props} />)
    fireEvent.focus(screen.getByRole('combobox'))
  }

  // Test 18. Inside the flex panel the listbox is the elastic member with a hard 3-row floor —
  // the "starved to one 44px row" mechanism is structurally closed, not tuned away.
  it('gives the nested listbox flex:1 and the LIST_MIN_H floor when chips share the panel', () => {
    openPicker({ cropChips: CROP_CHIPS_AUTO })
    const list = screen.getByRole('listbox')
    expect(list.style.flex).toBe('1 1 auto')
    expect(list.style.minHeight).toBe('140px')
  })

  // …and the legacy (chip-less) listbox is byte-identical to before: no flex, no floor.
  it('leaves the chip-less listbox untouched — no flex, no minHeight floor', () => {
    openPicker()
    const list = screen.getByRole('listbox')
    expect(screen.queryByTestId('ps-panel')).toBeNull()
    expect(list.style.flex).toBe('')
    expect(list.style.minHeight).toBe('')
    expect(list.style.maxHeight).toBe('280px')
  })

  // Test 19. The panel — BD-011's root cause was its ABSENT maxHeight — is now a bounded flex
  // column: list budget (unmeasured fallback LIST_MAX_H 280) + tray budget (184) + tray chrome
  // (36) = 500px, finite by construction.
  it('bounds the panel: flex column, overflow hidden, finite maxHeight (280+184+36)', () => {
    openPicker({ cropChips: CROP_CHIPS_AUTO })
    const panel = screen.getByTestId('ps-panel')
    expect(panel.style.display).toBe('flex')
    expect(panel.style.flexDirection).toBe('column')
    expect(panel.style.overflow).toBe('hidden')
    expect(panel.style.maxHeight).toBe('500px')
  })
})

describe('BD-011 — collapse-on-select rider', () => {
  // Consumer-owned Set, as every real host wires it — the collapsed row keeps a tray-selected
  // chip visible only because the consumer flips membership.
  function Harness({ onLayoutChange }) {
    const [sel, setSel] = useState(() => new Set())
    return (
      <FilterChipRow
        options={OPTS} selected={sel} pinned={['a']} trayMaxHeight={184}
        onToggle={v => setSel(prev => { const n = new Set(prev); if (n.has(v)) n.delete(v); else n.add(v); return n })}
        onLayoutChange={onLayoutChange} aria-label="Crops"
      />
    )
  }

  // Test 21a. SELECTING a tray-only chip collapses the tray (the list is the next thing the
  // user needs), keeps the chip visible, and notifies the host to re-measure.
  it('collapses on selecting a tray-only chip, keeps it visible, and fires onLayoutChange', () => {
    const onLayout = vi.fn()
    render(<Harness onLayoutChange={onLayout} />)
    fireEvent.click(chip('More ▾'))
    expect(onLayout).toHaveBeenCalledTimes(1)                // the expand itself
    fireEvent.click(chip('Beta'))                            // tray-only, selecting
    expect(screen.getByRole('button', { name: 'More ▾' })).toBeTruthy()  // auto-collapsed
    expect(onLayout).toHaveBeenCalledTimes(2)                // host re-measures the shrink
    expect(chip('Beta').getAttribute('aria-pressed')).toBe('true')       // still visible + loud
  })

  // Test 21b. DESELECT keeps the tray open — the user is still browsing chips.
  it('keeps the tray open on deselect', () => {
    render(<Harness onLayoutChange={() => {}} />)
    fireEvent.click(chip('More ▾'))
    fireEvent.click(chip('Beta'))                            // select → collapses
    fireEvent.click(chip('More ▾'))                          // re-expand
    fireEvent.click(chip('Beta'))                            // DESELECT
    expect(screen.getByRole('button', { name: 'Less ▴' })).toBeTruthy()  // still expanded
    expect(chip('Beta').getAttribute('aria-pressed')).toBe('false')
  })

  // Test 22. Pinned taps never collapse — pins are the always-there chips; tapping one is not
  // "done with the tray".
  it('never collapses on a pinned chip tap', () => {
    render(<Harness onLayoutChange={() => {}} />)
    fireEvent.click(chip('More ▾'))
    fireEvent.click(chip('Alpha'))                           // pinned, selecting
    expect(screen.getByRole('button', { name: 'Less ▴' })).toBeTruthy()
    fireEvent.click(chip('Alpha'))                           // pinned, deselecting
    expect(screen.getByRole('button', { name: 'Less ▴' })).toBeTruthy()
  })
})

describe('BD-011 — HarvestExportSheet contract (no pinned, no trayMaxHeight)', () => {
  // Test 23. The export sheet's FilterChipRow must render byte-identically: chips in CALLER
  // order (band ordering is PlantingSelect's caller contract, not the primitive's), no tray,
  // no scroll constraints, and the pre-BD-011 root style byte-for-byte.
  it('renders the export-sheet shape untouched by BD-010/BD-011', () => {
    const onLayout = vi.fn()
    render(
      <FilterChipRow
        aria-label="Export crops"
        options={[{ value: 'zuke', label: 'Zucchini' }, { value: 'aster', label: 'Aster' }, { value: 'melon', label: 'Melon' }]}
        selected={new Set(['melon'])}
        onToggle={() => {}}
        onClear={() => {}}
        onLayoutChange={onLayout}
      />,
    )
    const row = screen.getByRole('group', { name: 'Export crops' })
    // Caller order preserved — NOT alphabetized, NOT band-ordered.
    const labels = [...row.querySelectorAll('button')].map(b => b.textContent)
    expect(labels).toEqual(['Zucchini', 'Aster', 'Melon', 'Clear'])
    expect(screen.queryByRole('button', { name: 'More ▾' })).toBeNull()
    // The exact pre-BD-011 root style, byte-for-byte.
    expect(row.style.cssText).toBe('display: flex; flex-wrap: wrap; gap: 8px; align-items: center;')
    // A select tap neither collapses anything nor asks the host to re-measure.
    fireEvent.click(chip('Aster'))
    expect(onLayout).not.toHaveBeenCalled()
  })
})
