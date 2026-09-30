// Walk a place (Put-Up B′ release 2; V4 §2.2 "Walk a place", §6.2, §6.3) — the shipped freezer walk
// (V4-PUTUPSESSION-001), generalised to ANY place, end to end through the DOM.
//
// REWRITTEN for B′ in the same commit as the change (brief: characterization tests amended with a
// reason). The shipped walk asked a crop, a bag count on a number pad and the size of each bag through the
// ordinary log form; V4 replaces that per-group form with: What is it? (the name search) · method-or-As is
// (required) · how many (a stepper after a method) · Save → next, and adds duplicate prevention ("Already
// logged here ▸", "already here", "That's this one → move it here"). Kept from the shipped walk and still
// pinned here: the mode flag (`?session=putup`, the shipped key), the offline pre-flight, one place and
// one date per sitting applied to every save, the band with its Undo and its exit, BottomNav suppression,
// the localStorage stash, "Change", and "What haven't I put up?". Dropped with the old form: the number
// pad, "How big is each?" and its A3 total (V4 puts "weight of each" under More — not built in B′, see the
// lane report), the planting auto-resolution (the name search's planting hit replaces it) and the running
// count ("— N logged so far"; V4: no running count).
//
// Every claim is about STATE and the WIRE; none is about geometry (jsdom has none).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow } from './helpers/pantryFake.js'
import { estimateChips } from '../components/putup/putItUp.js'
import { toYmd } from '../components/putup/jarWords.js'

installStoragePolyfill()

// ONE stable fetch identity (the real useApiFetch's is stable too): effects keyed on `fetch` would
// otherwise re-run on every render.
let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({ useCropTypes: () => ({ cropTypes: [], loading: false }) }))

import PutUp from '../pages/PutUp.jsx'

const LOCATIONS = [
  { id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' },
  { id: 'loc-2', label: 'Chest Freezer 2', kind: 'deep_freezer' },
  { id: 'loc-3', label: 'Kitchen fridge', kind: 'fridge' },
]
const CF1 = LOCATIONS[0]
const CF2 = LOCATIONS[1]
const LINE_HITS = { plantings: [{ plant_id: 'p-blue', label: 'Blueberries', crop_type_slug: 'blueberry', variety_id: 'v-blue', recent_picks: [] }], put_ups: [] }

function wire(opts = {}) {
  fake = pantryFetch({ places: LOCATIONS, lineSearch: LINE_HITS, ...opts })
  stableFetch.fn = fake
}
const posts = (path) => fake.calls('POST', path).filter(c => c.path === path)

function Probe() {
  const loc = useLocation()
  return <div data-testid="probe-loc">{loc.pathname + loc.search}</div>
}
function renderWalk(search = '?session=putup') {
  return render(<MemoryRouter initialEntries={[`/put-up${search}`]}><Probe /><PutUp /></MemoryRouter>)
}
const thisMonthStart = () => toYmd(estimateChips(new Date()).find(c => c.id === 'this_month').start)

async function answerSetup({ place = 'Chest Freezer 1', when = 'This month' } = {}) {
  fireEvent.click(await screen.findByRole('radio', { name: place }))
  fireEvent.click(screen.getByRole('radio', { name: when }))
  fireEvent.click(screen.getByTestId('putup-walk-start'))
  await screen.findByTestId('putup-walk-group')
}
const typeWhat = (v) => fireEvent.change(screen.getByTestId('walk-what-name'), { target: { value: v } })
const save = () => fireEvent.click(screen.getByTestId('walk-save'))

beforeEach(() => {
  wire()
  localStorage.clear(); sessionStorage.clear()
})

describe('the walk is a MODE FLAG, not a new page', () => {
  it('?session=putup opens the walk; the bare route is the ordinary page', async () => {
    renderWalk()
    expect(await screen.findByRole('heading', { name: 'Walk a place' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Which place are you at?' })).toBeTruthy()
  })

  it('without the param the page is untouched, and offers "Walk a place" as its door', async () => {
    renderWalk('')
    expect(await screen.findByRole('heading', { name: 'Put-Up' })).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Which place are you at?' })).toBeNull()
    fireEvent.click(screen.getByTestId('putup-walk-door'))
    expect(await screen.findByRole('heading', { name: 'Walk a place' })).toBeTruthy()
    expect(screen.getByTestId('probe-loc').textContent).toBe('/put-up?session=putup')
  })

  it('names its place in the URL once started (&place=), and a place in the URL is preselected', async () => {
    renderWalk()
    await answerSetup({ place: 'Chest Freezer 2' })
    await waitFor(() => expect(screen.getByTestId('probe-loc').textContent).toBe('/put-up?session=putup&place=loc-2'))
  })

  it('?session=putup&place=<id> opens the setup on that place', async () => {
    renderWalk('?session=putup&place=loc-3')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Kitchen fridge' }).getAttribute('aria-checked')).toBe('true'))
  })
})

describe('the offline pre-flight — find out BEFORE the walk, not after each item', () => {
  it('blocks the start and says why when the device reports no network', async () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      renderWalk()
      expect((await screen.findByTestId('putup-walk-offline')).textContent).toMatch(/nothing you log here will save/i)
      fireEvent.click(await screen.findByRole('radio', { name: 'Chest Freezer 1' }))
      fireEvent.click(screen.getByRole('radio', { name: 'This month' }))
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
})

describe('setup: one place and one date for the sitting (required 2, nothing preselected)', () => {
  it('needs BOTH answers before the walk can start', async () => {
    renderWalk()
    const start = await screen.findByTestId('putup-walk-start')
    const req = [...document.querySelectorAll('[aria-required="true"]')].map(e => e.getAttribute('aria-label'))
    expect(req).toEqual(['Which place are you at?', 'Roughly when did it go in?'])
    expect(screen.getAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true')).toHaveLength(0)
    expect(start.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Chest Freezer 1' }))
    expect(start.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'This month' }))
    expect(start.disabled).toBe(false)
  })

  it('offers any place — the household\'s own, then a template for a kind it has none of — and Not sure', async () => {
    renderWalk()
    const places = within(await screen.findByRole('radiogroup', { name: 'Which place are you at?' })).getAllByRole('radio')
    expect(places.map(r => r.textContent)).toEqual(['Chest Freezer 1', 'Chest Freezer 2', 'Kitchen fridge', 'Pantry shelf', 'Counter'])
    const whens = within(screen.getByRole('radiogroup', { name: 'Roughly when did it go in?' })).getAllByRole('radio').map(r => r.textContent)
    expect(whens[0]).toBe('This month')
    expect(whens.at(-1)).toBe('Not sure')
  })

  it('SHOWS what it will record — an estimate in its words, Not sure as "not sure"', async () => {
    renderWalk()
    fireEvent.click(await screen.findByRole('radio', { name: 'This month' }))
    expect(screen.getByTestId('putup-walk-date-resolved').textContent).toMatch(/sometime in /)
    fireEvent.click(screen.getByRole('radio', { name: 'Not sure' }))
    expect(screen.getByTestId('putup-walk-date-resolved').textContent).toMatch(/put up: not sure/)
  })

  it('a template place is made once, when the walk starts, and every save names it by id', async () => {
    renderWalk()
    await answerSetup({ place: 'Pantry shelf' })
    expect(posts('/api/storage-locations').map(c => c.body)).toEqual([{ label: 'Pantry shelf', kind: 'pantry' }])
    typeWhat('Dilly beans')
    fireEvent.click(screen.getByTestId('walk-method-can_water_bath'))
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    expect(posts('/api/preservation')[0].body.storage_location_id).toBe('loc-new-1')
  })
})

describe('each group: what · method-or-As is · how many · Save → next', () => {
  it('asks exactly two things at open, and how many only once a method is chosen', async () => {
    renderWalk()
    await answerSetup()
    const group = screen.getByTestId('putup-walk-group')
    const req = [...group.querySelectorAll('[aria-required="true"]')]
    expect(req.map(e => e.getAttribute('aria-label') ?? e.tagName.toLowerCase())).toEqual(['input', 'How was it put up?'])
    expect(screen.queryByTestId('walk-count-count')).toBeNull()
    fireEvent.click(screen.getByTestId('walk-method-whole_freeze'))
    expect(screen.getByTestId('walk-count-count').value).toBe('1')
  })

  it('Save with no method moves focus to the method row with one line, and writes nothing', async () => {
    renderWalk()
    await answerSetup()
    typeWhat('Blueberries')
    save()
    expect(screen.getByTestId('walk-error').textContent).toBe('How was it put up? Pick one — or As is.')
    expect(document.activeElement).toBe(screen.getByTestId('walk-method-whole_freeze'))
    expect(posts('/api/preservation')).toHaveLength(0)
    expect(posts('/api/pantry/items')).toHaveLength(0)
  })

  it('a method is a put-up, carrying the sitting\'s place and date — with no per-group taps for either', async () => {
    renderWalk()
    await answerSetup()
    typeWhat('Blueberries')
    fireEvent.click(screen.getByTestId('walk-method-whole_freeze'))
    fireEvent.click(screen.getByTestId('walk-count-plus'))
    fireEvent.click(screen.getByTestId('walk-count-plus'))
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    const b = posts('/api/preservation')[0].body
    expect({ ...b, idempotency_key: 'K' }).toEqual({
      idempotency_key: 'K', label: 'Blueberries', method: 'whole_freeze', preserved_at: thisMonthStart(),
      preserved_at_precision: 'month', preserved_at_approx: true, package_count: 3, storage_location_id: 'loc-1',
    })
    expect(b.idempotency_key).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('carries the place and date to the NEXT group without re-asking, and the group starts clean', async () => {
    renderWalk()
    await answerSetup({ place: 'Chest Freezer 2', when: 'Not sure' })
    typeWhat('Corn')
    fireEvent.click(screen.getByTestId('walk-method-blanch_freeze'))
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    expect(screen.getByTestId('walk-what-name').value).toBe('')
    expect(screen.queryByTestId('walk-count-count')).toBeNull()
    typeWhat('Peas')
    fireEvent.click(screen.getByTestId('walk-method-blanch_freeze'))
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(2))
    const [a, b] = posts('/api/preservation').map(c => c.body)
    for (const x of [a, b]) {
      expect(x.storage_location_id).toBe('loc-2')
      expect(x.preserved_at_precision).toBe('unknown')     // Not sure: the walk day, no table date (V4 §3.1)
    }
    expect(a.idempotency_key).not.toBe(b.idempotency_key)
  })

  it('As is is a bought item on the Pantry route, with the sitting\'s place and date', async () => {
    renderWalk()
    await answerSetup({ place: 'Kitchen fridge' })
    typeWhat('Oat milk')
    fireEvent.click(screen.getByTestId('walk-method-as_is'))
    expect(screen.queryByTestId('walk-count-count')).toBeNull()      // no counts on bought items
    save()
    await waitFor(() => expect(posts('/api/pantry/items')).toHaveLength(1))
    const b = posts('/api/pantry/items')[0].body
    expect({ ...b, idempotency_key: 'K' }).toEqual({ idempotency_key: 'K', name: 'Oat milk', storage_location_id: 'loc-3',
      acquired_at: thisMonthStart(), acquired_precision: 'month' })
    expect(posts('/api/preservation')).toHaveLength(0)
  })

  it('a planting hit fills the planting and crop; at a freezer it offers methods only (no As is)', async () => {
    renderWalk()
    await answerSetup()
    typeWhat('Blue')
    fireEvent.click(await screen.findByTestId('walk-what-hit-planting:p-blue', {}, { timeout: 2000 }))
    expect(screen.queryByTestId('walk-method-as_is')).toBeNull()
    fireEvent.click(screen.getByTestId('walk-method-whole_freeze'))
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    expect(posts('/api/preservation')[0].body).toMatchObject({ label: 'Blueberries', plant_id: 'p-blue', crop_type_slug: 'blueberry',
      variety_id: 'v-blue', source_kind: 'own_garden' })
  })

  it('a different date for ONE group, under More, moves that group only', async () => {
    renderWalk()
    await answerSetup()
    typeWhat('Pesto')
    fireEvent.click(screen.getByTestId('walk-method-pesto'))
    fireEvent.click(screen.getByTestId('walk-more'))
    fireEvent.click(screen.getByTestId('walk-own-unsure'))
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    expect(posts('/api/preservation')[0].body.preserved_at_precision).toBe('unknown')
    typeWhat('More pesto')
    fireEvent.click(screen.getByTestId('walk-method-pesto'))
    save()
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(2))
    expect(posts('/api/preservation')[1].body.preserved_at_precision).toBe('month')
  })

  it('each group shows one preview line: the date it uses and the date it gives, with its basis', async () => {
    renderWalk()
    await answerSetup()
    typeWhat('Blueberries')
    fireEvent.click(screen.getByTestId('walk-method-whole_freeze'))
    expect(screen.getByTestId('walk-preview').textContent).toMatch(/^put up sometime in .+ · discard by around .+ · general figure: whole freeze, deep freezer$/)
  })
})

describe('duplicate prevention — never logged twice', () => {
  const HERE = jarRow({ stock_id: 'jar-here', name: 'Blueberries', place: CF1, group_key: 'loc-1', group_label: 'Chest Freezer 1', count_left: 4 })
  const THERE = jarRow({ stock_id: 'jar-there', name: 'Blueberry jam', place: CF2, group_key: 'loc-2', group_label: 'Chest Freezer 2', count_left: 2 })
  const ITEM_THERE = itemRow({ stock_id: 'item-there', name: 'Blue cheese', place: CF2, group_key: 'loc-2', group_label: 'Chest Freezer 2' })

  it('"Already logged here ▸" is collapsed, then lists names and what is left at THIS place only, no count', async () => {
    wire({ rows: [HERE, THERE] })
    renderWalk()
    await answerSetup()
    const toggle = screen.getByTestId('putup-walk-here-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('Already logged here ▸')
    expect(fake.calls('GET').some(c => c.path.includes('place_id='))).toBe(false)
    fireEvent.click(toggle)
    const panel = await screen.findByTestId('putup-walk-here')
    await waitFor(() => expect(within(panel).getByText('Blueberries · 4 left')).toBeTruthy())
    expect(within(panel).queryByText(/Blueberry jam/)).toBeNull()
    expect(fake.calls('GET').some(c => c.path === '/api/pantry?group=place&place_id=loc-1')).toBe(true)
    fireEvent.click(within(panel).getByText('Blueberries · 4 left'))
    expect(await screen.findByTestId('row-sheet')).toBeTruthy()
  })

  it('the name search marks a match here "already here" and opens it — nothing is written', async () => {
    wire({ rows: [HERE, THERE] })
    renderWalk()
    await answerSetup()
    typeWhat('Blueb')
    const hit = await screen.findByTestId('walk-what-hit-put_up:jar-here')
    expect(hit.textContent).toBe('Blueberries · already here · 4 left')
    fireEvent.click(hit)
    expect((await screen.findByTestId('row-sheet')).getAttribute('data-row-key')).toBe('put_up:jar-here')
    expect(posts('/api/preservation')).toHaveLength(0)
  })

  it('a match at another place reads "That\'s this one → move it here", and moves it (a jar through its move route)', async () => {
    wire({ rows: [HERE, THERE] })
    renderWalk()
    await answerSetup()
    typeWhat('jam')
    const hit = await screen.findByTestId('walk-what-hit-put_up:jar-there')
    expect(hit.textContent).toBe("Blueberry jam · in Chest Freezer 2 — That's this one → move it here")
    fireEvent.click(hit)
    await waitFor(() => expect(posts('/api/preservation/jar-there/move')).toHaveLength(1))
    const b = posts('/api/preservation/jar-there/move')[0].body
    expect(b.place).toEqual({ id: 'loc-1' })
    expect(b.when.precision).toBe('day')
    expect(await screen.findByText(/Moved Blueberry jam here/)).toBeTruthy()
    expect(posts('/api/preservation')).toHaveLength(0)
  })

  it('a bought item at another place moves by a PATCH of its storage_location_id', async () => {
    wire({ rows: [HERE, ITEM_THERE] })
    renderWalk()
    await answerSetup()
    typeWhat('cheese')
    fireEvent.click(await screen.findByTestId('walk-what-hit-pantry_item:item-there'))
    await waitFor(() => expect(fake.calls('PATCH', '/api/pantry/items/item-there')).toHaveLength(1))
    expect(fake.calls('PATCH', '/api/pantry/items/item-there')[0].body).toEqual({ storage_location_id: 'loc-1' })
  })
})

describe('the band — an honest record of what happened, and a deliberate exit', () => {
  it('shows the group just saved, with an Undo that really deletes it (a put-up, then a bought item)', async () => {
    renderWalk()
    await answerSetup()
    typeWhat('Blueberries')
    fireEvent.click(screen.getByTestId('walk-method-whole_freeze'))
    save()
    const band = screen.getByTestId('putup-walk-band')
    await waitFor(() => expect(within(band).getByTestId('putup-walk-last').textContent).toMatch('1 × Blueberries · Freeze whole'))
    fireEvent.click(within(band).getByTestId('putup-walk-undo'))
    await waitFor(() => expect(fake.calls('DELETE').map(c => c.path)).toEqual(['/api/preservation/jar-new-1']))
    expect(within(band).getByTestId('putup-walk-last').textContent).toMatch('Undone')
    expect(within(band).queryByTestId('putup-walk-undo')).toBeNull()

    typeWhat('Frozen peas')
    fireEvent.click(screen.getByTestId('walk-method-as_is'))
    save()
    await waitFor(() => expect(within(band).getByTestId('putup-walk-last').textContent).toMatch('Frozen peas · As is'))
    fireEvent.click(within(band).getByTestId('putup-walk-undo'))
    await waitFor(() => expect(fake.calls('DELETE').map(c => c.path)[1]).toMatch(/^\/api\/pantry\/items\/item-new-/))
  })

  it('always carries the sitting\'s place and date', async () => {
    renderWalk()
    await answerSetup()
    expect(screen.getByTestId('putup-walk-where').textContent).toMatch(/^Chest Freezer 1 · sometime in /)
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

describe('pick up where you left off — over several evenings', () => {
  it('a fresh walk asks the two questions; a stashed one skips straight back in, with no running count', async () => {
    localStorage.setItem('garden:putup-walk:v1', JSON.stringify({
      v: 1, place: { key: 'id:loc-2', id: 'loc-2', label: 'Chest Freezer 2', kind: 'deep_freezer' }, whenChoice: 'unsure',
      pickedDate: '', when: { date: '2026-09-30', precision: 'unknown' }, whenWords: 'not sure', date: '2026-09-30',
    }))
    renderWalk()
    await screen.findByTestId('putup-walk-group')
    expect(screen.queryByRole('radiogroup', { name: 'Which place are you at?' })).toBeNull()
    expect(screen.getByTestId('putup-walk-resumed').textContent).toBe('Picked up where you left off.')
    expect(screen.getByTestId('putup-walk-where').textContent).toBe('Chest Freezer 2 · date not sure')
  })

  it('the shipped freezer walk\'s stash does not skip the setup — it only preselects its freezer', async () => {
    localStorage.setItem('garden:putup-walk:v1', JSON.stringify({
      v: 1, storageId: 'loc-2', date: '2026-07-16', dateApprox: true, dateChoice: 'summer', cropSlug: 'blueberry', savedCount: 7,
    }))
    renderWalk()
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Chest Freezer 2' }).getAttribute('aria-checked')).toBe('true'))
    expect(screen.queryByTestId('putup-walk-group')).toBeNull()
    expect(document.body.textContent).not.toMatch(/logged so far/)
  })

  it('the stash is written when the walk starts, so a torn-down tab loses nothing but its place on screen', async () => {
    renderWalk()
    await answerSetup({ place: 'Chest Freezer 2' })
    const stash = JSON.parse(localStorage.getItem('garden:putup-walk:v1'))
    expect(stash).toMatchObject({ v: 1, place: { id: 'loc-2', label: 'Chest Freezer 2' }, when: { date: thisMonthStart(), precision: 'month' } })
  })

  it('"Change" reopens the two questions mid-walk without ending it', async () => {
    renderWalk()
    await answerSetup()
    fireEvent.click(screen.getByTestId('putup-walk-change'))
    fireEvent.click(await screen.findByRole('radio', { name: 'Chest Freezer 2' }))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByTestId('putup-walk-group')
    expect(screen.getByTestId('putup-walk-where').textContent).toMatch('Chest Freezer 2')
  })
})

describe('"what haven\'t I put up?" — one collapsed line that cannot become a nag', () => {
  const harvests = { aggregates: { crops: [{ crop_type_slug: 'blueberry', crop_name: 'Blueberries' }, { crop_type_slug: 'watermelon', crop_name: 'Watermelon' }] } }
  const withHarvests = (stores = { groups: [] }) => wire({ overrides: {
    'GET /api/harvests': () => harvests,
    'GET /api/preservation/whats-put-up': () => stores,
  } })

  it('makes no accusation until it is opened — and costs no season scan either', async () => {
    withHarvests()
    renderWalk()
    await answerSetup()
    expect(screen.getByTestId('putup-walk-unrecorded-toggle').textContent).toMatch(/What haven.t I put up\?/)
    expect(fake.calls('GET').some(c => c.path.includes('include=aggregates'))).toBe(false)
  })

  it('lists crops picked with nothing recorded once opened', async () => {
    withHarvests()
    renderWalk()
    await answerSetup()
    fireEvent.click(screen.getByTestId('putup-walk-unrecorded-toggle'))
    const panel = await screen.findByTestId('putup-walk-unrecorded')
    await waitFor(() => expect(within(panel).getByText('Blueberries')).toBeTruthy())
    expect(within(panel).getByText('Watermelon')).toBeTruthy()
  })

  it('"Not one I put up" removes a crop AND the removal survives a remount', async () => {
    withHarvests()
    const first = renderWalk()
    await answerSetup()
    fireEvent.click(screen.getByTestId('putup-walk-unrecorded-toggle'))
    const panel = await screen.findByTestId('putup-walk-unrecorded')
    await waitFor(() => expect(within(panel).getByText('Watermelon')).toBeTruthy())
    fireEvent.click(within(panel).getAllByTestId('putup-walk-not-mine')[1])
    await waitFor(() => expect(within(panel).queryByText('Watermelon')).toBeNull())
    first.unmount()

    renderWalk()
    await screen.findByTestId('putup-walk-group')     // resumed from the stash this walk wrote
    fireEvent.click(screen.getByTestId('putup-walk-unrecorded-toggle'))
    const again = await screen.findByTestId('putup-walk-unrecorded')
    await waitFor(() => expect(within(again).getByText('Blueberries')).toBeTruthy())
    expect(within(again).queryByText('Watermelon')).toBeNull()
  })

  it('a crop already put up is not on the list at all', async () => {
    withHarvests({ groups: [{ group_key: 'blueberry', label: 'Blueberries', records: [{ crop_type_slug: 'blueberry' }] }] })
    renderWalk()
    await answerSetup()
    fireEvent.click(screen.getByTestId('putup-walk-unrecorded-toggle'))
    const panel = await screen.findByTestId('putup-walk-unrecorded')
    await waitFor(() => expect(within(panel).getByText('Watermelon')).toBeTruthy())
    expect(within(panel).queryByText('Blueberries')).toBeNull()
  })
})
