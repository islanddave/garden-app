// V4-SEARCHCROPTYPE-001, CLIENT LEG — "search must ALWAYS match on crop type, not just cultivar
// name", on the three filters that run in the browser.
//
// The server half shipped in a5d80526 and matches crop type three ways (crop_types.slug,
// .display_name, .search_aliases — lambda/dashboard/handlers.js). The client half did not, and the
// client half is the one that answers instantly, offline, and whenever the server slice degrades.
// cropTypeSearchParity.test.jsx (the recon file) characterised the gap; this file is the closure,
// and it renders the REAL components rather than re-implementing any predicate.
//
// SURFACES COVERED HERE:
//   · Search.jsx           — whole-garden search, client filter. Had NO crop-type term at all.
//   · PlantingSelect.jsx   — the typed /log picker. Had the slug, unreachable by its spoken form.
//   · VarietyPicker.jsx    — the variety combobox. Had NO crop-type term at all.
// NOT covered — routed, not forgotten: VoiceHarvest.jsx's plantingAliases() (another lane owns that
// file) and crop_types.search_aliases, which is deliberately never SELECTed into a response shape
// and so cannot reach any client until the ?view=picker projection widens. See the lane report.
//
// FIXTURES ARE REAL PROD ROWS, carried over verbatim from the recon file's prod read (garden_ro,
// 2026-08-31), and the distribution is the point:
//   Suyo Long        slug 'cucumber'       display 'Cucumber'                    aliases (null)
//   Charentais       slug 'melon'          display 'Melon'                       aliases 'cantaloupe, …'
//   Tokyo Long White slug 'bunching_onion' display 'Onion (bunching / scallion)' aliases (null)
// Suyo Long is named after its own crop, so a name-only matcher answers "cucumber" on that row BY
// ACCIDENT — Dave's headline case cannot prove anything on its own. Tokyo Long White carries neither
// "onion" nor "scallion" in any name field, which is what makes the crop-type term observable.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }), apiFetch: (...a) => fetchSpy(...a) }))
vi.mock('../lib/transcribe.js', () => ({
  isTranscriptionSupported: () => false,
  startLiveTranscription: () => ({ stop() {}, cancel() {} }),
}))

import Search from '../pages/Search.jsx'
import PlantingSelect from '../components/forms/PlantingSelect.jsx'
import VarietyPicker from '../components/VarietyPicker.jsx'

const CROP_TYPES = [
  { slug: 'cucumber', display_name: 'Cucumber', category: 'vegetable' },
  { slug: 'melon', display_name: 'Melon', category: 'fruit' },
  { slug: 'bunching_onion', display_name: 'Onion (bunching / scallion)', category: 'vegetable' },
]

// The wide /api/plants shape Search reads (variety_ref carries all 21 subfields there).
const PLANTS = [
  { id: 'pl-suyo', project_id: 'p1', project_name: 'Beds', name: 'Suyo Long',
    variety_ref: { id: 'cv-1', name: 'Suyo Long', crop_type_slug: 'cucumber' } },
  { id: 'pl-char', project_id: 'p1', project_name: 'Beds', name: 'Charentais',
    variety_ref: { id: 'cv-2', name: 'Charentais', crop_type_slug: 'melon' } },
  { id: 'pl-tokyo', project_id: 'p1', project_name: 'Beds', name: 'Tokyo Long White',
    variety_ref: { id: 'cv-3', name: 'Tokyo Long White', crop_type_slug: 'bunching_onion' } },
]

const VARIETIES = [
  { id: 'cv-1', name: 'Suyo Long', crop_type_slug: 'cucumber' },
  { id: 'cv-2', name: 'Charentais', crop_type_slug: 'melon' },
  { id: 'cv-3', name: 'Tokyo Long White', crop_type_slug: 'bunching_onion' },
]

// Route by path: VarietyPicker mounts BOTH /api/varieties and /api/varieties/crop-types, and a
// blanket mock that answers plantings to every call would hand the crop-type vocabulary rows with no
// `slug` — the display-name assertions would then pass or fail for a reason unrelated to the code.
beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path = '') => {
    const p = String(path)
    if (p.startsWith('/api/varieties/crop-types')) return Promise.resolve(CROP_TYPES)
    if (p.startsWith('/api/varieties')) return Promise.resolve(VARIETIES)
    if (p.startsWith('/api/locations')) return Promise.resolve([])
    return Promise.resolve(PLANTS)   // /api/plants, with or without ?view=picker
  })
})

// ── Surface harnesses. Each returns the planting/variety ids the surface is OFFERING. ───────────
async function typeInWholeGardenSearch(query) {
  render(<MemoryRouter initialEntries={['/search']}><Search /></MemoryRouter>)
  const input = await screen.findByLabelText('Search your garden')
  await act(async () => { fireEvent.change(input, { target: { value: query } }) })
  // Rows link to the canonical un-scoped route (V4-UNSCOPEDROUTES-001).
  return PLANTS.map(p => p.id).filter(id => document.querySelector(`a[href="/plantings/${id}"]`))
}

async function typeInPicker(query) {
  await act(async () => { render(<PlantingSelect plants={PLANTS} value="" onChange={() => {}} />) })
  const input = screen.getByRole('combobox')
  await act(async () => { fireEvent.focus(input); fireEvent.change(input, { target: { value: query } }) })
  return PLANTS.map(p => p.id).filter(id => screen.queryByTestId(`ps-opt-${id}`))
}

async function typeInVarietyPicker(query) {
  render(<VarietyPicker onChange={() => {}} />)
  const input = screen.getByRole('combobox')
  await act(async () => { fireEvent.focus(input) })
  // The server ?q= leg is mocked to return the full list, so what is asserted below is exactly the
  // client-side defensive filter this lane changed. Option ids are useId-derived, so rows are read
  // back by their rendered name rather than by a constructed id.
  await act(async () => { fireEvent.change(input, { target: { value: query } }) })
  await waitFor(() => expect(screen.queryByText('Loading varieties…')).toBe(null))
  const rows = screen.queryAllByRole('option').map(li => li.textContent ?? '')
  return VARIETIES.filter(v => rows.some(t => t.includes(v.name))).map(v => v.id)
}

describe("V4-SEARCHCROPTYPE-001 client leg — Dave's headline case, on all three client filters", () => {
  it('whole-garden search: "cucumber" finds Suyo Long without the server slice', async () => {
    expect(await typeInWholeGardenSearch('cucumber')).toEqual(['pl-suyo'])
  })

  it('typed /log picker: "cucumber" finds Suyo Long', async () => {
    expect(await typeInPicker('cucumber')).toEqual(['pl-suyo'])
  })

  it('variety picker: "cucumber" finds Suyo Long', async () => {
    expect(await typeInVarietyPicker('cucumber')).toEqual(['cv-1'])
  })
})

describe('crop type is genuinely in the vocabulary, not reached by name coincidence', () => {
  // Tokyo Long White carries "onion" in NO name field. If the crop-type term were absent or dead,
  // these return []. This is the assertion that makes the headline case above non-vacuous.
  it('whole-garden search: "onion" finds Tokyo Long White, which is named for none of it', async () => {
    expect(await typeInWholeGardenSearch('onion')).toEqual(['pl-tokyo'])
  })

  it('typed /log picker: "onion" finds Tokyo Long White', async () => {
    expect(await typeInPicker('onion')).toEqual(['pl-tokyo'])
  })

  it('variety picker: "onion" finds Tokyo Long White', async () => {
    expect(await typeInVarietyPicker('onion')).toEqual(['cv-3'])
  })
})

describe('BUG-LOOSEKEYREPEAT-001 (A) in situ — a multi-word slug by its spoken form', () => {
  // Before the underscore fix these were all [], on every surface: 'bunching_onion' and
  // 'bunching onion' could not produce the same key. 12 live plantings sit on such a slug.
  it('whole-garden search: "bunching onion"', async () => {
    expect(await typeInWholeGardenSearch('bunching onion')).toEqual(['pl-tokyo'])
  })

  it('typed /log picker: "bunching onion"', async () => {
    expect(await typeInPicker('bunching onion')).toEqual(['pl-tokyo'])
  })

  it('variety picker: "bunching onion"', async () => {
    expect(await typeInVarietyPicker('bunching onion')).toEqual(['cv-3'])
  })
})

describe('the crop DISPLAY NAME, where the surface holds the vocabulary', () => {
  // VarietyPicker is the one client with the crop_types rows already in hand (useCropTypes, for
  // labelling), so "scallion" — a word that appears only in crop_types.display_name — reaches it
  // with no extra request. The other two surfaces have the slug and nothing else crop-shaped;
  // pinned below as the routed residual.
  it('variety picker: "scallion" reaches Tokyo Long White via crop_types.display_name', async () => {
    expect(await typeInVarietyPicker('scallion')).toEqual(['cv-3'])
  })

  it('RESIDUAL — the other two surfaces cannot: display_name is not on their wire', async () => {
    expect(await typeInWholeGardenSearch('scallion')).toEqual([])
    cleanup()
    expect(await typeInPicker('scallion')).toEqual([])
  })

  it('RESIDUAL — "cantaloupe" reaches no client at all: search_aliases is server-only', async () => {
    // crop-types-columns.test.js pins that search_aliases is never SELECTed into a response shape.
    // Until that changes deliberately, this half of the row\'s acceptance needs the server slice.
    expect(await typeInWholeGardenSearch('cantaloupe')).toEqual([])
    cleanup()
    expect(await typeInPicker('cantaloupe')).toEqual([])
    cleanup()
    expect(await typeInVarietyPicker('cantaloupe')).toEqual([])
  })
})

describe('the widening does not cost precision', () => {
  it('an exact cultivar-name hit is not buried by crop-type hits', async () => {
    expect(await typeInWholeGardenSearch('Charentais')).toEqual(['pl-char'])
    cleanup()
    expect(await typeInPicker('Charentais')).toEqual(['pl-char'])
    cleanup()
    expect(await typeInVarietyPicker('Charentais')).toEqual(['cv-2'])
  })

  it('a query matching neither a name nor a crop type still returns nothing', async () => {
    expect(await typeInWholeGardenSearch('rutabaga')).toEqual([])
    cleanup()
    expect(await typeInPicker('rutabaga')).toEqual([])
    cleanup()
    expect(await typeInVarietyPicker('rutabaga')).toEqual([])
  })
})
