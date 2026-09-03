// V5-HARVESTVOICEFLOW-001 — the first user-facing voice slice, and the first time the grammar and
// the commit debouncer run against real data rather than inside the /admin probe.
//
// WHAT THESE TESTS ARE FOR. Dave's own framing decides the priorities: "a silent wrong save is worse
// than a slow form", and BUG-VOICEFAILSILENT-001 verbatim — "I DON'T JUST MISS IT COMPLETELY AND
// BELIEVE IT WAS FINE. A SILENT FAIL IS A LOST LOG." So the cases that matter most here are not the
// happy path; they are the four ways a spoken record can fail to become a row, each of which must be
// impossible to mistake for success.
//
// The recogniser is driven through the SHARED fake (helpers/fakeSpeechRecognition.js), which models
// the `onend -> start -> onstart` re-arm loop the device proved is the dominant path. transcribe.js
// is deliberately NOT mocked — this page does not use it, and mocking it would hide that.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
// Haptics touch navigator.vibrate and a localStorage preference; neither is the subject here, and a
// real call would make the assertions depend on jsdom's vibrate stub rather than on the flow.
vi.mock('../lib/haptics.js', () => ({
  hapticSaveCommitted: vi.fn(), hapticSaveFailed: vi.fn(),
  hapticDigitAccepted: vi.fn(), hapticDigitRejected: vi.fn(), hapticUndoApplied: vi.fn(),
  hapticMatchUncertain: vi.fn(),
}))
// The mocked module itself, so the cue tests can assert WHICH symbol fired. haptics.test.js proves the
// patterns are distinct; these prove the page reaches for the right one, which is the half that was
// wrong — a guess fired the success cue and a dead mic fired nothing at all.
import * as haptics from '../lib/haptics.js'

import VoiceHarvest, {
  matchPlantings, matchPlantingsWithRescue, resolveCommandCollision, plantingAliases, resolveOneBreath,
  namesAPlantingExactly, CANDIDATE_LIMIT,
} from '../pages/VoiceHarvest.jsx'
import { indexAliases } from '../lib/voiceAliases.js'
import { looseKey } from '../lib/comboboxInput.js'

const planting = (id, name, slug, unit = null) => ({
  id, name, archived_at: null,
  variety_ref: { id: `v-${id}`, name: `${name} cultivar`, crop_type_slug: slug, default_unit: unit },
})

const PLANTS = [
  planting('p1', 'Suyo Long', 'cucumber'),
  planting('p2', 'Marketmore', 'cucumber'),
  planting('p3', 'Chinese Red Noodle', 'bean'),
  planting('p4', 'Pineapple Tomatillo', 'tomatillo', 'count'),
]

// THE REAL CREATE RESPONSE, taken from the producer rather than invented. lambda/events/index.js:3890
// returns `resp(201, { ...newEvent, … })` and `:3495` builds newEvent from the event_log row, so the
// id arrives as a TOP-LEVEL `id`. There is no `eventId` key and no nested `event` object anywhere in
// lambda/events — every `eventId` in that file is an internal variable.
//
// The previous fixture was `{ eventId: 'evt-1' }`, a shape the API has never returned. That is why the
// undo test below was green against a client that could not find the id in production: the Undo button
// requires `r.eventId`, so on device it never rendered and the session's stated "every committed row
// carries an Undo" was false. A fixture invented to match the client cannot falsify the client.
const EVENT_ID = '9c4b1f2e-6a7d-4f10-8b33-5d2e0a71c4ab'
const createdEvent = () => ({
  id: EVENT_ID,
  event_type: 'harvest',
  event_date: '2026-08-31',
  plant_id: 'p1',
  project_id: null,
  notes: null,
  private_notes: null,
  quantity: null,
  is_public: false,
  has_photo: false,
  metadata: { harvest_input_source: 'voice' },
  created_at: '2026-08-31T16:00:00.000Z',
  harvest: { id: 'h-1', quantity: 3, unit: 'count', quality_rating: null, weight_grams: null },
  newly_earned_achievements: [],
  updated_streak: 1,
  xp_gained: 5,
  daily_xp_remaining: 95,
  level: 3,
  leveled_up: false,
})

let mic

beforeEach(() => {
  mic = installFakeSpeechRecognition(vi)
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url) => {
    if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: PLANTS })
    return Promise.resolve(createdEvent())
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// Start the mic and hand back the live fake. Everything downstream drives this.
async function startListening() {
  render(<VoiceHarvest />)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
  await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
  return mic.latest()
}

// One spoken utterance, settled. A DATA final commits at the session boundary; a WRITE command
// deliberately does not, and waits out the settle window on a tick — so a command needs its timer to
// land, which is what `advance` covers.
async function speak(rec, text) {
  await act(async () => { rec.deliverFinal(text) })
  await act(async () => { rec.endSession() })
}

const statusText = () => screen.getByTestId('voice-harvest-status').textContent
const record = () => screen.getByTestId('voice-harvest-record').textContent
const harvestPosts = () =>
  apiFetchSpy.mock.calls.filter(([url, opts]) => url === '/api/events' && opts?.method === 'POST')

describe('matchPlantings — what a planting can be called out loud', () => {
  it('matches on the crop type, not just the cultivar name', () => {
    // V4-SEARCHCROPTYPE-001's reason, made worse by speech: a recogniser has no chance on "Suyo
    // Long" and every chance on "cucumber".
    expect(matchPlantings(PLANTS, 'cucumber').map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('promotes an EXACT alias match over a merely-containing one', () => {
    // The case promotion exists for: a decoy whose NAME contains the spoken word without being it.
    // "cucumber" must not offer the trap crop alongside the cucumbers.
    const decoy = planting('p6', 'Cucumber Beetle Trap Crop', 'nasturtium')
    const hits = matchPlantings([...PLANTS, decoy], 'cucumber')
    expect(hits.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('does NOT narrow to the one planting literally NAMED the crop — every cucumber is a cucumber', () => {
    // A planting called "Cucumber" is exact on its name and p1/p2 are exact on their crop slug, so
    // all three are equally what he asked for. Narrowing to the name-match would silently hide two
    // real plantings behind a naming coincidence, and he would have to notice the absence to correct
    // it. Offering the choice is the honest answer.
    const hits = matchPlantings([...PLANTS, planting('p5', 'Cucumber', 'cucumber')], 'cucumber')
    expect(hits.map((p) => p.id)).toEqual(['p1', 'p2', 'p5'])
  })

  it('is voice-forgiving in the same way the picker is (looseKey)', () => {
    expect(matchPlantings(PLANTS, 'chinese').map((p) => p.id)).toEqual(['p3'])
  })

  it('returns nothing for an empty or unmatched utterance rather than everything', () => {
    expect(matchPlantings(PLANTS, '')).toEqual([])
    expect(matchPlantings(PLANTS, 'rhubarb')).toEqual([])
  })

  it('aliases are name, cultivar name and crop slug — nothing else', () => {
    expect(plantingAliases(PLANTS[0])).toEqual(['Suyo Long', 'Suyo Long cultivar', 'cucumber'])
  })
})

describe('resolveCommandCollision — a planting can be named after a command word', () => {
  it('demotes a command to a search when a planting is named EXACTLY that', () => {
    const plants = [planting('p9', 'Next', 'brassica')]
    const cmd = { kind: 'command', command: 'save_and_advance', transcript: 'next' }
    expect(resolveCommandCollision(cmd, plants).kind).toBe('search')
  })

  it('does NOT demote on a partial match — "save" must survive growing a Savoy', () => {
    const plants = [planting('p9', 'Savoy Cabbage', 'brassica')]
    const cmd = { kind: 'command', command: 'save', transcript: 'save' }
    expect(resolveCommandCollision(cmd, plants)).toBe(cmd)
  })

  it('leaves non-commands untouched', () => {
    const data = { kind: 'weight', value: 231, unit: 'g', transcript: '231 grams' }
    expect(resolveCommandCollision(data, PLANTS)).toBe(data)
  })
})

describe('VoiceHarvest — the spoken record', () => {
  // ── V5-VOICEONEBREATH-002 ──────────────────────────────────────────────────────────────────────
  //
  // Dave, 2026-09-02: "I want to speak planting, brief pause, count, brief pause, weight, next all
  // as ONE breath rather than three." The four-utterance test below is the same record spoken the
  // old way; these two are the same record spoken the way he actually wants to speak it, and they
  // must produce a byte-identical POST.
  it('ONE BREATH: the whole record plus "next" in a single utterance posts the same harvest', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long three count 231 grams next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    const posts = harvestPosts()
    expect(posts, 'one breath must still write exactly one row').toHaveLength(1)
    const body = JSON.parse(posts[0][1].body)
    expect(body.plant_id).toBe('p1')
    expect(body.harvest).toMatchObject({ quantity: 3, unit: 'count', weight: 231, weight_unit: 'g' })
    vi.useRealTimers()
  })

  // The shape Chrome actually produces when it ends the session at his pause after the crop name:
  // the amounts and the command arrive together, with no name. Before the fix this classified as a
  // SEARCH for the whole literal string and lost both values in silence.
  it('ONE BREATH, split by Chrome: the nameless pair plus "next" still posts the record', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count 231 grams next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    const posts = harvestPosts()
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0][1].body).harvest)
      .toMatchObject({ quantity: 3, unit: 'count', weight: 231, weight_unit: 'g' })
    vi.useRealTimers()
  })

  // A DUPLICATE FINAL MUST NOT DOUBLE-WRITE. The one-breath utterance classifies as `search`, not
  // `command`, so before the debouncer was taught to read its trailing command it held no cooldown
  // slot at all while performing exactly the write a bare "next" performs. This repo has five
  // recorded duplicate-final recurrences (BUG-VOICEDUPE-001..005), so this is a live shape, not a
  // hypothetical: unprotected it writes two harvests and skips a planting Dave never sees.
  it('a REPEATED one-breath final writes ONE harvest, not two', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long three count 231 grams next')
    await speak(rec, 'Suyo Long three count 231 grams next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(harvestPosts(), 'the write cooldown must cover the one-breath path').toHaveLength(1)
    vi.useRealTimers()
  })

  // THE SAFETY CASE, at the UI level rather than the grammar level: a trailing command may never
  // conjure a save out of a search term. "Suyo Long next" selects and does NOT write.
  it('a search term with a trailing command does NOT save', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(harvestPosts(), 'no amounts were spoken — nothing may be written').toHaveLength(0)
    vi.useRealTimers()
  })

  it('a full spoken record posts ONE harvest with the values that were said', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, '231 grams')
    await speak(rec, 'next')
    // The write waits out the settle window; only a tick can commit it.
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    const posts = harvestPosts()
    expect(posts).toHaveLength(1)
    const body = JSON.parse(posts[0][1].body)
    expect(body.plant_id).toBe('p1')
    expect(body.event_type).toBe('harvest')
    expect(body.harvest).toMatchObject({ quantity: 3, unit: 'count', weight: 231, weight_unit: 'g' })
    // The container is derived server-side (deriveEventProjectId) — the client must not guess one.
    expect(body.project_id).toBeNull()
    // C8: the row says how it was captured, so voice rows are separable from typed ones later.
    expect(body.metadata).toMatchObject({ harvest_input_source: 'voice' })
    vi.useRealTimers()
  })

  it('names what it saved and leaves an undoable row — the loud confirmation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    expect(statusText()).toContain('Saved Suyo Long')
    expect(statusText()).toContain('3 count')
    expect(screen.getAllByTestId('voice-harvest-row')).toHaveLength(1)
    expect(screen.getByLabelText(/Undo Suyo Long/)).toBeDefined()
    vi.useRealTimers()
  })

  it('CLEARS the record after a save so the next crop starts empty', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(record()).not.toContain('Suyo Long')
    vi.useRealTimers()
  })

  it('offers a choice when several plantings match, and saves NOTHING until one is picked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'cucumber')
    expect(statusText()).toContain('2 match')
    expect(screen.getAllByRole('button', { name: /Suyo Long|Marketmore/ }).length).toBeGreaterThan(0)

    await speak(rec, 'three count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(harvestPosts()).toHaveLength(0)
    expect(statusText()).toContain('still need a crop')
    vi.useRealTimers()
  })
})

describe('VoiceHarvest — the four ways a spoken record must fail LOUDLY', () => {
  it('refuses to save with no quantity, and KEEPS the record rather than advancing over it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    expect(harvestPosts()).toHaveLength(0)
    expect(statusText()).toContain('still need a quantity')
    // THE PROPERTY THAT MATTERS: the planting is still selected. Advancing over an unsaveable record
    // is how a picking is silently lost — the failure V101 found in /log's own save_and_advance.
    expect(record()).toContain('Suyo Long')
    vi.useRealTimers()
  })

  it('NEVER saves a quantity that was not spoken — no default is seeded on selection', async () => {
    // THE REGRESSION THIS PINS ACTUALLY HAPPENED, in the browser harness, in this slice. Selecting a
    // planting briefly pre-filled `{ value: 1, unit: variety_ref.default_unit }` so a weighed crop
    // would be complete from the weight alone. The result: "Suyo Long" then "next", with no count
    // ever spoken, saved a harvest of 1 count and ANNOUNCED IT AS A SUCCESS.
    //
    // p4 carries default_unit 'count' precisely so this test would go green under that bug.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Pineapple Tomatillo')
    expect(record()).toContain('Pineapple Tomatillo')

    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(harvestPosts()).toHaveLength(0)
    expect(statusText()).toContain('still need a quantity')
    vi.useRealTimers()
  })

  it('says NOT SAVED on a POST failure, keeps the record, and lets "next" retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')

    apiFetchSpy.mockImplementationOnce(() => Promise.reject(new Error('offline')))
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(statusText()).toContain('NOT SAVED')
    expect(record()).toContain('Suyo Long')
    expect(screen.queryAllByTestId('voice-harvest-row')).toHaveLength(0)

    // THE RETRY. A failed write releases the cooldown (invalidateLastWrite), so saying "next" again
    // inside the 1500 ms window is a real retry rather than being swallowed as a transport duplicate.
    // Without that release, the user's only natural recovery is dead for longer than they will wait.
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(harvestPosts()).toHaveLength(2)
    expect(statusText()).toContain('Saved Suyo Long')
    vi.useRealTimers()
  })

  it('says so when nothing matched, instead of leaving the last crop selected', async () => {
    // THE SECOND HALF OF THIS TEST'S OWN NAME, which it did not previously assert. It checked the
    // banner and stopped, so "instead of leaving the last crop selected" described behaviour the
    // code did not have: the failed re-selection left Suyo Long in the Crop slot, and `say` then
    // overwrote the failure with the next message. See the end-to-end below for what that cost.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'rhubarb')
    expect(statusText()).toContain('Nothing matched')
    expect(statusText()).toContain('rhubarb')
    expect(record()).not.toContain('Suyo Long')
  })

  it('drops the crop when the name matched MANY, so an unpicked list cannot be saved against', async () => {
    // Same hole, other branch. An ambiguous name puts a list on screen and until one is tapped the
    // user has confirmed nothing — but the previous crop stayed selected behind the list.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'cucumber')
    expect(statusText()).toContain('2 match')
    expect(screen.getByTestId('voice-harvest-candidates')).toBeTruthy()
    expect(record()).not.toContain('Suyo Long')
  })

  it('a "next" after a failed re-selection refuses, instead of saving against the old crop', async () => {
    // THE HARM, end to end, and the reason this outranked everything else in the lane. Measured
    // sequence: the failure is announced ONCE and then buried under two successful-sounding
    // messages, and the row that lands names a plant he never confirmed — eyes-off, indistinguishable
    // from success. Identical in effect to the bare-number reselect this release already fixed,
    // reached by a completely different route.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'rhubarb')       // misheard crop — matches nothing
    await speak(rec, 'three count')   // banner overwrites the failure
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    expect(harvestPosts()).toHaveLength(0)
    expect(statusText()).toContain('Not saved')
    expect(statusText()).toContain('crop')
    vi.useRealTimers()
  })

  it('routes a near-miss of a command to "say it again", never to a different action', async () => {
    // "text" is a MEASURED 1-in-9 mishear of "next" on Dave's Android (2026-08-28 probe). The grammar
    // sends it to `unparsed` rather than letting it become a search, because a mishear that performs
    // a DIFFERENT action and looks like it worked is worse than one that does nothing.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'text')
    expect(statusText()).toContain('say "next" again')
    expect(harvestPosts()).toHaveLength(0)
    expect(record()).toContain('Suyo Long')
  })
})

describe('VoiceHarvest — the mic itself', () => {
  it('re-arms on its own after every utterance, with no further taps', async () => {
    const rec = await startListening()
    expect(rec.startCount).toBe(1)
    await act(async () => { rec.endSession() })
    expect(rec.startCount).toBe(2)
  })

  it('RELEASES the mic on unmount, handlers detached first', async () => {
    // The leak this pins is the one S1 fixed on the OTHER hook (useVoiceInput had no useEffect at
    // all, so a recogniser it started outlived the component). Leaving this route is the primary
    // escape hatch for the whole slice — "close it if it misbehaves" is only true if closing it
    // actually stops the mic. Handlers are detached BEFORE abort because a teardown can still
    // dispatch, and a final arriving after unmount would commit against nothing.
    const view = render(<VoiceHarvest />)
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
    const rec = mic.latest()
    expect(rec.started).toBe(true)

    await act(async () => { view.unmount() })
    expect(rec.started).toBe(false)
    expect(rec.onresult).toBeNull()
    expect(rec.onend).toBeNull()
    expect(rec.onerror).toBeNull()
  })

  it('stops listening on "done" without saving anything', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'done')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(statusText()).toContain('Stopped')
    expect(harvestPosts()).toHaveLength(0)
    vi.useRealTimers()
  })

  it('undo deletes the event and strikes the row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    await act(async () => { fireEvent.click(screen.getByLabelText(/Undo Suyo Long/)) })
    await waitFor(() => expect(
      apiFetchSpy.mock.calls.some(([u, o]) => u === `/api/events/${EVENT_ID}` && o?.method === 'DELETE'),
    ).toBe(true))
    expect(statusText()).toContain('Removed Suyo Long')
    vi.useRealTimers()
  })
})

// BUG-VOICENUMWORD-001 — the fold layer, in place, against the real names it exists for.
//
// Dave has nine live plantings whose names carry digits. Chrome dictates those digits as WORDS, so
// before this the chooser returned NOTHING for them and saying it again more clearly never helped —
// the recogniser was never wrong. These use his actual names, not invented ones, because the whole
// defect was that the grammar had only ever been checked against invented identifiers.
describe('BUG-VOICENUMWORD-001 — spoken number words reach a digit-named planting', () => {
  const DIGITS = [
    planting('d1', '1884', 'tomato'),
    planting('d2', 'Danvers 126 Carrot', 'carrot'),
    planting('d3', 'Clemson Spineless 80', 'okra'),
    planting('d4', 'Chinese 5-Color', 'pepper'),
  ]

  it.each([
    ['eighteen eighty four', 'd1'],
    ['danvers one twenty six', 'd2'],
    ['clemson spineless eighty', 'd3'],
    ['chinese five color', 'd4'],
  ])('resolves %j to the planting named with digits', (spoken, id) => {
    const { hits, rescued } = matchPlantingsWithRescue(DIGITS, spoken, null)
    expect(hits.map((h) => h.id)).toEqual([id])
    // Truthy so the caller QUOTES the heard text back. Dave said words and got digits; a fold that
    // announced itself as a clean match would hide the one step worth seeing.
    expect(rescued).toBe('folded')
  })

  it('does not disturb a phrase that already resolves', () => {
    // The strict matcher still answers first, so nothing that works today changes — including the
    // digit name TYPED or spoken as digits, which never needed folding.
    expect(matchPlantingsWithRescue(DIGITS, '1884', null))
      .toEqual({ hits: [DIGITS[0]], rescued: null })
    expect(matchPlantings(PLANTS, 'Suyo Long').map((p) => p.id)).toEqual(['p1'])
  })

  it('leaves a phrase with no number words byte-identical', () => {
    // Guards the early-out: a fold that changed nothing must not re-run the query or alter the shape.
    expect(matchPlantingsWithRescue(PLANTS, 'marketmore', null))
      .toEqual({ hits: [PLANTS[1]], rescued: null })
    expect(matchPlantingsWithRescue(DIGITS, 'rhubarb', null))
      .toEqual({ hits: [], rescued: null })
  })

  // LAYER ORDER, asserted from this side too. c2's voiceAliases suite owns the learned-beats-fuzzy
  // property; this pins the boundary the fold introduced between them, which neither suite covered.
  it('a human\'s taught alias still outranks the derived fold', () => {
    // The teach is deliberately WRONG — it claims "eighteen eighty four" means the carrot. It must
    // still win: aliases are user-scoped because two people's recognisers mishear differently, and a
    // universal rule must not silently overrule one person's correction of their own device.
    //
    // The key is DERIVED via looseKey, never hand-written — it collapses the doubled "e", so the
    // stored key is "eightenightyfour". A literal here inserts fine and matches nothing, which is a
    // silent pass: the fold would answer instead and the assertion would look like it had exercised
    // the learned layer. c2's suite documents hitting exactly this; the first draft of THIS test hit
    // it too and reported 'folded'.
    const aliasIdx = indexAliases([
      { heard_key: looseKey('eighteen eighty four'), variety_id: 'v-d2' },
    ])
    const { hits, rescued } = matchPlantingsWithRescue(DIGITS, 'eighteen eighty four', aliasIdx)
    expect(rescued).toBe('learned')
    expect(hits.map((h) => h.id)).toEqual(['d2'])
  })
})

// ── BUG-VOICECOUNTSPLIT-001 — the count that arrives in two pieces ────────────────────────────────
//
// Dave, 2026-08-31: "sometimes it hears it, and sometimes it doesn't, and it's not clear why."
// The words were never the problem — voiceHarvestGrammar.test.js pins that "three count" and
// "fifteen counts" both parse. What varies is whether Chrome ends the recogniser session BETWEEN the
// number and the unit. `speak()` ends a session after every utterance, which is exactly that shape,
// so these tests reproduce the defect rather than approximate it.
describe('BUG-VOICECOUNTSPLIT-001 — a value split across two utterances', () => {
  it('rejoins "three" + "count" into the quantity that was actually spoken', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    await speak(rec, 'count')
    expect(record()).toContain('3 count')
  })

  it('announces the rejoin instead of passing it off as a clean parse', async () => {
    // Same rule as a fuzzy rescue: the app ASSEMBLED this value, so it says so and Dave can correct
    // it before "next" rather than after the row is written.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    await speak(rec, 'count')
    expect(statusText()).toContain('two parts')
  })

  it('saves the rejoined value — the split path reaches a real row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'fifteen')
    await speak(rec, 'counts')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    const posts = harvestPosts()
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0][1].body).harvest).toMatchObject({ quantity: 15, unit: 'count' })
    vi.useRealTimers()
  })

  it('rejoins onto the WEIGHT axis too, by unit vocabulary and not by field order', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, '231')
    await speak(rec, 'grams')
    expect(record()).toContain('231 g')
  })

  // THE DANGEROUS HALF, and the reason this is a bug rather than an annoyance. Measured against
  // Dave's real 239 live plantings: the search branch is substring-permissive, so a stray "two"
  // selects *Brentwood* Leaf Lettuce and "four" Marvel of *Four* Seasons. The count is lost AND the
  // chosen plant is silently replaced, so the following "next" writes a harvest he never named.
  it('a bare number no longer reselects a planting whose NAME merely contains it', async () => {
    const DECOYS = [...PLANTS, planting('p7', 'Brentwood Leaf Lettuce', 'lettuce')]
    apiFetchSpy.mockImplementation((url) => {
      if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: DECOYS })
      return Promise.resolve({ eventId: 'evt-1' })
    })
    // Non-vacuity: the decoy IS reachable by substring, so this test would fail without the fix.
    expect(matchPlantings(DECOYS, 'two').map((p) => p.id)).toEqual(['p7'])

    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'two')
    expect(record()).toContain('Suyo Long')
    expect(record()).not.toContain('Brentwood')
  })

  it('shows a held number as UNFINISHED, never as a filled quantity', async () => {
    // A bare number rendered as "2" would look exactly like a complete slot, which is the
    // looks-complete-but-isn't failure the record card exists to prevent.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'two')
    expect(record()).toContain('needs a unit')
    expect(statusText()).toContain('now say the unit')
  })

  it('refuses to save a held number that never got its unit', async () => {
    // The honest outcome. A number with no unit is exactly the shape of a silent wrong save, so it
    // is never applied on its own — saveRecord reports the gap out loud instead.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    expect(harvestPosts()).toHaveLength(0)
    expect(statusText()).toContain('Not saved')
    expect(statusText()).toContain('quantity')
    vi.useRealTimers()
  })

  it('a second number replaces the first — that is a correction, not a pair', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    await speak(rec, 'fifteen')
    await speak(rec, 'count')
    expect(record()).toContain('15 count')
    expect(record()).not.toContain('3 count')
  })

  it('does not hold a number before a planting is chosen — a bare number still searches', async () => {
    // The gate that makes suppressing the search safe. Before a plant is selected a number can
    // legitimately be a search term; only after one is chosen can it only be an amount.
    const rec = await startListening()
    await speak(rec, 'three')
    expect(record()).not.toContain('needs a unit')
    expect(statusText()).toContain('Nothing matched')
  })

  it('drops the held number when the record is cleared, so it cannot bleed into the next crop', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    await speak(rec, 'clear')
    await speak(rec, 'Marketmore')
    await speak(rec, 'count')
    // The "count" finds no held number and is refused, rather than attaching Suyo Long's 3 to
    // Marketmore.
    expect(record()).not.toContain('3 count')
    expect(statusText()).toContain("Didn't catch that")
  })

  it('leaves a COMPLETE phrase entirely alone — the change is additive', async () => {
    // Non-vacuity for the whole slice: the pairing must be unreachable for an utterance classify()
    // already resolves, or it has started intercepting the path that works.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    expect(record()).toContain('3 count')
    expect(statusText()).not.toContain('two parts')
  })
})

// ── V5-VOICEONEBREATH-001 — the whole record in one sentence ──────────────────────────────────────
//
// Dave, 2026-08-31: "I don't know if I can just say, big boy, two count, fifteen grams really fast,
// and it'll pick it up. I haven't tried that yet." He could not: the sentence returned unparsed.
// The grammar offers candidate splits; these test the half that CHOOSES, which is the half that can
// commit a wrong harvest.
describe('V5-VOICEONEBREATH-001 — one sentence, whole record', () => {
  const NUMBERED = [
    planting('p1', 'Suyo Long', 'cucumber'),
    planting('n1', '1884', 'tomato'),
    planting('n2', 'Super Sweet 100', 'tomato'),
    planting('n3', 'Big Boy', 'tomato'),
  ]
  const useNumbered = () => {
    apiFetchSpy.mockImplementation((url) => {
      if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: NUMBERED })
      return Promise.resolve({ eventId: 'evt-1' })
    })
  }

  it('fills the whole record from one utterance', async () => {
    useNumbered()
    const rec = await startListening()
    await speak(rec, 'big boy two count fifteen grams')
    expect(record()).toContain('Big Boy')
    expect(record()).toContain('2 count')
    expect(record()).toContain('15 g')
  })

  it('saves that record — the sentence reaches a real row', async () => {
    useNumbered()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'big boy two count fifteen grams')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    const posts = harvestPosts()
    expect(posts).toHaveLength(1)
    const body = JSON.parse(posts[0][1].body)
    expect(body.plant_id).toBe('n3')
    expect(body.harvest).toMatchObject({ quantity: 2, unit: 'count', weight: 15, weight_unit: 'g' })
    vi.useRealTimers()
  })

  // THE CASE THE STRING CANNOT DECIDE. "eighteen eighty four two count" reads as 1884 + 2, or
  // 188 0 + 6, or 18 + 86 — the vocabulary is what rules out the last two, and getting this wrong
  // is BUG-VOICENUMSUM-001 re-entered through the one-breath door.
  it('lets the planting vocabulary pick the split for a number-NAMED crop', async () => {
    useNumbered()
    const rec = await startListening()
    await speak(rec, 'eighteen eighty four two count 165 grams')
    expect(record()).toContain('1884')
    expect(record()).toContain('2 count')     // NOT 6, NOT 86
    expect(record()).toContain('165 g')
  })

  it('prefers the EXACT name over a reading that merely matches part of it', async () => {
    // Both "super sweet one hundred" (exact, count 3) and "super sweet one" (substring of the same
    // planting, count 103) resolve to one hit. Without the exactness tiebreak this correct sentence
    // would be refused as ambiguous.
    useNumbered()
    const rec = await startListening()
    await speak(rec, 'super sweet one hundred three count')
    expect(record()).toContain('Super Sweet 100')
    expect(record()).toContain('3 count')
    expect(record()).not.toContain('103')
  })

  it('resolves the DIGIT form of the same sentence — "1884 two count"', async () => {
    // classify() still refuses this on its own (BUG-VOICENUMSUM-001 is untouched: parseNumber must
    // never sum a digit-literal name into the count, and its tests still pin 1886 as unreachable).
    // What changed is that the REFUSAL is no longer the end of the line — the vocabulary is asked,
    // and it says the name is 1884 and the count is 2.
    useNumbered()
    const rec = await startListening()
    await speak(rec, '1884 two count')
    expect(record()).toContain('1884')
    expect(record()).toContain('2 count')
    expect(record()).not.toContain('1886')
  })

  it('refuses a sentence whose name half matches nothing, and says how to recover', async () => {
    useNumbered()
    const rec = await startListening()
    await speak(rec, 'rhubarb two count fifteen grams')
    expect(record()).not.toContain('2 count')
    expect(statusText()).toContain("Didn't catch that")
    expect(statusText()).toContain('separately')
  })

  it('clears the previous record when the sentence names a DIFFERENT planting', async () => {
    // Otherwise a weight spoken for the previous crop survives onto this one and the record looks
    // complete while being wrong.
    useNumbered()
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, '900 grams')
    await speak(rec, 'big boy two count')
    expect(record()).toContain('Big Boy')
    expect(record()).toContain('2 count')
    expect(record()).not.toContain('900')
  })

  it('leaves the three-utterance flow exactly as it was', async () => {
    // Non-vacuity for the whole slice: this hooks only `unparsed`, so the path Dave uses today must
    // be untouched. If this reddens, the one-breath reader has started intercepting working speech.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, '231 grams')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    const posts = harvestPosts()
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0][1].body).harvest).toMatchObject({ quantity: 3, unit: 'count', weight: 231 })
    vi.useRealTimers()
  })

  it('resolveOneBreath refuses when two equally-exact readings disagree', async () => {
    // The tie the tiebreak cannot break. Two plantings named so that both splits are exact means no
    // reading is chosen — a wrong harvest committed silently is worse than one more utterance.
    const TWINS = [planting('t1', 'Two', 'lettuce'), planting('t2', 'Two Count Three', 'lettuce')]
    const cands = [
      { name: 'two count three', values: [{ kind: 'quantity', value: 4, unit: 'count' }] },
      { name: 'two', values: [{ kind: 'quantity', value: 9, unit: 'count' }] },
    ]
    expect(resolveOneBreath(TWINS, cands)).toBeNull()
  })
})

// ── BUG-VOICEFAILSILENT-001 — the channel that reaches him when he is not looking ─────────────────
//
// Dave, verbatim: "I DON'T JUST MISS IT COMPLETELY AND BELIEVE IT WAS FINE. A SILENT FAIL IS A LOST
// LOG." The page already announces every outcome on a banner. These pin the two places where the
// banner was the ONLY channel and the hand was told either nothing or the wrong thing — which is the
// same as being told nothing, since he is holding a cucumber and looking at the bed.
describe('BUG-VOICEFAILSILENT-001 — mic death and an uncertain match reach the hand', () => {
  const cues = () => [
    haptics.hapticSaveFailed, haptics.hapticMatchUncertain,
    haptics.hapticDigitAccepted, haptics.hapticDigitRejected,
  ]
  beforeEach(() => { for (const c of cues()) c.mockClear() })

  it.each([['not-allowed'], ['service-not-allowed'], ['audio-capture']])(
    'buzzes the failure cue when the mic dies with %j, not just a banner', async (code) => {
      // HIGHEST LOSS PER OCCURRENCE in the whole flow: capture is over, and until he happens to look
      // down every further utterance is gone. It was signalled on the one channel he is not using.
      const rec = await startListening()
      await act(async () => { rec.deliverError(code) })
      expect(haptics.hapticSaveFailed).toHaveBeenCalled()
      expect(statusText().length).toBeGreaterThan(0)
    })

  it('stays silent on a no-speech error, which is ordinary and re-arms', async () => {
    // Non-vacuity for the pair above. If the cue fired on every onerror it would fire constantly in a
    // continuous session and mean nothing by the second bed.
    const rec = await startListening()
    await act(async () => { rec.deliverError('no-speech') })
    expect(haptics.hapticSaveFailed).not.toHaveBeenCalled()
  })

  it('buzzes when the mic cannot restart itself — the dead-but-looks-live case', async () => {
    // The re-arm is what makes this page hands-free. When it throws, hands-free is over; the banner
    // says so and now so does the motor.
    const rec = await startListening()
    rec.start = () => { throw new Error('InvalidStateError') }
    await act(async () => { rec.endSession() })
    expect(haptics.hapticSaveFailed).toHaveBeenCalled()
    expect(statusText()).toContain('could not restart')
  })

  it('a GUESSED match feels different from a match the matcher was sure of', async () => {
    // The false-success class. This branch auto-selects on one hit whether the strict matcher
    // answered or a rescue scored its way there — the banner says which, the hand could not, and a
    // rescue onto the wrong plant then took the following "next" with it.
    const DIGITS = [planting('p1', 'Suyo Long', 'cucumber'), planting('d1', '1884', 'tomato')]
    apiFetchSpy.mockImplementation((url) => (String(url).startsWith('/api/plants')
      ? Promise.resolve({ plants: DIGITS })
      : Promise.resolve(createdEvent())))
    const rec = await startListening()

    await speak(rec, 'Suyo Long')                 // strict — the matcher was sure
    expect(haptics.hapticDigitAccepted).toHaveBeenCalled()
    expect(haptics.hapticMatchUncertain).not.toHaveBeenCalled()

    for (const c of cues()) c.mockClear()
    await speak(rec, 'eighteen eighty four')      // rescued by the number-word fold
    expect(statusText()).toContain('Heard')
    expect(haptics.hapticMatchUncertain).toHaveBeenCalled()
    expect(haptics.hapticDigitAccepted).not.toHaveBeenCalled()
  })
})

// ── The residuals the dev-state recon measured on 1a22ae2 ────────────────────────────────────────
describe('BUG-VOICECOUNTSPLIT-001 residuals — a number that is a NAME, and a number that is lost', () => {
  // Dave's real digit-named planting, beside the real decoy that made the hold necessary: "two" is a
  // substring of *Brentwood*. One fixture, both directions, so a change that satisfies one and
  // breaks the other cannot pass.
  const MIXED = [
    planting('p1', 'Suyo Long', 'cucumber'),
    planting('d1', '1884', 'tomato'),
    planting('p7', 'Brentwood Leaf Lettuce', 'lettuce'),
  ]
  const useMixed = (plants = MIXED) => apiFetchSpy.mockImplementation((url) => (
    String(url).startsWith('/api/plants')
      ? Promise.resolve({ plants })
      : Promise.resolve(createdEvent())))

  it('switches to a planting whose WHOLE NAME is the number that was said', async () => {
    // Case C. Before this, "1884" while another crop was selected was held as a pending quantity, so
    // the digit route to that planting was unreachable while the word route still worked.
    useMixed()
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, '1884')
    expect(statusText()).toContain('now say the count or the weight')
    expect(record()).toContain('1884')
    expect(record()).not.toContain('Suyo Long')
    expect(record()).not.toContain('needs a unit')
  })

  it('still HOLDS a number that merely appears inside a name — the guard is not reopened', async () => {
    // The whole reason case C is a trade and not a free fix. Whole-key equality cannot be satisfied
    // by a proper substring, and this is that claim executed rather than argued.
    useMixed()
    expect(matchPlantings(MIXED, 'two').map((p) => p.id)).toEqual(['p7'])   // reachable by substring
    expect(namesAPlantingExactly(MIXED, 'two')).toBe(false)                 // but not by whole name
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'two')
    expect(record()).toContain('Suyo Long')
    expect(record()).not.toContain('Brentwood')
    expect(record()).toContain('needs a unit')
  })

  it('holds a number WORD even when a planting is named for it — the digit bound', async () => {
    // The second bound, and the one that costs nothing today: measured against the 239 live
    // plantings, zero number-word utterances key-match any alias. It exists so that a planting named
    // "Three" cannot put every spoken count one mishearing away from switching crops.
    const WORDY = [planting('p1', 'Suyo Long', 'cucumber'), planting('w1', 'Three', 'bean')]
    expect(namesAPlantingExactly(WORDY, 'three')).toBe(false)
    expect(namesAPlantingExactly(WORDY, '1884')).toBe(false)
    useMixed(WORDY)
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    expect(record()).toContain('Suyo Long')
    expect(record()).toContain('needs a unit')
  })

  it('takes a count against the planting it switched to — the fall-through lands somewhere usable', async () => {
    useMixed()
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, '1884')
    await speak(rec, 'two count')
    expect(record()).toContain('1884')
    expect(record()).toContain('2 count')
  })

  it('SAYS the held number it threw away when the next utterance changes the plant', async () => {
    // Case E. Dropping it is right — a value with no unit must never be applied — but dropping it
    // silently is the defect: he spoke a 3, nothing on screen ever admitted it was gone, and "next"
    // then refuses for a reason he has no way to connect to the utterance that caused it.
    useMixed()
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    await speak(rec, 'Brentwood')
    expect(record()).toContain('Brentwood')
    expect(statusText()).toContain('dropped 3')
    expect(record()).not.toContain('needs a unit')
  })

  it('says it on an utterance it did not understand either, where the loss is least explicable', async () => {
    useMixed()
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    await speak(rec, 'text')
    expect(statusText()).toContain("Didn't catch that")
    expect(statusText()).toContain('dropped 3')
  })

  it('says NOTHING about a drop when the number gets its unit — non-vacuity for the note', async () => {
    // If the note fired on the rejoin too it would be noise on the path that works, and it would no
    // longer distinguish a lost value from a captured one.
    useMixed()
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    await speak(rec, 'count')
    expect(record()).toContain('3 count')
    expect(statusText()).toContain('two parts')
    expect(statusText()).not.toContain('dropped')
  })
})

describe('the candidate list says how much of itself it is hiding', () => {
  // Dave logs by planting name, so this is not his path — but a crop-type utterance reaches 46 live
  // tomatoes and the card rendered eight of them with nothing admitting the other 38 existed, which
  // reads as "these are all of them". Ordering and ranking are deliberately untouched.
  const many = (n) => Array.from({ length: n }, (_, i) => planting(`t${i}`, `Tomato ${i}`, 'tomato'))

  it('counts the hits it did not render', async () => {
    const TOMATOES = many(12)
    apiFetchSpy.mockImplementation((url) => (String(url).startsWith('/api/plants')
      ? Promise.resolve({ plants: TOMATOES })
      : Promise.resolve(createdEvent())))
    const rec = await startListening()
    await speak(rec, 'tomato')

    const card = screen.getByTestId('voice-harvest-candidates')
    expect(card.querySelectorAll('button')).toHaveLength(CANDIDATE_LIMIT)
    expect(card.textContent).toContain(`showing ${CANDIDATE_LIMIT} of 12`)
  })

  it('says nothing about a cap when the whole list fits', async () => {
    const FEW = many(3)
    apiFetchSpy.mockImplementation((url) => (String(url).startsWith('/api/plants')
      ? Promise.resolve({ plants: FEW })
      : Promise.resolve(createdEvent())))
    const rec = await startListening()
    await speak(rec, 'tomato')

    const card = screen.getByTestId('voice-harvest-candidates')
    expect(card.querySelectorAll('button')).toHaveLength(3)
    expect(card.textContent).not.toContain('showing')
  })
})
