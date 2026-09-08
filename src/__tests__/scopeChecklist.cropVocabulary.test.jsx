// V4-LOGMANYCROPFILTER-001 / BD-073 — the crop axis speaks DAVE'S VOCABULARY, composes with the
// location axis, and says on screen which filters are on.
//
// The three parts of BD-073 were built under V4-LOGMANYUXREFRESH-001 (S1 crop chips, S4 location ×
// crop + grouping, S5 grouping on the review list too) and are pinned by
// scopeChecklist.groupFilter.test.jsx. What was NOT built is the sentence the row ends on:
//
//     "label chips with Dave's vocabulary. A filter chip labelled with a slug he does not use is
//      the same failure in a different surface."
//
// The labels came from `titleizeSlug(crop_type_slug)` — a mechanical transform of the STORAGE KEY.
// Measured against prod, 15 crop types with live plants read differently under the controlled
// vocabulary, and two of them read WRONG rather than merely plain: `squash` titleizes to "Squash"
// while crop_types calls it "Summer Squash" (there is a separate winter_squash), and
// `bunching_onion` titleizes to "Bunching Onion" while the vocabulary — and Dave — say
// "Onion (bunching / scallion)".
//
// EVERY FILTER ASSERTION HERE CARRIES A POSITIVE CONTROL. "The pepper is gone" is satisfied by a
// filter that hides everything, by a filter that crashed, and by a list that never rendered; only
// "these rows are present AND that one is not" distinguishes a working filter from a broken one.
// So each case names the rows it EXPECTS as well as the ones it must not see.
//
// The crop_types fixture is copied from prod (psql, 2026-09-07) rather than invented — including
// squash's real `search_aliases` ('zucchini, courgette') and melon's ('cantaloupe, muskmelon,
// honeydew'), which is the row BD-072 was filed from.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

// `fetch` MUST be a module-level spy, not an inline `vi.fn()`. ScopeChecklist now calls
// useCropTypes (through useCropFacetOptions), whose effect deps are [fetch, enabled] and whose
// .then SETS STATE. A factory that mints a fresh fn per call gives a new identity every render, so
// the effect refires forever and the test HANGS rather than fails. The real useApiFetch returns a
// useCallback'd fetch, so this is a mock artifact, not a defect.
const CROP_TYPES = [
  { slug: 'tomato',         display_name: 'Tomato',                      search_aliases: null },
  { slug: 'pepper',         display_name: 'Pepper',                      search_aliases: null },
  { slug: 'squash',         display_name: 'Summer Squash',               search_aliases: 'zucchini, courgette' },
  { slug: 'bunching_onion', display_name: 'Onion (bunching / scallion)', search_aliases: null },
  { slug: 'melon',          display_name: 'Melon',                       search_aliases: 'cantaloupe, muskmelon, honeydew' },
]
let vocabulary = CROP_TYPES
const apiFetch = vi.fn(async (path) => (path === '/api/varieties/crop-types' ? vocabulary : undefined))
const getTokenMock = vi.fn(async () => null)
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch, getToken: getTokenMock }) }))
vi.mock('../lib/notificationPrefsClient.js', () => ({
  fetchNotificationPrefs: vi.fn(async () => null),
  saveLogManyAllSelected: vi.fn(),
  saveHandedness: vi.fn(),
  HANDEDNESS_VALUES: ['right', 'left'],
}))

import ScopeChecklist from '../components/forms/ScopeChecklist.jsx'

const LOCATIONS = [
  { id: 'pasture', name: 'Pasture',  parent_id: null,      sort_order: 1 },
  { id: 'bag',     name: 'Bag Area', parent_id: 'pasture', sort_order: 1 },
  { id: 'deck',    name: 'Deck',     parent_id: null,      sort_order: 2 },
]

// 15 rows, and the shape is load-bearing in two places. The Bag Area alone has to clear
// CHIPS_MIN_ROWS (8), or the crop chip row is correctly absent under a zone scope and the BULK
// composition case has nothing to tap. And tomato/pepper have to lead the counts so the three
// crops whose vocabulary label DIVERGES all land in the More tray — which is where a chip can be
// active and invisible, and therefore why the breadcrumb below has a job.
const PLANTINGS = [
  { id: 't1', name: 'Sun Gold',          crop_type_slug: 'tomato',         location_id: 'bag' },
  { id: 't2', name: 'San Marzano',       crop_type_slug: 'tomato',         location_id: 'bag' },
  { id: 't3', name: 'Black Krim',        crop_type_slug: 'tomato',         location_id: 'bag' },
  { id: 't4', name: 'Green Zebra',       crop_type_slug: 'tomato',         location_id: 'bag' },
  { id: 't5', name: 'Mortgage Lifter',   crop_type_slug: 'tomato',         location_id: 'bag' },
  { id: 't6', name: 'Cherokee Purple',   crop_type_slug: 'tomato',         location_id: 'deck' },
  { id: 'p1', name: 'Aji Dulce',         crop_type_slug: 'pepper',         location_id: 'bag' },
  { id: 'p2', name: 'Jalapeno',          crop_type_slug: 'pepper',         location_id: 'bag' },
  { id: 'p3', name: 'Shishito',          crop_type_slug: 'pepper',         location_id: 'bag' },
  { id: 'p4', name: 'Padron',            crop_type_slug: 'pepper',         location_id: 'deck' },
  { id: 's1', name: 'Costata Romanesco', crop_type_slug: 'squash',         location_id: 'bag' },
  { id: 'o1', name: 'Evergreen Hardy',   crop_type_slug: 'bunching_onion', location_id: 'deck' },
  { id: 'm1', name: 'Charentais',        crop_type_slug: 'melon',          location_id: 'deck' },
  { id: 'n1', name: 'Aloe Vera',         crop_type_slug: null,             location_id: 'bag' },
  { id: 'n2', name: 'Kousa Dogwood',     crop_type_slug: null,             location_id: 'deck' },
]
const TOTAL = PLANTINGS.length          // 15
const IN_BAG = 10

// Scope-AWARE, so the BULK case exercises Dave's "bag area + tomatoes" the way the page really
// reaches it: a zone SCOPE resolved server-side, narrowed by a crop CHIP client-side. A fixed list
// would have made the scope chip a no-op and the composition untestable on that surface. The
// descendant map stands in for the Lambda's `WITH RECURSIVE loc_subtree`.
const SUBTREE = { pasture: ['pasture', 'bag'], bag: ['bag'], deck: ['deck'] }
const dryRun = vi.fn(({ scope }) => {
  const rows = scope?.type === 'space'
    ? PLANTINGS.filter(p => (SUBTREE[scope.location_id] ?? []).includes(p.location_id))
    : PLANTINGS
  return Promise.resolve({ count: rows.length, capped: false, plantings: rows })
})

function Harness({ locations = LOCATIONS, ...rest }) {
  const [scope, setScope] = useState({ type: 'all' })
  return (
    <ScopeChecklist
      scope={scope} onScopeChange={setScope} projects={[]} locations={locations}
      eventType="watering" eventDate="" verbLabel="watering"
      runDryRun={dryRun} onSelectionChange={() => {}}
      {...rest}
    />
  )
}

const enterPick = async () => {
  fireEvent.click(await screen.findByTestId('sc-mode-pick'))
  return screen.findByTestId('pick-frame')
}
const openReview = async () => {
  fireEvent.click(await screen.findByText(/Review \d+ plantings/))
  return screen.findByTestId('sc-review-list')
}
// Names, not ids: an assertion that reads back the words on screen is the one that fails when the
// wrong rows survive a filter.
const pickNames = () => [...document.querySelectorAll('[data-testid^="pick-row-"]')]
  .map(b => b.querySelector('span:nth-of-type(2)')?.textContent ?? '')
const reviewNames = () => [...document.querySelectorAll('[data-testid="sc-review-list"] li button[aria-pressed]')]
  .map(b => b.textContent.replace(/^[✓○]/, '').trim())
const pickHeaders = () => [...document.querySelectorAll('[data-testid^="pick-group-"]')]
  .map(li => li.querySelector('span')?.textContent ?? '')
const reviewHeaders = () => [...document.querySelectorAll('[data-testid^="sc-group-"]')]
  .map(li => li.querySelector('span')?.textContent ?? '')
const chipsIn = (testid) => [...document.querySelectorAll(`[data-testid="${testid}"] button`)]
  .map(b => b.textContent.replace(/\s+/g, ' ').trim())
const chip = (testid, label) => [...document.querySelectorAll(`[data-testid="${testid}"] button`)]
  .find(b => b.textContent.replace(/\s+/g, ' ').trim() === label)
// FilterChipRow UNMOUNTS the tray options when collapsed (not hides them), so a non-pinned chip is
// unreachable until More is tapped. Idempotent: once expanded the control reads "Less ▴".
const expandChips = (testid) => {
  const more = [...document.querySelectorAll(`[data-testid="${testid}"] button`)].find(b => /^More/.test(b.textContent))
  if (more) fireEvent.click(more)
}
const tapCrop = (label) => { expandChips('sc-crop-chips'); fireEvent.click(chip('sc-crop-chips', label)) }
const tapZone = (label) => { expandChips('sc-zone-chips'); fireEvent.click(chip('sc-zone-chips', label)) }
const type = (v) => fireEvent.change(screen.getByTestId('sc-search'), { target: { value: v } })
const pillTexts = () => [...document.querySelectorAll('[data-testid="tag-filter-bar"] [data-testid="tag-chip"]')]
  .map(c => c.textContent.replace(/×$/, '').trim())
// The vocabulary lands in a microtask after mount, so every case that reads a label waits for one
// only the controlled vocabulary can produce. Expanding first because 'Summer Squash' is a tray chip.
const awaitVocabulary = async () => {
  await screen.findByTestId('sc-crop-chips')
  await waitFor(() => {
    expandChips('sc-crop-chips')
    expect(chipsIn('sc-crop-chips')).toContain('Summer Squash')
  })
}

beforeEach(() => {
  vocabulary = CROP_TYPES
  apiFetch.mockClear(); dryRun.mockClear()
  try { localStorage.clear() } catch (e) { /* private mode */ }
})
afterEach(() => cleanup())

// ══ BD-073 (1) — THE CROP FILTER, LABELLED IN DAVE'S WORDS ═════════════════════════════════════
describe('(1) the crop chips carry the controlled vocabulary, not a titleized slug', () => {
  it('labels squash "Summer Squash" — the titleizer said "Squash", which is a different crop', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    const labels = chipsIn('sc-crop-chips')
    expect(labels).toContain('Summer Squash')
    // The regression this exists to prevent, named rather than merely absent: with a separate
    // winter_squash type in the vocabulary, a chip reading "Squash" claims to cover both.
    expect(labels).not.toContain('Squash')
  })

  it('labels bunching_onion "Onion (bunching / scallion)" — the word Dave actually uses', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    const labels = chipsIn('sc-crop-chips')
    expect(labels).toContain('Onion (bunching / scallion)')
    expect(labels).not.toContain('Bunching Onion')
  })

  it('POSITIVE CONTROL — tapping the re-labelled chip selects that crop and nothing else', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    tapCrop('Summer Squash')
    // What it INCLUDES. A "the peppers are gone" assertion alone would pass on an empty list.
    await waitFor(() => expect(pickNames()).toEqual(['Costata Romanesco']))
    expect(screen.getByTestId('sc-shown-note').textContent).toMatch(new RegExp(`Showing 1 of ${TOTAL}`))
  })

  it('POSITIVE CONTROL — two chips OR within the axis, so both crops come back', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    tapCrop('Summer Squash')
    tapCrop('Onion (bunching / scallion)')
    await waitFor(() => expect(pickNames().sort()).toEqual(['Costata Romanesco', 'Evergreen Hardy']))
  })

  it('degrades to the titleizer, not to blank chips, when the vocabulary is unreachable', async () => {
    vocabulary = undefined            // useCropTypes resolves to [] on any non-array
    render(<Harness />)
    await enterPick()
    // The pre-change labels EXACTLY: prettySlug is the same slug→Title Case transform titleizeSlug
    // was, so a failed vocabulary fetch costs the old labels and nothing more.
    await waitFor(() => expect(chipsIn('sc-crop-chips')).toContain('Tomato'))
    expandChips('sc-crop-chips')
    expect(chipsIn('sc-crop-chips')).toContain('Squash')
    expect(chipsIn('sc-crop-chips')).toContain('Bunching Onion')
    // POSITIVE CONTROL: still a working filter, not merely a labelled one.
    fireEvent.click(chip('sc-crop-chips', 'Squash'))
    await waitFor(() => expect(pickNames()).toEqual(['Costata Romanesco']))
  })

  it('never lets the vocabulary rename the Ungrouped bucket, even if a row claims that slug', async () => {
    // The bucket is this file's own synthetic value, not a crop. A crop_types row that happened to
    // carry the sentinel slug must not get to name it — that is how crop-type-less plantings end up
    // filed under someone else's word.
    vocabulary = [...CROP_TYPES, { slug: '__ungrouped__', display_name: 'HIJACKED', search_aliases: null }]
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    expect(chipsIn('sc-crop-chips')).toContain('Ungrouped')
    expect(chipsIn('sc-crop-chips')).not.toContain('HIJACKED')
    // POSITIVE CONTROL: the bucket still holds its two rows.
    fireEvent.click(chip('sc-crop-chips', 'Ungrouped'))
    await waitFor(() => expect(pickNames().sort()).toEqual(['Aloe Vera', 'Kousa Dogwood']))
  })

  it('never pins Ungrouped, even when it is the BIGGEST bucket', async () => {
    // A GARDEN WHERE THE GUARD HAS TO FIRE. Against the main fixture Ungrouped is third by count,
    // so "it is not pinned" holds whether the `!== UNGROUPED` filter exists or not — a green test
    // that proves nothing (mutation-checked: deleting the filter left it passing). Here the null
    // bucket outnumbers every real crop, so the top-2-by-count rule would pin it and only the
    // guard keeps it out. The pins must still be the two real crops.
    const heavy = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, name: `Unknown ${i}`, crop_type_slug: null, location_id: 'bag' })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `h${i}`, name: `Heirloom ${i}`, crop_type_slug: 'tomato', location_id: 'bag' })),
      ...Array.from({ length: 2 }, (_, i) => ({ id: `c${i}`, name: `Chile ${i}`, crop_type_slug: 'pepper', location_id: 'deck' })),
    ]
    render(<Harness runDryRun={() => Promise.resolve({ count: heavy.length, capped: false, plantings: heavy })} />)
    await enterPick()
    // Deliberately does NOT expand: the claim is about what is one tap away before the More tray.
    await waitFor(() => expect(chipsIn('sc-crop-chips')).toContain('Tomato'))
    const collapsed = chipsIn('sc-crop-chips')
    expect(collapsed).toContain('Pepper')
    expect(collapsed).not.toContain('Ungrouped')
    // POSITIVE CONTROL — the bucket is still REACHABLE from the tray, not merely unpinned.
    expandChips('sc-crop-chips')
    fireEvent.click(chip('sc-crop-chips', 'Ungrouped'))
    await waitFor(() => expect(pickNames()).toHaveLength(6))
    expect(pickNames()).toContain('Unknown 0')
  })
})

// ══ The search field answers to the same vocabulary the chips do ═══════════════════════════════
describe('search matches display_name and aliases, not just the slug', () => {
  it('POSITIVE CONTROL — typing the chip label "summer squash" finds the row', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    type('summer squash')
    await waitFor(() => expect(pickNames()).toEqual(['Costata Romanesco']))
  })

  it('POSITIVE CONTROL — "scallion" reaches bunching_onion through display_name', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    type('scallion')
    await waitFor(() => expect(pickNames()).toEqual(['Evergreen Hardy']))
  })

  it('POSITIVE CONTROL — "cantaloupe" reaches melon through search_aliases (the BD-072 sentence)', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    type('cantaloupe')
    await waitFor(() => expect(pickNames()).toEqual(['Charentais']))
  })

  it('still matches the raw slug and the cultivar name', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    type('squash')
    await waitFor(() => expect(pickNames()).toEqual(['Costata Romanesco']))
    type('krim')
    await waitFor(() => expect(pickNames()).toEqual(['Black Krim']))
  })

  it('a vocabulary term does not become a wildcard — "scallion" excludes the tomatoes', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    type('scallion')
    await waitFor(() => expect(pickNames()).toHaveLength(1))
    expect(pickNames()).not.toContain('Sun Gold')
  })
})

// ══ BD-073 (2) — LOCATION × CROP COMPOSE ═══════════════════════════════════════════════════════
describe('(2) location and crop compose — "bag area + tomatoes"', () => {
  const BAG_TOMATOES = ['Black Krim', 'Green Zebra', 'Mortgage Lifter', 'San Marzano', 'Sun Gold']

  it('POSITIVE CONTROL — the intersection is the five bag tomatoes, by name', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    tapZone('Bag Area')
    tapCrop('Tomato')
    await waitFor(() => expect(pickNames().sort()).toEqual(BAG_TOMATOES))
    // Both halves of the intersection have to be doing work: a bag PEPPER proves the crop axis
    // still applies, a deck TOMATO proves the location axis does.
    expect(pickNames()).not.toContain('Aji Dulce')
    expect(pickNames()).not.toContain('Cherokee Purple')
  })

  it('neither axis clobbers the other — the order the two chips are tapped does not matter', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    tapCrop('Tomato')
    tapZone('Bag Area')
    await waitFor(() => expect(pickNames().sort()).toEqual(BAG_TOMATOES))
  })

  it('POSITIVE CONTROL — in BULK the zone SCOPE and the crop CHIP compose the same way', async () => {
    // The surface Dave reaches first. The zone is a server-resolved scope here rather than a chip,
    // so this proves the composition across the client/server seam, not just within one memo.
    render(<Harness />)
    fireEvent.click(await screen.findByText('By zone'))
    fireEvent.click(await screen.findByText('Bag Area'))
    await screen.findByText(new RegExp(`Review ${IN_BAG} plantings`))
    await openReview()
    await waitFor(() => expect(chipsIn('sc-crop-chips')).toContain('Tomato'))
    fireEvent.click(chip('sc-crop-chips', 'Tomato'))
    await waitFor(() => expect(reviewNames().sort()).toEqual(BAG_TOMATOES))
    expect(reviewNames()).not.toContain('Aji Dulce')       // the bag pepper: crop axis is live
    expect(reviewNames()).not.toContain('Cherokee Purple') // the deck tomato: scope is live
  })

  it('the crop axis composes with the SEARCH field too', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    tapCrop('Tomato')
    type('san')
    await waitFor(() => expect(pickNames()).toEqual(['San Marzano']))
  })
})

// ══ BD-073 (3) — GROUPING, IN THE VOCABULARY'S WORDS ═══════════════════════════════════════════
describe('(3) location-only results are parented under crop types', () => {
  it('POSITIVE CONTROL — a zone-only filter still groups, and the headers use display_name', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    tapZone('Bag Area')
    // Part (3) verbatim: "when filtering by LOCATION ONLY … parented under their crop types".
    await waitFor(() => expect(pickNames()).toHaveLength(IN_BAG))
    expect(pickHeaders()).toEqual(['Tomato', 'Pepper', 'Summer Squash', 'Ungrouped'])
    expect(pickHeaders()).not.toContain('Squash')
  })

  it('attributes every row to the header above it, not merely renders headers', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    tapZone('Bag Area')
    await waitFor(() => expect(pickNames()).toHaveLength(IN_BAG))
    const under = {}
    let current = null
    for (const li of document.querySelectorAll('[data-testid="pick-list"] > *')) {
      const tid = li.dataset.testid ?? ''
      if (tid.startsWith('pick-group-')) { current = li.querySelector('span')?.textContent; under[current] = []; continue }
      const btn = li.querySelector('button[aria-pressed]')
      if (btn) under[current].push(btn.querySelector('span:nth-of-type(2)')?.textContent)
    }
    expect(under['Tomato'].sort()).toEqual(['Black Krim', 'Green Zebra', 'Mortgage Lifter', 'San Marzano', 'Sun Gold'])
    expect(under['Pepper'].sort()).toEqual(['Aji Dulce', 'Jalapeno', 'Shishito'])
    expect(under['Summer Squash']).toEqual(['Costata Romanesco'])
    expect(under['Ungrouped']).toEqual(['Aloe Vera'])
  })

  it('the BULK review list groups under the same vocabulary labels', async () => {
    render(<Harness />)
    await openReview()
    await waitFor(() => expect(reviewHeaders()).toContain('Summer Squash'))
    expect(reviewHeaders()).toEqual([
      'Tomato', 'Pepper', 'Melon', 'Onion (bunching / scallion)', 'Summer Squash', 'Ungrouped',
    ])
    expect(reviewHeaders()).not.toContain('Bunching Onion')
    // Ungrouped is forced last and never dropped — the silent-omission class the row names.
    expect(reviewNames()).toContain('Kousa Dogwood')
  })

  it('the PICK row label names the crop in the vocabulary too', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    type('costata')
    await waitFor(() => expect(pickNames()).toEqual(['Costata Romanesco']))
    expect(screen.getByTestId('pick-row-s1').textContent).toContain('Summer Squash')
  })
})

// ══ The active-filter breadcrumb (Photos parity) ═══════════════════════════════════════════════
describe('the breadcrumb names the active filters and removes them one at a time', () => {
  it('is absent with no filters on', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    expect(screen.queryByTestId('tag-filter-bar')).toBeNull()
  })

  it('names both axes once they are on', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    tapZone('Bag Area')
    tapCrop('Tomato')
    await waitFor(() => expect(pillTexts()).toHaveLength(2))
    expect(pillTexts()).toContain('Tomato')
    expect(pillTexts()).toContain('Bag Area')
  })

  it('labels the crop pill in the vocabulary, matching the chip it came from', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    tapCrop('Summer Squash')
    await waitFor(() => expect(pillTexts()).toEqual(['Summer Squash']))
  })

  it('POSITIVE CONTROL — removing the crop pill leaves the ZONE filter still filtering', async () => {
    // The whole point of per-pill removal, and the assertion that would pass vacuously if written
    // as "the peppers came back": if removal wiped both axes the deck rows would return too.
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    tapZone('Bag Area')
    tapCrop('Tomato')
    await waitFor(() => expect(pickNames()).toHaveLength(5))
    fireEvent.click(screen.getByLabelText('Remove Tomato'))
    await waitFor(() => expect(pickNames()).toHaveLength(IN_BAG))
    expect(pickNames()).toContain('Aji Dulce')            // the bag pepper is back
    expect(pickNames()).not.toContain('Cherokee Purple')  // the deck tomato is NOT — zone still on
    expect(pillTexts()).toEqual(['Bag Area'])
  })

  it('POSITIVE CONTROL — removing the zone pill leaves the CROP filter still filtering', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    tapZone('Bag Area')
    tapCrop('Tomato')
    await waitFor(() => expect(pickNames()).toHaveLength(5))
    fireEvent.click(screen.getByLabelText('Remove Bag Area'))
    await waitFor(() => expect(pickNames()).toHaveLength(6))
    expect(pickNames()).toContain('Cherokee Purple')  // the deck tomato is back
    expect(pickNames()).not.toContain('Aji Dulce')    // still tomatoes only
    expect(pillTexts()).toEqual(['Tomato'])
  })

  it('POSITIVE CONTROL — Clear all restores every row, including clearing the typed query', async () => {
    render(<Harness />)
    await enterPick()
    await awaitVocabulary()
    tapZone('Bag Area')
    tapCrop('Tomato')
    type('san')
    await waitFor(() => expect(pickNames()).toEqual(['San Marzano']))
    fireEvent.click(screen.getByText('Clear all'))
    await waitFor(() => expect(pickNames()).toHaveLength(TOTAL))
    expect(screen.getByTestId('sc-search').value).toBe('')
    expect(screen.queryByTestId('tag-filter-bar')).toBeNull()
  })

  it('a filter never touches the committed batch — only what is shown', async () => {
    // The safety property the S1 header states: "they narrow WHAT IS SHOWN ONLY". A breadcrumb that
    // could deselect would be the invisible-filter trap wearing a new costume.
    let sel = null
    render(<Harness onSelectionChange={(s) => { sel = s }} />)
    await openReview()
    await waitFor(() => expect(chipsIn('sc-crop-chips')).toContain('Tomato'))
    const before = sel.committedCount
    expect(before).toBe(TOTAL)
    fireEvent.click(chip('sc-crop-chips', 'Tomato'))
    await waitFor(() => expect(reviewNames()).toHaveLength(6))
    expect(sel.committedCount).toBe(before)
    fireEvent.click(screen.getByLabelText('Remove Tomato'))
    await waitFor(() => expect(reviewNames()).toHaveLength(TOTAL))
    expect(sel.committedCount).toBe(before)
  })

  it('shows on the BULK review list too, not only in the pick frame', async () => {
    render(<Harness />)
    await openReview()
    await waitFor(() => expect(chipsIn('sc-crop-chips')).toContain('Tomato'))
    fireEvent.click(chip('sc-crop-chips', 'Tomato'))
    await waitFor(() => expect(pillTexts()).toEqual(['Tomato']))
    expect(reviewNames()).toContain('Cherokee Purple')
    expect(reviewNames()).not.toContain('Aji Dulce')
  })
})
