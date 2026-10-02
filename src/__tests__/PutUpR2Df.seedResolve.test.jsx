// Put-Up R2a, lane Df — a seeded door and an onChange that is NOT a touch (the Df ↔ Dn seam).
//
// The name search (lane Dn) calls the door's onChange from a SEARCH ANSWER as well as from a tap or a
// keystroke: the same `source: 'typed'`, the same name, plus or minus the `crop_type_slug` the server
// resolved for that name. So "a door opened with a What is not dirty until something changes" cannot mean
// "until onChange fires": it is decided against what the door opened with — the same planting (or none), the
// same name once trimmed and case-folded.
//
// The field is STUBBED here, on purpose: this file pins the door's half of the seam (what it does with each
// onChange) whatever the field's own search does, so it is the same proof on a base with and without lane Dn.
// The real field, with the real door, is every other PutUpR2Df file.
// MUTATION (run, see the lane report): compare the whole What, crop included -> "an onChange that only adds
// crop_type_slug: no key, no draft, no hold" reds.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch, minted, field } = vi.hoisted(() => ({ stableFetch: { fn: null }, minted: { n: 0 }, field: { onChange: null, value: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))
vi.mock('../components/kitchen/idempotencyKey.js', async (importActual) => {
  const actual = await importActual()
  return { ...actual, mintKey: (...a) => { minted.n += 1; return actual.mintKey(...a) } }
})
// The field's contract, and nothing of its search: it shows the name and hands the test its onChange.
vi.mock('../components/pantry/NameSearchField.jsx', () => ({
  default: function NameSearchFieldStub({ value, onChange, idPrefix }) {
    field.onChange = onChange
    field.value = value
    return <button type="button" data-testid={`${idPrefix}-stub`}>{value?.name ?? ''}</button>
  },
}))

import PutSomethingUpSheet, { isDoorDraft } from '../components/pantry/PutSomethingUpSheet.jsx'
import { DOOR_SHEET } from '../components/pantry/putSomethingUp.js'
import { sheetDraftKey, readSheetDraft } from '../components/kitchen/sheetDraft.js'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date(2026, 9, 1, 14, 0)
const DRAFT_KEY = sheetDraftKey('user_dave', DOOR_SHEET, 'new')
const P1 = { source: 'planting', name: 'Sungold cherry', plant_id: 'p1', crop_type_slug: 'tomato', variety_id: 'v1' }

async function openDoor(props = {}) {
  const handlers = { onClose: vi.fn(), onSaved: vi.fn() }
  render(<PutSomethingUpSheet open now={NOW.getTime()} {...handlers} {...props} />)
  await screen.findByTestId('door-place-id:loc-1')
  await new Promise(r => setTimeout(r, 0))
  return handlers
}
const answer = (what) => act(() => { field.onChange(what) })
const clean = () => [minted.n, localStorage.getItem(DRAFT_KEY), isReloadBlocked()]
const posts = (path) => fake.calls('POST').filter(c => c.path === path)

beforeEach(() => {
  fake = pantryFetch({ rows: [] }); stableFetch.fn = fake
  localStorage.clear(); sessionStorage.clear(); clearReloadBlocks(); minted.n = 0
})

describe('a seeded, untouched door and what a search answer tells it', () => {
  it('an onChange that only adds crop_type_slug: no key, no draft, no hold', async () => {
    await openDoor({ initialName: 'Garlic' })
    expect(clean()).toEqual([0, null, false])
    answer({ source: 'typed', name: 'Garlic', crop_type_slug: 'garlic' })     // the server resolved the typed name's crop
    expect(field.value).toEqual({ source: 'typed', name: 'Garlic', crop_type_slug: 'garlic' })
    await new Promise(r => setTimeout(r, 0))
    expect(clean()).toEqual([0, null, false])
    answer({ source: 'typed', name: 'Garlic' })                               // … and a later answer took it away again
    await new Promise(r => setTimeout(r, 0))
    expect(clean()).toEqual([0, null, false])
  })

  it('the crop it was told is still sent once he saves', async () => {
    const { onSaved } = await openDoor({ initialName: 'Garlic' })
    answer({ source: 'typed', name: 'Garlic', crop_type_slug: 'garlic' })
    fireEvent.click(screen.getByTestId('door-place-id:loc-3'))                // the first real change
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull())
    expect([minted.n, isReloadBlocked()]).toEqual([1, true])
    expect(readSheetDraft(DRAFT_KEY, DOOR_SHEET, isDoorDraft).what).toEqual({ source: 'typed', name: 'Garlic', crop_type_slug: 'garlic' })
    fireEvent.click(screen.getByTestId('door-method-as_is'))
    fireEvent.click(screen.getByTestId('door-save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(posts('/api/pantry/items')[0].body).toMatchObject({ name: 'Garlic', crop_type_slug: 'garlic' })
  })

  it('a different name IS a touch; so is a planting picked for a typed seed, and a planting dropped from a planting seed', async () => {
    await openDoor({ initialName: 'Garlic' })
    answer({ source: 'typed', name: 'Garlic scapes' })
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull())
    expect([minted.n, isReloadBlocked()]).toEqual([1, true])
    answer({ source: 'typed', name: ' garlic ' })                             // back to the seed's name, whatever its case: pristine again
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).toBeNull())
    expect(isReloadBlocked()).toBe(false)
    answer({ source: 'planting', name: 'Garlic', plant_id: 'p9' })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('a planting seed: the same planting under the same name is untouched; an edited name, or the planting dropped, is a touch', async () => {
    await openDoor({ initialWhat: P1 })
    answer({ ...P1 })
    await new Promise(r => setTimeout(r, 0))
    expect(clean()).toEqual([0, null, false])
    answer({ ...P1, name: 'Sungold cherry, the early ones' })                 // an edit keeps the hit — and is his typing
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    answer({ ...P1 })
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
    answer({ source: 'typed', name: 'Sungold cherry' })                       // "Search again": the planting is gone
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('a plain open is as it was: any name is a change, and a crop told about an empty name is not', async () => {
    await openDoor()
    answer({ source: 'typed', name: '', crop_type_slug: 'garlic' })
    await new Promise(r => setTimeout(r, 0))
    expect(clean()).toEqual([0, null, false])
    answer({ source: 'typed', name: 'G' })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })
})
