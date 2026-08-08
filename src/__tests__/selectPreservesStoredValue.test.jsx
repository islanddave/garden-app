// BUG-LOCTYPEVOCAB-001 — a <Select> must never render a set value as if it were unset.
//
// Found on device, not by any test: locations.type_label = 'area' was the most common value in live
// data (9 of 21 locations, 200 live plantings) and was absent from LOCATION_TYPE_LABELS. The select
// therefore showed its placeholder — "— optional —" — for a field that was set. The real hazard is
// not the display: it is that the obvious fix from the user's side is to pick a value to fill the
// apparently-empty box, and type_label feeds the care engine's covered/outdoor branch
// (`l.type_label in ('shelf','rack','tray') then true`). Filling one of those boxes with shelf/rack/
// tray flips every planting under that location to covered — no rain credit, no frost alerts.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Select from '../components/forms/Select.jsx'
import { LOCATION_TYPE_LABELS } from '../lib/constants.js'

describe('Select surfaces a stored value that is not in its options', () => {
  it('renders an unrecognised value as a selected option, not as the placeholder', () => {
    render(<Select value="legacy_kind" onChange={() => {}} placeholder="— optional —"
                   options={['zone', 'rack']} aria-label="t" />)
    const el = screen.getByLabelText('t')
    expect(el.value).toBe('legacy_kind')
    expect([...el.options].map(o => o.value)).toContain('legacy_kind')
  })

  it('still shows the placeholder when the value is genuinely empty', () => {
    render(<Select value="" onChange={() => {}} placeholder="— optional —"
                   options={['zone', 'rack']} aria-label="t" />)
    const el = screen.getByLabelText('t')
    expect(el.value).toBe('')
    expect([...el.options].map(o => o.value)).toEqual(['', 'zone', 'rack'])
  })

  it('does not duplicate or reorder options when the value IS recognised', () => {
    render(<Select value="rack" onChange={() => {}} placeholder="p"
                   options={['zone', 'rack']} aria-label="t" />)
    const el = screen.getByLabelText('t')
    expect([...el.options].map(o => o.value)).toEqual(['', 'zone', 'rack'])
  })
})

describe('the location type vocabulary covers what the data and the care engine use', () => {
  it('includes every value the care engine branches on', () => {
    // These three are the covered=true arm in lambda/daily-plan/handler.js. A value the engine
    // special-cases but the UI cannot offer is unreachable through the app.
    for (const v of ['shelf', 'rack', 'tray']) expect(LOCATION_TYPE_LABELS).toContain(v)
  })

  it("includes 'area', the most common value in live data", () => {
    // Pinned by name because its absence was the live defect, and because a future tidy-up of this
    // list would otherwise re-break 9 locations and 200 plantings with nothing to catch it.
    expect(LOCATION_TYPE_LABELS).toContain('area')
  })
})
