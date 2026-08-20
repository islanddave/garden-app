// V4-DIRTYGUARDSWEEP-001 — Locations ↔ the service-worker reload gate.
//
// Driven against the REAL reloadGate, never a spy on setReloadBlocked: V4-RELOADGATEWIRE-001 shipped
// the primitive with no callers while its own unit tests stayed green, so a "was it called" spy
// would rebuild exactly the blind spot this row closes.
//
// Locations is the hardest of the four pages in this sweep because it carries THREE forms that can
// be open at once, seeded three different ways:
//   • Add location   — starts empty          → typed name is the signal
//   • Add child      — starts empty          → typed name is the signal
//   • Inline edit    — SEEDED FROM THE ROW   → only "differs from the row" means anything
// The edit form is the sharpest false-positive case anywhere in the sweep: its four original fields
// are all non-empty the instant it opens, so a truthiness guard would hold a service-worker update
// for anyone who tapped ✏️ Edit and changed nothing.
// V4-COVEREDNOTMODELLED-001 added a fifth, `covered`, which cuts the OTHER way: it seeds EMPTY on any
// row nobody has classified. So the two naive guards now fail in opposite directions on the same
// form — truthiness holds the gate on a pristine open, and emptiness would ignore a real edit that
// changes a bed from unstated to under-cover. Only "differs from the row" is right for both.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { apiFetchSpy, locations } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  locations: { current: [] },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))

import Locations from '../pages/Locations.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

const ZONE = {
  id: 'loc1', name: 'Stable', slug: 'stable', level: 0, type_label: 'area',
  parent_id: null, sort_order: 3, description: 'the old horse barn', is_active: true,
}

beforeEach(() => {
  clearReloadBlocks()
  locations.current = [ZONE]
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/locations') return Promise.resolve(locations.current)
    if (path === '/api/locations/with-path') return Promise.resolve([])
    return Promise.resolve({})
  })
})

async function renderPage() {
  const out = render(<MemoryRouter><Locations /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText('Stable')).toBeTruthy())
  return out
}

// Ids, not labels: with two forms open there are two controls labelled "Name".
const byId = (id) => document.getElementById(id)

async function openMenuItem(pattern) {
  fireEvent.click(screen.getByLabelText('Actions'))
  fireEvent.click(screen.getByText(pattern))
}

describe('Locations ↔ dirty guard — add location form', () => {
  it('a merely-OPENED add form does not hold the gate; one keystroke does', async () => {
    await renderPage()
    fireEvent.click(screen.getByText('+ Add'))
    expect(byId('add-loc-name')).toBeTruthy()
    expect(isReloadBlocked(), 'a merely-opened add form must not hold a deploy').toBe(false)
    // Paired in the SAME test: a lone "does not hold" assertion also passes with nothing wired.
    fireEvent.change(byId('add-loc-name'), { target: { value: 'I' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('clearing the typed name releases the hold', async () => {
    await renderPage()
    fireEvent.click(screen.getByText('+ Add'))
    fireEvent.change(byId('add-loc-name'), { target: { value: 'Indoor Rack' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.change(byId('add-loc-name'), { target: { value: '' } })
    expect(isReloadBlocked(), 'an emptied form has nothing left to protect').toBe(false)
  })

  it('whitespace alone does NOT hold — the guard is the trimmed one', async () => {
    await renderPage()
    fireEvent.click(screen.getByText('+ Add'))
    fireEvent.change(byId('add-loc-name'), { target: { value: '   ' } })
    expect(isReloadBlocked(), 'a stray space must not hold the SW reload').toBe(false)
  })

  it('choosing a Type does NOT hold the gate', async () => {
    await renderPage()
    fireEvent.click(screen.getByText('+ Add'))
    fireEvent.change(byId('add-loc-type'), { target: { value: 'area' } })
    expect(isReloadBlocked(), 'a pick must not hold the SW reload').toBe(false)
    // …and the guard still fires after it, so this is an exclusion and not a dead predicate.
    fireEvent.change(byId('add-loc-name'), { target: { value: 'Indoor Rack' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('Cancel releases the hold', async () => {
    await renderPage()
    fireEvent.click(screen.getByText('+ Add'))
    fireEvent.change(byId('add-loc-name'), { target: { value: 'Indoor Rack' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(screen.getByText('Cancel'))
    expect(isReloadBlocked(), 'a cancelled form must not hold a deploy').toBe(false)
  })
})

describe('Locations ↔ dirty guard — inline edit form', () => {
  it('a merely-OPENED edit form does not hold the gate, even though every field is pre-filled', async () => {
    await renderPage()
    await openMenuItem(/Edit/)
    // All four seeded and non-empty on arrival. This is what a truthiness guard would trip on.
    expect(byId('inline-edit-name').value).toBe('Stable')
    expect(byId('inline-edit-type').value).toBe('area')
    expect(byId('inline-edit-sort').value).toBe('3')
    expect(byId('inline-edit-desc').value).toBe('the old horse barn')
    expect(isReloadBlocked(), 'an opened-but-unedited row must not hold a deploy').toBe(false)
    fireEvent.change(byId('inline-edit-name'), { target: { value: 'Stables' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('reverting the edit back to the row value releases the hold', async () => {
    await renderPage()
    await openMenuItem(/Edit/)
    fireEvent.change(byId('inline-edit-name'), { target: { value: 'Stables' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.change(byId('inline-edit-name'), { target: { value: 'Stable' } })
    expect(isReloadBlocked(), 'back at the row value is not a pending edit').toBe(false)
  })

  it('each of the other three fields flips the gate on its own', async () => {
    // Unlike the add forms, picks DO count here: on an edit, a changed Type or Sort order is a
    // pending change to existing data that a reload would silently revert, and "differs from the
    // row" is false on a pristine open — so there is no false positive to trade against.
    await renderPage()
    await openMenuItem(/Edit/)
    for (const [id, dirty, seed] of [
      ['inline-edit-type', 'bed',      'area'],
      ['inline-edit-sort', '7',        '3'],
      ['inline-edit-desc', 'rebuilt',  'the old horse barn'],
      // V4-COVEREDNOTMODELLED-001. Seeds to '' here because ZONE carries no `covered` key at all —
      // the shape a client cached before that column joined the GET projection. Marking a bed as
      // under cover is the single highest-consequence edit on this form (it stops the watering model
      // counting rainfall for everything in it), so a reload silently reverting it is the worst
      // instance of exactly what this gate exists to prevent.
      ['inline-edit-covered', 'true',  ''],
    ]) {
      fireEvent.change(byId(id), { target: { value: dirty } })
      expect(isReloadBlocked(), `${id} must hold the gate`).toBe(true)
      fireEvent.change(byId(id), { target: { value: seed } })
      expect(isReloadBlocked(), `${id} must release on revert`).toBe(false)
    }
  })

  it('V4-COVEREDNOTMODELLED-001: cover seeds as a TRI-state, and "not stated" is not "not covered"', async () => {
    // The reason this control is a <select> and not a checkbox. A checkbox has two renderings for a
    // three-valued column, so it must show an unstated bed as unchecked — a positive claim that rain
    // reaches it, made by the UI on Dave's behalf about a bed nobody has classified. Here the three
    // states are distinguishable on sight, and only the two Dave picked are ever sent.
    for (const [covered, expected] of [[true, 'true'], [false, 'false'], [null, ''], [undefined, '']]) {
      clearReloadBlocks()
      locations.current = [{ ...ZONE, covered }]
      const { unmount } = await renderPage()
      await openMenuItem(/Edit/)
      expect(byId('inline-edit-covered').value, `covered=${covered} must seed as '${expected}'`).toBe(expected)
      // And seeding must never be mistaken for editing, whichever of the three it seeded to.
      expect(isReloadBlocked(), `a pristine open on covered=${covered} must not hold the gate`).toBe(false)
      unmount()
    }
  })

  it('Cancel on the edit form releases the hold', async () => {
    await renderPage()
    await openMenuItem(/Edit/)
    fireEvent.change(byId('inline-edit-name'), { target: { value: 'Stables' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(screen.getByText('Cancel'))
    expect(isReloadBlocked(), 'a cancelled edit must not hold a deploy').toBe(false)
  })
})

describe('Locations ↔ dirty guard — add child form', () => {
  it('a merely-OPENED add-child form does not hold the gate; one keystroke does', async () => {
    await renderPage()
    await openMenuItem(/Add child/)
    expect(byId('add-child-name')).toBeTruthy()
    expect(isReloadBlocked(), 'a merely-opened add-child form must not hold a deploy').toBe(false)
    fireEvent.change(byId('add-child-name'), { target: { value: 'North bay' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('clearing the typed child name releases the hold', async () => {
    await renderPage()
    await openMenuItem(/Add child/)
    fireEvent.change(byId('add-child-name'), { target: { value: 'North bay' } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.change(byId('add-child-name'), { target: { value: '' } })
    expect(isReloadBlocked()).toBe(false)
  })
})

describe('Locations ↔ dirty guard — three forms, one union', () => {
  it('closing one dirty form does not release a hold the other still owns', async () => {
    // The predicate is a union of three independent terms. If it ever collapses into one shared
    // boolean, this is the test that catches it: the add form closing would drop the edit's hold.
    await renderPage()
    // Captured before the click: this same node is what relabels to "Cancel", and with the edit
    // form also open there are two buttons reading "Cancel".
    const headerToggle = screen.getByText('+ Add')
    fireEvent.click(headerToggle)
    fireEvent.change(byId('add-loc-name'), { target: { value: 'Indoor Rack' } })
    await openMenuItem(/Edit/)
    fireEvent.change(byId('inline-edit-name'), { target: { value: 'Stables' } })
    expect(isReloadBlocked()).toBe(true)

    // Collapse the add form only — the header toggle clears its fields too.
    fireEvent.click(headerToggle)
    expect(isReloadBlocked(), 'the pending edit still has something to protect').toBe(true)

    fireEvent.change(byId('inline-edit-name'), { target: { value: 'Stable' } })
    expect(isReloadBlocked(), 'both terms clean → release').toBe(false)
  })

  it('unmounting with a dirty form RELEASES the hold (never wedge updates)', async () => {
    const { unmount } = await renderPage()
    fireEvent.click(screen.getByText('+ Add'))
    fireEvent.change(byId('add-loc-name'), { target: { value: 'half typed' } })
    expect(isReloadBlocked()).toBe(true)
    unmount()
    expect(isReloadBlocked()).toBe(false)
  })
})
