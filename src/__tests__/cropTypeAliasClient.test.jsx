// OPS-CROPTYPEALIASCLIENT-001 — crop_types.search_aliases on the client, the parts the two
// surface-acceptance files do not cover.
//
// WHERE THE FOUR-SURFACE ACCEPTANCE LIVES, so this file is not read as the whole story:
//   · cropTypeSearchClientParity.test.jsx — "cantaloupe" -> Charentais on whole-garden search, the
//     /log planting picker and the variety picker, through the REAL components.
//   · VoiceHarvest.cropType.test.jsx      — the same word through the voice chooser.
// This file owns what neither of those can express: the SPLIT semantics of the column, the fail-soft
// behaviour when the vocabulary does not load, and the never-render rule.
//
// THE NEVER-RENDER RULE IS THE REASON THIS FILE EXISTS AT ALL. search_aliases is a separate column
// rather than more parentheticals inside display_name precisely because display_name is SELECTed as
// crop_name by lambda/facebook-share/index.js:319 and reaches the text of a public Facebook/Instagram
// post. lambda/dashboard/crop-types-columns.test.js and lambda/dashboard/search.test.js pin that the
// SEARCH handlers never select the column into a response, and this lane deliberately did not touch
// either guard: a search RESULT ROW is a render surface. The crop-types vocabulary list is not — it
// is a controlled vocabulary the client filters against — so the column now travels to the browser,
// and what has to be pinned is that it never travels from the browser onto the screen.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { splitCropAliases, cropTypeTerms, looseIncludesCropType } from '../lib/comboboxInput.js'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }), apiFetch: (...a) => fetchSpy(...a) }))
vi.mock('../lib/transcribe.js', () => ({
  isTranscriptionSupported: () => false,
  startLiveTranscription: () => ({ stop() {}, cancel() {} }),
}))

import Search from '../pages/Search.jsx'

// Verbatim from migrations/v4-croptypealias-001/0a-data.sql — the rows prod holds. `bitter_melon`
// and `cucamelon` are in the fixture on purpose: both carry "melon" INSIDE an alias
// ('bitter gourd, karela' / 'mouse melon, mexican sour gherkin'), which is the collision the
// splitting rule has to survive.
const CROP_TYPES = [
  { slug: 'melon', display_name: 'Melon', category: 'fruit', search_aliases: 'cantaloupe, muskmelon, honeydew' },
  { slug: 'cucumber', display_name: 'Cucumber', category: 'vegetable', search_aliases: null },
  { slug: 'bitter_melon', display_name: 'Bitter Melon', category: 'vegetable', search_aliases: 'bitter gourd, karela' },
  { slug: 'cucamelon', display_name: 'Cucamelon', category: 'vegetable', search_aliases: 'mouse melon, mexican sour gherkin' },
]

const PLANTS = [
  { id: 'pl-char', project_id: 'p1', project_name: 'Beds', name: 'Charentais',
    variety_ref: { id: 'cv-2', name: 'Charentais', crop_type_slug: 'melon' } },
  { id: 'pl-suyo', project_id: 'p1', project_name: 'Beds', name: 'Suyo Long',
    variety_ref: { id: 'cv-1', name: 'Suyo Long', crop_type_slug: 'cucumber' } },
]
const VARIETIES = [
  { id: 'cv-2', name: 'Charentais', crop_type_slug: 'melon' },
  { id: 'cv-1', name: 'Suyo Long', crop_type_slug: 'cucumber' },
]

function mockApi({ cropTypes = CROP_TYPES } = {}) {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path = '') => {
    const p = String(path)
    if (p.startsWith('/api/varieties/crop-types')) return Promise.resolve(cropTypes)
    if (p.startsWith('/api/varieties')) return Promise.resolve(VARIETIES)
    if (p.startsWith('/api/locations')) return Promise.resolve([])
    if (p.startsWith('/api/search')) return Promise.resolve({ results: {} })
    return Promise.resolve(PLANTS)
  })
}

beforeEach(() => { mockApi() })

async function searchFor(query) {
  render(<MemoryRouter initialEntries={['/search']}><Search /></MemoryRouter>)
  const input = await screen.findByLabelText('Search your garden')
  // The vocabulary lands on its own promise; without settling it first the filter runs against an
  // empty cropBySlug and every assertion below would report on load order rather than on matching.
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/varieties/crop-types'))
  await act(async () => { fireEvent.change(input, { target: { value: query } }) })
  return PLANTS.map(p => p.id).filter(id => document.querySelector(`a[href="/plantings/${id}"]`))
}

describe('splitCropAliases — the column is comma-separated TEXT, not an array', () => {
  it('splits and trims the real melon row', () => {
    expect(splitCropAliases('cantaloupe, muskmelon, honeydew'))
      .toEqual(['cantaloupe', 'muskmelon', 'honeydew'])
  })

  it('survives the shapes a text column actually takes', () => {
    // NULL is the common case — 54 of the crop types carry an alias and the rest are null.
    expect(splitCropAliases(null)).toEqual([])
    expect(splitCropAliases(undefined)).toEqual([])
    expect(splitCropAliases('')).toEqual([])
    // A trailing separator or a doubled comma must not yield an EMPTY term: looseIncludes returns
    // true for an empty needle, so an empty term in the haystack list is harmless, but an empty
    // term is still a lie about the vocabulary and the filter drops it.
    expect(splitCropAliases('rocket,')).toEqual(['rocket'])
    expect(splitCropAliases('a,,b')).toEqual(['a', 'b'])
    expect(splitCropAliases('  spaced  ,  out  ')).toEqual(['spaced', 'out'])
  })

  it("keeps a multi-word alias whole — 'green bean' is one alias, not two", () => {
    expect(splitCropAliases('green bean, snap bean, string bean'))
      .toEqual(['green bean', 'snap bean', 'string bean'])
  })
})

describe('cropTypeTerms — aliases ADD to the slug and display name, never replace them', () => {
  const melon = CROP_TYPES[0]

  it('yields slug, display name, then every alias', () => {
    expect(cropTypeTerms('melon', melon))
      .toEqual(['melon', 'Melon', 'cantaloupe', 'muskmelon', 'honeydew'])
  })

  it('degrades to slug-only with no crop-type row, exactly as before this lane', () => {
    expect(cropTypeTerms('melon')).toEqual(['melon'])
  })

  it('an aliasless crop type yields slug + display name and no empty third term', () => {
    expect(cropTypeTerms('cucumber', CROP_TYPES[1])).toEqual(['cucumber', 'Cucumber'])
  })

  it('a slugless row with no crop type yields nothing, so it cannot match an empty query', () => {
    expect(cropTypeTerms(null, null)).toEqual([])
    expect(looseIncludesCropType(null, '', null)).toBe(false)
  })

  it('matches each alias on its own terms', () => {
    for (const word of ['cantaloupe', 'muskmelon', 'honeydew']) {
      expect(looseIncludesCropType('melon', word, melon)).toBe(true)
    }
    expect(looseIncludesCropType('melon', 'rocket', melon)).toBe(false)
  })

  it('a needle spanning the comma cannot match — the point of splitting', () => {
    // looseKey strips whitespace but NOT commas, so against the raw column string this hits.
    expect('cantaloupe, muskmelon, honeydew'.replace(/\s/g, '')).toContain('cantaloupe,musk')
    expect(looseIncludesCropType('melon', 'cantaloupe, musk', melon)).toBe(false)
  })
})

describe('Search.jsx — the alias axis end to end, and its floor', () => {
  it('"cantaloupe" finds Charentais and nothing else', async () => {
    expect(await searchFor('cantaloupe')).toEqual(['pl-char'])
  })

  it('"karela" reaches the bitter_melon row and NOT the melon row', async () => {
    // Two crop types in this fixture carry "melon" inside an alias. If aliases were pooled across
    // the vocabulary instead of read per row, this query would also return Charentais.
    expect(await searchFor('karela')).toEqual([])
  })

  it('an unrelated word still returns nothing', async () => {
    expect(await searchFor('rutabaga')).toEqual([])
  })

  it('the vocabulary failing to load degrades to slug-only rather than breaking the box', async () => {
    // useCropTypes fails soft to []. The page must still answer every term it answered before this
    // lane — the slug travels on the planting row itself.
    mockApi({ cropTypes: [] })
    expect(await searchFor('cucumber')).toEqual(['pl-suyo'])
    cleanup()
    mockApi({ cropTypes: [] })
    expect(await searchFor('cantaloupe')).toEqual([])
  })
})

describe('THE NEVER-RENDER RULE — the alias text reaches the browser, never the screen', () => {
  it('no alias appears anywhere in the DOM for a query that matched through one', async () => {
    // The whole justification for search_aliases being its own column rather than more
    // parentheticals in display_name: display_name reaches the text of a public post
    // (lambda/facebook-share/index.js:319). Matching on the alias must not surface it.
    const ids = await searchFor('cantaloupe')
    expect(ids).toEqual(['pl-char'])
    const text = document.body.textContent ?? ''
    for (const word of ['cantaloupe', 'muskmelon', 'honeydew', 'karela', 'mouse melon']) {
      expect(text.toLowerCase()).not.toContain(word)
    }
    // The row IS on screen — asserting an absence against an empty page would pass for free.
    expect(text).toContain('Charentais')
  })

  it('matching through ONE alias does not render the row\'s other aliases', async () => {
    // The tempting UI is a "matched: honeydew" hint or an alias subtitle on the row, which is how
    // the list would leak one word at a time. Query the THIRD alias so the two unrendered ones are
    // words the user demonstrably did not type — the page echoing its own query back (it does, in
    // the empty state) can never satisfy this.
    expect(await searchFor('honeydew')).toEqual(['pl-char'])
    const text = (document.body.textContent ?? '').toLowerCase()
    expect(text).not.toContain('cantaloupe')
    expect(text).not.toContain('muskmelon')
    expect(document.body.textContent).toContain('Charentais')
  })
})
