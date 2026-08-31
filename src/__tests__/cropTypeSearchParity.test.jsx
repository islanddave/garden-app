// V4-SEARCHCROPTYPE-001 (BD-072) — CHARACTERIZATION of where crop-type matching actually reaches.
//
// This file asserts the CURRENT shipped behaviour, gap included. It is not a wish list: every
// expectation below passed on dev 1a22ae2 the day it was written, and the two `NOT to contain`
// cases are the residual, pinned deliberately so that closing it turns this file red and whoever
// closes it has to come here and say so.
//
// What shipped (a5d80526, in main): the SERVER whole-garden search matches crop type three ways —
// crop_types.slug, crop_types.display_name, and crop_types.search_aliases
// (lambda/dashboard/handlers.js searchPlantings:1022-1035 / searchVarieties:1100-1117).
// What did NOT: the two CLIENT surfaces match the SLUG ONLY —
//   · the typed /log picker  — PlantingSelect.jsx:628-633, looseIncludes(variety_ref.crop_type_slug)
//   · the voice harvest flow — VoiceHarvest.jsx:96, plantingAliases() ends at crop_type_slug
// Neither can do better on today's wire: GET /api/plants?view=picker projects crop_type_slug and
// no other crop-type field (lambda/plants/index.js:1313-1319), so the display name and the alias
// list are not on the client at all.
//
// FIXTURES ARE REAL ROWS, read from prod 2026-08-31 via garden_ro, not invented:
//   Suyo Long        slug 'cucumber'       display 'Cucumber'                    aliases (null)
//   Charentais       slug 'melon'          display 'Melon'                       aliases 'cantaloupe, muskmelon, honeydew'
//   Tokyo Long White slug 'bunching_onion' display 'Onion (bunching / scallion)' aliases (null)
// That distribution is the whole point. Dave's headline case works ONLY because 'cucumber' happens
// to be the slug; his second stated case ('cantaloupe' -> Charentais) needs the alias column and so
// reaches neither client surface. 61 of 239 live plantings sit on a crop type whose common word is
// not its slug — melon, squash/'zucchini', bean/'green bean', bunching_onion/'scallion'.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }), apiFetch: (...a) => fetchSpy(...a) }))

import PlantingSelect from '../components/forms/PlantingSelect.jsx'
import { matchPlantings, plantingAliases } from '../pages/VoiceHarvest.jsx'

// The ?view=picker shape verbatim — this is every crop-type-bearing field the client is given.
const PLANTS = [
  { id: 'pl-suyo', name: 'Suyo Long', project_id: 'p1', project_name: 'Beds',
    variety_ref: { id: 'cv-1', name: 'Suyo Long', crop_type_slug: 'cucumber' } },
  { id: 'pl-char', name: 'Charentais', project_id: 'p1', project_name: 'Beds',
    variety_ref: { id: 'cv-2', name: 'Charentais', crop_type_slug: 'melon' } },
  { id: 'pl-tokyo', name: 'Tokyo Long White', project_id: 'p1', project_name: 'Beds',
    variety_ref: { id: 'cv-3', name: 'Tokyo Long White', crop_type_slug: 'bunching_onion' } },
]

beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation(() => Promise.resolve(PLANTS))
})

// Type into the /log picker and return the ids it offers. Opens on focus, filters on change.
async function typeInPicker(query) {
  await act(async () => { render(<PlantingSelect plants={PLANTS} value="" onChange={() => {}} />) })
  const input = screen.getByRole('combobox')
  await act(async () => { fireEvent.focus(input); fireEvent.change(input, { target: { value: query } }) })
  return PLANTS.map(p => p.id).filter(id => screen.queryByTestId(`ps-opt-${id}`))
}

describe("V4-SEARCHCROPTYPE-001 — Dave's stated case, on the surfaces he uses", () => {
  it('typed /log picker: "cucumber" returns Suyo Long', async () => {
    expect(await typeInPicker('cucumber')).toEqual(['pl-suyo'])
  })

  it('voice flow: saying "cucumber" resolves to exactly Suyo Long', () => {
    expect(matchPlantings(PLANTS, 'cucumber').map(p => p.id)).toEqual(['pl-suyo'])
  })

  it('crop type is genuinely IN the spoken vocabulary, not reached by name coincidence', () => {
    // Suyo Long is named after its cultivar, so a name-only matcher would also answer 'cucumber'
    // by accident on THIS row. Tokyo Long White carries the word in no name field at all, which is
    // what makes the slug term observable rather than merely present.
    expect(plantingAliases(PLANTS[2])).toContain('bunching_onion')
    expect(matchPlantings(PLANTS, 'onion').map(p => p.id)).toEqual(['pl-tokyo'])
  })

  it('an exact cultivar-name hit is not buried by crop-type hits', async () => {
    expect(await typeInPicker('Charentais')).toEqual(['pl-char'])
    expect(matchPlantings(PLANTS, 'Charentais').map(p => p.id)).toEqual(['pl-char'])
  })

  it('a query matching neither name nor crop type returns nothing', async () => {
    expect(await typeInPicker('rutabaga')).toEqual([])
    expect(matchPlantings(PLANTS, 'rutabaga')).toEqual([])
  })
})

describe('RESIDUAL — the client surfaces are slug-only, so a crop\'s COMMON word misses', () => {
  // Both of these succeed against the server (ct.search_aliases / ct.display_name) and fail here.
  // Closing the residual makes these two red; that is the intended signal, not a regression.
  it('"cantaloupe" does NOT reach Charentais in the typed picker (slug is \'melon\')', async () => {
    expect(await typeInPicker('cantaloupe')).toEqual([])
  })

  it('"cantaloupe" does NOT reach Charentais by voice either', () => {
    expect(matchPlantings(PLANTS, 'cantaloupe')).toEqual([])
  })

  it('"scallion" does NOT reach Tokyo Long White (display name is server-side only)', async () => {
    expect(await typeInPicker('scallion')).toEqual([])
    expect(matchPlantings(PLANTS, 'scallion')).toEqual([])
  })

  // CLOSED 2026-08-31 by BUG-LOOSEKEYREPEAT-001 (A) — coming here to say so, as this file's header
  // asks. The second, narrower defect this file found: looseKey (comboboxInput.js) dropped
  // whitespace, hyphens, apostrophes and periods but NOT underscores, so a multi-word slug kept its
  // underscore while the words a human says collapsed without one, and the two keys could never be
  // equal ('bunching_onion' -> "bunching_onion" vs 'bunching onion' -> "bunchingonion"). The slug
  // term therefore contributed NOTHING for any multi-word crop type addressed by its natural spoken
  // form. 10 crop types with live plantings carry an underscore slug (12 plantings). '_' is now in
  // the separator class, so both spellings key identically and the assertion inverts. The rest of
  // this describe block still stands: display_name and search_aliases remain server-only.
  it('a multi-word slug IS now reachable by its spoken two-word form (underscore is collapsed)', () => {
    expect(matchPlantings(PLANTS, 'bunching onion').map(p => p.id)).toEqual(['pl-tokyo'])
    // The single word substring-matched even before the fix; it must keep doing so.
    expect(matchPlantings(PLANTS, 'onion').map(p => p.id)).toEqual(['pl-tokyo'])
  })
})
