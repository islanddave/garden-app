// Put-Up R2a, lane K — the planting page opens the "Put something up" door IN PLACE.
//
// The section's button (PutUpFromPlanting.jsx) opens the Pantry's own door (PutSomethingUpSheet, the REAL
// one, mounted here with the real name field) seeded with the planting (plantingKitchen.doorWhatOf). No
// navigation, no router state. The host closes the door on Save, shows the server's row in completionWords
// on the Pantry's line (CompletionLine) directly above the button, and re-reads BOTH of the page's reads
// after a Save and after an Undo: the put-up list (a put-up) and PlantingKitchen's kept-fresh read (a
// "Fresh, as picked" item). The page (PlantingDetail.jsx) is told while the door is open, so an arrow key
// or a sideways swipe inside it cannot page to another planting.
//
// The world below is the Pantry fake (helpers/pantryFake.js: creates judged by the Lambda's own validators)
// with the planting page's two reads answered from what was saved and not undone.
//
// MUTATIONS (ΔQA section 2, lane K; run, see the lane report), each red here:
//   K-M1  the door mounted open, or its body rendered before a tap  -> "the planting page at rest: …"
//   K-M2  a seeded open is dirty                                      -> "opened from the link and closed untouched: …"
//   K-M3  a stored draft read into the seeded door, or wiped at open  -> "a Pantry draft survives an untouched open here, …"
//   K-M4  no re-read after Save                                       -> "a saved put-up is in the planting's list"
//   K-M5  only the put-up list re-read                                -> "a Fresh, as picked save shows where kept-fresh items show"
//   K-M6  the line built from what was sent                           -> "the line is completionWords of the server's row"
//   K-M7  Undo calls nothing, the wrong route, or leaves the line     -> "Undo on a put-up sends DELETE …" / "… on an item …"
//   K-M8  a failed Undo drops the line                                -> "Undo fails: the line and Undo stay, with the refusal"
//   K-M9  X, Back or Save navigates                                   -> "location is the planting page after each"
//   K-M10 a where-from row for the planting                           -> "no where-from row"
//   K-M11 first focus on the name                                     -> "focus is on the first place chip"
//   drop `&& !kitchenSheetOpen`                                       -> "with the door open an arrow key does not page"
//   pass onStartBatchInstead                                          -> "the door draws no Start a batch instead line here"
//   seed a blank name for a variety-named planting                    -> "a planting named only by its variety seeds that name"
//   a re-read that sets Loading…                                      -> "a re-read blanks nothing: …"
//   the line keyed on the reload count                                -> "Undo on a put-up sends DELETE …" (Undone is lost)
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { MemoryRouter, BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, apiError, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

const { stableFetch, minted } = vi.hoisted(() => ({ stableFetch: { fn: null }, minted: { n: 0 } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))
vi.mock('../components/kitchen/idempotencyKey.js', async (importActual) => {
  const actual = await importActual()
  return { ...actual, mintKey: (...a) => { minted.n += 1; return actual.mintKey(...a) } }
})
vi.mock('../components/PutUpPhotoThumb.jsx', () => ({ default: () => null }))
// The planting page's own neighbours, stubbed as its pager test stubs them.
vi.mock('../lib/uxEvents.js', async (importActual) => ({
  ...(await importActual()),
  useUxFlow: () => ({ step: () => {}, tap: () => {}, complete: () => {}, reset: () => {} }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import PlantingKitchen from '../components/planting/PlantingKitchen.jsx'
import PutUpFromPlanting, { DOOR_FIRST_TEXT, DOOR_MORE_TEXT, EMPTY_TEXT } from '../components/planting/PutUpFromPlanting.jsx'
import { doorWhatOf } from '../components/planting/plantingKitchen.js'
import PutSomethingUpSheet, { isDoorDraft } from '../components/pantry/PutSomethingUpSheet.jsx'
import { DOOR_SHEET, completionWords, START_BATCH_INSTEAD_TEXT } from '../components/pantry/putSomethingUp.js'
import { sheetDraftKey, readSheetDraft, writeSheetDraft } from '../components/kitchen/sheetDraft.js'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'
import PlantingDetail from '../pages/PlantingDetail.jsx'
import { setPlantingSequence, __resetPlantingSequence } from '../lib/plantingSequence.js'

const NOW = new Date(2026, 9, 1, 14, 0)
const DRAFT_KEY = sheetDraftKey('user_dave', DOOR_SHEET, 'new')
const PLANTING = { id: 'pl-1', name: 'Sungold cherry', variety_id: 'var-sg', variety_ref: { id: 'var-sg', name: 'Sungold', crop_type_slug: 'tomato' } }
const WHAT = { source: 'planting', name: 'Sungold cherry', plant_id: 'pl-1', crop_type_slug: 'tomato', variety_id: 'var-sg' }
const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const placeOf = (id) => PLACES.find(p => p.id === id) ?? null

// The planting page's world: the Pantry fake, plus the page's two reads answered from what was saved and not
// undone. `answer(row)` is what the SERVER answers a put-up create with (it may differ from what was sent).
function plantingWorld({ answer = (r) => r, overrides = {} } = {}) {
  const world = { jars: [], fresh: [], answers: [] }
  const plantOf = (path) => new URL(path, 'http://x').searchParams.get('plant_id')
  const fake = pantryFetch({ overrides: {
    'GET /api/preservation/whats-put-up': ({ path }) => {
      const mine = world.jars.filter(j => String(j.plant_id) === plantOf(path))
      return { group_by: 'storage', groups: PLACES.map(p => ({ group_key: p.id, label: p.label, records: mine.filter(j => j.storage_location_id === p.id) }))
        .filter(g => g.records.length) }
    },
    'GET /api/kitchen-batches': ({ path }) => ({ plant_id: plantOf(path), batches: [], kept_fresh: world.fresh.filter(f => String(f.plant_id) === plantOf(path)) }),
    ...overrides,
  } })
  const fn = async (path, options = {}) => {
    const method = options.method || 'GET'
    let r = await fake(path, options)
    const id = decodeURIComponent(String(path).split('/').pop())
    if (method === 'POST' && path === '/api/preservation') {
      r = answer(r)
      world.answers.push(r)
      world.jars.push({ id: r.id, plant_id: r.plant_id ?? null, label: r.label, method: r.method, storage_location_id: r.storage_location_id,
        package_count: r.package_count, remaining_count: r.package_count, preserved_at: r.preserved_at, use_by_target: r.use_by_target,
        use_by_basis: r.use_by_basis, storage_kind: placeOf(r.storage_location_id)?.kind ?? null })
    } else if (method === 'POST' && path === '/api/pantry/items') {
      world.answers.push(r)
      world.fresh.push({ id: r.item.id, plant_id: r.item.plant_id ?? null, name: r.item.name, place_label: placeOf(r.item.storage_location_id)?.label ?? null,
        used_up_at: null, next_time: [] })
    } else if (method === 'DELETE' && path.startsWith('/api/preservation/')) world.jars = world.jars.filter(j => j.id !== id)
    else if (method === 'DELETE' && path.startsWith('/api/pantry/items/')) world.fresh = world.fresh.filter(f => f.id !== id)
    return r
  }
  fn.world = world
  fn.calls = fake.calls
  return fn
}

function Probe() {
  const loc = useLocation()
  return <p data-testid="at">{loc.pathname + loc.search}</p>
}
// The section as the planting page mounts it (PlantingKitchen, which hosts PutUpFromPlanting).
function mountPage({ planting = PLANTING, world = plantingWorld(), onSheetOpenChange } = {}) {
  stableFetch.fn = world
  render(
    <MemoryRouter initialEntries={['/planting']}>
      <Routes>
        <Route path="/planting" element={<><Probe /><PlantingKitchen planting={planting} fetch={world} now={NOW} onSheetOpenChange={onSheetOpenChange} /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  )
  return world
}
// The Pantry's own door: no seed.
function mountPantryDoor(handlers = {}) {
  render(<PutSomethingUpSheet open now={NOW.getTime()} onClose={() => {}} onSaved={() => {}} {...handlers} />)
}

const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)) })
const doorButton = () => screen.getByTestId('putup-from-planting-door')
// A tap: the button takes focus, then the click (fireEvent.click alone does not focus).
async function tapDoor() {
  const b = await screen.findByTestId('putup-from-planting-door')
  b.focus()
  fireEvent.click(b)
  return b
}
async function openDoor() {
  const b = await tapDoor()
  await screen.findByTestId('door-place-id:loc-1')
  await settle()
  return b
}
async function save(place, method) {
  fireEvent.click(screen.getByTestId(`door-place-id:${place}`))
  fireEvent.click(screen.getByTestId(`door-method-${method}`))
  fireEvent.click(screen.getByTestId('door-save'))
  await waitFor(() => expect(screen.queryByTestId('door-sheet')).toBeNull())
  await settle()
}
const line = () => screen.queryByTestId('pantry-completion')
const lineText = () => line()?.querySelector('span')?.textContent ?? null
// Each row's name (the head's own text, before its method).
const rowHeads = () => screen.queryAllByTestId('putup-from-planting-head').map(e => e.firstChild?.nodeType === 3 ? e.firstChild.textContent : '')
const clean = () => [minted.n, localStorage.getItem(DRAFT_KEY), isReloadBlocked()]
const checkedPlace = () => screen.getAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true' && r.dataset.testid?.startsWith('door-place-'))
  .map(r => r.dataset.testid)

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); clearReloadBlocks(); minted.n = 0
  window.scrollTo = vi.fn()
})
afterEach(() => {
  cleanup()
  document.body.style.overflow = ''; document.body.style.overscrollBehavior = ''
})

describe('doorWhatOf — the What the planting page opens the door with', () => {
  it('the planting, its crop and its variety, as the old prefill read them', () => {
    expect(doorWhatOf(PLANTING)).toEqual(WHAT)
    expect(doorWhatOf({ id: 'pl-1', name: 'Sungold cherry', variety_ref: { id: 'var-sg' } })).toEqual({ source: 'planting', name: 'Sungold cherry', plant_id: 'pl-1', variety_id: 'var-sg' })
    expect(doorWhatOf({ id: 'pl-1', name: '  Sungold cherry ' })).toEqual({ source: 'planting', name: 'Sungold cherry', plant_id: 'pl-1' })
  })

  it('a planting with no name of its own is named by its variety; with neither, or no id, there is no What', () => {
    expect(doorWhatOf({ id: 'pl-2', name: null, variety_ref: { id: 'v2', name: 'Dark Green Zucchini', crop_type_slug: 'squash' } }))
      .toEqual({ source: 'planting', name: 'Dark Green Zucchini', plant_id: 'pl-2', crop_type_slug: 'squash', variety_id: 'v2' })
    expect(doorWhatOf({ id: 'pl-2', name: '   ', variety_ref: { name: 'Dark Green Zucchini' } }).name).toBe('Dark Green Zucchini')
    for (const p of [{ id: 'pl-3' }, { id: 'pl-3', name: ' ', variety_ref: { name: '' } }, { name: 'No id' }, null, undefined]) expect(doorWhatOf(p)).toBeNull()
  })
})

describe('at rest, and the button', () => {
  it('a planting named only by its variety seeds that name', async () => {
    const world = mountPage({ planting: { id: 'pl-2', name: null, variety_ref: { id: 'v2', name: 'Dark Green Zucchini', crop_type_slug: 'squash' } } })
    await openDoor()
    expect(screen.getByTestId('door-what-name').value).toBe('Dark Green Zucchini')
    await save('loc-1', 'whole_freeze')
    expect(world.calls('POST', '/api/preservation')[0].body).toMatchObject({ label: 'Dark Green Zucchini', plant_id: 'pl-2', crop_type_slug: 'squash', variety_id: 'v2' })
  })

  it('a planting with neither a name nor a variety name draws no button and opens no door', async () => {
    const world = mountPage({ planting: { id: 'pl-3', name: null, variety_ref: null } })
    expect(await screen.findByText(EMPTY_TEXT)).toBeTruthy()
    expect(screen.queryByTestId('putup-from-planting-door')).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(world.calls('GET', '/api/storage-locations')).toHaveLength(0)
  })

  it('the button\'s words: before anything is put up, and after', async () => {
    const world = mountPage()
    expect((await screen.findByTestId('putup-from-planting-door')).textContent).toBe(DOOR_FIRST_TEXT)
    expect([DOOR_FIRST_TEXT, DOOR_MORE_TEXT, EMPTY_TEXT]).toEqual(['Put something up from this planting', 'Put up more from this planting', 'Nothing put up from this planting yet.'])
    expect(screen.getByText(EMPTY_TEXT)).toBeTruthy()
    world.world.jars.push({ id: 'old-1', plant_id: 'pl-1', label: 'Sungold, frozen', method: 'whole_freeze', storage_location_id: 'loc-1', package_count: 2, remaining_count: 2, preserved_at: '2026-09-01' })
    cleanup()
    mountPage({ world })
    await screen.findAllByTestId('putup-from-planting-row')
    expect(doorButton().textContent).toBe(DOOR_MORE_TEXT)
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull()
  })

  it('the door draws no Start a batch instead line here', async () => {
    mountPage()
    await openDoor()
    expect(screen.queryByTestId('door-start-batch-instead')).toBeNull()
    expect(document.body.textContent).not.toContain(START_BATCH_INSTEAD_TEXT)
  })

  it('no where-from row: the planting is where it came from, and the disclosure says Notes', async () => {
    mountPage()
    await openDoor()
    const b = screen.getByTestId('door-from')
    expect(b.textContent).toContain('Notes')
    fireEvent.click(b)
    expect(screen.getByTestId('door-from-panel')).toBeTruthy()
    expect(screen.queryByTestId('door-source')).toBeNull()
    expect(screen.getByTestId('door-from-panel').querySelectorAll('[data-testid^="door-source"]')).toHaveLength(0)
    expect(screen.getByTestId('door-notes')).toBeTruthy()      // INSTRUMENT: the panel really is open
  })

  it('focus is on the first place chip once the places have answered', async () => {
    mountPage()
    await openDoor()
    expect(document.activeElement).toBe(screen.getByTestId('door-place-id:loc-1'))
    expect(screen.getByTestId('door-what-name').value).toBe('Sungold cherry')
  })

  it('the page is told while the door is open, and never at rest', async () => {
    const told = vi.fn()
    mountPage({ onSheetOpenChange: told })
    await screen.findByTestId('putup-from-planting-door')
    await settle()
    expect(told).not.toHaveBeenCalled()
    await openDoor()
    expect(told.mock.calls).toEqual([[true]])
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(told.mock.calls).toEqual([[true], [false]]))
  })
})

describe('Save: the host closes the door, says what the server answered, and re-reads both reads', () => {
  it('a saved put-up is in the planting\'s list', async () => {
    mountPage()
    const before = await openDoor()
    await save('loc-1', 'whole_freeze')
    await waitFor(() => expect(rowHeads()).toEqual(['Sungold cherry']))
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull()
    // The same button, now saying the next thing; focus came back to it.
    expect(doorButton()).toBe(before)
    expect(doorButton().textContent).toBe(DOOR_MORE_TEXT)
    expect(document.activeElement).toBe(before)
  })

  it('the line is completionWords of the server\'s row', async () => {
    // The server's row differs from what was sent: its own name, and a date the body never carried.
    const world = mountPage({ world: plantingWorld({ answer: (r) => ({ ...r, label: 'Sungold cherry, wave 2' }) }) })
    await openDoor()
    await save('loc-1', 'whole_freeze')
    expect(world.calls('POST', '/api/preservation')[0].body).toMatchObject({ label: 'Sungold cherry' })
    expect(world.calls('POST', '/api/preservation')[0].body.use_by_target).toBeUndefined()
    const place = { ...placeOf('loc-1'), key: 'id:loc-1' }
    expect(lineText()).toBe(completionWords({ route: 'jar', saved: world.world.answers[0], place, now: NOW }))
    expect(lineText()).toBe('Sungold cherry, wave 2 — put up · Chest Freezer 1 · discard by Sep 30, 2027 · general figure: whole freeze, deep freezer')
  })

  it('the line sits directly above the button, with Undo and its close ×, and no How it was made', async () => {
    mountPage()
    await openDoor()
    await save('loc-1', 'whole_freeze')
    const l = line()
    expect(l.nextElementSibling).toBe(doorButton())
    expect(l.getAttribute('role')).toBe('status')
    expect(screen.getByTestId('pantry-completion-undo').style.minHeight).toBe('48px')
    expect(screen.getByRole('button', { name: 'Close — the saved line' }).style.minHeight).toBe('48px')
    expect(screen.queryByTestId('pantry-completion-how')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close — the saved line' }))
    expect(line()).toBeNull()
    expect(rowHeads()).toEqual(['Sungold cherry'])
  })

  it('a Fresh, as picked save shows where kept-fresh items show', async () => {
    const world = mountPage()
    const before = await openDoor()
    await save('loc-3', 'as_is')
    expect(world.calls('POST', '/api/pantry/items')[0].body).toMatchObject({ name: 'Sungold cherry', plant_id: 'pl-1', crop_type_slug: 'tomato' })
    const id = world.world.answers[0].item.id
    await waitFor(() => expect(screen.getByTestId(`planting-fresh-${id}`).textContent).toContain('Sungold cherry'))
    expect(screen.getByTestId('planting-kept-fresh').textContent).toContain('Kitchen fridge')
    expect(lineText()).toBe('Sungold cherry — in the pantry · Kitchen fridge')
    // Nothing was PUT UP: the sentence stays true, and the button keeps its first words.
    expect(screen.getByText(EMPTY_TEXT)).toBeTruthy()
    expect([doorButton(), doorButton().textContent]).toEqual([before, DOOR_FIRST_TEXT])
  })

  it('a re-read blanks nothing: the line and the button stay while the list is asked again, and onRows is fed again', async () => {
    let release
    let reads = 0
    const world = plantingWorld({ overrides: {
      'GET /api/preservation/whats-put-up': () => {
        reads += 1
        const answer = () => ({ group_by: 'storage', groups: world.world.jars.length
          ? [{ group_key: 'loc-1', label: 'Chest Freezer 1', records: world.world.jars }] : [] })
        return reads === 1 ? answer() : new Promise(r => { release = () => r(answer()) })
      },
    } })
    stableFetch.fn = world
    const onRows = vi.fn()
    render(<PutUpFromPlanting planting={PLANTING} fetch={world} now={NOW} onRows={onRows} />)
    const before = await openDoor()
    await save('loc-1', 'whole_freeze')
    expect(reads).toBe(2)
    expect(screen.queryByText(/Loading/)).toBeNull()
    expect([doorButton(), !!line(), screen.getByText(EMPTY_TEXT) != null]).toEqual([before, true, true])
    await act(async () => { release() })
    await waitFor(() => expect(rowHeads()).toEqual(['Sungold cherry']))
    expect(onRows.mock.calls.map(c => c[0].map(r => r.id))).toEqual([[], [world.world.answers[0].id]])
    expect(doorButton()).toBe(before)
  })
})

describe('Undo: the line says so, and both reads re-run', () => {
  it('Undo on a put-up sends DELETE /api/preservation/<id>; the row leaves the list and the line reads Undone', async () => {
    const world = mountPage()
    const before = await openDoor()
    await save('loc-1', 'whole_freeze')
    await waitFor(() => expect(rowHeads()).toHaveLength(1))
    const l = line()
    const said = lineText()
    const id = world.world.answers[0].id
    fireEvent.click(screen.getByTestId('pantry-completion-undo'))
    await waitFor(() => expect(rowHeads()).toEqual([]))
    expect(world.calls('DELETE').map(c => c.path)).toEqual([`/api/preservation/${id}`])
    // The SAME line (its own state survived the list emptying under it), now saying Undone, with × only.
    expect(line()).toBe(l)
    expect(lineText()).toBe(`Undone — ${said}`)
    expect(screen.queryByTestId('pantry-completion-undo')).toBeNull()
    expect(screen.getByRole('button', { name: 'Close — the saved line' })).toBeTruthy()
    expect([doorButton(), doorButton().textContent]).toEqual([before, DOOR_FIRST_TEXT])
    expect(screen.getByText(EMPTY_TEXT)).toBeTruthy()
    // Both reads ran again after the Undo: three of each (open, Save, Undo).
    expect([world.calls('GET', '/api/preservation/whats-put-up').length, world.calls('GET', '/api/kitchen-batches?').length]).toEqual([3, 3])
  })

  it('Undo on an item sends the item DELETE; it leaves Kept fresh', async () => {
    const world = mountPage()
    await openDoor()
    await save('loc-3', 'as_is')
    const id = world.world.answers[0].item.id
    await screen.findByTestId(`planting-fresh-${id}`)
    fireEvent.click(screen.getByTestId('pantry-completion-undo'))
    await waitFor(() => expect(screen.queryByTestId(`planting-fresh-${id}`)).toBeNull())
    expect(world.calls('DELETE').map(c => c.path)).toEqual([`/api/pantry/items/${id}`])
    expect(lineText()).toBe('Undone — Sungold cherry — in the pantry · Kitchen fridge')
  })

  it('Undo fails: the line and Undo stay, with the refusal', async () => {
    const world = mountPage({ world: plantingWorld({ overrides: {
      'DELETE /api/preservation/*': () => { throw apiError(500, { error: 'Something went wrong' }) },
    } }) })
    await openDoor()
    await save('loc-1', 'whole_freeze')
    await waitFor(() => expect(rowHeads()).toHaveLength(1))
    const said = lineText()
    fireEvent.click(screen.getByTestId('pantry-completion-undo'))
    await waitFor(() => expect(screen.getByTestId('pantry-completion-error')).toBeTruthy())
    await settle()
    expect([!!line(), lineText(), !!screen.queryByTestId('pantry-completion-undo')]).toEqual([true, said, true])
    expect(rowHeads()).toHaveLength(1)
    expect(world.calls('DELETE')).toHaveLength(1)
  })

  it('a second save after an Undo is a new line, with its own Undo', async () => {
    mountPage()
    await openDoor()
    await save('loc-1', 'whole_freeze')
    fireEvent.click(screen.getByTestId('pantry-completion-undo'))
    await waitFor(() => expect(lineText()).toMatch(/^Undone — /))
    await openDoor()
    await save('loc-3', 'as_is')
    expect(lineText()).toBe('Sungold cherry — in the pantry · Kitchen fridge')
    expect(screen.getByTestId('pantry-completion-undo')).toBeTruthy()
  })

  it('the line is gone on the next visit', async () => {
    const world = mountPage()
    await openDoor()
    await save('loc-1', 'whole_freeze')
    expect(line()).toBeTruthy()
    cleanup()
    mountPage({ world })
    await screen.findAllByTestId('putup-from-planting-row')
    expect(line()).toBeNull()
  })
})

describe('the door\'s draft, shared with the Pantry\'s door', () => {
  const PANTRY_DRAFT = { key: 'k-pantry', what: { source: 'typed', name: 'Oat milk' }, place: { key: 'id:loc-3', id: 'loc-3', label: 'Kitchen fridge', kind: 'fridge' },
    method: 'as_is', count: '1', whenChip: 'today', estimate: null, pickedDate: '', discard: { mode: 'auto', date: '' }, notes: 'half a carton' }

  it('opened from the link and closed untouched: no draft, no hold; the Pantry\'s door then opens empty', async () => {
    mountPage()
    await openDoor()
    expect(clean()).toEqual([0, null, false])
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByTestId('door-sheet')).toBeNull())
    await settle()
    expect(clean()).toEqual([0, null, false])
    cleanup()
    mountPantryDoor()
    await screen.findByTestId('door-place-id:loc-1')
    await settle()
    expect(screen.getByTestId('door-what-name').value).toBe('')
    expect(checkedPlace()).toEqual([])
    expect(clean()).toEqual([0, null, false])
  })

  it('a Pantry draft survives an untouched open here, and is replaced at the first change', async () => {
    writeSheetDraft(DRAFT_KEY, DOOR_SHEET, PANTRY_DRAFT)
    const stored = localStorage.getItem(DRAFT_KEY)
    mountPage()
    await openDoor()
    // The planting is what the door opened on — not the stored draft's name, place or method.
    expect(screen.getByTestId('door-what-name').value).toBe('Sungold cherry')
    expect(checkedPlace()).toEqual([])
    expect(localStorage.getItem(DRAFT_KEY)).toBe(stored)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByTestId('door-sheet')).toBeNull())
    await settle()
    expect(localStorage.getItem(DRAFT_KEY)).toBe(stored)
    await openDoor()
    expect(localStorage.getItem(DRAFT_KEY)).toBe(stored)
    fireEvent.click(screen.getByTestId('door-place-id:loc-1'))                 // the first real change
    await waitFor(() => expect(readSheetDraft(DRAFT_KEY, DOOR_SHEET, isDoorDraft)?.what).toEqual(WHAT))
    expect(readSheetDraft(DRAFT_KEY, DOOR_SHEET, isDoorDraft).place.id).toBe('loc-1')
  })

  it('the Pantry\'s unseeded door later restores a draft written from this host, and saves it to the planting', async () => {
    mountPage()
    await openDoor()
    fireEvent.click(screen.getByTestId('door-place-id:loc-1'))
    fireEvent.click(screen.getByTestId('door-method-whole_freeze'))
    await waitFor(() => expect(readSheetDraft(DRAFT_KEY, DOOR_SHEET, isDoorDraft)?.method).toBe('whole_freeze'))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByTestId('door-sheet')).toBeNull())
    cleanup()
    const onSaved = vi.fn()
    const world = plantingWorld()
    stableFetch.fn = world
    mountPantryDoor({ onSaved })
    await screen.findByTestId('door-place-id:loc-1')
    await settle()
    expect(screen.getByTestId('door-what-name').value).toBe('Sungold cherry')
    expect(checkedPlace()).toEqual(['door-place-id:loc-1'])
    expect(screen.getByTestId('door-method-whole_freeze').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('door-save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(world.calls('POST', '/api/preservation')[0].body).toMatchObject({ label: 'Sungold cherry', plant_id: 'pl-1', crop_type_slug: 'tomato', variety_id: 'var-sg' })
  })
})

// Against REAL jsdom history and the REAL dismiss registry (the app's order: router, then registry). Under
// MemoryRouter with no registry the door's Back entry does not exist and a Back test passes over nothing.
describe('the planting page stays: at rest, X, Back and Save', () => {
  const PAGE = '/projects/proj1/plantings/pl-1'
  const NET_MS = 2000
  let pops = 0
  const onPop = () => { pops += 1 }
  const settleBack = (from) => act(async () => {
    const deadline = Date.now() + NET_MS
    while (pops === from && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
    let seen
    do {
      seen = pops
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
    } while (pops !== seen && Date.now() < deadline)
  })
  const back = async () => { const from = pops; act(() => { window.history.back() }); await settleBack(from) }
  const armed = () => !!readMarker(window.history.state)
  const url = () => window.location.pathname + window.location.search
  const at = () => screen.getByTestId('at').textContent

  async function mountUnderHistory(world = plantingWorld()) {
    stableFetch.fn = world
    await act(async () => {
      render(
        <BrowserRouter>
          <DismissRegistryProvider>
            <Routes>
              <Route path="/projects/:id/plantings/:plantingId" element={<><Probe /><PlantingKitchen planting={PLANTING} fetch={world} now={NOW} /></>} />
              <Route path="*" element={<Probe />} />
            </Routes>
          </DismissRegistryProvider>
        </BrowserRouter>,
      )
    })
    await screen.findByTestId('putup-from-planting-door')
    await settle()
    return world
  }
  const stillHere = () => [url(), at(), armed(), !!screen.queryByRole('dialog'), !!screen.queryByTestId('putup-from-planting-door')]

  beforeEach(() => {
    window.addEventListener('popstate', onPop)
    window.history.replaceState({ __base: 1 }, '', '/garden')
    window.history.pushState({ __page: 1 }, '', PAGE)
  })
  afterEach(async () => {
    cleanup()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    window.removeEventListener('popstate', onPop)
  })

  it('the planting page at rest: no door, no places read, history length unchanged, no reload hold, no draft written', async () => {
    const length = window.history.length
    const world = await mountUnderHistory()
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByTestId('door-sheet')).toBeNull()
    expect(world.calls('GET', '/api/storage-locations')).toHaveLength(0)
    expect(world.calls('GET', '/api/kitchen-batches/line-search')).toHaveLength(0)
    expect([window.history.length, armed(), isReloadBlocked(), localStorage.getItem(DRAFT_KEY), minted.n]).toEqual([length, false, false, null, 0])
    // INSTRUMENT: a tap does arm it (so the checks above can see a door when there is one).
    await openDoor()
    expect([armed(), world.calls('GET', '/api/storage-locations').length]).toEqual([true, 1])
  })

  it('location is the planting page after each: X, Back, and Save', async () => {
    await mountUnderHistory()
    await openDoor()
    expect(url()).toBe(PAGE)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await settleBack(pops)
    expect(stillHere()).toEqual([PAGE, PAGE, false, false, true])

    await openDoor()
    await back()
    expect(stillHere()).toEqual([PAGE, PAGE, false, false, true])

    await openDoor()
    const from = pops
    await save('loc-1', 'whole_freeze')
    await settleBack(from)
    expect(stillHere()).toEqual([PAGE, PAGE, false, false, true])
    expect(line()).toBeTruthy()
  })

  it('the button, then the phone\'s Back at once: still on the planting', async () => {
    await mountUnderHistory()
    await tapDoor()
    await waitFor(() => expect(armed()).toBe(true))
    await back()
    expect(stillHere()).toEqual([PAGE, PAGE, false, false, true])
    expect(clean()).toEqual([0, null, false])
  })
})

// The page itself: with the door open, an arrow key on a door control does not page to another planting.
describe('PlantingDetail — the pager is inactive while the door is open', () => {
  const NAMES = { pl1: 'Ancho', pl2: 'Jalapeno' }
  const plantingById = (id) => ({
    id, name: NAMES[id] || id, project_id: 'proj1', project_name: 'Peppers 2026', status: 'fruiting', quantity: 1, variety_ref: null,
    sown_at: null, transplanted_at: null, source_type: null, lineage_note: null, notes: null, location_path: null, featured_photo_view_url: null,
  })
  function mountDetail() {
    const world = plantingWorld({ overrides: {
      'GET /api/plants/*': ({ path }) => plantingById(path.split('/').pop().split('?')[0]),
      'GET /api/events*': () => [],
      'GET /api/members*': () => [],
    } })
    stableFetch.fn = world
    render(
      <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
        <Routes>
          <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
        </Routes>
      </MemoryRouter>,
    )
    return world
  }
  beforeEach(() => {
    __resetPlantingSequence()
    setPlantingSequence({ items: [{ projectId: 'proj1', plantingId: 'pl1', name: 'Ancho' }, { projectId: 'proj1', plantingId: 'pl2', name: 'Jalapeno' }], ctxLabel: 'Peppers' })
  })
  afterEach(() => __resetPlantingSequence())

  it('with the door open an arrow key does not page; closed, the same key does', async () => {
    mountDetail()
    await screen.findByRole('heading', { name: 'Ancho' })
    await openDoor()
    const more = screen.getByTestId('door-more')                  // a door button: not an input, not a radio
    more.focus()
    await act(async () => { fireEvent.keyDown(more, { key: 'ArrowRight' }); await Promise.resolve() })
    await settle()
    expect(screen.getByRole('heading', { name: 'Ancho' })).toBeTruthy()
    expect(screen.getByTestId('door-sheet')).toBeTruthy()
    // INSTRUMENT: with the door closed, the same key pages.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByTestId('door-sheet')).toBeNull())
    await act(async () => { fireEvent.keyDown(document.body, { key: 'ArrowRight' }); await Promise.resolve() })
    await screen.findByRole('heading', { name: 'Jalapeno' })
  })
})

describe('words — the section in every state, with the line showing', () => {
  it('no banned word, nothing counted, nothing unfilled', async () => {
    const texts = []
    const section = () => screen.getByTestId('planting-kitchen').textContent
    mountPage()
    await screen.findByTestId('putup-from-planting-door')
    texts.push(section())                                                       // empty
    await openDoor()
    await save('loc-1', 'whole_freeze')
    await waitFor(() => expect(rowHeads()).toHaveLength(1))
    texts.push(section())                                                       // a put-up saved, the line showing
    fireEvent.click(screen.getByTestId('pantry-completion-undo'))
    await waitFor(() => expect(lineText()).toMatch(/^Undone — /))
    texts.push(section())                                                       // undone
    await openDoor()
    await save('loc-3', 'as_is')
    await screen.findByTestId('planting-kept-fresh')
    texts.push(section())                                                       // Fresh, as picked saved, the line showing
    for (const text of texts) {
      expect(text).not.toMatch(BANNED)
      expect(text).not.toMatch(/%|\btotal\b|\d+ batches|\bcontainers?\b|\bput-ups?\b/i)
      expect(text).not.toMatch(/null|undefined|NaN|\[object/)
    }
    // INSTRUMENT: the states were really on screen.
    expect(texts.map(t => [t.includes(EMPTY_TEXT), /— put up ·/.test(t), t.includes('Undone —'), t.includes('in the pantry')]))
      .toEqual([[true, false, false, false], [false, true, false, false], [true, true, true, false], [true, false, false, true]])
    expect('How long it keeps').toMatch(BANNED)
  })
})
