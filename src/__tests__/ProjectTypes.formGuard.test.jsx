// V4-DIRTYGUARDSWEEP-001 — ProjectTypes ↔ the service-worker reload gate.
//
// Driven against the REAL reloadGate, never a spy on setReloadBlocked. V4-RELOADGATEWIRE-001 shipped
// reloadGate.js fully built and mutation-proved while nothing in the app CALLED it, and its own unit
// tests stayed green throughout — a primitive cannot see that it has no callers. So every assertion
// here reads isReloadBlocked() after driving the real page.
//
// The false-positive tests are the point, not padding. This form arrives with category='garden' and
// icon='🌱' already set, so a truthiness guard would hold a service-worker update (deferred, per
// BUG-STALECLIENT-001, but held) for every user who merely tapped "+ New type".
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'user_dave' } }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import ProjectTypes from '../pages/ProjectTypes.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

beforeEach(() => {
  clearReloadBlocks()
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/projects/types') return Promise.resolve([])
    return Promise.resolve({})
  })
})

async function renderAndOpenForm() {
  const out = render(<ProjectTypes />)
  await waitFor(() => expect(screen.getByText('Project Types')).toBeTruthy())
  fireEvent.click(screen.getByText('+ New type'))
  await waitFor(() => expect(screen.getByLabelText('Name *')).toBeTruthy())
  return out
}

const name = () => screen.getByLabelText('Name *')
const description = () => screen.getByLabelText('Description')

describe('ProjectTypes ↔ dirty guard', () => {
  it('a merely-OPENED form does not hold the gate; one keystroke does', async () => {
    await renderAndOpenForm()
    // Both seeded fields are non-empty on arrival — this is what a truthiness guard would trip on.
    expect(screen.getByLabelText('Category *').value).toBe('garden')
    expect(isReloadBlocked(), 'a merely-opened form must not hold a deploy').toBe(false)
    // Paired in the SAME test deliberately: a lone "does not hold" assertion also passes when
    // nothing is wired at all, so it discriminates nothing on its own.
    fireEvent.change(name(), { target: { value: 'F' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('clearing the typed name releases the hold', async () => {
    await renderAndOpenForm()
    fireEvent.change(name(), { target: { value: 'Fruit Trees' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.change(name(), { target: { value: '' } })
    expect(isReloadBlocked(), 'an emptied form has nothing left to protect').toBe(false)
  })

  it('the description alone holds the gate', async () => {
    await renderAndOpenForm()
    fireEvent.change(description(), { target: { value: 'anything with a trunk' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('whitespace alone does NOT hold — the guard is the trimmed one', async () => {
    await renderAndOpenForm()
    fireEvent.change(name(), { target: { value: '   ' } })
    expect(isReloadBlocked(), 'a stray space must not hold the SW reload').toBe(false)
  })

  it('an icon chip tap and a category change do NOT hold the gate', async () => {
    await renderAndOpenForm()
    fireEvent.click(screen.getByText('🍅'))
    fireEvent.change(screen.getByLabelText('Category *'), { target: { value: 'infrastructure' } })
    // Both moved off their seed and both are one tap to redo. The icon grid and the free-text icon
    // box write the SAME field, so counting either would make a chip tap hold a deploy.
    expect(isReloadBlocked(), 'picks must not hold the SW reload').toBe(false)
    // …and the guard still works after them, so this is an exclusion, not a dead predicate.
    fireEvent.change(name(), { target: { value: 'Fruit Trees' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('collapsing the form with Cancel releases the hold, and the text is still there on re-open', async () => {
    await renderAndOpenForm()
    fireEvent.change(name(), { target: { value: 'Fruit Trees' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(screen.getByText('Cancel'))
    // Cancel only collapses — it does not clear — so this proves the showForm term is doing the
    // releasing. Off-screen text the user dismissed must not keep holding a deploy they cannot see.
    expect(isReloadBlocked(), 'a collapsed form must not hold a deploy').toBe(false)
    fireEvent.click(screen.getByText('+ New type'))
    expect(name().value).toBe('Fruit Trees')
    expect(isReloadBlocked()).toBe(true)
  })

  it('unmounting a dirty form RELEASES the hold (never wedge updates)', async () => {
    const { unmount } = await renderAndOpenForm()
    fireEvent.change(name(), { target: { value: 'half typed' } })
    expect(isReloadBlocked()).toBe(true)
    unmount()
    expect(isReloadBlocked()).toBe(false)
  })
})
