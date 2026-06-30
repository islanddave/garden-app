// V4-THEME-001 — SegmentedControl freeze/behaviour guard (dark primitive).
// No jest-dom (L-182): assert via roles + attributes + toBeTruthy.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'

const OPTS = [
  { value: 'plants', label: 'Plants' },
  { value: 'photos', label: 'Photos' },
]

describe('SegmentedControl (V4-THEME-001)', () => {
  it('renders a radiogroup with one radio per option; active is aria-checked', () => {
    render(<SegmentedControl options={OPTS} value="plants" onChange={() => {}} ariaLabel="View" />)
    expect(screen.getByRole('radiogroup').getAttribute('aria-label')).toBe('View')
    const radios = screen.getAllByRole('radio')
    expect(radios.length).toBe(2)
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    expect(radios[1].getAttribute('aria-checked')).toBe('false')
    // roving tabindex: active=0, inactive=-1
    expect(radios[0].getAttribute('tabindex')).toBe('0')
    expect(radios[1].getAttribute('tabindex')).toBe('-1')
  })

  it('click selects an option (onChange with its value)', () => {
    const onChange = vi.fn()
    render(<SegmentedControl options={OPTS} value="plants" onChange={onChange} />)
    fireEvent.click(screen.getByText('Photos'))
    expect(onChange).toHaveBeenCalledWith('photos')
  })

  it('ArrowRight moves selection to the next option (wraps)', () => {
    const onChange = vi.fn()
    render(<SegmentedControl options={OPTS} value="photos" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('plants') // wrapped from last to first
  })
})
