import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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

// BUG-SILENTFAILSWEEP-001 — `catch { setBusy(false) }`, commented "stay put on failure so the owner
// can retry", with nothing telling the owner there was anything to retry. Staying put IS the right
// recovery; on its own it returned the card to the exact resting state it has when nothing was
// tapped at all. Success unmounts the card (the parent reloads), so the two outcomes only differ
// once the failure says something.
describe('FindingCard — a failed resolve does not render as a success', () => {
  const live = { ...base, finding_id: 'issue:evt-42', decay_state: 'fresh' }
  const cardErr = () => screen.queryByTestId('finding-resolve-error')

  it('a failed resolve and a successful one do NOT render the same thing', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('nope'))
    const failed = render(<FindingCard finding={live} onResolve={failing} />, wrap)
    fireEvent.click(screen.getByText('Mark resolved'))
    // FAILURE: named, and the control is back — it is the retry.
    await waitFor(() => expect(cardErr()).not.toBeNull())
    expect(screen.getByText('Mark resolved')).toBeTruthy()
    failed.unmount()

    // SUCCESS: nothing said, and the control stays spent — in the app the parent's reload unmounts
    // this card, which is the confirmation. Silence is only correct on this arm.
    let settle
    const ok = vi.fn(() => new Promise(r => { settle = () => r(undefined) }))
    render(<FindingCard finding={live} onResolve={ok} />, wrap)
    fireEvent.click(screen.getByText('Mark resolved'))
    await act(async () => { settle(); await Promise.resolve() })
    expect(cardErr()).toBeNull()
    expect(screen.getByText('Resolving…')).toBeTruthy()
  })

  it('names this card’s own verb and the state the finding is left in', async () => {
    render(<FindingCard finding={live} onResolve={vi.fn().mockRejectedValue(new Error('nope'))} />, wrap)
    fireEvent.click(screen.getByText('Mark resolved'))
    const el = await screen.findByTestId('finding-resolve-error')
    expect(el.getAttribute('role')).toBe('alert')   // inserted on failure, so it announces
    expect(el.textContent).toMatch(/Couldn't mark this resolved/)
    expect(el.textContent).toMatch(/still open/)
  })

  it('a retry clears the stale message while in flight, and re-reports if it fails again', async () => {
    // Mid-flight, not after: a clear that only happened on success is indistinguishable from no
    // clear at all once the retry has landed.
    let release
    const onResolve = vi.fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockImplementationOnce(() => new Promise((_, rej) => { release = () => rej(new Error('again')) }))
    render(<FindingCard finding={live} onResolve={onResolve} />, wrap)
    fireEvent.click(screen.getByText('Mark resolved'))
    await screen.findByTestId('finding-resolve-error')

    fireEvent.click(screen.getByText('Mark resolved'))
    await waitFor(() => expect(cardErr()).toBeNull())
    await act(async () => { release(); await Promise.resolve() })
    await waitFor(() => expect(cardErr()).not.toBeNull())
  })
})
