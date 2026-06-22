// Lane D / Phase B+C — EnumSelect + StatusSelect tests. They compose the Phase A
// Select; assert option normalization, alpha-by-label sort, the single humanizer,
// and that StatusSelect offers exactly the registry's values (never one the badge
// can't render).
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EnumSelect, StatusSelect } from '../components/forms'
import { PLANT_STATUSES, PROJECT_STATUSES, statusLabel } from '../lib/constants.js'

describe('EnumSelect', () => {
  it('normalizes {value,label} | {v,label} | string and alphabetizes by label', () => {
    render(<EnumSelect value="" onChange={() => {}} enumValues={[{ value: 'z', label: 'Zucchini' }, { v: 'a', label: 'Apple' }, 'mango']} />)
    const opts = screen.getAllByRole('option').map(o => o.textContent)
    expect(opts).toEqual(['Apple', 'mango', 'Zucchini'])  // locale-aware (case-insensitive) alpha by label
  })
  it('renders a placeholder option when given', () => {
    render(<EnumSelect value="" onChange={() => {}} placeholder="— pick —" enumValues={['x']} />)
    expect(screen.getByRole('option', { name: '— pick —' }).value).toBe('')
  })
  it('passes id + aria through to the native select (Field-compatible)', () => {
    render(<EnumSelect id="my-enum" value="" onChange={() => {}} enumValues={['x']} aria-invalid={true} />)
    const sel = document.getElementById('my-enum')
    expect(sel.tagName).toBe('SELECT')
    expect(sel.getAttribute('aria-invalid')).toBe('true')
  })
})

describe('StatusSelect', () => {
  it('plant kind offers exactly the PLANT_STATUSES (humanized) + the empty option', () => {
    render(<StatusSelect kind="plant" value="" onChange={() => {}} />)
    const labels = screen.getAllByRole('option').map(o => o.textContent)
    for (const v of PLANT_STATUSES) expect(labels).toContain(statusLabel(v))
    expect(labels).toContain('— none —')
    // every non-empty option value is a real registry value (badge can render it)
    const vals = screen.getAllByRole('option').map(o => o.value).filter(Boolean)
    for (const v of vals) expect(PLANT_STATUSES).toContain(v)
  })
  it('V3-STATUS-003: plant kind preserves the custom lifecycle order (not alpha)', () => {
    render(<StatusSelect kind="plant" value="" onChange={() => {}} />)
    const vals = screen.getAllByRole('option').map(o => o.value).filter(Boolean)
    expect(vals).toEqual([...PLANT_STATUSES])
  })
  it('V3-STATUS-003: harvested planting status humanizes to "Harvesting"', () => {
    expect(statusLabel('harvested')).toBe('Harvesting')
  })
  it('project kind switches the vocabulary', () => {
    render(<StatusSelect kind="project" value="" onChange={() => {}} />)
    const vals = screen.getAllByRole('option').map(o => o.value).filter(Boolean)
    expect(vals.sort()).toEqual([...PROJECT_STATUSES].sort())
  })
})

// V3-CONFIG-001 ext — dropdownRegistry drift guards. Each new set must keep its derived
// label map in lockstep with its option array (label-set == option-set, no orphans), and
// stay sourced from the canonical taxonomy (so the registry can never drift from the SSoT).
import {
  EVENT_TYPE_OPTIONS, EVENT_TYPE_LABELS,
  PROJECT_CATEGORY_OPTIONS, PROJECT_CATEGORY_LABELS,
} from '../lib/dropdownRegistry.js'
import { EVENT_TYPES, EVENT_TYPE_META } from '../lib/eventTypes.js'
import { PROJECT_CATEGORIES } from '../lib/constants.js'

describe('dropdownRegistry — EVENT_TYPE set (V3-CONFIG-001)', () => {
  it('label map keys exactly mirror the option values (no drift, no orphans)', () => {
    const optValues = EVENT_TYPE_OPTIONS.map(o => o.value).sort()
    const labelKeys = Object.keys(EVENT_TYPE_LABELS).sort()
    expect(labelKeys).toEqual(optValues)
    for (const o of EVENT_TYPE_OPTIONS) expect(EVENT_TYPE_LABELS[o.value]).toBe(o.label)
  })
  it('is sourced from the canonical EVENT_TYPES taxonomy (same value set)', () => {
    expect(EVENT_TYPE_OPTIONS.map(o => o.value).sort()).toEqual([...EVENT_TYPES].sort())
  })
  it('options are alpha-sorted by raw value (legacy EventDetail ordering preserved)', () => {
    const vals = EVENT_TYPE_OPTIONS.map(o => o.value)
    expect(vals).toEqual([...vals].sort((a, b) => a.localeCompare(b)))
  })
  it('label shape is emoji + de-snaked value (behavior-preserving, not the META prose label)', () => {
    const t = 'pest_treatment'
    const expected = (EVENT_TYPE_META[t]?.emoji ?? '📝') + ' ' + t.replace(/_/g, ' ')
    expect(EVENT_TYPE_LABELS[t]).toBe(expected)
    expect(EVENT_TYPE_LABELS[t]).toContain('pest treatment')
  })
})

describe('dropdownRegistry — PROJECT_CATEGORY set (V3-CONFIG-001)', () => {
  it('label map keys exactly mirror the option values (no drift, no orphans)', () => {
    const optValues = PROJECT_CATEGORY_OPTIONS.map(o => o.value).sort()
    const labelKeys = Object.keys(PROJECT_CATEGORY_LABELS).sort()
    expect(labelKeys).toEqual(optValues)
    for (const o of PROJECT_CATEGORY_OPTIONS) expect(PROJECT_CATEGORY_LABELS[o.value]).toBe(o.label)
  })
  it('is sourced from the canonical PROJECT_CATEGORIES taxonomy (value + label parity)', () => {
    expect(PROJECT_CATEGORY_OPTIONS).toEqual(PROJECT_CATEGORIES.map(c => ({ value: c.v, label: c.label })))
  })
})
