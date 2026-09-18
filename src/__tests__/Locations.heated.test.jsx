// V5-LOCHEATEDUI-001 — the Heated checkbox on the Locations edit form.
//
// The server refuses heated=true on a location that is not under cover (lambda/locations/heated.js).
// The form must therefore never ASK for that state: ticking Heated sets Rain shelter to Under cover,
// and leaving Under cover unticks Heated, in the same gesture. These tests drive the real page, the
// real reload gate and the real save path; only the network (useApiFetch) is faked.
//
// Why the coupling matters beyond the 400: heated=true silences every cold card for the plants in a
// location, and a covered location is already outside the frost alert. A form that let a tick ride
// along with "Open to the sky" would be one server check away from a silent location.
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

const HOUSE = {
  id: 'loc-house', name: 'House', slug: 'house', level: 0, type_label: 'zone',
  parent_id: null, sort_order: 0, description: null, is_active: true, covered: true, heated: true,
}

beforeEach(() => {
  clearReloadBlocks()
  locations.current = [HOUSE]
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/locations') return Promise.resolve({ locations: locations.current })
    if (path === '/api/locations/with-path') return Promise.resolve([])
    return Promise.resolve({})
  })
})

const byId = (id) => document.getElementById(id)
const heatedBox = () => screen.getByLabelText('Heated')
const coverSelect = () => byId('inline-edit-covered')

async function openEdit(row) {
  locations.current = [row]
  const out = render(<MemoryRouter><Locations /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText(row.name)).toBeTruthy())
  fireEvent.click(screen.getByLabelText('Actions'))
  fireEvent.click(screen.getByText(/Edit/))
  return out
}

const putBody = () => {
  const call = apiFetchSpy.mock.calls.find(([, opts]) => opts?.method === 'PUT')
  return call ? JSON.parse(call[1].body) : null
}

async function save() {
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(putBody()).not.toBeNull())
  return putBody()
}

describe('Heated — seeding and labelling', () => {
  it.each([
    [true, true],
    [false, false],
    // No key at all: a response cached before heated joined the GET. Unticked, and pristine.
    [undefined, false],
  ])('heated=%s seeds the box as %s, and a pristine open does not hold the reload gate', async (heated, checked) => {
    const row = { ...HOUSE }
    if (heated === undefined) delete row.heated
    else row.heated = heated
    await openEdit(row)
    expect(heatedBox().checked).toBe(checked)
    expect(isReloadBlocked(), 'seeding is not editing').toBe(false)
  })

  it('is a real checkbox named "Heated", described by the plain-language hint', async () => {
    await openEdit(HOUSE)
    const box = heatedBox()
    expect(box.type).toBe('checkbox')
    const hint = byId(box.getAttribute('aria-describedby'))
    expect(hint, 'aria-describedby must point at the hint').not.toBeNull()
    expect(hint.textContent).toMatch(/Kept warm in winter, like the House\. Plants here get no cold warnings\./)
  })

  it('the whole label row is at least the 44px tap floor (mobile)', async () => {
    await openEdit(HOUSE)
    // jsdom has no layout, so this reads the declared floor rather than a measured box; the
    // measured box is in the lane's 390px harness capture.
    expect(heatedBox().closest('label').style.minHeight).toBe('44px')
  })
})

describe('Heated ↔ Rain shelter coupling', () => {
  it('ticking Heated on an unclassified location sets Rain shelter to Under cover', async () => {
    await openEdit({ ...HOUSE, name: 'Greenhouse', covered: null, heated: false })
    expect(coverSelect().value).toBe('')
    fireEvent.click(heatedBox())
    expect(heatedBox().checked).toBe(true)
    expect(coverSelect().value).toBe('true')
  })

  it('ticking Heated on an open-sky location moves it under cover', async () => {
    await openEdit({ ...HOUSE, name: 'Bag Area', covered: false, heated: false })
    fireEvent.click(heatedBox())
    expect(coverSelect().value).toBe('true')
  })

  it('unticking Heated leaves Rain shelter where it was', async () => {
    await openEdit(HOUSE)
    fireEvent.click(heatedBox())
    expect(heatedBox().checked).toBe(false)
    expect(coverSelect().value, 'a warm room that stops being heated is still under a roof').toBe('true')
  })

  it.each([['false'], ['']])('moving Rain shelter off Under cover (to %j) unticks Heated', async (v) => {
    await openEdit(HOUSE)
    expect(heatedBox().checked).toBe(true)
    fireEvent.change(coverSelect(), { target: { value: v } })
    expect(heatedBox().checked).toBe(false)
  })

  it('moving back to Under cover does NOT re-tick Heated — warmth is never inferred', async () => {
    await openEdit(HOUSE)
    fireEvent.change(coverSelect(), { target: { value: 'false' } })
    fireEvent.change(coverSelect(), { target: { value: 'true' } })
    expect(heatedBox().checked).toBe(false)
  })
})

describe('Heated ↔ the reload gate', () => {
  it('a tick holds the gate and an untick back to the row releases it', async () => {
    await openEdit({ ...HOUSE, heated: false })
    fireEvent.click(heatedBox())
    expect(isReloadBlocked(), 'a pending heated edit must hold a deploy').toBe(true)
    fireEvent.click(heatedBox())
    expect(isReloadBlocked(), 'back at the row value is not a pending edit').toBe(false)
  })
})

describe('Heated → the PUT body', () => {
  it('ticking Heated sends heated:true with covered:true', async () => {
    await openEdit({ ...HOUSE, name: 'Sunroom', covered: null, heated: false })
    fireEvent.click(heatedBox())
    const body = await save()
    expect(body.heated).toBe(true)
    expect(body.covered).toBe(true)
  })

  it('moving a heated location off Under cover sends heated:false with covered:false', async () => {
    await openEdit(HOUSE)
    fireEvent.change(coverSelect(), { target: { value: 'false' } })
    const body = await save()
    expect(body.heated).toBe(false)
    expect(body.covered).toBe(false)
  })

  it('a rename of the heated House keeps heated:true — the value is re-sent, not reset', async () => {
    await openEdit(HOUSE)
    fireEvent.change(byId('inline-edit-name'), { target: { value: 'The House' } })
    const body = await save()
    expect(body.name).toBe('The House')
    expect(body.heated).toBe(true)
  })

  it('a row with no heated key sends no heated key — an unrelated edit cannot un-heat it', async () => {
    const stale = { ...HOUSE }
    delete stale.heated
    await openEdit(stale)
    fireEvent.change(byId('inline-edit-name'), { target: { value: 'The House' } })
    const body = await save()
    expect(body).not.toHaveProperty('heated')
  })

  it('…but ticking the box on such a row does send it', async () => {
    const stale = { ...HOUSE, covered: true }
    delete stale.heated
    await openEdit(stale)
    fireEvent.click(heatedBox())
    const body = await save()
    expect(body.heated).toBe(true)
  })
})

describe('Heated is edit-only', () => {
  it('neither add form renders it', async () => {
    locations.current = [HOUSE]
    render(<MemoryRouter><Locations /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('House')).toBeTruthy())
    fireEvent.click(screen.getByText('+ Add'))
    expect(screen.queryByLabelText('Heated')).toBeNull()
    fireEvent.click(screen.getByLabelText('Actions'))
    fireEvent.click(screen.getByText(/Add child/))
    expect(screen.queryByLabelText('Heated')).toBeNull()
  })
})
