// Put-Up R2a, lane P — the Pantry's Places sheet: rename a place, change its kind, delete one that holds
// nothing (C1). The form's "Edit locations" editor is frozen in R2a and keeps its own tests, unedited
// (PutUpStorageLocationEdit.test.jsx); these are the same behaviours on the new surface, under the titles
// the QA seat's table gives where it gives one. Every assertion about a write is about THE WIRE.
//
// WHAT CHANGED FROM THE FORM'S EDITOR, each pinned here:
//   • the door is drawn from a read of the PLACES, never from the Pantry's groups: an empty place has no
//     group, and a mistyped place is usually exactly that;
//   • the list says what is stored in each place, counted from the UNFILTERED Pantry rows;
//   • Delete… is offered only where nothing is stored (the server refuses it otherwise);
//   • a save sends ONLY what changed, so a rename never carries `kind` and can never meet the re-kind refusal;
//   • the re-kind refusal is said in the sheet's own two lines, built from the answer's `n`;
//   • flat: one row open at a time, Escape in an editor cancels the edit, Back closes the sheet from any state.
// KIND WORDS are read from putup/placeKinds.js here too: lane Df changes them, and these tests must not care.
// MUTATIONS (run, see the lane report): P-M1 … P-M6, Δ-M1, `kind` sent on a pure rename.
// CI LANE: `npm test` plus the blocking TZ re-run. Nothing here reads a clock. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, apiError } from './helpers/pantryFake.js'

installStoragePolyfill()

const { wired } = vi.hoisted(() => ({ wired: { fake: null } }))
// ONE function for the whole file: a fetch whose identity changed between renders would re-run every read.
const f = (...a) => wired.fake(...a)
vi.mock('../lib/api.js', () => {
  const g = (...a) => wired.fake(...a)
  return { useApiFetch: () => ({ fetch: g, getToken: () => Promise.resolve('t') }), apiFetch: g }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import PantryView, { usePantryList } from '../components/pantry/PantryView.jsx'
import PantryRowSheet from '../components/pantry/PantryRowSheet.jsx'
import PlacesSheet, {
  storedIn, storedWords, storedBlocksDeleteWords, rekindRefusedLines, deleteQuestion, deletedWords, kindWords,
  EDIT_PLACES_LABEL, PLACES_TITLE, PLACE_KIND_QUESTION, PLACE_NAME_REQUIRED_TEXT, PLACE_NAME_TAKEN_TEXT, PLACE_SAVED_TEXT,
  NO_PLACES_TEXT, PLACES_LOAD_FAILED_TEXT, PLACE_SAVE_FAILED_TEXT, PLACE_DELETE_FAILED_TEXT,
} from '../components/pantry/PlacesSheet.jsx'
import { PLACE_KINDS, placeKindLabel } from '../components/putup/placeKinds.js'
import { ensurePlaceId, listPlaces, updatePlace, deletePlace, PLACES_PATH } from '../lib/pantryApi.js'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Two chest freezers that hold things, the typo this sheet exists for (it holds nothing), an empty shelf,
// and a household peer's fridge. Scoping is the server's job: the client must not hide her row.
const CF1 = { id: 'loc-1', user_id: 'user_dave', label: 'Chest Freezer 1', kind: 'deep_freezer' }
const CF2 = { id: 'loc-2', user_id: 'user_dave', label: 'Chest Freezer 2', kind: 'deep_freezer' }
const TYPO = { id: 'loc-3', user_id: 'user_dave', label: 'Garage freezr', kind: 'deep_freezer' }
const SHELF = { id: 'loc-4', user_id: 'user_dave', label: 'Garage shelf', kind: 'pantry' }
const JEN = { id: 'loc-5', user_id: 'user_jen', label: "Jen's fridge", kind: 'fridge' }
const OFF_LIST = { id: 'loc-6', user_id: 'user_dave', label: 'Old crock shelf', kind: 'root_cellar_v0' }
const PLACES = [CF1, CF2, TYPO, SHELF, JEN]

const at = (place, o) => ({ place: { id: place.id, label: place.label, kind: place.kind }, group_key: place.id, group_label: place.label, ...o })
const jar = (place, id, o = {}) => jarRow(at(place, { stock_id: id, name: id, ...o }))
// Four in Chest Freezer 1 (ONE of them to use soon), one in Chest Freezer 2, one bought item in Jen's fridge.
const ROWS = [
  jar(CF1, 'blueberries'), jar(CF1, 'corn'), jar(CF1, 'peas'),
  jar(CF1, 'pesto', { discard: { date: '2026-10-05', basis: 'table', status: 'soon' } }),
  jar(CF2, 'stock'),
  itemRow(at(JEN, { stock_id: 'milk', name: 'Oat milk' })),
]

// The fake's PUT and DELETE answer and rewrite nothing. This file's default lays a rename over the places
// the next read answers AND over the rows' own place (the server's list would carry the new name), and a
// delete takes the place out of the next read. Every read answers COPIES, as a real response does: handed
// the fake's own array, a component would hold the very objects the next write here rewrites.
function wire({ places = PLACES, rows = ROWS, overrides = {} } = {}) {
  const live = places.map(p => ({ ...p }))
  const idOf = (path) => decodeURIComponent(path.split('/').pop())
  wired.fake = pantryFetch({ rows, places: live, overrides: {
    'GET /api/storage-locations': () => live.map(p => ({ ...p })),
    'PUT /api/storage-locations/*': ({ path, body, state }) => {
      const p = live.find(x => x.id === idOf(path))
      if (body.label != null) p.label = String(body.label).trim()
      if (body.kind != null) p.kind = body.kind
      state.rows = state.rows.map(r => (r.place?.id === p.id
        ? { ...r, place: { ...r.place, label: p.label, kind: p.kind }, group_label: r.group_key === p.id ? p.label : r.group_label } : r))
      return { ...p }
    },
    'DELETE /api/storage-locations/*': ({ path }) => {
      const i = live.findIndex(x => x.id === idOf(path))
      if (i >= 0) live.splice(i, 1)
      return { ok: true }
    },
    ...overrides,
  } })
  return wired.fake
}
const calls = (method, prefix = PLACES_PATH) => wired.fake.calls(method, prefix)
const pantryReads = () => wired.fake.calls('GET', '/api/pantry?')
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

// The Pantry as the page mounts it: the real list hook, so a re-read is a real second GET.
function Pantry(props) {
  const [group, setGroup] = useState('place')
  const pantry = usePantryList({ fetch: f, group })
  const [recent, setRecent] = useState({})
  return (
    <PantryView fetch={f} group={group} onGroupChange={setGroup} rows={pantry.rows} loading={pantry.loading} error={pantry.error}
      onReload={pantry.reload} recent={recent} onRecent={setRecent} now={new Date(2026, 9, 2).getTime()} {...props} />
  )
}
const door = () => screen.queryByTestId('pantry-edit-places')
async function openPlaces(props) {
  const view = render(<Pantry {...props} />)
  const link = await screen.findByTestId('pantry-edit-places')
  link.focus()                                                    // a tap focuses what it taps; fireEvent.click does not
  fireEvent.click(link)
  await screen.findAllByTestId('pu-location-row')
  // The Pantry list has answered: the counts are known.
  await waitFor(() => expect(pantryReads().length).toBeGreaterThan(0))
  await settle()
  return view
}
const rows = () => screen.queryAllByTestId('pu-location-row')
const rowFor = (id) => rows().find(r => r.getAttribute('data-loc-id') === id)
const detailOf = (id) => within(rowFor(id)).getByTestId('pu-location-detail').textContent
const edit = (id) => fireEvent.click(within(rowFor(id)).getByTestId('pu-location-rename'))
const nameField = () => screen.getByTestId('pu-location-name')
const type = (text) => fireEvent.change(nameField(), { target: { value: text } })
const save = () => fireEvent.click(screen.getByTestId('pu-location-save'))
const kindChips = () => [...screen.getByRole('radiogroup', { name: PLACE_KIND_QUESTION }).querySelectorAll('[role="radio"]')]
const chosenKind = () => kindChips().filter(c => c.getAttribute('aria-checked') === 'true').map(c => c.getAttribute('data-testid'))
const word = (kind) => placeKindLabel(kind)

beforeEach(() => { wire(); localStorage.clear(); sessionStorage.clear() })

describe('the door — Edit places on the Group-by row', () => {
  it('`Edit places` is absent when the places read is empty', async () => {
    wire({ places: [], rows: [] })
    render(<Pantry />)
    await waitFor(() => expect(calls('GET')).toHaveLength(1))
    await settle()
    expect(door()).toBeNull()
    expect(screen.getByRole('radiogroup', { name: 'Group by' })).toBeTruthy()
  })

  it('one empty place: Edit places is there', async () => {
    // Nothing is stored anywhere, so the Pantry has no group at all. The place is still there to fix.
    wire({ places: [SHELF], rows: [] })
    render(<Pantry />)
    expect((await screen.findByTestId('pantry-edit-places')).textContent).toBe('Edit places')
    expect(EDIT_PLACES_LABEL).toBe('Edit places')
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0)
    expect(screen.getByTestId('pantry-empty')).toBeTruthy()
  })

  it('it is absent until the places read answers, and stays absent when that read fails', async () => {
    let answer
    wire({ overrides: { 'GET /api/storage-locations': () => new Promise((res, rej) => { answer = { res, rej } }) } })
    render(<Pantry />)
    await waitFor(() => expect(calls('GET')).toHaveLength(1))
    await screen.findByTestId('pantry-group-loc-1')
    expect(door()).toBeNull()                                    // the Pantry has groups; the read has not answered
    await act(async () => { answer.rej(new Error('Failed to fetch')) })
    await settle()
    expect(door()).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()               // it fails without a word: the Pantry is whole
    expect(calls('GET')).toHaveLength(1)
  })

  it('an answer that is not a list is no door, never "no places"', async () => {
    wire({ overrides: { 'GET /api/storage-locations': () => ({ places: PLACES }) } })
    render(<Pantry />)
    await screen.findByTestId('pantry-group-loc-1')
    await settle()
    expect(door()).toBeNull()
    await expect(listPlaces(async () => ({ places: PLACES }))).rejects.toThrow()
    await expect(listPlaces(async () => null)).rejects.toThrow()
    expect(await listPlaces(async () => PLACES)).toBe(PLACES)
  })

  it('it is a quiet 48 px button at the end of the Group-by row, read ONCE when the Pantry mounts', async () => {
    render(<Pantry />)
    const link = await screen.findByTestId('pantry-edit-places')
    const group = screen.getByRole('radiogroup', { name: 'Group by' })
    expect(link.parentElement).toBe(group.parentElement)
    expect([...group.parentElement.children]).toEqual([group, link])
    expect(link.style.minHeight).toBe('48px')
    expect(link.style.background).toMatch(/^none/)                // quiet: the screen's one filled button is the header's
    // A re-read of the list, and a regroup, ask for the places no more.
    fireEvent.click(screen.getByRole('radio', { name: 'By what it is' }))
    await waitFor(() => expect(pantryReads()).toHaveLength(2))
    await settle()
    expect(calls('GET')).toHaveLength(1)
  })

  it('opens a sheet titled Places; Close closes it, and the door has the focus back', async () => {
    await openPlaces()
    expect(PLACES_TITLE).toBe('Places')
    const dialog = screen.getByRole('dialog', { name: 'Places' })
    expect(within(dialog).getByTestId('places-sheet')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(door())
  })
})

describe('the list', () => {
  it('an empty place is listed: every live place, with its kind\'s word and what is stored there', async () => {
    await openPlaces()
    expect(rows().map(r => r.getAttribute('data-loc-id'))).toEqual(['loc-1', 'loc-2', 'loc-3', 'loc-4', 'loc-5'])
    expect(within(rowFor('loc-3')).getByText('Garage freezr')).toBeTruthy()
    expect(detailOf('loc-1')).toBe(`${word('deep_freezer')} · 4 stored here`)
    expect(detailOf('loc-2')).toBe(`${word('deep_freezer')} · 1 stored here`)
    expect(detailOf('loc-3')).toBe(`${word('deep_freezer')} · nothing stored here`)
    expect(detailOf('loc-4')).toBe(`${word('pantry')} · nothing stored here`)
    expect(detailOf('loc-5')).toBe(`${word('fridge')} · 1 stored here`)
    // The Pantry itself has no heading for the two empty places: the sheet is the only place they show.
    expect(screen.queryByTestId('pantry-group-loc-3')).toBeNull()
    expect(screen.queryByTestId('pantry-group-loc-4')).toBeNull()
  })

  it('the sheet reads the places itself when it opens: one more GET, and a place made since the Pantry mounted is there', async () => {
    const view = render(<Pantry />)
    await screen.findByTestId('pantry-edit-places')
    expect(calls('GET')).toHaveLength(1)
    // Another phone makes a place.
    wired.fake = wire({ places: [...PLACES, { id: 'loc-9', user_id: 'user_jen', label: 'Porch fridge', kind: 'fridge' }] })
    fireEvent.click(screen.getByTestId('pantry-edit-places'))
    await waitFor(() => expect(rows()).toHaveLength(6))
    expect(calls('GET')).toHaveLength(1)                          // one, on the new fake: the second in all
    expect(within(rowFor('loc-9')).getByText('Porch fridge')).toBeTruthy()
    view.unmount()
  })

  it('N stored here under Use soon is the unfiltered count', async () => {
    await openPlaces({ useSoonOnly: true })
    // The list on screen is narrowed to the one put-up to use soon…
    expect(screen.getByTestId('pantry-group-loc-1').querySelectorAll('li')).toHaveLength(1)
    expect(screen.queryByTestId('pantry-group-loc-2')).toBeNull()
    // …and the sheet still counts everything the place holds.
    expect(detailOf('loc-1')).toBe(`${word('deep_freezer')} · 4 stored here`)
    expect(detailOf('loc-2')).toBe(`${word('deep_freezer')} · 1 stored here`)
    expect(within(rowFor('loc-2')).queryByTestId('pu-location-delete')).toBeNull()
  })

  it('Delete… only where nothing is stored; a place that holds something says to move it first', async () => {
    await openPlaces()
    for (const id of ['loc-3', 'loc-4']) {
      expect(within(rowFor(id)).getByTestId('pu-location-delete').textContent).toBe('Delete…')
      expect(within(rowFor(id)).queryByTestId('pu-location-in-use')).toBeNull()
    }
    expect(within(rowFor('loc-1')).queryByTestId('pu-location-delete')).toBeNull()
    expect(within(rowFor('loc-1')).getByTestId('pu-location-in-use').textContent).toBe('4 stored here — move them to delete this place.')
    expect(within(rowFor('loc-2')).queryByTestId('pu-location-delete')).toBeNull()
    expect(within(rowFor('loc-2')).getByTestId('pu-location-in-use').textContent).toBe('1 stored here — move it to delete this place.')
    for (const id of ['loc-1', 'loc-2', 'loc-3', 'loc-4', 'loc-5']) {
      expect(within(rowFor(id)).getByTestId('pu-location-rename').textContent).toBe('Edit…')
    }
  })

  it('until the Pantry list has answered nothing is said about what is stored, and no Delete… is offered', async () => {
    render(<PlacesSheet open fetch={f} rows={null} onClose={() => {}} />)
    await screen.findAllByTestId('pu-location-row')
    expect(detailOf('loc-3')).toBe(word('deep_freezer'))
    expect(screen.queryByTestId('pu-location-delete')).toBeNull()
    expect(screen.queryByTestId('pu-location-in-use')).toBeNull()
    expect(storedIn(null, 'loc-3')).toBeNull()
    expect(storedIn(undefined, 'loc-3')).toBeNull()
  })

  it('the count is of rows in that place: a put-up and a bought item alike, and a row with no place in none', () => {
    const loose = jarRow({ stock_id: 'loose', place: null })
    expect(storedIn([...ROWS, loose], 'loc-1')).toBe(4)
    expect(storedIn([...ROWS, loose], 'loc-5')).toBe(1)
    expect(storedIn([...ROWS, loose], 'loc-4')).toBe(0)
    expect(storedIn([], 'loc-1')).toBe(0)
    expect([0, 1, 4].map(storedWords)).toEqual(['nothing stored here', '1 stored here', '4 stored here'])
    expect([1, 4].map(storedBlocksDeleteWords)).toEqual([
      '1 stored here — move it to delete this place.', '4 stored here — move them to delete this place.'])
  })

  it('no places: it says so', async () => {
    wire({ places: [], rows: [] })
    render(<PlacesSheet open fetch={f} rows={[]} onClose={() => {}} />)
    expect((await screen.findByTestId('places-empty')).textContent).toBe('No places yet. A place is made the first time you put something in it.')
    expect(NO_PLACES_TEXT).toBe('No places yet. A place is made the first time you put something in it.')
    expect(rows()).toHaveLength(0)
  })

  it('the read failed: it says so, and Try again reads again', async () => {
    let failing = true
    wire({ overrides: { 'GET /api/storage-locations': () => { if (failing) throw new Error('Failed to fetch'); return PLACES } } })
    render(<PlacesSheet open fetch={f} rows={ROWS} onClose={() => {}} />)
    const line = await screen.findByTestId('places-load-failed')
    expect(line.getAttribute('role')).toBe('alert')
    expect(line.textContent).toBe("Couldn't load your places. Try again")
    expect(PLACES_LOAD_FAILED_TEXT).toBe("Couldn't load your places.")
    expect(screen.queryByTestId('places-empty')).toBeNull()       // a failed read is never "no places"
    failing = false
    fireEvent.click(screen.getByTestId('places-retry'))
    await waitFor(() => expect(rows()).toHaveLength(5))
    expect(screen.queryByTestId('places-load-failed')).toBeNull()
    expect(calls('GET')).toHaveLength(2)
  })
})

describe('rename — PUT /api/storage-locations/:id', () => {
  it('a rename sends the label alone', async () => {
    await openPlaces()
    edit('loc-3')
    expect(nameField().value).toBe('Garage freezr')
    type('Garage freezer')
    save()
    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(calls('PUT')[0]).toEqual({ path: '/api/storage-locations/loc-3', method: 'PUT', body: { label: 'Garage freezer' } })
  })

  it('a rename of a place that HOLDS dated put-ups sends the label alone too: it can never meet the re-kind refusal', async () => {
    await openPlaces()
    edit('loc-1')
    type('Garage chest freezer')
    save()
    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(calls('PUT')[0].body).toEqual({ label: 'Garage chest freezer' })
    expect(Object.keys(calls('PUT')[0].body)).not.toContain('kind')
  })

  it('the heading reads the new name: the Pantry list is re-read once after a save', async () => {
    await openPlaces()
    expect(screen.getByTestId('pantry-group-loc-1').querySelector('h2').textContent).toBe('Chest Freezer 1')
    const before = pantryReads().length
    edit('loc-1')
    type('Garage chest freezer')
    save()
    await waitFor(() => expect(screen.getByTestId('pantry-group-loc-1').querySelector('h2').textContent).toBe('Garage chest freezer'))
    await settle()
    expect(pantryReads()).toHaveLength(before + 1)
    // And the sheet's own row reads it with no read of its own.
    expect(within(rowFor('loc-1')).getByText('Garage chest freezer')).toBeTruthy()
    expect(calls('GET')).toHaveLength(2)                          // the Pantry's at mount, the sheet's at open
  })

  it('after a save the row says "Saved." in place, the editor is gone and the row\'s Edit… has the focus', async () => {
    await openPlaces()
    edit('loc-3')
    type('Garage freezer')
    save()
    const said = await screen.findByTestId('pu-location-saved')
    expect(said.textContent).toBe('Saved.')
    expect(PLACE_SAVED_TEXT).toBe('Saved.')
    expect(said.getAttribute('role')).toBe('status')
    expect(rowFor('loc-3').contains(said)).toBe(true)
    expect(screen.queryByTestId('pu-location-editor')).toBeNull()
    expect(document.activeElement).toBe(within(rowFor('loc-3')).getByTestId('pu-location-rename'))
    // No timer: it is still there, and it goes when the next thing is opened.
    await settle()
    expect(screen.getByTestId('pu-location-saved')).toBeTruthy()
    edit('loc-4')
    expect(screen.queryByTestId('pu-location-saved')).toBeNull()
  })

  it('trims the name rather than storing the spaces', async () => {
    await openPlaces()
    edit('loc-1')
    type('  Deep freeze  ')
    save()
    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(calls('PUT')[0].body).toEqual({ label: 'Deep freeze' })
  })

  it('a blank name is refused in place and sends nothing', async () => {
    await openPlaces()
    edit('loc-1')
    type('   ')
    save()
    expect(screen.getByRole('alert').textContent).toBe('Give the place a name.')
    expect(PLACE_NAME_REQUIRED_TEXT).toBe('Give the place a name.')
    expect(nameField().getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(nameField())
    await settle()
    expect(calls('PUT')).toHaveLength(0)
    expect(screen.getByTestId('pu-location-editor')).toBeTruthy()
  })

  it('nothing changed: Save closes the editor, sends nothing and says nothing', async () => {
    await openPlaces()
    const before = pantryReads().length
    edit('loc-1')
    save()
    await settle()
    expect(calls('PUT')).toHaveLength(0)
    expect(screen.queryByTestId('pu-location-editor')).toBeNull()
    expect(screen.queryByTestId('pu-location-saved')).toBeNull()
    expect(pantryReads()).toHaveLength(before)
    // A name that differs only by spaces at its ends is the same name.
    edit('loc-1')
    type(' Chest Freezer 1 ')
    save()
    await settle()
    expect(calls('PUT')).toHaveLength(0)
  })

  it('a save that fails keeps the editor and what was typed, and says so', async () => {
    wire({ overrides: { 'PUT /api/storage-locations/*': () => { throw apiError(500, { error: 'boom' }) } } })
    await openPlaces()
    const before = pantryReads().length
    edit('loc-1')
    type('Renamed')
    save()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Couldn't save that — try again."))
    expect(PLACE_SAVE_FAILED_TEXT).toBe("Couldn't save that — try again.")
    expect(nameField().value).toBe('Renamed')
    expect(screen.getByTestId('pu-location-save').disabled).toBe(false)
    expect(screen.queryByTestId('pu-location-saved')).toBeNull()
    expect(pantryReads()).toHaveLength(before)
  })

  it('Enter in the name field puts the keyboard away and never saves', async () => {
    await openPlaces()
    edit('loc-3')
    expect(document.activeElement).toBe(nameField())             // Edit opens on the name
    expect(nameField().getAttribute('enterkeyhint')).toBe('done')
    type('Garage freezer')
    const notPrevented = fireEvent.keyDown(nameField(), { key: 'Enter' })
    expect(notPrevented).toBe(false)
    expect(document.activeElement).not.toBe(nameField())
    await settle()
    expect(calls('PUT')).toHaveLength(0)
    expect(nameField().value).toBe('Garage freezer')
  })

  it('Escape in an open editor cancels the edit, and the sheet stays', async () => {
    await openPlaces()
    edit('loc-3')
    type('Garage freezer')
    const notPrevented = fireEvent.keyDown(nameField(), { key: 'Escape' })
    expect(notPrevented).toBe(false)
    expect(screen.queryByTestId('pu-location-editor')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Places' })).toBeTruthy()
    expect(within(rowFor('loc-3')).getByText('Garage freezr')).toBeTruthy()
    expect(calls('PUT')).toHaveLength(0)
    // Opened again it starts from the stored name, not from what was typed and thrown away.
    edit('loc-3')
    expect(nameField().value).toBe('Garage freezr')
  })

  it('Cancel closes the editor and sends nothing', async () => {
    await openPlaces()
    edit('loc-3')
    type('Garage freezer')
    fireEvent.click(screen.getByTestId('pu-location-cancel'))
    expect(screen.queryByTestId('pu-location-editor')).toBeNull()
    expect(document.activeElement).toBe(within(rowFor('loc-3')).getByTestId('pu-location-rename'))
    expect(calls('PUT')).toHaveLength(0)
  })

  it('one row is open at a time: Edit… on another row closes this one, and so does Delete…', async () => {
    await openPlaces()
    edit('loc-3')
    expect(rowFor('loc-3').contains(screen.getByTestId('pu-location-editor'))).toBe(true)
    edit('loc-4')
    expect(screen.getAllByTestId('pu-location-editor')).toHaveLength(1)
    expect(rowFor('loc-4').contains(screen.getByTestId('pu-location-editor'))).toBe(true)
    expect(nameField().value).toBe('Garage shelf')
    fireEvent.click(within(rowFor('loc-3')).getByTestId('pu-location-delete'))
    expect(screen.queryByTestId('pu-location-editor')).toBeNull()
    expect(rowFor('loc-3').contains(screen.getByTestId('pu-location-confirm-delete'))).toBe(true)
    edit('loc-4')
    expect(screen.queryByTestId('pu-location-confirm-delete')).toBeNull()
  })

  it('with a name typed a stray tap on the backdrop does nothing; with nothing changed it closes the sheet', async () => {
    await openPlaces()
    const backdrop = () => screen.getByRole('dialog', { name: 'Places' }).previousSibling
    edit('loc-3')
    type('Garage freezer')
    fireEvent.click(backdrop())
    expect(screen.getByRole('dialog', { name: 'Places' })).toBeTruthy()
    expect(nameField().value).toBe('Garage freezer')
    type('Garage freezr')                                        // back to the stored name: nothing to lose
    fireEvent.click(backdrop())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the editor has ONE filled button, Save; the list has none', async () => {
    await openPlaces()
    const filled = () => [...screen.getByTestId('places-sheet').querySelectorAll('button')]
      .filter(b => b.style.backgroundColor && b.style.backgroundColor !== 'transparent').map(b => b.textContent)
    expect(filled()).toEqual([])
    edit('loc-3')
    expect(filled().filter(t => !kindChips().some(c => c.textContent === t))).toEqual(['Save'])
    expect(within(screen.getByTestId('pu-location-editor')).getByText('Name').tagName).toBe('LABEL')
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(nameField())
  })
})

describe('kind — What kind of place?', () => {
  // The storage Lambda's own list, read as text (it is not exported), as placeKinds.test.js reads it.
  function serverKinds() {
    const src = readFileSync(resolve(REPO, 'lambda/storage-location/index.js'), 'utf8')
    const from = src.indexOf('const VALID_KINDS = [')
    if (from < 0) throw new Error('lambda/storage-location/index.js no longer declares `const VALID_KINDS = [`')
    return [...src.slice(from, src.indexOf(']', from)).matchAll(/'([a-z_]+)'/g)].map(m => m[1])
  }

  it('the six chips are placeKinds\' six, which are the server\'s', async () => {
    await openPlaces()
    edit('loc-1')
    expect(PLACE_KIND_QUESTION).toBe('What kind of place?')
    expect(kindChips().map(c => c.getAttribute('data-testid'))).toEqual(PLACE_KINDS.map(k => `pu-location-kind-${k.kind}`))
    expect(kindChips().map(c => c.textContent)).toEqual(PLACE_KINDS.map(k => k.label))
    expect(kindChips()).toHaveLength(6)
    expect(serverKinds()).toHaveLength(6)
    expect([...PLACE_KINDS.map(k => k.kind)].sort()).toEqual([...serverKinds()].sort())
    expect(chosenKind()).toEqual(['pu-location-kind-deep_freezer'])
  })

  it('a re-kind of an EMPTY place sends the kind alone, and the row reads the new kind', async () => {
    await openPlaces()
    edit('loc-3')
    fireEvent.click(screen.getByTestId('pu-location-kind-pantry'))
    expect(chosenKind()).toEqual(['pu-location-kind-pantry'])
    save()
    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(calls('PUT')[0]).toEqual({ path: '/api/storage-locations/loc-3', method: 'PUT', body: { kind: 'pantry' } })
    await screen.findByTestId('pu-location-saved')
    expect(detailOf('loc-3')).toBe(`${word('pantry')} · nothing stored here`)
  })

  it('a rename and a re-kind in one save send both', async () => {
    await openPlaces()
    edit('loc-3')
    type('Garage shelf two')
    fireEvent.click(screen.getByTestId('pu-location-kind-pantry'))
    save()
    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(calls('PUT')[0].body).toEqual({ label: 'Garage shelf two', kind: 'pantry' })
  })

  it('a kind tapped and then put back is not a change: nothing is sent for it', async () => {
    await openPlaces()
    edit('loc-3')
    fireEvent.click(screen.getByTestId('pu-location-kind-pantry'))
    fireEvent.click(screen.getByTestId('pu-location-kind-deep_freezer'))
    type('Garage freezer')
    save()
    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(calls('PUT')[0].body).toEqual({ label: 'Garage freezer' })
  })

  it('an off-list kind is never rewritten', async () => {
    // A place opened to fix a typo must not be re-filed. Its kind is its own chosen chip, a seventh.
    wire({ places: [OFF_LIST], rows: [] })
    await openPlaces()
    expect(detailOf('loc-6')).toBe('root_cellar_v0 · nothing stored here')
    edit('loc-6')
    expect(kindChips()).toHaveLength(7)
    expect(chosenKind()).toEqual(['pu-location-kind-root_cellar_v0'])
    expect(screen.getByTestId('pu-location-kind-root_cellar_v0').textContent).toBe('root_cellar_v0')
    type('Old crock shelf, cellar')
    save()
    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(calls('PUT')[0].body).toEqual({ label: 'Old crock shelf, cellar' })
    expect(JSON.stringify(calls('PUT')[0].body)).not.toMatch(/kind|deep_freezer|fridge/)
  })

  it('an off-list kind changed on purpose is sent, and the seventh chip is then gone', async () => {
    wire({ places: [OFF_LIST], rows: [] })
    await openPlaces()
    edit('loc-6')
    fireEvent.click(screen.getByTestId('pu-location-kind-cold_storage'))
    save()
    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(calls('PUT')[0].body).toEqual({ kind: 'cold_storage' })
    await screen.findByTestId('pu-location-saved')
    edit('loc-6')
    expect(kindChips()).toHaveLength(6)
  })
})

describe('re-kind refused — the sheet\'s own two lines, from the answer\'s n', () => {
  const SERVER_SAYS = '3 put-ups in this place have dates worked out from the kind of place it is now. Set those dates by hand, or move them somewhere else, then change the kind.'
  const refuse = (n, words = SERVER_SAYS) => ({ 'PUT /api/storage-locations/*': () => { throw apiError(409, { error: words, message: words, code: 'place_has_dated_jars', n }) } })

  it('says how many put-ups and which kind, then the two ways out — the count is the ANSWER\'s, never this sheet\'s', async () => {
    // The Pantry lists FOUR things in Chest Freezer 1; the server counted three put-ups with worked-out dates.
    wire({ overrides: refuse(3) })
    await openPlaces()
    const before = pantryReads().length
    edit('loc-1')
    fireEvent.click(screen.getByTestId('pu-location-kind-fridge'))
    save()
    const line1 = await screen.findByRole('alert')
    expect(line1.textContent).toBe(`Can't change the kind: 3 put-ups here have dates worked out for this kind of place (${word('deep_freezer').toLowerCase()}).`)
    expect(screen.getByTestId('pu-location-refusal-next').textContent).toBe('Set those dates by hand from Edit, or move them somewhere else, then change the kind.')
    expect(screen.getByTestId('pu-location-refusal').textContent).not.toContain('in this place')   // not the server's sentence
    expect(calls('PUT')[0].body).toEqual({ kind: 'fridge' })
    // Nothing was written: the editor is still open on what was chosen, the row still says its kind.
    expect(chosenKind()).toEqual(['pu-location-kind-fridge'])
    expect(detailOf('loc-1')).toBe(`${word('deep_freezer')} · 4 stored here`)
    expect(screen.queryByTestId('pu-location-saved')).toBeNull()
    expect(pantryReads()).toHaveLength(before)
  })

  it('one put-up: the singular', async () => {
    wire({ overrides: refuse(1) })
    await openPlaces()
    edit('loc-2')
    fireEvent.click(screen.getByTestId('pu-location-kind-pantry'))
    save()
    expect((await screen.findByRole('alert')).textContent).toBe(`Can't change the kind: 1 put-up here has a date worked out for this kind of place (${word('deep_freezer').toLowerCase()}).`)
    expect(screen.getByTestId('pu-location-refusal-next').textContent).toBe('Set its date by hand from Edit, or move it somewhere else, then change the kind.')
  })

  it('the kind word is the kind the place IS, read from placeKinds, lower case in the sentence', () => {
    for (const k of PLACE_KINDS) {
      expect(rekindRefusedLines(4, k.kind)[0]).toBe(`Can't change the kind: 4 put-ups here have dates worked out for this kind of place (${k.label.toLowerCase()}).`)
    }
    expect(rekindRefusedLines(2, 'root_cellar_v0')[0]).toContain('(root_cellar_v0)')
    expect(kindWords('fridge_freezer')).toBe(placeKindLabel('fridge_freezer'))
  })

  it('an answer that carries no count it can use: the server\'s own sentence', async () => {
    wire({ overrides: refuse(undefined) })
    await openPlaces()
    edit('loc-1')
    fireEvent.click(screen.getByTestId('pu-location-kind-fridge'))
    save()
    expect((await screen.findByRole('alert')).textContent).toBe(SERVER_SAYS)
    expect(screen.queryByTestId('pu-location-refusal-next')).toBeNull()
  })

  it('choosing the place\'s own kind again and saving the name clears the refusal and saves', async () => {
    let refusing = true
    wire({ overrides: { 'PUT /api/storage-locations/*': ({ body }) => {
      if (refusing && body.kind) throw apiError(409, { error: SERVER_SAYS, message: SERVER_SAYS, code: 'place_has_dated_jars', n: 3 })
      return { ...CF1, ...body }
    } } })
    await openPlaces()
    edit('loc-1')
    fireEvent.click(screen.getByTestId('pu-location-kind-fridge'))
    save()
    await screen.findByRole('alert')
    fireEvent.click(screen.getByTestId('pu-location-kind-deep_freezer'))
    type('Garage chest freezer')
    save()
    await screen.findByTestId('pu-location-saved')
    expect(calls('PUT').map(c => c.body)).toEqual([{ kind: 'fridge' }, { label: 'Garage chest freezer' }])
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('delete — two taps, and the second one says what it does', () => {
  const del = (id) => fireEvent.click(within(rowFor(id)).getByTestId('pu-location-delete'))

  it('the first tap deletes nothing', async () => {
    await openPlaces()
    del('loc-4')
    expect(rowFor('loc-4').contains(screen.getByTestId('pu-location-confirm-delete'))).toBe(true)
    await settle()
    expect(calls('DELETE')).toHaveLength(0)
    expect(rows()).toHaveLength(5)
  })

  it('the question says what happens, exactly, and offers Yes, delete and Keep it', async () => {
    await openPlaces()
    del('loc-4')
    expect(screen.getByTestId('pu-location-delete-consequence').textContent)
      .toBe('Delete "Garage shelf"? Nothing is stored there. It stops being offered as a place.')
    expect(deleteQuestion('Garage shelf')).toBe('Delete "Garage shelf"? Nothing is stored there. It stops being offered as a place.')
    const confirm = within(screen.getByTestId('pu-location-confirm-delete'))
    expect(confirm.getAllByRole('button').map(b => b.textContent)).toEqual(['Yes, delete', 'Keep it'])
    expect(screen.getByTestId('pu-location-delete-confirm').textContent).toBe('Yes, delete')
  })

  it('Yes, delete: DELETE to the right route, and the row leaves the sheet\'s list — "Deleted" is said where it was', async () => {
    await openPlaces()
    const before = pantryReads().length
    del('loc-4')
    fireEvent.click(screen.getByTestId('pu-location-delete-confirm'))
    await waitFor(() => expect(calls('DELETE')).toHaveLength(1))
    expect(calls('DELETE')[0]).toMatchObject({ path: '/api/storage-locations/loc-4', method: 'DELETE' })
    const gone = await screen.findByTestId('pu-location-deleted')
    expect(gone.textContent).toBe('Deleted "Garage shelf".')
    expect(deletedWords('Garage shelf')).toBe('Deleted "Garage shelf".')
    expect(gone.getAttribute('role')).toBe('status')
    expect(rows().map(r => r.getAttribute('data-loc-id'))).toEqual(['loc-1', 'loc-2', 'loc-3', 'loc-5'])
    // In the row's place: between Garage freezr and Jen's fridge, where it was.
    const order = [...screen.getByTestId('places-sheet').querySelectorAll('[data-loc-id]')].map(el => el.getAttribute('data-loc-id'))
    expect(order).toEqual(['loc-1', 'loc-2', 'loc-3', 'loc-4', 'loc-5'])
    expect(document.activeElement).toBe(gone)
    // Nothing was stored there, so the Pantry's list has nothing new to read.
    await settle()
    expect(pantryReads()).toHaveLength(before)
  })

  it('"Keep it" backs out and sends nothing', async () => {
    await openPlaces()
    del('loc-4')
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByTestId('pu-location-confirm-delete')).toBeNull()
    expect(document.activeElement).toBe(within(rowFor('loc-4')).getByTestId('pu-location-rename'))
    await settle()
    expect(calls('DELETE')).toHaveLength(0)
  })

  it('a delete that fails keeps the row, and says so', async () => {
    wire({ overrides: { 'DELETE /api/storage-locations/*': () => { throw apiError(500, { error: 'boom' }) } } })
    await openPlaces()
    del('loc-4')
    fireEvent.click(screen.getByTestId('pu-location-delete-confirm'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Couldn't delete that — try again."))
    expect(PLACE_DELETE_FAILED_TEXT).toBe("Couldn't delete that — try again.")
    expect(rowFor('loc-4')).toBeTruthy()
    expect(screen.queryByTestId('pu-location-deleted')).toBeNull()
    expect(within(rowFor('loc-4')).getByTestId('pu-location-delete')).toBeTruthy()
  })

  it('the server still answers place_in_use: its sentence is printed, and the Pantry is re-read so the count catches up', async () => {
    // The other phone put something in the shelf after this Pantry was read.
    const SERVER_SAYS = '1 thing is stored in this place. Move it first, then delete it.'
    wire({ overrides: { 'DELETE /api/storage-locations/*': ({ state }) => {
      state.rows = [...state.rows, jar(SHELF, 'beans')]
      throw apiError(409, { error: SERVER_SAYS, message: SERVER_SAYS, code: 'place_in_use', n: 1 })
    } } })
    await openPlaces()
    const before = pantryReads().length
    del('loc-4')
    fireEvent.click(screen.getByTestId('pu-location-delete-confirm'))
    expect((await screen.findByRole('alert')).textContent).toBe(SERVER_SAYS)
    await waitFor(() => expect(pantryReads()).toHaveLength(before + 1))
    await waitFor(() => expect(detailOf('loc-4')).toBe(`${word('pantry')} · 1 stored here`))
    expect(within(rowFor('loc-4')).queryByTestId('pu-location-delete')).toBeNull()
    expect(within(rowFor('loc-4')).getByTestId('pu-location-in-use').textContent).toBe('1 stored here — move it to delete this place.')
    expect(screen.queryByTestId('pu-location-confirm-delete')).toBeNull()
  })

  it('deleting the only place takes the door away once the sheet is closed', async () => {
    wire({ places: [SHELF], rows: [] })
    await openPlaces()
    del('loc-4')
    fireEvent.click(screen.getByTestId('pu-location-delete-confirm'))
    await screen.findByTestId('pu-location-deleted')
    expect(rows()).toHaveLength(0)
    expect(screen.queryByTestId('places-empty')).toBeNull()      // "Deleted" is what there is to say
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(door()).toBeNull()
  })
})

describe('a coded refusal the sheet has no words for is shown in the server\'s words', () => {
  it('rename', async () => {
    wire({ overrides: { 'PUT /api/storage-locations/*': () => { throw apiError(409, { error: 'That place is being changed on another phone.', code: 'place_busy' }) } } })
    await openPlaces()
    edit('loc-1')
    type('Chest Freezer one')
    save()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That place is being changed on another phone.'))
    expect(nameField().value).toBe('Chest Freezer one')
  })

  it('an uncoded 4xx is the server\'s sentence too', async () => {
    wire({ overrides: { 'PUT /api/storage-locations/*': () => { throw apiError(400, { error: 'label must be non-blank' }) } } })
    await openPlaces()
    edit('loc-1')
    type('X')
    save()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('label must be non-blank'))
  })
})

describe('a place that already exists', () => {
  const placeExists = (body) => apiError(409, { code: 'place_exists', ...body })

  it('a rename onto an existing name says so in the sheet\'s words and keeps the edit', async () => {
    const SERVER_SAYS = 'You already have a place with that name. Pick it instead, or use a different name.'
    wire({ overrides: { 'PUT /api/storage-locations/*': () => { throw placeExists({ error: SERVER_SAYS, message: SERVER_SAYS, existing_id: 'loc-1' }) } } })
    await openPlaces()
    edit('loc-3')
    type('Chest Freezer 1')
    save()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('You already have a place with that name and kind. Use a different name.'))
    expect(PLACE_NAME_TAKEN_TEXT).toBe('You already have a place with that name and kind. Use a different name.')
    expect(nameField().value).toBe('Chest Freezer 1')
    expect(screen.getByTestId('pu-location-save')).toBeTruthy()
    // A rename refusal is never read as "that place instead": the editor is still on loc-3.
    expect(rowFor('loc-3').contains(screen.getByTestId('pu-location-editor'))).toBe(true)
    expect(within(rowFor('loc-3')).getByText('Garage freezr')).toBeTruthy()
  })

  it.each([
    ['existing_id', { existing_id: 'loc-2' }],
    ['id', { id: 'loc-2' }],
    ['place_id', { place_id: 'loc-2' }],
  ])('a create refused 409 place_exists names the place meant — read as `%s`', async (_, body) => {
    const post = vi.fn(() => Promise.reject(placeExists({ message: 'You already have a place called Chest Freezer 2.', ...body })))
    expect(await ensurePlaceId(post, { label: 'chest freezer 2', kind: 'deep_freezer' })).toBe('loc-2')
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('a 409 with no id shows the server\'s words and saves nothing', async () => {
    const SERVER_SAYS = 'That place is already there.'
    wire({ overrides: { 'POST /api/storage-locations': () => { throw placeExists({ message: SERVER_SAYS }) } } })
    await expect(ensurePlaceId(f, { label: 'Fridge', kind: 'fridge' })).rejects.toMatchObject({ status: 409 })
    // On screen: a bought item moved to a place that is not made yet (a template chip).
    const MILK = itemRow(at(CF1, { stock_id: 'milk', name: 'Oat milk' }))
    render(<PantryRowSheet row={MILK} fetch={f} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('row-move'))
    // Once the panel's own places read has answered: a template is offered only for a kind with no place yet.
    await waitFor(() => expect(screen.getByTestId('move-panel').querySelector('[data-testid^="move-place-id:"]')).toBeTruthy())
    const template = screen.getByTestId('move-panel').querySelector('[data-testid^="move-place-new:"]')
    expect(template).toBeTruthy()
    fireEvent.click(template)
    expect(template.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('move-save'))
    expect((await screen.findByTestId('move-error')).textContent).toBe(SERVER_SAYS)
    expect(wired.fake.calls('PATCH')).toHaveLength(0)
    expect(screen.getByTestId('move-panel')).toBeTruthy()
  })
})

describe('a two-user household', () => {
  it('lists and can rename a household peer\'s place — scoping is the server\'s job', async () => {
    await openPlaces()
    const row = rowFor('loc-5')
    expect(within(row).getByText("Jen's fridge")).toBeTruthy()
    expect(detailOf('loc-5')).toBe(`${word('fridge')} · 1 stored here`)
    edit('loc-5')
    type('Kitchen fridge')
    save()
    await waitFor(() => expect(calls('PUT')).toHaveLength(1))
    expect(calls('PUT')[0]).toEqual({ path: '/api/storage-locations/loc-5', method: 'PUT', body: { label: 'Kitchen fridge' } })
  })
})

describe('the helpers (src/lib/pantryApi.js)', () => {
  it('updatePlace PUTs the patch as it is handed; deletePlace DELETEs; the id is encoded', async () => {
    const g = vi.fn(async () => ({ ok: true }))
    await updatePlace(g, 'loc 1/x', { label: 'A' })
    await deletePlace(g, 'loc 1/x')
    expect(g.mock.calls).toEqual([
      ['/api/storage-locations/loc%201%2Fx', { method: 'PUT', body: JSON.stringify({ label: 'A' }) }],
      ['/api/storage-locations/loc%201%2Fx', { method: 'DELETE' }],
    ])
    expect(PLACES_PATH).toBe('/api/storage-locations')
  })
})

// Flat (MOB 12): no sub-state for Back to step out of. Against REAL jsdom history and the REAL registry —
// under MemoryRouter and no registry the sheet's Back entry does not exist and a Back test passes over nothing.
describe('Back closes the sheet from any state', () => {
  const NET_MS = 2000
  let pops = 0
  const onPop = () => { pops += 1 }
  const settleBack = (from = pops) => act(async () => {
    const deadline = Date.now() + NET_MS
    while (pops === from && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
    let seen
    do {
      seen = pops
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
    } while (pops !== seen && Date.now() < deadline)
  })
  const back = async () => { const from = pops; act(() => { window.history.back() }); await settleBack(from) }
  const PAGE_URL = '/put-up?view=pantry'
  const armed = () => !!readMarker(window.history.state)
  const atPage = () => !armed() && window.history.state?.__page === 1
  const url = () => window.location.pathname + window.location.search

  function Host() {
    const [open, setOpen] = useState(true)
    return (
      <DismissRegistryProvider>
        <p data-testid="page">the Pantry</p>
        <PlacesSheet open={open} fetch={f} rows={ROWS} onClose={() => setOpen(false)} />
      </DismissRegistryProvider>
    )
  }
  async function openUnderRegistry() {
    await act(async () => { render(<Host />) })
    await waitFor(() => expect(armed()).toBe(true))
    await screen.findAllByTestId('pu-location-row')
  }

  beforeEach(() => {
    window.addEventListener('popstate', onPop)
    window.history.replaceState({ __base: 1 }, '', '/today')
    window.history.pushState({ __page: 1 }, '', PAGE_URL)
  })
  afterEach(async () => {
    cleanup()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    window.removeEventListener('popstate', onPop)
    document.body.style.overflow = ''; document.body.style.overscrollBehavior = ''
  })

  it('SELF-TEST: the open sheet holds a Back entry of its own, on the page\'s URL', async () => {
    await openUnderRegistry()
    expect(armed()).toBe(true)
    expect(url()).toBe(PAGE_URL)
  })

  it('from the list: one Back, the sheet is gone and the page\'s entry is current', async () => {
    await openUnderRegistry()
    await back()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atPage()).toBe(true)
    expect(url()).toBe(PAGE_URL)
  })

  it('from an open editor with a name typed: one Back closes the SHEET (there is no step back inside it)', async () => {
    await openUnderRegistry()
    edit('loc-3')
    type('Garage freezer')
    await back()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atPage()).toBe(true)
    expect(calls('PUT')).toHaveLength(0)
    expect(screen.getByTestId('page')).toBeTruthy()
  })

  it('from the delete question: one Back closes the sheet and deletes nothing', async () => {
    await openUnderRegistry()
    fireEvent.click(within(rowFor('loc-4')).getByTestId('pu-location-delete'))
    await back()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atPage()).toBe(true)
    expect(calls('DELETE')).toHaveLength(0)
  })

  it('Escape on the list closes the sheet; Escape in an editor closed only the editor', async () => {
    await openUnderRegistry()
    edit('loc-3')
    fireEvent.keyDown(nameField(), { key: 'Escape' })
    expect(screen.queryByTestId('pu-location-editor')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Places' })).toBeTruthy()
    const from = pops
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await settleBack(from)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atPage()).toBe(true)
  })
})
