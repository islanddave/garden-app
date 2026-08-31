// V4-PUTUPSESSION-001 slice 0 — the freezer walk, end to end through the DOM.
//
// WHAT THESE ASSERT AND WHAT THEY CANNOT. Every claim here is about STATE and the WIRE: which
// fields are on the fast path, what the POST body carries, what the band offers, what survives the
// tab being torn down. None of them is about geometry — jsdom returns zeros from
// getBoundingClientRect (tests/harness/README.md:14-16), so the number pad's clearance against the
// band is measured at runtime by the band's own ResizeObserver and verified in the browser harness,
// not certified here.
//
// The load-bearing assertions are the ones that read `lastPost()`: a walk that shows the right
// things and posts the wrong ones would still leave 37.2 lb of blueberries wrong in the database.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({
    cropTypes: [
      { slug: 'blueberry', display_name: 'Blueberries', category: 'fruit' },
      { slug: 'tomato', display_name: 'Tomato', category: 'vegetable' },
    ],
    loading: false,
  }),
}))

import PutUp from '../pages/PutUp.jsx'

// The real shape, trimmed: blueberry has exactly ONE planting (measured on prod 2026-08-31 — 48
// harvests, 37.2 lb, one plant), tomato has two. That contrast is the whole auto-resolution rule.
const PLANTS = [
  { id: 'p-blue', name: 'Blueberries', variety_ref: { id: 'v-blue', name: 'Blueberries', crop_type_slug: 'blueberry' } },
  { id: 'p-tom-1', name: 'Sungold', variety_ref: { id: 'v-sg', name: 'Sungold', crop_type_slug: 'tomato' } },
  { id: 'p-tom-2', name: 'San Marzano', variety_ref: { id: 'v-sm', name: 'San Marzano', crop_type_slug: 'tomato' } },
]
const LOCATIONS = [
  { id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' },
  { id: 'loc-2', label: 'Chest Freezer 2', kind: 'deep_freezer' },
]

function wire(overrides = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve(LOCATIONS)
    if (path.startsWith('/api/plants') && method === 'GET') return Promise.resolve(PLANTS)
    if (path.startsWith('/api/harvests')) return Promise.resolve(overrides.harvests ?? { aggregates: { crops: [] } })
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve(overrides.stores ?? { groups: [] })
    if (path === '/api/preservation' && method === 'POST') {
      return Promise.resolve({ id: 'new-1', source_kind: 'own_garden', crop_type_slug: JSON.parse(options.body).crop_type_slug })
    }
    if (path.startsWith('/api/preservation/') && method === 'DELETE') return Promise.resolve({ ok: true })
    return Promise.resolve(null)
  })
}
function lastPost() {
  const call = [...fetchMock.mock.calls].reverse().find(([, o]) => o?.method === 'POST')
  return call ? JSON.parse(call[1].body) : null
}
function lastDelete() {
  const call = [...fetchMock.mock.calls].reverse().find(([, o]) => o?.method === 'DELETE')
  return call ? call[0] : null
}

function renderWalk(search = '?session=putup') {
  return render(<MemoryRouter initialEntries={[`/put-up${search}`]}><PutUp /></MemoryRouter>)
}

// The two setup answers, as taps. Returns once the form is on screen.
async function answerSetup({ freezer = 'Chest Freezer 1', when = 'This summer' } = {}) {
  fireEvent.click(await screen.findByRole('button', { name: freezer }))
  fireEvent.click(screen.getByRole('button', { name: when }))
  fireEvent.click(screen.getByTestId('putup-walk-start'))
  await screen.findByRole('combobox', { name: 'Crop' })
}
const pickCrop = (slug) => fireEvent.change(screen.getByRole('combobox', { name: 'Crop' }), { target: { value: slug } })
const bagsField = () => screen.getByRole('spinbutton', { name: 'How many bags or jars' })
const typeQty = (v) => fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: v } })
async function saveItem() {
  const before = fetchMock.mock.calls.filter(([, o]) => o?.method === 'POST').length
  fireEvent.click(screen.getByRole('button', { name: 'Save & next' }))
  await waitFor(() => expect(fetchMock.mock.calls.filter(([, o]) => o?.method === 'POST').length).toBe(before + 1))
}

beforeEach(() => {
  fetchMock.mockReset(); wire()
  localStorage.clear(); sessionStorage.clear()
})

describe('the walk is a MODE FLAG, not a new page', () => {
  it('?session=putup opens the walk; the bare route is the shipped page', async () => {
    renderWalk()
    expect(await screen.findByText('Which freezer are you at?')).toBeTruthy()
    // Non-vacuity: the same component with no param is the ordinary Put-Up page.
  })

  it('without the param the page is untouched', async () => {
    renderWalk('')
    expect(await screen.findByRole('heading', { name: 'Put-Up' })).toBeTruthy()
    expect(screen.queryByText('Which freezer are you at?')).toBeNull()
  })

  it('the Put-Up page offers a door into the walk', async () => {
    renderWalk('')
    expect(await screen.findByTestId('putup-walk-door')).toBeTruthy()
  })
})

describe('the offline pre-flight — find out BEFORE the walk, not after each item', () => {
  it('blocks the start and says why when the device reports no network', async () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      renderWalk()
      expect((await screen.findByTestId('putup-walk-offline')).textContent).toMatch(/nothing you log here will save/i)
      // The gate is the Start button, not a message beside an enabled one: Put-Up refuses to save
      // anything offline, so starting would buy thirty minutes of work and zero rows.
      fireEvent.click(await screen.findByRole('button', { name: 'Chest Freezer 1' }))
      fireEvent.click(screen.getByRole('button', { name: 'This summer' }))
      expect(screen.getByTestId('putup-walk-start').disabled).toBe(true)
    } finally { spy.mockRestore() }
  })

  it('clears itself the moment the connection comes back', async () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    renderWalk()
    await screen.findByTestId('putup-walk-offline')
    spy.mockReturnValue(true)
    fireEvent(window, new Event('online'))
    await waitFor(() => expect(screen.queryByTestId('putup-walk-offline')).toBeNull())
    spy.mockRestore()
  })

  it('does not block a start when the device is online', async () => {
    renderWalk()
    fireEvent.click(await screen.findByRole('button', { name: 'Chest Freezer 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'This summer' }))
    expect(screen.getByTestId('putup-walk-start').disabled).toBe(false)
  })
})

describe('the two questions, asked once and applied to every save', () => {
  it('needs BOTH answers before the walk can start', async () => {
    renderWalk()
    const start = await screen.findByTestId('putup-walk-start')
    expect(start.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Chest Freezer 1' }))
    expect(start.disabled).toBe(true)             // freezer alone is not enough
    fireEvent.click(screen.getByRole('button', { name: 'This summer' }))
    expect(start.disabled).toBe(false)
  })

  it('SHOWS the date it will record, and says an estimate is an estimate', async () => {
    renderWalk()
    fireEvent.click(await screen.findByRole('button', { name: 'This summer' }))
    // "a wrong default launders a wrong decision" — the resolved date is on screen before he starts.
    expect(screen.getByTestId('putup-walk-date-resolved').textContent).toMatch(/around /)
    expect(screen.getByTestId('putup-walk-date-resolved').textContent).toMatch(/an estimate, not a date you picked/)
  })

  it('a date he PICKS is not described as an estimate', async () => {
    renderWalk()
    fireEvent.click(await screen.findByRole('button', { name: 'Pick a date' }))
    fireEvent.change(screen.getByLabelText('Put-up date'), { target: { value: '2026-07-04' } })
    const line = screen.getByTestId('putup-walk-date-resolved')
    expect(line.textContent).not.toMatch(/around /)
    expect(line.textContent).not.toMatch(/an estimate/)
  })

  it('puts BOTH answers on the wire for an item, with no per-item taps', async () => {
    renderWalk()
    await answerSetup()
    pickCrop('blueberry')
    fireEvent.change(bagsField(), { target: { value: '12' } })
    typeQty('1')
    await saveItem()
    expect(lastPost()).toMatchObject({
      crop_type_slug: 'blueberry',
      package_count: 12,
      storage_location_id: 'loc-1',
      source_kind: 'own_garden',
    })
    // The date is the coarse answer resolved at setup, never today-by-default.
    expect(lastPost().preserved_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(lastPost().preserved_at).not.toBe(new Date().toISOString().slice(0, 10))
  })

  it('carries the answers to the NEXT item without re-asking', async () => {
    renderWalk()
    await answerSetup()
    pickCrop('blueberry')
    fireEvent.change(bagsField(), { target: { value: '12' } })
    typeQty('1')
    await saveItem()
    const first = lastPost()
    // The form stays put — no success screen to tap past sixty times.
    expect(screen.getByRole('button', { name: 'Save & next' })).toBeTruthy()
    fireEvent.change(bagsField(), { target: { value: '4' } })
    typeQty('2')
    await saveItem()
    expect(lastPost().package_count).toBe(4)
    expect(lastPost().storage_location_id).toBe(first.storage_location_id)
    expect(lastPost().preserved_at).toBe(first.preserved_at)
  })
})

// V4-PUTUPSESSION-001 slice 1. Slice 0 knew the date was an estimate and had nowhere to put it, so
// the record read back as a date Dave picked. These are the assertions that say it now travels.
describe('an estimate is STORED as an estimate, not just spoken about on screen', () => {
  it('a coarse answer puts preserved_at_approx TRUE on the wire', async () => {
    renderWalk()
    await answerSetup({ when: 'This summer' })
    pickCrop('blueberry')
    typeQty('1')
    await saveItem()
    expect(lastPost().preserved_at_approx).toBe(true)
  })

  it('a date he PICKS puts FALSE — a recorded fact, not an omission', async () => {
    // Absent would mean NULL in the column, i.e. "nobody was ever asked", which is false here: he
    // was asked and he answered with a calendar date.
    renderWalk()
    fireEvent.click(await screen.findByRole('button', { name: 'Chest Freezer 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pick a date' }))
    fireEvent.change(screen.getByLabelText('Put-up date'), { target: { value: '2026-07-04' } })
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByRole('combobox', { name: 'Crop' })
    pickCrop('blueberry')
    typeQty('1')
    await saveItem()
    expect(lastPost().preserved_at).toBe('2026-07-04')
    expect(lastPost().preserved_at_approx).toBe(false)
    expect('preserved_at_approx' in lastPost()).toBe(true)
  })

  it('typing an exact date for ONE item stops that item being an estimate', async () => {
    // The setup copy promises exactly this: "change it for any item you know exactly". Typing a date
    // is the only act in the form that obtains a date FROM him, so it is the only thing that can
    // turn the estimate into a fact.
    renderWalk()
    await answerSetup({ when: 'This summer' })
    pickCrop('blueberry')
    typeQty('1')
    fireEvent.change(screen.getByLabelText('Put-up date'), { target: { value: '2026-08-02' } })
    await saveItem()
    expect(lastPost().preserved_at).toBe('2026-08-02')
    expect(lastPost().preserved_at_approx).toBe(false)
  })

  it('the flag never separates from the date it qualifies', async () => {
    // Slice 0 carries a corrected date forward to the next item (resetForNext leaves it alone, the
    // same way it leaves the freezer alone). The flag has to travel with it: reverting on its own
    // would re-label a date he typed as a guess, and staying true would be the original defect.
    renderWalk()
    await answerSetup({ when: 'This summer' })
    pickCrop('blueberry')
    typeQty('1')
    fireEvent.change(screen.getByLabelText('Put-up date'), { target: { value: '2026-08-02' } })
    await saveItem()
    expect(lastPost()).toMatchObject({ preserved_at: '2026-08-02', preserved_at_approx: false })

    typeQty('2')
    await saveItem()
    expect(lastPost()).toMatchObject({ preserved_at: '2026-08-02', preserved_at_approx: false })

    // A genuinely different session answer moves the PAIR — not the date with a stale flag on it.
    fireEvent.click(screen.getByTestId('putup-walk-change'))
    fireEvent.click(await screen.findByRole('button', { name: 'Earlier this year' }))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByRole('combobox', { name: 'Crop' })
    typeQty('3')
    await saveItem()
    expect(lastPost().preserved_at).not.toBe('2026-08-02')
    expect(lastPost().preserved_at_approx).toBe(true)
  })

  it('says on the form itself that the date it is about to save is an estimate', async () => {
    renderWalk()
    await answerSetup({ when: 'This summer' })
    expect(screen.getByText(/an estimate, not a date you picked/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Put-up date'), { target: { value: '2026-08-02' } })
    expect(screen.queryByText(/an estimate, not a date you picked/)).toBeNull()
  })
})

describe('the inversion — the bag count is the number the inventory actually reports', () => {
  it('"How many bags / jars?" is on the fast path in the walk, not behind More', async () => {
    renderWalk()
    await answerSetup()
    expect(bagsField()).toBeTruthy()
    // The reveal it used to hide in is still there and no longer holds it.
    fireEvent.click(screen.getByRole('button', { name: /More/ }))
    expect(screen.queryByLabelText('Number of containers')).toBeNull()
  })

  it('is promoted on the ORDINARY form too — the read surface sums the same column everywhere', async () => {
    renderWalk('')
    fireEvent.click(await screen.findByRole('radio', { name: 'Log a put-up' }))
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(screen.getByRole('spinbutton', { name: 'How many bags or jars' })).toBeTruthy()
  })

  it('the walk gives it a number pad whose decimal key is dead — package_count is an integer', async () => {
    renderWalk()
    await answerSetup()
    // Build semantics, from the shipped default of '1': backspace it away, then tap 1 then 2.
    fireEvent.click(screen.getByTestId('pu-bagpad-back'))
    expect(bagsField().value).toBe('')
    fireEvent.click(screen.getByTestId('pu-bagpad-1'))
    fireEvent.click(screen.getByTestId('pu-bagpad-2'))
    expect(bagsField().value).toBe('12')
    // A bag count is an integer column — the decimal key is dead rather than absent, so no tap
    // target moves (comboboxInput.js:138-144).
    expect(screen.getByTestId('pu-bagpad-dot').disabled).toBe(true)
    fireEvent.click(screen.getByTestId('pu-bagpad-back'))
    expect(bagsField().value).toBe('1')
  })

  it('the ordinary form gets NO pad — it is a walk affordance', async () => {
    renderWalk('')
    fireEvent.click(await screen.findByRole('radio', { name: 'Log a put-up' }))
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(screen.queryByTestId('pu-bagpad-1')).toBeNull()
  })

  it('never proposes a quantity of its own — the app knows 37.2 lb and must not offer it', async () => {
    renderWalk()
    await answerSetup()
    pickCrop('blueberry')
    await waitFor(() => expect(screen.getByTestId('pu-auto-planting')).toBeTruthy())
    expect(screen.getByRole('textbox', { name: 'Quantity' }).value).toBe('')
    expect(bagsField().value).toBe('1')   // the shipped default, not a derived figure
  })
})

describe('auto-resolving the planting — stated, never silent', () => {
  it('fills in the only planting of a crop AND says so on screen', async () => {
    renderWalk()
    await answerSetup()
    pickCrop('blueberry')
    const line = await screen.findByTestId('pu-auto-planting')
    expect(line.textContent).toMatch('My garden')
    expect(line.textContent).toMatch('Blueberries')
    expect(line.textContent).toMatch(/the only planting of this crop/)
    fireEvent.change(bagsField(), { target: { value: '12' } })
    typeQty('1')
    await saveItem()
    expect(lastPost().plant_id).toBe('p-blue')
  })

  it('does NOT guess when the crop has two plantings — two is a choice', async () => {
    renderWalk()
    await answerSetup()
    pickCrop('tomato')
    await waitFor(() => expect(fetchMock.mock.calls.some(([p]) => p.startsWith('/api/plants'))).toBe(true))
    expect(screen.queryByTestId('pu-auto-planting')).toBeNull()
    typeQty('1')
    await saveItem()
    expect(lastPost().plant_id).toBeUndefined()
  })

  it('revises its own guess when the crop changes, and withdraws it when the new crop is ambiguous', async () => {
    renderWalk()
    await answerSetup()
    pickCrop('blueberry')
    await screen.findByTestId('pu-auto-planting')
    pickCrop('tomato')
    await waitFor(() => expect(screen.queryByTestId('pu-auto-planting')).toBeNull())
    typeQty('1')
    await saveItem()
    expect(lastPost().plant_id).toBeUndefined()   // no stale blueberry plant on a tomato row
  })
})

describe('the band — an honest record of what happened, and a deliberate exit', () => {
  it('shows the item just saved, with an Undo that really deletes it', async () => {
    renderWalk()
    await answerSetup()
    pickCrop('blueberry')
    fireEvent.change(bagsField(), { target: { value: '12' } })
    typeQty('1')
    await saveItem()
    const band = screen.getByTestId('putup-walk-band')
    expect(within(band).getByTestId('putup-walk-last').textContent).toMatch('12 × Blueberries')
    fireEvent.click(within(band).getByTestId('putup-walk-undo'))
    await waitFor(() => expect(lastDelete()).toBe('/api/preservation/new-1'))
    // Undone rows stay listed struck through — the band is not a mutable cart.
    expect(within(band).getByTestId('putup-walk-last').textContent).toMatch('Undone')
    expect(within(band).queryByTestId('putup-walk-undo')).toBeNull()
  })

  it('always carries the sitting\'s freezer and date, marked as an estimate', async () => {
    renderWalk()
    await answerSetup()
    expect(screen.getByTestId('putup-walk-band').textContent).toMatch(/Chest Freezer 1 · around /)
  })

  it('has an exit built in from the start, and exiting ends the walk', async () => {
    renderWalk()
    await answerSetup()
    fireEvent.click(screen.getByTestId('putup-walk-exit'))
    await waitFor(() => expect(screen.queryByTestId('putup-walk-band')).toBeNull())
    expect(localStorage.getItem('garden:putup-walk:v1')).toBeNull()
  })

  it('suppresses the bottom nav while the walk is open and gives it back on exit', async () => {
    renderWalk()
    await answerSetup()
    expect(document.getElementById('putup-walk-nav-suppress')).not.toBeNull()
    expect(document.documentElement.style.getPropertyValue('--bottom-nav-height')).toBe('0px')
    fireEvent.click(screen.getByTestId('putup-walk-exit'))
    await waitFor(() => expect(document.getElementById('putup-walk-nav-suppress')).toBeNull())
  })
})

describe('pick up where you left off — sixty-plus items over several evenings', () => {
  it('a fresh walk asks the two questions; a stashed one skips straight back in', async () => {
    localStorage.setItem('garden:putup-walk:v1', JSON.stringify({
      v: 1, storageId: 'loc-2', date: '2026-07-16', dateApprox: true, dateChoice: 'summer',
      cropSlug: 'blueberry', savedCount: 7,
    }))
    renderWalk()
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(screen.queryByText('Which freezer are you at?')).toBeNull()
    expect(screen.getByTestId('putup-walk-resumed').textContent).toMatch('7 logged so far')
    // The PLACE comes back too: the freezer, the date and the crop he was standing in front of.
    expect(screen.getByTestId('putup-walk-band').textContent).toMatch('Chest Freezer 2')
    expect(screen.getByRole('combobox', { name: 'Crop' }).value).toBe('blueberry')
  })

  it('the stash is written as the walk goes, so a torn-down tab loses nothing but its place on screen', async () => {
    renderWalk()
    await answerSetup({ freezer: 'Chest Freezer 2' })
    pickCrop('blueberry')
    fireEvent.change(bagsField(), { target: { value: '3' } })
    typeQty('1')
    await saveItem()
    await waitFor(() => {
      const stash = JSON.parse(localStorage.getItem('garden:putup-walk:v1'))
      expect(stash).toMatchObject({ storageId: 'loc-2', savedCount: 1, cropSlug: 'blueberry', dateApprox: true })
    })
  })

  it('"Change" reopens the two questions mid-walk without ending it', async () => {
    renderWalk()
    await answerSetup()
    fireEvent.click(screen.getByTestId('putup-walk-change'))
    expect(await screen.findByText('Which freezer are you at?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Chest Freezer 2' }))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(screen.getByTestId('putup-walk-band').textContent).toMatch('Chest Freezer 2')
  })
})

describe('"what haven\'t I put up?" — one collapsed line that cannot become a nag', () => {
  const harvests = {
    aggregates: {
      crops: [
        { crop_type_slug: 'blueberry', crop_name: 'Blueberries' },
        { crop_type_slug: 'watermelon', crop_name: 'Watermelon' },
      ],
    },
  }

  it('makes no accusation until it is opened — and costs no season scan either', async () => {
    wire({ harvests })
    renderWalk()
    await answerSetup()
    expect(screen.getByTestId('putup-walk-unrecorded-toggle').textContent).toMatch(/What haven.t I put up\?/)
    // The collapsed line carries no count, and the full-season aggregates query has not run.
    expect(fetchMock.mock.calls.some(([p]) => p.includes('include=aggregates'))).toBe(false)
  })

  it('lists crops picked with nothing recorded once opened', async () => {
    wire({ harvests })
    renderWalk()
    await answerSetup()
    fireEvent.click(screen.getByTestId('putup-walk-unrecorded-toggle'))
    const panel = await screen.findByTestId('putup-walk-unrecorded')
    await waitFor(() => expect(within(panel).getByText('Blueberries')).toBeTruthy())
    expect(within(panel).getByText('Watermelon')).toBeTruthy()
  })

  it('"Not one I put up" removes a crop AND the removal survives a remount', async () => {
    wire({ harvests })
    const first = renderWalk()
    await answerSetup()
    fireEvent.click(screen.getByTestId('putup-walk-unrecorded-toggle'))
    const panel = await screen.findByTestId('putup-walk-unrecorded')
    await waitFor(() => expect(within(panel).getByText('Watermelon')).toBeTruthy())
    // Dave: "it cannot be a forever nag — i pick watermelons for example but mostly eat them fresh".
    const rows = within(panel).getAllByTestId('putup-walk-not-mine')
    fireEvent.click(rows[1])
    await waitFor(() => expect(within(panel).queryByText('Watermelon')).toBeNull())
    expect(within(panel).getByText('Blueberries')).toBeTruthy()
    first.unmount()

    renderWalk()
    await screen.findByRole('combobox', { name: 'Crop' })     // resumed from the stash this walk wrote
    fireEvent.click(screen.getByTestId('putup-walk-unrecorded-toggle'))
    const again = await screen.findByTestId('putup-walk-unrecorded')
    await waitFor(() => expect(within(again).getByText('Blueberries')).toBeTruthy())
    expect(within(again).queryByText('Watermelon')).toBeNull()
  })

  it('a crop already put up is not on the list at all', async () => {
    wire({ harvests, stores: { groups: [{ group_key: 'blueberry', label: 'Blueberries', records: [{ crop_type_slug: 'blueberry' }] }] } })
    renderWalk()
    await answerSetup()
    fireEvent.click(screen.getByTestId('putup-walk-unrecorded-toggle'))
    const panel = await screen.findByTestId('putup-walk-unrecorded')
    await waitFor(() => expect(within(panel).getByText('Watermelon')).toBeTruthy())
    expect(within(panel).queryByText('Blueberries')).toBeNull()
  })
})
