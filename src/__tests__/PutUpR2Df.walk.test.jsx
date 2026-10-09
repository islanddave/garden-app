// Put-Up R2a, lane Df — Walk a place: the three things R2a changes on it (brief items 16 to 18).
//
//   16. Raw · In oil are drawn by DoorParts.RawInOilChips, the one part both doors use. NOTHING looks different:
//       PutUpWalk.test.jsx and PutUpUxC.walk.test.jsx pass unedited and are the parity check; this file pins the
//       shape the part must keep for the Walk (one group, the same two test ids, no hint line here).
//   17. The canning reference line under the method row, for the two canning methods — the door's part and constant.
//   18. THE EXIT ASKS when a name is typed (UX 3.6 item 1): the band shows a tick for the item before, so he
//       believes the one on screen is in. The first tap on "End the walk" turns the band's row into
//       `"<name>" isn't saved.` · Save it · End without it — in place, no modal. With nothing typed it ends at once,
//       as it always did (PutUpWalk.test.jsx, unedited). "Change" keeps the typed item: hidden, never cleared.
//
// MUTATIONS (run, see the lane report): the question skipped with a name typed -> "End the walk with a name
// typed asks first, and nothing is cleared"; the held item dropped on Change -> "Change keeps the typed
// item"; the canning line shown for a third method, or absent for one of the two -> its test.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch } from './helpers/pantryFake.js'

installStoragePolyfill()

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
import { walkUnsavedText, WALK_SAVE_IT_LABEL, WALK_END_WITHOUT_LABEL } from '../components/pantry/WalkPlace.jsx'
import { CANNING_LINE, METHOD_REQUIRED_TEXT } from '../components/pantry/putSomethingUp.js'
import { ALL_PUT_UP_METHODS } from '../components/putup/putItUp.js'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

const LOCATIONS = [
  { id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' },
  { id: 'loc-2', label: 'Chest Freezer 2', kind: 'deep_freezer' },
  { id: 'loc-3', label: 'Kitchen fridge', kind: 'fridge' },
]
const STASH = 'garden:putup-walk:v1'
const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i

function Probe() {
  const loc = useLocation()
  return <div data-testid="probe-loc">{loc.pathname + loc.search}</div>
}
function renderWalk() {
  return render(<MemoryRouter initialEntries={['/put-up?session=putup']}><Probe /><PutUp /></MemoryRouter>)
}
async function startWalk(place = 'Kitchen fridge') {
  renderWalk()
  fireEvent.click(await screen.findByRole('radio', { name: place }))
  fireEvent.click(screen.getByRole('radio', { name: 'This month' }))
  fireEvent.click(screen.getByTestId('putup-walk-start'))
  await screen.findByTestId('putup-walk-group')
}
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const typeWhat = (v) => fireEvent.change(screen.getByTestId('walk-what-name'), { target: { value: v } })
const posts = (path) => fake.calls('POST').filter(c => c.path === path)
const where = () => screen.getByTestId('probe-loc').textContent
const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

beforeEach(() => {
  fake = pantryFetch({ places: LOCATIONS }); stableFetch.fn = fake
  localStorage.clear(); sessionStorage.clear(); clearReloadBlocks()
})

describe('Raw · In oil on the Walk — the shared part, and nothing looks different', () => {
  it('one group named "Raw or in oil": Raw (where the method allows it) then In oil, their test ids unchanged, no hint line', async () => {
    await startWalk()
    typeWhat('Reaper sauce'); tap('walk-method-hot_sauce'); tap('walk-more')
    const group = within(screen.getByTestId('walk-more-panel')).getByRole('group', { name: 'Raw or in oil' })
    expect([...group.children].map(c => [c.tagName, c.getAttribute('data-testid'), c.textContent, c.getAttribute('aria-pressed')])).toEqual([
      ['BUTTON', 'walk-raw', 'Raw', 'false'], ['BUTTON', 'walk-inoil', 'In oil', 'false']])
    expect([group.style.display, group.style.flexWrap, group.style.gap]).toEqual(['flex', 'wrap', '8px'])
    expect(screen.queryByTestId('walk-raw-hint')).toBeNull()                  // the door prints the line; the Walk never did
    expect(group.parentElement).toBe(screen.getByTestId('walk-more-panel'))   // a direct child, as it was: no wrapper
    tap('walk-raw'); tap('walk-inoil')
    expect([screen.getByTestId('walk-raw').getAttribute('aria-pressed'), screen.getByTestId('walk-inoil').getAttribute('aria-pressed')]).toEqual(['true', 'true'])
    tap('walk-method-quick_pickle')
    expect([...within(screen.getByTestId('walk-more-panel')).getByRole('group', { name: 'Raw or in oil' }).children].map(c => c.getAttribute('data-testid'))).toEqual(['walk-inoil'])
    tap('walk-method-as_is')
    expect(within(screen.getByTestId('walk-more-panel')).queryByRole('group', { name: 'Raw or in oil' })).toBeNull()
  })
})

describe('the canning line on the Walk', () => {
  it('shows for the two canning methods and for no other, under the method row and above How many', async () => {
    await startWalk()
    tap('walk-method-more')
    expect(screen.queryByTestId('walk-canning-line')).toBeNull()
    for (const m of [...ALL_PUT_UP_METHODS, 'as_is']) {
      tap(`walk-method-${m}`)
      expect(`${m}: ${!!screen.queryByTestId('walk-canning-line')}`).toBe(`${m}: ${m === 'can_water_bath' || m === 'can_pressure'}`)
    }
    tap('walk-method-can_pressure')
    const note = screen.getByTestId('walk-canning-line')
    expect(after(screen.getByTestId('walk-methods'), note)).toBe(true)
    expect(after(note, screen.getByTestId('walk-count-count'))).toBe(true)
  })

  it('is the door\'s line: the same two sentences, the same link, a note', async () => {
    await startWalk()
    tap('walk-method-more'); tap('walk-method-can_water_bath')
    const note = screen.getByTestId('walk-canning-line')
    expect(note.getAttribute('role')).toBe('note')
    expect([...note.children].slice(0, 2).map(c => c.textContent)).toEqual(CANNING_LINE.lines)
    const link = within(note).getByRole('link', { name: 'National Center for Home Food Preservation — opens in a new tab' })
    expect([link.getAttribute('href'), link.getAttribute('target'), parseInt(link.style.minHeight, 10)]).toEqual(['https://nchfp.uga.edu/how/can', '_blank', 48])
    for (const s of [note.textContent]) expect(s).not.toMatch(BANNED)
    // It stops nothing: the group saves.
    typeWhat('Tomatoes')
    tap('walk-save')
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
  })
})

describe('the exit asks when a name is typed', () => {
  it('the words', () => {
    expect([walkUnsavedText('Blueberries'), WALK_SAVE_IT_LABEL, WALK_END_WITHOUT_LABEL]).toEqual(['"Blueberries" isn\'t saved.', 'Save it', 'End without it'])
  })

  it('End the walk with a name typed asks first, and nothing is cleared', async () => {
    await startWalk()
    typeWhat('  Blueberries ')
    const at = where()
    tap('putup-walk-exit')
    const band = screen.getByTestId('putup-walk-band')
    const row = within(band).getByTestId('putup-walk-unsaved')
    expect(within(row).getByTestId('putup-walk-unsaved-text').textContent).toBe('"Blueberries" isn\'t saved.')
    expect(within(row).getByTestId('putup-walk-unsaved-text').getAttribute('role')).toBe('status')
    expect(within(row).getAllByRole('button').map(b => [b.textContent.trim(), b.getAttribute('data-testid'), parseInt(b.style.minHeight, 10)])).toEqual([
      ['Save it', 'putup-walk-exit-save', 48], ['End without it', 'putup-walk-exit-anyway', 48]])
    // The band's row TURNED INTO the question: its own three things are not beside it.
    expect([within(band).queryByTestId('putup-walk-where'), within(band).queryByTestId('putup-walk-change'), within(band).queryByTestId('putup-walk-exit')]).toEqual([null, null, null])
    // In place: no modal, no dialog, no navigation — and nothing is cleared.
    expect([screen.queryByRole('dialog'), screen.queryByRole('alertdialog')]).toEqual([null, null])
    expect(where()).toBe(at)
    expect(localStorage.getItem(STASH)).not.toBeNull()
    expect(screen.getByTestId('walk-what-name').value).toBe('  Blueberries ')
    expect(fake.calls('POST')).toEqual([])
    expect(row.textContent).not.toMatch(BANNED)
  })

  it('a name of spaces is nothing typed: it ends at once', async () => {
    await startWalk()
    typeWhat('   ')
    tap('putup-walk-exit')
    await waitFor(() => expect(screen.queryByTestId('putup-walk-band')).toBeNull())
    expect(localStorage.getItem(STASH)).toBeNull()
  })

  it('End without it ends the walk', async () => {
    await startWalk()
    typeWhat('Blueberries')
    tap('putup-walk-exit'); tap('putup-walk-exit-anyway')
    await waitFor(() => expect(screen.queryByTestId('putup-walk-band')).toBeNull())
    expect(localStorage.getItem(STASH)).toBeNull()
    expect(where()).toBe('/put-up')
    expect(fake.calls('POST')).toEqual([])
  })

  it('Save it saves the group through its own Save; the walk goes on with its tick, and End the walk then ends at once', async () => {
    await startWalk()
    typeWhat('Blueberries'); tap('walk-method-ferment')
    tap('putup-walk-exit'); tap('putup-walk-exit-save')
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    expect(posts('/api/preservation')[0].body).toMatchObject({ label: 'Blueberries', method: 'ferment', storage_location_id: 'loc-3' })
    const band = screen.getByTestId('putup-walk-band')
    await waitFor(() => expect(within(band).getByTestId('putup-walk-last').textContent).toMatch('1 × Blueberries · Ferment'))
    expect(within(band).queryByTestId('putup-walk-unsaved')).toBeNull()
    expect(within(band).getByTestId('putup-walk-exit').textContent.trim()).toBe('End the walk')
    expect(screen.getByTestId('walk-what-name').value).toBe('')
    tap('putup-walk-exit')                                                    // nothing typed now: no question
    await waitFor(() => expect(screen.queryByTestId('putup-walk-band')).toBeNull())
  })

  it('Save it with no method: the group\'s own refusal, nothing sent, the walk not ended, the name still there', async () => {
    await startWalk()
    typeWhat('Blueberries')
    tap('putup-walk-exit'); tap('putup-walk-exit-save')
    expect(screen.getByTestId('walk-error').textContent).toBe(METHOD_REQUIRED_TEXT)
    expect(fake.calls('POST')).toEqual([])
    expect(screen.getByTestId('putup-walk-band')).toBeTruthy()
    expect(screen.queryByTestId('putup-walk-unsaved')).toBeNull()
    expect(screen.getByTestId('walk-what-name').value).toBe('Blueberries')
    expect(localStorage.getItem(STASH)).not.toBeNull()
  })

  it('the question is about the name on screen: once that changes, the band is its usual row again', async () => {
    await startWalk()
    typeWhat('Blueberries')
    tap('putup-walk-exit')
    expect(screen.getByTestId('putup-walk-unsaved')).toBeTruthy()
    typeWhat('Blueberries, the late ones')
    expect(screen.queryByTestId('putup-walk-unsaved')).toBeNull()
    expect(screen.getByTestId('putup-walk-exit')).toBeTruthy()
    tap('putup-walk-exit')
    expect(screen.getByTestId('putup-walk-unsaved-text').textContent).toBe('"Blueberries, the late ones" isn\'t saved.')
  })

  // BUG-PUTUPRETRYCOPYRESIDUE-001 (c), review 4 M-1. A refusal that says to end the walk leaves the group spent on
  // the row it names, and the exit then does not ask. That must not outlive the refusal: a later Save that goes out
  // and fails on the update leaves a CHANGE pending, and the question is the last offer to retry it.
  it('BUG-PUTUPRETRYCOPYRESIDUE-001 (c) — spent on "end this walk", then a Save that goes out and whose change may not have saved: End the walk ASKS again', async () => {
    const JARS = '/api/preservation'
    const table = { row: null, patches: 0 }
    const lost = () => { throw new TypeError('Failed to fetch') }
    fake = pantryFetch({ places: LOCATIONS, overrides: {
      // The first create LANDS with its answer lost; each one after is answered with the jar, replayed.
      [`POST ${JARS}`]: ({ body }) => {
        if (table.row) return { ...table.row, replayed: true }
        table.row = {
          id: 'jar-first', user_id: 'user_dave', label: body.label, method: body.method, method_other_text: null,
          package_count: body.package_count, remaining_count: body.package_count, quantity_value: null, quantity_unit: null, remaining_amount: null,
          storage_location_id: body.storage_location_id, plant_id: null, crop_type_slug: body.crop_type_slug ?? null, variety_id: null, harvest_log_id: null,
          preserved_at: `${body.preserved_at}T00:00:00.000Z`, preserved_at_precision: body.preserved_at_precision, preserved_at_approx: body.preserved_at_approx,
          use_by_target: '2027-10-01T00:00:00.000Z', use_by_basis: 'table', is_raw: null, in_oil: null, texture: null, notes: null,
          source_kind: null, source_label: null, idempotency_key: body.idempotency_key,
          created_at: new Date(Date.now() - 30 * 1000).toISOString(), updated_at: null, deleted_at: null,
        }
        return lost()
      },
      // No PATCH reaches the server: the jar stays as the first Save made it.
      [`PATCH ${JARS}/*`]: () => { table.patches += 1; return lost() },
    } })
    stableFetch.fn = fake
    const MAYBE = '“Corn” is already in the Pantry — an earlier Save went through. This change may not have saved — try again.'
    const said = (text) => waitFor(() => expect([screen.queryByTestId('walk-error')?.textContent ?? null, screen.getByTestId('walk-save').disabled]).toEqual([text, false]))
    const freeze = () => { if (!screen.queryByTestId('walk-method-whole_freeze')) tap('walk-method-more'); tap('walk-method-whole_freeze') }
    await startWalk('Chest Freezer 1')
    typeWhat('Corn'); freeze()
    tap('walk-save'); await said("Couldn't save it — what you entered is kept. Try again.")
    tap('walk-count-plus')
    tap('walk-save'); await said(MAYBE)
    expect(table.patches).toBe(1)
    tap('walk-method-as_is')
    tap('walk-save'); await said('“Corn” is already in the Pantry as a put-up — an earlier Save went through. It can\'t also be saved as “As is” from here. If you want both, end this walk and start another.')
    freeze()
    tap('walk-save')
    await waitFor(() => expect(table.patches).toBe(2))
    await said(MAYBE)
    tap('putup-walk-exit')
    expect(screen.getByTestId('putup-walk-unsaved-text').textContent).toBe('"Corn" isn\'t saved.')
    expect(screen.getByTestId('putup-walk-group')).toBeTruthy()
    expect(localStorage.getItem(STASH)).not.toBeNull()
    expect(posts(JARS).map(c => c.body.idempotency_key).filter((k, i, a) => a.indexOf(k) === i)).toHaveLength(1)
    expect(posts('/api/pantry/items')).toEqual([])
  })
})

describe('"Change" keeps the typed item — hidden, never cleared', () => {
  async function typedThenChange() {
    await startWalk()
    typeWhat('Reaper sauce'); tap('walk-method-hot_sauce')
    tap('walk-count-plus'); tap('walk-count-plus')
    tap('walk-more'); tap('walk-raw')
    tap('putup-walk-change')
    await screen.findByRole('radiogroup', { name: 'Which place are you at?' })
  }

  it('Change keeps the typed item: gone from the screen while the two questions are up, back whole when the walk is', async () => {
    await typedThenChange()
    expect(screen.queryByTestId('putup-walk-group')).toBeNull()               // hidden: the group is not mounted behind the questions
    expect(screen.queryByTestId('walk-what-name')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Chest Freezer 2' }))
    tap('putup-walk-start')
    await screen.findByTestId('putup-walk-band')
    expect(screen.getByTestId('walk-what-name').value).toBe('Reaper sauce')
    expect(screen.getByTestId('walk-method-hot_sauce').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('walk-count-count').value).toBe('3')
    expect(screen.getByTestId('walk-raw').getAttribute('aria-pressed')).toBe('true')   // its disclosure open as he left it
    tap('walk-save')
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    expect(posts('/api/preservation')[0].body).toMatchObject({ label: 'Reaper sauce', method: 'hot_sauce', package_count: 3, is_raw: true, storage_location_id: 'loc-2' })
  })

  it('while the questions are up, the held item still holds a deploy\'s reload; with nothing held it does not', async () => {
    await typedThenChange()
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Chest Freezer 2' }))
    tap('putup-walk-start')
    await screen.findByTestId('putup-walk-band')
    tap('walk-save')
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
    tap('putup-walk-change')
    await screen.findByRole('radiogroup', { name: 'Which place are you at?' })
    expect(isReloadBlocked()).toBe(false)
  })

  it('"Not now" on the questions with an item held goes back to the walk, where the exit asks; with none held it ends the walk', async () => {
    await typedThenChange()
    tap('putup-walk-setup-exit')
    await screen.findByTestId('putup-walk-band')
    expect(localStorage.getItem(STASH)).not.toBeNull()
    expect(screen.getByTestId('walk-what-name').value).toBe('Reaper sauce')
    tap('putup-walk-exit')
    expect(screen.getByTestId('putup-walk-unsaved-text').textContent).toBe('"Reaper sauce" isn\'t saved.')
    tap('putup-walk-exit-anyway')
    await waitFor(() => expect(screen.queryByTestId('putup-walk-band')).toBeNull())
    expect(localStorage.getItem(STASH)).toBeNull()
  })

  it('"Not now" with nothing typed ends the walk, as it always did', async () => {
    await startWalk()
    tap('putup-walk-change')
    await screen.findByRole('radiogroup', { name: 'Which place are you at?' })
    tap('putup-walk-setup-exit')
    await waitFor(() => expect(where()).toBe('/put-up'))
    expect(localStorage.getItem(STASH)).toBeNull()
  })
})
