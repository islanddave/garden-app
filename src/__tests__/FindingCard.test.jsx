import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import FindingCard from '../components/findings/FindingCard.jsx'

// V4-OVERLAY-001 Slice 2: the "Treated…" deep-link is now an <OverlayLink> (client nav that opens
// /log as a flyover over Findings) instead of a raw <a href>, so these renders need a Router in
// scope. Wrapping via the testing-library `wrapper` option keeps every existing assertion intact —
// react-router's <Link> still renders an <a href> whose value the href tests read.
const wrap = { wrapper: MemoryRouter }

const base = {
  finding_id: 'issue:1', statement: 'Manitoba (Tomatoes) likely needs water.',
  confidence_band: 'moderate', confidence_basis: 'one logged issue, no corroboration yet',
  assertion_mode: 'assert', decay_state: 'fresh', trend: 'worsening', urgency_level: 'low',
}

describe('FindingCard', () => {
  it('renders the engine statement as the headline', () => {
    render(<FindingCard finding={base} />, wrap)
    expect(screen.getByText(/Manitoba \(Tomatoes\) likely needs water\./)).toBeTruthy()
  })

  it('frames assert mode as a heads-up and ask mode as a question', () => {
    const { rerender } = render(<FindingCard finding={base} />, wrap)
    expect(screen.getByText('Heads-up')).toBeTruthy()
    rerender(<FindingCard finding={{ ...base, assertion_mode: 'ask' }} />)
    expect(screen.getByText('Question')).toBeTruthy()
  })

  it('shows confidence band + basis text', () => {
    render(<FindingCard finding={base} />, wrap)
    expect(screen.getByText('moderate confidence')).toBeTruthy()
    expect(screen.getByText(/one logged issue/)).toBeTruthy()
  })

  it('renders urgency only as a de-privileged labelled dot, never as text (C7)', () => {
    render(<FindingCard finding={base} />, wrap)
    expect(screen.getByLabelText('urgency: low')).toBeTruthy()
    expect(screen.queryByText(/urgency/i)).toBeNull()
  })

  it('shows a Mark resolved control for a live issue and calls onResolve with the source event id', () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<FindingCard finding={{ ...base, finding_id: 'issue:evt-42', decay_state: 'fresh' }} onResolve={onResolve} />, wrap)
    const btn = screen.getByText('Mark resolved')
    fireEvent.click(btn)
    expect(onResolve).toHaveBeenCalledWith('evt-42')
  })

  it('hides Mark resolved for an already-resolved finding', () => {
    const onResolve = vi.fn()
    render(<FindingCard finding={{ ...base, decay_state: 'resolved' }} onResolve={onResolve} />, wrap)
    expect(screen.queryByText('Mark resolved')).toBeNull()
  })

  it('hides Mark resolved when no onResolve handler is provided', () => {
    render(<FindingCard finding={{ ...base, decay_state: 'fresh' }} />, wrap)
    expect(screen.queryByText('Mark resolved')).toBeNull()
  })

  it('offers a Treated… deep-link carrying the source event + plant/project (V4-TREATLOG-001)', () => {
    render(<FindingCard finding={{ ...base, finding_id: 'issue:evt9', plant_id: 'pl9', project_id: 'pr9' }} onResolve={() => {}} />, wrap)
    const link = screen.getByText('Treated…')
    const href = link.getAttribute('href')
    expect(href).toContain('event_type=doctored')
    expect(href).toContain('resolve=evt9')
    expect(href).toContain('plant=pl9')
    expect(href).toContain('project=pr9')
  })

  it('hides Treated… for an already-resolved finding', () => {
    render(<FindingCard finding={{ ...base, decay_state: 'resolved' }} onResolve={() => {}} />, wrap)
    expect(screen.queryByText('Treated…')).toBeNull()
  })
})
