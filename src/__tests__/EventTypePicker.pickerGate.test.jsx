// V4-PICKERGATE-001 — the OTHER direction: EventNew's picker must still offer all three.
//
// This lane narrows three creation surfaces. The failure mode of a narrowing change is narrowing
// too much, and it is silent: every per-surface test in this lane would still pass if the panel-
// bearing surface lost the types too. So the both-sides proof needs an assertion that lives beside
// the change and fails when EventNew's picker shrinks.
//
// V4-LOSSUI-001 has one — EventNew.reduction.test.jsx reaches 'Plants given away' through the More
// panel — but it is a single assertion inside a 31-test file about something else, and it does not
// cover 'Plants lost' (that file's default type, reached without the picker) or 'Harvested'. This
// file asserts the picker's DEFAULT `available` directly: EventNew passes no props, so the default
// IS EventNew's list.
//
// EventTypePicker renders `primaries` unconditionally and `available` only into the More panel, so
// the two halves need separate assertions — a narrowing of `available` would leave the harvest
// PRIMARY tile untouched and could read as "harvest is still offered" while the More panel had been
// gutted. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import EventTypePicker from '../components/forms/EventTypePicker.jsx'
import {
  SELECTABLE_EVENT_TYPES,
  CAPTURE_PANEL_REQUIRED_TYPES,
  EVENT_TYPE_META,
  creatableEventTypes,
} from '../lib/eventTypes.js'

afterEach(() => cleanup())

// No `available` prop — exactly how EventNew.jsx:1777 renders it.
const renderAsEventNew = () => render(<EventTypePicker value="" onChange={vi.fn()} />)

describe('V4-PICKERGATE-001 — EventNew\'s picker keeps the WHOLE vocabulary', () => {
  it('offers every capture-panel type: harvest as a primary tile, the reduction pair under More', () => {
    renderAsEventNew()
    // 'harvest' is a first-class quick-pick (EVENT_TYPES_UI), so it is visible before any expand.
    expect(screen.getByText('Harvested')).toBeTruthy()
    fireEvent.click(screen.getByText('More event types'))
    // Labels walked from the vocabulary rather than hand-typed, so a label rename cannot make this
    // pass for the wrong reason.
    for (const t of CAPTURE_PANEL_REQUIRED_TYPES) {
      const label = EVENT_TYPE_META[t]?.label
      expect(label, `${t} has no label`).toBeTruthy()
      expect(screen.getAllByText(label).length, `${label} must be offered`).toBeGreaterThan(0)
    }
    // Named too — these are the two V4-LOSSUI-001 landed and the ones this lane must not undo.
    expect(screen.getByText('Plants lost')).toBeTruthy()
    expect(screen.getByText('Plants given away')).toBeTruthy()
  })

  it('renders the Attrition group — the route by which a user reaches the reduction types', () => {
    renderAsEventNew()
    fireEvent.click(screen.getByText('More event types'))
    expect(screen.getByText('Attrition')).toBeTruthy()
  })

  it('its default `available` is the full seam, NOT a gated list', () => {
    // The structural claim behind the render assertions: EventNew is the surface that HAS the
    // panels, so its picker takes the whole vocabulary. If this default is ever changed to a safe
    // list, EventNew must start passing its own — and this test says so out loud.
    renderAsEventNew()
    fireEvent.click(screen.getByText('More event types'))
    const gated = creatableEventTypes({ capturePanels: false, plantScoped: true })
    for (const t of SELECTABLE_EVENT_TYPES) {
      if (gated.includes(t)) continue // present on the narrowed surfaces too; proves nothing here
      expect(screen.getAllByText(EVENT_TYPE_META[t].label).length,
        `${t} is dropped by the creation gate and MUST still be here`).toBeGreaterThan(0)
    }
  })
})
