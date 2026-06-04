// Lane D / Phase D — EventTypePicker tests (extracted from EventNew, behavior-
// preserving). Primary quick-picks render + click → onChange(value); the More
// toggle reveals the secondary groups.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import EventTypePicker, { EVENT_TYPES_UI } from '../components/forms/EventTypePicker.jsx'

describe('EventTypePicker', () => {
  it('renders every primary quick-pick', () => {
    render(<EventTypePicker value="" onChange={() => {}} />)
    expect(screen.getByText('Watered')).toBeDefined()
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(EVENT_TYPES_UI.length)
  })
  it('fires onChange with the value when a primary type is clicked', () => {
    const onChange = vi.fn()
    render(<EventTypePicker value="" onChange={onChange} />)
    fireEvent.click(screen.getByText('Watered'))
    expect(onChange).toHaveBeenCalledWith('watering')
  })
  it('the More toggle reveals secondary-group types (hidden by default)', () => {
    render(<EventTypePicker value="" onChange={() => {}} />)
    expect(screen.queryByText('Mulched')).toBeNull()
    fireEvent.click(screen.getByText('More event types'))
    expect(screen.getByText('Mulched')).toBeDefined()
  })
})
