// DD9 / W-EVTDEL — the disclose-and-offer confirm.
//
// These RENDER the component and drive real user events. Every acceptance criterion in the plan's
// §5 that this component owns (W-EVTDEL-AC3/AC4/AC5/AC6) is a rendering assertion here, and AC4 in
// particular is asserted explicitly rather than assumed — "a checked default silently inverts the
// whole decision", so "unchecked" being the default is not something a reader may infer from the
// source.
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import EventDeleteConfirm, { coverNames } from '../components/photo/EventDeleteConfirm.jsx'

afterEach(() => { cleanup() })

const checkbox = () => screen.queryByRole('checkbox')
const deleteBtn = () => screen.getByRole('button', { name: /^Delete/ })

describe('EventDeleteConfirm — the offer', () => {
  it('W-EVTDEL-AC4 — the checkbox appears whenever the event has a photo, and is UNCHECKED', () => {
    render(<EventDeleteConfirm open eventCount={1} photoCount={1} coverFor={[]} />)
    const box = checkbox()
    expect(box).toBeTruthy()
    expect(box.checked).toBe(false)
    expect(screen.getByText('Also delete the photo')).toBeTruthy()
  })

  it('W-EVTDEL-AC4 — offered even when the photo is NOT a cover photo anywhere', () => {
    // "Sometimes I definitely do wanna delete the photo also" (Dave). Gating the offer on
    // cover-photo status would silently remove the option in the common case.
    render(<EventDeleteConfirm open photoCount={1} coverFor={[]} />)
    expect(checkbox()).toBeTruthy()
    expect(screen.queryByTestId('cover-disclosure')).toBeNull()
  })

  it('W-EVTDEL-AC6 — an event with no photo shows no checkbox and no cover-photo copy', () => {
    render(<EventDeleteConfirm open eventCount={1} photoCount={0} coverFor={[{ name: 'Celebrity Rescue' }]} />)
    expect(checkbox()).toBeNull()
    expect(screen.queryByTestId('cover-disclosure')).toBeNull()
  })

  it('reports the choice to the caller — unchecked by default, checked only after a tap', () => {
    const onConfirm = vi.fn()
    render(<EventDeleteConfirm open photoCount={1} onConfirm={onConfirm} />)

    fireEvent.click(deleteBtn())
    expect(onConfirm).toHaveBeenLastCalledWith({ deletePhotos: false })

    fireEvent.click(checkbox())
    fireEvent.click(deleteBtn())
    expect(onConfirm).toHaveBeenLastCalledWith({ deletePhotos: true })
  })

  it('re-opening RESETS the tick — a sticky checkbox is a checked default one interaction later', () => {
    const onConfirm = vi.fn()
    const { rerender } = render(<EventDeleteConfirm open photoCount={1} onConfirm={onConfirm} />)
    fireEvent.click(checkbox())
    expect(checkbox().checked).toBe(true)

    rerender(<EventDeleteConfirm open={false} photoCount={1} onConfirm={onConfirm} />)
    rerender(<EventDeleteConfirm open photoCount={1} onConfirm={onConfirm} />)
    expect(checkbox().checked).toBe(false)

    fireEvent.click(deleteBtn())
    expect(onConfirm).toHaveBeenLastCalledWith({ deletePhotos: false })
  })
})

describe('EventDeleteConfirm — the disclosure (this is what converts D1 from silent to visible)', () => {
  it('W-EVTDEL-AC3 — NAMES the affected parent when the photo is a cover photo', () => {
    render(<EventDeleteConfirm open photoCount={1} coverFor={[{ id: 'p1', name: 'Celebrity Rescue' }]} />)
    const line = screen.getByTestId('cover-disclosure')
    expect(line.textContent).toContain('Celebrity Rescue')
    expect(line.textContent).toContain('cover photo for')
  })

  it('W-EVTDEL-AC3 — omits the line entirely when the photo covers nothing', () => {
    render(<EventDeleteConfirm open photoCount={1} coverFor={[]} />)
    expect(screen.queryByTestId('cover-disclosure')).toBeNull()
  })

  it('says the cover STAYS while unchecked, and is REMOVED once checked', () => {
    // The sentence tracks the choice currently made. A static warning would be wrong in one of the
    // two states, and the unchecked state is the one that must read as "nothing happens to it".
    render(<EventDeleteConfirm open photoCount={1} coverFor={[{ name: 'Celebrity Rescue' }]} />)
    expect(screen.getByTestId('cover-disclosure').textContent).toMatch(/It will stay there\./)
    fireEvent.click(checkbox())
    expect(screen.getByTestId('cover-disclosure').textContent).toMatch(/It will be removed from there\./)
  })

  it('frames recovery as DURABLE, never as a countdown (DD8 / V3-ARCHIVE-001)', () => {
    // A toast asserting "gone" after 5s makes the user's belief WORSE than the system's state. The
    // row is recoverable forever, so the copy points at Recently deleted, not at a timer.
    render(<EventDeleteConfirm open photoCount={1} />)
    fireEvent.click(checkbox())
    expect(screen.getByText(/recoverable from Recently deleted/i)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/undo|seconds|\bsec\b/i)
  })

  it('names every parent, pluralizes, and caps the list at two + a count', () => {
    expect(coverNames(['A'])).toBe('A')
    expect(coverNames(['A', 'B'])).toBe('A and B')
    expect(coverNames(['A', 'B', 'C'])).toBe('A, B and 1 more')
    expect(coverNames(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more')
    expect(coverNames([])).toBe('')
    // Accepts a bare string list as well as {id,name} rows — the caller has both shapes available.
    render(<EventDeleteConfirm open photoCount={2} coverFor={['Sun Sugar', 'Suyo Long']} />)
    expect(screen.getByTestId('cover-disclosure').textContent).toContain('Sun Sugar and Suyo Long')
  })
})

describe('EventDeleteConfirm — batches', () => {
  it('W-EVTDEL-AC5 — the count is over the WHOLE batch and the checkbox is all-or-nothing', () => {
    const onConfirm = vi.fn()
    render(<EventDeleteConfirm open eventCount={2} photoCount={2} onConfirm={onConfirm} />)
    expect(screen.getByText('Also delete all 2 photos')).toBeTruthy()
    // One boolean for the batch — there is no per-event tick, by design.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.click(checkbox())
    fireEvent.click(deleteBtn())
    expect(onConfirm).toHaveBeenLastCalledWith({ deletePhotos: true })
  })

  it('pluralizes the title and the confirm label for a batch', () => {
    render(<EventDeleteConfirm open eventCount={3} photoCount={3} />)
    expect(screen.getByText('Delete these 3 events?')).toBeTruthy()
    expect(deleteBtn().textContent).toMatch(/Delete 3 events/)
    fireEvent.click(checkbox())
    expect(deleteBtn().textContent).toMatch(/and 3 photos/)
  })
})

describe('EventDeleteConfirm — destructive-control safety at 390px (Android Chrome)', () => {
  it('the destructive button is NOT the bottom-most control — Cancel is', () => {
    // In a bottom sheet the bottom-most control is the one the thumb reaches most easily. Putting
    // the destructive action there is the mis-tap hazard; Cancel takes that slot instead.
    render(<EventDeleteConfirm open photoCount={1} />)
    const labels = screen.getAllByRole('button').map((b) => b.textContent.trim())
    const del = labels.findIndex((t) => /^Delete/.test(t))
    const cancel = labels.lastIndexOf('Cancel')
    expect(del).toBeGreaterThanOrEqual(0)
    expect(cancel).toBeGreaterThan(del)
  })

  it('the two actions are stacked full-width, never side by side', () => {
    render(<EventDeleteConfirm open photoCount={1} />)
    const del = deleteBtn()
    expect(del.style.width).toBe('100%')
    expect(del.parentElement.style.flexDirection).toBe('column')
    // A real gap between a destructive target and a safe one, not a hairline.
    expect(parseInt(del.parentElement.style.gap, 10)).toBeGreaterThanOrEqual(12)
  })

  it('the whole checkbox row is a >=44px tappable label, not a bare 16px box', () => {
    render(<EventDeleteConfirm open photoCount={1} />)
    const label = checkbox().closest('label')
    expect(label).toBeTruthy()
    expect(parseInt(label.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
  })

  it('disables both controls while the caller\'s write is in flight', () => {
    // Without this the sheet stays live over an in-flight request and a second impatient tap sends
    // a second delete — on flaky mobile connectivity that is routine, not exotic.
    const onConfirm = vi.fn()
    render(<EventDeleteConfirm open photoCount={1} busy onConfirm={onConfirm} />)
    expect(checkbox().disabled).toBe(true)
    expect(screen.getByRole('button', { name: /Deleting/ }).disabled).toBe(true)
  })
})

describe('EventDeleteConfirm — it is a dialog, and it is closable', () => {
  it('renders as an accessible modal dialog named by the question it asks', () => {
    render(<EventDeleteConfirm open photoCount={0} />)
    const dlg = screen.getByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.textContent).toContain('Delete this event?')
  })

  it('cancel is reachable from the sheet chrome as well as the button', () => {
    const onCancel = vi.fn()
    render(<EventDeleteConfirm open photoCount={0} onCancel={onCancel} />)
    for (const b of screen.getAllByRole('button', { name: 'Cancel' })) fireEvent.click(b)
    expect(onCancel).toHaveBeenCalled()
  })

  it('renders nothing at all when closed', () => {
    render(<EventDeleteConfirm open={false} photoCount={1} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(checkbox()).toBeNull()
  })
})
