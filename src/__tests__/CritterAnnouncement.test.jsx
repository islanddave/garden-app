import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import CritterAnnouncement from '../components/CritterAnnouncement.jsx'

describe('CritterAnnouncement', () => {
  it('renders nothing when critter prop is null', () => {
    const { container } = render(<CritterAnnouncement critter={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for unknown species_id (defensive)', () => {
    const { container } = render(
      <CritterAnnouncement critter={{ species_id: 255, meta: { copy_variant_id: 0 } }} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders aria-live=polite + aria-atomic + role=status for known species', () => {
    render(<CritterAnnouncement critter={{ species_id: 3, meta: { copy_variant_id: 0 } }} />)
    const el = screen.getByTestId('critter-announcement')
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('aria-live')).toBe('polite')
    expect(el.getAttribute('aria-atomic')).toBe('true')
    expect(el.getAttribute('data-species-id')).toBe('3')
  })

  it('aria-label strips the sparkle emoji per revision §3.18', () => {
    render(<CritterAnnouncement critter={{ species_id: 3, meta: { copy_variant_id: 0 } }} />)
    const el = screen.getByTestId('critter-announcement')
    const aria = el.getAttribute('aria-label')
    expect(aria).not.toContain('✨')
    expect(aria.length).toBeGreaterThan(0)
  })

  it('visible text contains the ✨ emoji prefix', () => {
    render(<CritterAnnouncement critter={{ species_id: 3, meta: { copy_variant_id: 0 } }} />)
    const el = screen.getByTestId('critter-announcement')
    expect(el.textContent).toContain('✨')
  })

  it('uses species aria_announce_name when interpolating', () => {
    // species_id=8 = Ruby-throated hummingbird → "a hummingbird"
    render(<CritterAnnouncement critter={{ species_id: 8, meta: { copy_variant_id: 0 } }} />)
    const el = screen.getByTestId('critter-announcement')
    expect(el.getAttribute('aria-label')).toContain('A hummingbird')
  })

  it('falls back gracefully when meta missing', () => {
    render(<CritterAnnouncement critter={{ species_id: 3 }} />)
    const el = screen.getByTestId('critter-announcement')
    expect(el).toBeDefined()
  })

  it('present_tense mode includes plant noun when plantName passed', () => {
    render(<CritterAnnouncement
      critter={{ species_id: 3, meta: { copy_variant_id: 0 } }}
      mode="present_tense"
      plantName="tomatoes"
    />)
    const el = screen.getByTestId('critter-announcement')
    expect(el.textContent).toContain('tomatoes')
  })
})
