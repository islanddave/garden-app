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
  it('project kind switches the vocabulary', () => {
    render(<StatusSelect kind="project" value="" onChange={() => {}} />)
    const vals = screen.getAllByRole('option').map(o => o.value).filter(Boolean)
    expect(vals.sort()).toEqual([...PROJECT_STATUSES].sort())
  })
})
