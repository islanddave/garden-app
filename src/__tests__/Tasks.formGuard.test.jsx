// V4-DIRTYGUARDSWEEP-001 — Tasks ↔ the service-worker reload gate.
//
// Driven against the REAL reloadGate, never a spy on setReloadBlocked: the failure this row closes
// is "the primitive shipped with no callers", and a spy proves a call happened, not that the gate
// ends up held.
//
// Standing caveat, deliberately not papered over: Tasks' handleCreate is a stub ("coming soon via
// /api/tasks Lambda"), so nothing typed here can be saved by any route. The guard is still correct —
// the text IS unsaved and a reload does destroy it — but the hold releases only on unmount or on the
// text being cleared, never on a successful save, and there is no save-clears-the-hold test below
// because there is no save. Revisit when the route lands.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import Tasks from '../pages/Tasks.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

beforeEach(() => { clearReloadBlocks() })

function renderAndOpenForm() {
  const out = render(<Tasks />)
  fireEvent.click(screen.getByText('+ Add task'))
  return out
}

const title = () => screen.getByLabelText('Title *')
const notes = () => screen.getByLabelText('Notes (optional)')

describe('Tasks ↔ dirty guard', () => {
  it('a merely-OPENED form does not hold the gate; one keystroke does', () => {
    renderAndOpenForm()
    // priority seeds to 'normal' — the field a truthiness guard would trip on for every user who
    // merely tapped "+ Add task".
    expect(screen.getByLabelText('Priority').value).toBe('normal')
    expect(isReloadBlocked(), 'a merely-opened form must not hold a deploy').toBe(false)
    // Paired in the SAME test: a lone "does not hold" assertion also passes with nothing wired.
    fireEvent.change(title(), { target: { value: 'W' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('clearing the typed title releases the hold', () => {
    renderAndOpenForm()
    fireEvent.change(title(), { target: { value: 'Water pepper seedlings' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.change(title(), { target: { value: '' } })
    expect(isReloadBlocked(), 'an emptied form has nothing left to protect').toBe(false)
  })

  it('the notes field alone holds the gate', () => {
    renderAndOpenForm()
    fireEvent.change(notes(), { target: { value: 'the two flats on the north rack' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('whitespace alone does NOT hold — the guard is the trimmed one', () => {
    renderAndOpenForm()
    fireEvent.change(title(), { target: { value: '   ' } })
    expect(isReloadBlocked(), 'a stray space must not hold the SW reload').toBe(false)
  })

  it('a due date and a priority change do NOT hold the gate', () => {
    renderAndOpenForm()
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-09-01' } })
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'high' } })
    // Both are one tap to redo. Counting either would hold a deploy for a user who only set a date.
    expect(isReloadBlocked(), 'picks must not hold the SW reload').toBe(false)
    // …and the guard still fires after them, so this is an exclusion and not a dead predicate.
    fireEvent.change(title(), { target: { value: 'Water pepper seedlings' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('Cancel releases the hold', () => {
    renderAndOpenForm()
    fireEvent.change(title(), { target: { value: 'Water pepper seedlings' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(screen.getByText('Cancel'))
    // Unlike ProjectTypes, this toggle also calls setForm(emptyForm()) — so both the showForm term
    // and the text term go false together. Asserted anyway: if the clear is ever dropped, the
    // showForm term must still carry the release on its own.
    expect(isReloadBlocked(), 'a cancelled form must not hold a deploy').toBe(false)
  })

  it('unmounting a dirty form RELEASES the hold (never wedge updates)', () => {
    const { unmount } = renderAndOpenForm()
    fireEvent.change(title(), { target: { value: 'half typed' } })
    expect(isReloadBlocked()).toBe(true)
    unmount()
    expect(isReloadBlocked()).toBe(false)
  })
})
