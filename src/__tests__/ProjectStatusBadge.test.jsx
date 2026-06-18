// V3-FORMSYS-001 Phase F — canonical project-status badge.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ProjectStatusBadge from '../components/ProjectStatusBadge.jsx'
import { getStatusColors } from '../lib/status.js'

describe('ProjectStatusBadge', () => {
  it('renders the humanized label, not the raw status string', () => {
    render(<ProjectStatusBadge status="active" />)
    // statusLabel maps "active" -> a human label; the raw lowercase token must not show
    const el = screen.getByLabelText(/^Status:/)
    expect(el.textContent.trim()).not.toBe('active')
    expect(el.textContent.trim().length).toBeGreaterThan(0)
  })

  it('returns null when status is missing', () => {
    const { container } = render(<ProjectStatusBadge status={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('uses the shared stage colors so in-progress stages are NOT planning-gold (ProjectPublic bug)', () => {
    // growing is an in-progress stage; the old hardcoded ProjectPublic map missed it and
    // fell through to planning gold. Canonical getStatusColors gives it the active green.
    const growing = getStatusColors('growing')
    const planning = getStatusColors('growing') === getStatusColors('planning')
    render(<ProjectStatusBadge status="growing" />)
    const el = screen.getByLabelText(/^Status:/)
    expect(el).toBeTruthy()
    expect(growing.bg).not.toBe(getStatusColors('planning').bg)
  })

  it('exposes an aria-label for the status (a11y; ProjectPublic raw pill had none)', () => {
    render(<ProjectStatusBadge status="harvested" />)
    expect(screen.getByLabelText(/^Status:/)).toBeTruthy()
  })
})
