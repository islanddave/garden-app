// V4-PUTUPENGINE-001 slice 2 — the recent-harvest picker + the landing page's primary CTA.
//
// WHY THIS EXISTS, in the numbers: 791 harvests logged in 2026 against 5 put-up records ever, 0 of
// 791 linked. Slice 1 gave Put-Up its own tab (discoverability). This slice attacks the remaining
// cost — re-typing crop/variety/planting/quantity/unit that the app already knows.
//
// Assertions read the POST BODY wherever a claim is about data, not component state: a prefill that
// looks right on screen and writes the wrong unit is the failure mode this whole slice is shaped
// around (harvest_log stores SINGULAR units, preservation_log's pick-list is PLURAL).
//
// Harness ported from PutUpStashHarvestLink.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
const uploadMock = vi.fn()
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadMock, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({
    cropTypes: [
      { slug: 'tomato', display_name: 'Tomato', category: 'vegetable' },
      { slug: 'pepper', display_name: 'Peppers', category: 'vegetable' },
    ],
    loading: false,
  }),
}))

import PutUp from '../pages/PutUp.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

// Entries in the shape lambda/harvests/aggregate.js projectEntry() emits.
function harvest(over = {}) {
  return {
    event_id: 'e-1',
    day_key: '2026-08-21',
    plant_id: 'p-1',
    planting_name: 'Sungold — wave 2',
    planting_removed: false,
    crop_type_slug: 'tomato',
    crop_name: 'Tomato',
    variety_id: null,
    variety_name: 'Sungold',
    quantity: '4',
    unit: 'cup',
    harvest_log_id: 'h-1',
    ...over,
  }
}

let harvestsResponse = { entries: [] }
let harvestsFails = false

function wire() {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path.startsWith('/api/harvests')) {
      return harvestsFails ? Promise.reject(new Error('boom')) : Promise.resolve(harvestsResponse)
    }
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/plants') && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ groups: [] })
    if (path === '/api/preservation' && method === 'POST') return Promise.resolve({ id: 'new-1', source_kind: 'own_garden' })
    return Promise.resolve(null)
  })
}
function lastPost() {
  const call = [...fetchMock.mock.calls].reverse().find(([, o]) => o?.method === 'POST')
  return call ? JSON.parse(call[1].body) : null
}
function renderPage(prefill) {
  const entry = prefill ? { pathname: '/put-up', state: { prefill } } : { pathname: '/put-up' }
  return render(<MemoryRouter initialEntries={[entry]}><PutUp /></MemoryRouter>)
}
const openLogForm = () => fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
const qtyField = () => screen.getByRole('textbox', { name: 'Quantity' })
const picks = () => screen.queryAllByTestId('recent-harvest-pick')
async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
  await waitFor(() => expect(lastPost()).not.toBeNull())
}

beforeEach(() => {
  fetchMock.mockReset(); uploadMock.mockReset()
  harvestsResponse = { entries: [] }; harvestsFails = false
  wire()
  sessionStorage.clear()
  clearReloadBlocks()
})

describe('primary CTA — the "start something new" slot the landing page lacked', () => {
  it('renders on the read view and opens the form', async () => {
    renderPage()
    const cta = await screen.findByTestId('putup-primary-cta')
    fireEvent.click(cta)
    await screen.findByRole('combobox', { name: 'Crop' })
  })

  it('is NOT rendered on the form view, where it would do nothing', async () => {
    renderPage()
    await screen.findByTestId('putup-primary-cta')
    openLogForm()
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(screen.queryByTestId('putup-primary-cta')).toBeNull()
  })
})

describe('recent-harvest picker', () => {
  it('lists recent harvests on the form view', async () => {
    harvestsResponse = { entries: [harvest(), harvest({ event_id: 'e-2', planting_name: 'Jalapeño bed', crop_type_slug: 'pepper', quantity: '12', unit: 'count', harvest_log_id: 'h-2' })] }
    renderPage()
    openLogForm()
    await waitFor(() => expect(picks()).toHaveLength(2))
    expect(screen.getByText('Sungold — wave 2')).toBeTruthy()
    expect(screen.getByText('Jalapeño bed')).toBeTruthy()
  })

  it('shows the amount in the HARVEST vocabulary so it matches the Harvests page', async () => {
    harvestsResponse = { entries: [harvest()] }
    renderPage()
    openLogForm()
    await waitFor(() => expect(picks()).toHaveLength(1))
    // '4 cup' as the harvest recorded it — NOT the '4 cups' that will be written.
    expect(screen.getByText('4 cup')).toBeTruthy()
    expect(screen.queryByText('4 cups')).toBeNull()
  })

  it('is hidden when the page was opened WITH a prefill — you already came from a harvest', async () => {
    harvestsResponse = { entries: [harvest()] }
    renderPage({ crop_type_slug: 'tomato', harvest_log_id: 'h-9' })
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(picks()).toHaveLength(0)
  })

  it('renders nothing at all when there are no harvests yet', async () => {
    harvestsResponse = { entries: [] }
    renderPage()
    openLogForm()
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(picks()).toHaveLength(0)
    expect(screen.queryByText('From a recent harvest')).toBeNull()
  })

  it('a failed fetch says so, instead of rendering identically to "no harvests"', async () => {
    // The sibling ready-band surface carries this exact defect as a named finding: a swallowed
    // fetch error that looks the same as an empty result. Distinct state, asserted.
    harvestsFails = true
    renderPage()
    openLogForm()
    expect(await screen.findByText(/Couldn.t load your recent harvests/)).toBeTruthy()
    expect(picks()).toHaveLength(0)
  })

  it('hides the overflow behind a REAL control, never inert "+N more" text', async () => {
    harvestsResponse = { entries: Array.from({ length: 9 }, (_, i) => harvest({ event_id: `e-${i}`, planting_name: `Bed ${i}` })) }
    renderPage()
    openLogForm()
    await waitFor(() => expect(picks()).toHaveLength(5))
    const more = screen.getByRole('button', { name: 'Show 4 more' })
    fireEvent.click(more)
    await waitFor(() => expect(picks()).toHaveLength(9))
  })
})

describe('picking a harvest prefills the form — and writes the MAPPED unit', () => {
  it('carries crop, planting, quantity and the harvest link to the wire', async () => {
    harvestsResponse = { entries: [harvest()] }
    renderPage()
    openLogForm()
    await waitFor(() => expect(picks()).toHaveLength(1))
    fireEvent.click(picks()[0])

    await waitFor(() => expect(qtyField().value).toBe('4'))
    await save()
    const body = lastPost()
    expect(body.crop_type_slug).toBe('tomato')
    expect(body.plant_id).toBe('p-1')
    expect(body.quantity_value).toBe(4)
    // THE POINT OF THE WHOLE SLICE: 'cup' -> 'cups'. Writing the harvest's own spelling here would
    // put a value outside the pick-list into the column.
    expect(body.quantity_unit).toBe('cups')
    expect(body.quantity_unit).not.toBe('cup')
    // 0 of 791 harvests have ever been linked to a put-up. This is the path that changes that.
    expect(body.harvest_log_id).toBe('h-1')
  })

  it('picking a kg harvest carries identity but NOT a converted quantity', async () => {
    harvestsResponse = { entries: [harvest({ unit: 'kg', quantity: '2.5' })] }
    renderPage()
    openLogForm()
    await waitFor(() => expect(picks()).toHaveLength(1))
    fireEvent.click(picks()[0])

    await screen.findByRole('combobox', { name: 'Crop' })
    // Quantity stays empty rather than becoming 2.5 lbs or 5.5 lbs — both would be a guess written
    // into a column the UI renders as fact.
    expect(qtyField().value).toBe('')
    // Identity still saved the user three pickers.
    expect(screen.getByRole('combobox', { name: 'Crop' }).value).toBe('tomato')
  })

  it('a mis-picked harvest can be corrected — Change clears the link and restores the picker', async () => {
    // Before this slice a wrong harvest_log_id was BOTH invisible (no control on the form) and
    // uncorrectable. The picker can now create one by mis-tap, so the exit is part of the feature.
    harvestsResponse = { entries: [
      harvest(),
      harvest({ event_id: 'e-2', planting_name: 'Jalapeño bed', crop_type_slug: 'pepper', quantity: '12', unit: 'count', harvest_log_id: 'h-2', plant_id: 'p-2' }),
    ] }
    renderPage()
    openLogForm()
    await waitFor(() => expect(picks()).toHaveLength(2))

    fireEvent.click(picks()[0])                                  // the WRONG one
    await waitFor(() => expect(qtyField().value).toBe('4'))
    expect(screen.getByTestId('putup-prefill-strip')).toBeTruthy()
    expect(picks()).toHaveLength(0)                              // picker yields to the strip

    fireEvent.click(screen.getByTestId('putup-prefill-clear'))
    await waitFor(() => expect(picks()).toHaveLength(2))         // picker is back
    expect(screen.queryByTestId('putup-prefill-strip')).toBeNull()
    // The AMOUNT survives the clear, and that is the pre-existing rule, not an accident of this
    // slice: a bare mount resumes the draft's visible fields and drops ONLY the harvest link
    // (BUG-PUTUPSTASHHARVLINK-001 — cropSlug and plantId already behave exactly this way).
    // Quantity is visible and editable on the form, so a stale one is correctable; harvest_log_id
    // is neither, which is why it alone is guarded. Asserted so the asymmetry is deliberate.
    expect(qtyField().value).toBe('4')

    fireEvent.click(picks()[1])                                  // the RIGHT one
    await waitFor(() => expect(qtyField().value).toBe('12'))
    await save()
    const body = lastPost()
    expect(body.harvest_log_id).toBe('h-2')                      // NOT h-1
    expect(body.quantity_value).toBe(12)
    expect(body.quantity_unit).toBe('count')
    expect(body.plant_id).toBe('p-2')
  })
})

describe('the reload gate is not held by a pristine prefilled mount', () => {
  it('a picked harvest does not block a service-worker reload before the user types', async () => {
    // guardDirty counts qtyValue, which is now prefill-seedable. Counting a seeded value would pin
    // the gate on the form's new PRIMARY entry path, before a keystroke — the same failure the
    // plant_id term was already shaped to avoid.
    harvestsResponse = { entries: [harvest()] }
    renderPage()
    openLogForm()
    await waitFor(() => expect(picks()).toHaveLength(1))
    fireEvent.click(picks()[0])
    await waitFor(() => expect(qtyField().value).toBe('4'))

    expect(isReloadBlocked()).toBe(false)

    // Non-vacuity: the gate CAN close on this form — typing a different amount is real user input.
    fireEvent.change(qtyField(), { target: { value: '7' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })
})
