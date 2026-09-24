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
  // A failing assertion would otherwise leave fake timers installed for the next test.
  afterEach(() => { vi.useRealTimers() })

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

  // ── V5-VOICEVOCAB-001 — the unit is ASSUMED, not asked for ──────────────────────────────────────
  //
  // THESE TWO TESTS REPLACE, AND DELIBERATELY INVERT, the pair that pinned the old behaviour
  // ("shows a held number as UNFINISHED" / "refuses to save a held number that never got its unit").
  // They were correct characterisations of a decision Dave has since reversed — he does not want to
  // say "count" or "grams" — so they are rewritten to encode the NEW decision rather than deleted.
  // The safety property genuinely changed: a bare number IS now applied on its own. What replaces
  // "refuse the save" as the guard is "announce the inference", which the second test pins.
  it('no longer DEMANDS a unit — holding is now optional, not an instruction', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'two')
    expect(statusText()).not.toContain('now say the unit')
    expect(statusText()).toContain('carry on')
  })

  it('STILL rejoins when the unit arrives next — the split case that must not regress', async () => {
    // THE REGRESSION THIS PAIR EXISTS FOR. The first implementation applied the assumed unit the
    // instant the number arrived, which consumed "231" into the COUNT slot before its "grams" could
    // land — turning "231 grams" into 231 count. Chrome splits exactly this way constantly: in the
    // 2026-09-13 device trace EVERY weight arrived as "85" then "85 G". Assuming may only happen
    // when no unit ever comes.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, '231')
    await speak(rec, 'grams')
    expect(record()).toContain('231 g')
    expect(record()).not.toContain('231 count')
  })

  it('applies the held number with an assumed unit instead of dropping it', async () => {
    // The fixture leaves default_unit null, so the 'count' fallback is what is exercised here.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'two')
    await speak(rec, 'text')
    expect(record()).toContain('2 count')
    expect(statusText()).not.toContain('dropped 2')
  })

  it('SAYS the unit was assumed — the inference is never silent', async () => {
    // This is the guard that REPLACED "refuse the save". Dave spoke the number, not the unit, so the
    // unit is the app's inference; an unannounced inference is the fabricated-value class this page
    // was already bitten by once. If this assertion is removed to shorten the readback, the trade
    // Dave accepted (V5-VOICEVOCAB-001) stops holding.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'two')
    await speak(rec, 'text')
    expect(statusText()).toContain('2 count assumed')
  })

  it('saves without either unit word — crop, count, weight', async () => {
    // Dave's target phrasing with both unit words dropped. BUG-VOICETWOBARENUM-001: this test used to
    // assert only that "231" appeared somewhere in the POST — just as true of the WRONG row the page
    // actually wrote (231 count, no weight, the spoken 3 lost). It now pins the whole row.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    await speak(rec, '231')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    expect(harvestPosts()).toHaveLength(1)
    const body = JSON.parse(harvestPosts()[0][1].body)
    expect(body.harvest)
      .toEqual({ quantity: 3, unit: 'count', quality_rating: null, weight: 231, weight_unit: 'g' })
    expect(body.metadata).toEqual({ harvest_input_source: 'voice', assumed_units: ['count', 'g'] })
    vi.useRealTimers()
  })

  it('uses the variety default_unit when the crop type has one', async () => {
    const WITH_UNIT = [planting('p9', 'Green Magic', 'broccoli', 'head')]
    apiFetchSpy.mockImplementation((url) => {
      if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: WITH_UNIT })
      return Promise.resolve({ eventId: 'evt-1' })
    })
    const rec = await startListening()
    await speak(rec, 'Green Magic')
    await speak(rec, 'two')
    await speak(rec, 'text')
    expect(record()).toContain('2 head')
  })

  it('does NOT assume a unit before a planting is selected — the gate still holds', async () => {
    // Non-vacuity for the gate: with nothing selected a bare number must stay a SEARCH, because that
    // is the state where it may legitimately be a crop name. Dropping the unit words makes every
    // quantity a bare number, so this gate is what stops that widening the search branch.
    const rec = await startListening()
    await speak(rec, 'two')
    expect(record()).not.toContain('2 count')
    expect(statusText()).not.toContain('assumed')
  })

  // BUG-VOICETWOBARENUM-001 — THIS PAIR REPLACES, AND INVERTS, "a second number replaces the first —
  // that is a correction, not a pair" (ae83521, 2026-08-31). That test encoded the decision of its day:
  // a bare number could not become an amount without its unit, so "three" then "fifteen" could only be
  // a self-correction. Dave's V5-VOICEVOCAB-001 directive (2026-09-13: "assume the unit and assume
  // grams, so 'planting 2 165' replaces 'planting 2 count 165 grams'") replaced it — two bare numbers
  // are now the count and the weight — and the replace rule then saved his own example as 165 count
  // with no weight. The old sequence ended in "count", which is why it stayed green through that
  // defect: what it really pinned was the CORRECTION case, and the second test keeps that protection.
  it('a second bare number is the WEIGHT, not a correction — "planting 2 165"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    await speak(rec, 'fifteen')
    expect(record()).toContain('3 count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    expect(harvestPosts()).toHaveLength(1)
    expect(JSON.parse(harvestPosts()[0][1].body).harvest)
      .toEqual({ quantity: 3, unit: 'count', quality_rating: null, weight: 15, weight_unit: 'g' })
  })

  it('a correction said WITH its unit still replaces the count — what the old test protected', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    await speak(rec, 'fifteen')
    await speak(rec, 'count')
    expect(record()).toContain('15 count')
    expect(record()).not.toContain('3 count')
    expect(record()).toContain('Weight—')
  })

  it('does not hold a number before a planting is chosen — a bare number still searches', async () => {
    // The gate that makes suppressing the search safe. Before a plant is selected a number can
    // legitimately be a search term; only after one is chosen can it only be an amount.
    const rec = await startListening()
    await speak(rec, 'three')
    expect(record()).not.toContain('assumed unless you say a unit')
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
    expect(record()).not.toContain('assumed unless you say a unit')
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
    expect(record()).toContain('Quantity2 count (assumed unless you say a unit)')
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
    expect(record()).toContain('Quantity3 count (assumed unless you say a unit)')
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
    expect(record()).not.toContain('assumed unless you say a unit')
  })

  it('APPLIES the held number on an utterance it did not understand — no longer a loss', async () => {
    // INVERTED by V5-VOICEVOCAB-001, and the inversion is the point. This case used to be "the loss
    // is least explicable": an unrecognised utterance threw away a number Dave had spoken, and the
    // fix of the day was to at least SAY so. Now the record is still standing, so the number is
    // applied with an assumed unit instead of being lost at all — which is what BUG-VOICEFAILSILENT-001
    // actually wanted. The announcement survives; only its content changed from a loss to an
    // inference. Contrast the sibling test above, where a SEARCH changes the crop and dropping is
    // still correct.
    useMixed()
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three')
    await speak(rec, 'text')
    expect(statusText()).toContain("Didn't catch that")
    expect(statusText()).not.toContain('dropped 3')
    expect(statusText()).toContain('3 count assumed')
    expect(record()).toContain('3 count')
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

// ── BUG-VOICEHELDREPEAT-001 — a held number that comes back WITH its unit ─────────────────────────
//
// The device shape, from the 2026-09-16 real-page trace: "87" landed as a final, the settle tick
// committed it as held-number 517 ms later, and 551 ms after the number the SAME session re-delivered
// the whole phrase at the next result index — as "87 grounds". Chrome returned grams as "G" five times
// in six in that run, so the same timing with "87 G" is the ordinary case. The debouncer cannot
// supersede a final it has already committed, so the page receives one spoken phrase as two
// utterances, and the second one resolved the hold by SLOT ORDER: 87 count assumed, then 87 g.
describe('BUG-VOICEHELDREPEAT-001 — a held number restated with its unit is that number', () => {
  // The failing cases leave fake timers installed when an assertion throws; restoring here keeps a red
  // run from bleeding into the next test and muddying which one actually failed.
  afterEach(() => { vi.useRealTimers() })

  // A bare number committed by the SETTLE TICK, with no session end. `speak()` cannot produce this:
  // it flushes at the boundary, and the boundary never falls between Chrome's cumulative finals.
  async function holdByTick(rec, text) {
    await act(async () => { rec.deliverFinal(text) })
    await act(async () => { await vi.advanceTimersByTimeAsync(551) })
  }

  it('the device shape: "87", the tick, then the same session\'s "87 G" is a weight and no count', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await holdByTick(rec, '87')
    // Precondition, so this cannot pass by never reaching the hold.
    expect(record()).toContain('Quantity87 count (assumed unless you say a unit)')

    await act(async () => { rec.deliverFinal('87 G') })   // next index, same session
    await act(async () => { rec.endSession() })
    expect(record()).toContain('87 g')
    expect(record()).toContain('Quantity—')
    expect(statusText()).not.toContain('assumed')

    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(harvestPosts(), 'no count was spoken, so none may be saved').toHaveLength(0)
    expect(statusText()).toContain('still need a quantity')
  })

  it('a restatement after a session boundary is the same number too — "87", then "87 grams"', async () => {
    // The banner under a held number says "say a unit to change it", and "87 grams" is how a person
    // says a unit for 87. Across a boundary it reached the same slot-order resolution.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, '87')
    await speak(rec, '87 grams')
    expect(record()).toContain('87 g')
    expect(record()).toContain('Quantity—')
    expect(statusText()).not.toContain('assumed')
  })

  it('the mirror image makes no phantom WEIGHT — count said, "5", then "5 count"', async () => {
    // With the count slot filled, slot order sends a held number to grams, so restating it as a
    // count wrote 5 g beside the corrected 5 count.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, '5')
    await speak(rec, '5 count')
    expect(record()).toContain('5 count')
    expect(record()).toContain('Weight—')
    expect(statusText()).not.toContain('assumed')
  })

  it('a DIFFERENT value with its unit still resolves the hold by slot order', async () => {
    // Non-vacuity for the equality: V5-VOICEVOCAB-001's inference must survive for a number that is
    // not being restated, or "3" then "231 grams" would lose the count Dave said.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, '3')
    await speak(rec, '231 grams')
    expect(record()).toContain('3 count')
    expect(record()).toContain('231 g')
    expect(statusText()).toContain('3 count assumed')
  })
})

// ── BUG-VOICEVALPAIRNOSEL-001 — a count and a weight said BEFORE the crop ─────────────────────────
//
// Device, 2026-09-16 real-page trace +27268: "4 count 4 G" with nothing selected came back "Didn't
// catch that", while "four count" alone moments earlier was applied with nothing selected and survived
// into the saved Cucamelon row. Same values, same moment — the pair lost its weight and the single kept
// its count, so Dave had to say the weight again after the crop.
describe('BUG-VOICEVALPAIRNOSEL-001 — a count and weight said before the crop', () => {
  afterEach(() => { vi.useRealTimers() })

  it('keeps the pair, and "next" saves both once the crop is chosen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'three count 231 G')
    await speak(rec, 'Suyo Long')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    const posts = harvestPosts()
    expect(posts).toHaveLength(1)
    const body = JSON.parse(posts[0][1].body)
    expect(body.plant_id).toBe('p1')
    expect(body.harvest).toMatchObject({ quantity: 3, unit: 'count', weight: 231, weight_unit: 'g' })
  })

  it('reads the device transcript "4 count 4 G" instead of refusing it', async () => {
    const rec = await startListening()
    await speak(rec, '4 count 4 G')
    expect(record()).toContain('4 count')
    expect(record()).toContain('4 g')
    expect(statusText()).not.toContain("Didn't catch that")
  })

  it('a pair with a trailing "next" and no crop keeps the values and still refuses the save', async () => {
    // The other door to the same reader (the head of a trailing-command split), and the safety half:
    // values arriving early must not become a save without a crop. "next" stays the only go-ahead.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'three count 231 G next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(harvestPosts()).toHaveLength(0)
    expect(statusText()).toContain('still need a crop')
    expect(record()).toContain('3 count')
    expect(record()).toContain('231 g')

    await speak(rec, 'Suyo Long')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(harvestPosts()).toHaveLength(1)
    expect(JSON.parse(harvestPosts()[0][1].body).harvest)
      .toMatchObject({ quantity: 3, unit: 'count', weight: 231, weight_unit: 'g' })
  })
})

// ── V5-VOICEVOCAB-001 — the saved row says which unit was ASSUMED ─────────────────────────────────
//
// The no-unit path shipped, and the ledger still needs device confirmation that Dave's real harvests
// use it. The only evidence source was the localStorage debug trace he had to switch on and copy by
// hand, because an assumed unit and a spoken one produced byte-identical rows. metadata.assumed_units
// makes every ordinary voice harvest a data point, and these pin what it has to mean: the units THIS
// record's values got by inference — no more (a unit he then says is spoken) and no longer (a new
// record starts clean). A marker that over- or under-counts would confirm the wrong thing.
describe('V5-VOICEVOCAB-001 — the saved row records which unit was assumed', () => {
  afterEach(() => { vi.useRealTimers() })

  // Speak each line, then let the write tick land. 2000 ms rather than the 1200 used above so a
  // second record's "next" clears the 1500 ms write cooldown the first one armed.
  // QA F8 — exact rows, like the D3/D4 blocks: quality_rating and any stray key are pinned, and so is the
  // planting the row was written against.
  const H = (quantity, unit, weight) => (weight == null
    ? { quantity, unit, quality_rating: null }
    : { quantity, unit, quality_rating: null, weight, weight_unit: 'g' })

  async function saveAfter(rec, ...lines) {
    for (const line of lines) await speak(rec, line)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    return harvestPosts().map(([, opts]) => JSON.parse(opts.body))
  }

  it('(a) no unit words at all: both units recorded as assumed, quantity first', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    // "text" (the measured mishear of "next") is unparsed, so it resolves the held 3 by slot order
    // without touching the crop; "next" then resolves the held 231 onto the weight axis and saves.
    const [body] = await saveAfter(rec, 'Suyo Long', 'three', 'text', '231', 'next')
    expect(body.plant_id).toBe('p1')
    expect(body.harvest).toEqual(H(3, 'count', 231))
    expect(body.metadata).toEqual({ harvest_input_source: 'voice', assumed_units: ['count', 'g'] })
  })

  it('(a) a bare count followed by a weight WITH its unit marks only the count', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long', 'three', '231 grams', 'next')
    expect(body.plant_id).toBe('p1')
    expect(body.harvest).toEqual(H(3, 'count', 231))
    expect(body.metadata.assumed_units).toEqual(['count'])
  })

  it('(a) a bare weight after a spoken count marks only the weight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long', 'three count', '231', 'next')
    expect(body.plant_id).toBe('p1')
    expect(body.harvest).toEqual(H(3, 'count', 231))
    expect(body.metadata.assumed_units).toEqual(['g'])
  })

  it('(a) records the unit it actually assumed — the crop type default, not a fixed "count"', async () => {
    // The per-unit count is the measurement, so a marker that always said "count" would be wrong for
    // every crop that has a default_unit.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiFetchSpy.mockImplementation((url) => (String(url).startsWith('/api/plants')
      ? Promise.resolve({ plants: [planting('p9', 'Green Magic', 'broccoli', 'head')] })
      : Promise.resolve(createdEvent())))
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Green Magic', 'two', '150 grams', 'next')
    expect(body.plant_id).toBe('p9')
    expect(body.harvest).toEqual(H(2, 'head', 150))
    expect(body.metadata.assumed_units).toEqual(['head'])
  })

  it('(b) both units spoken: the key is still sent, and empty', async () => {
    // Present-and-empty, not absent, so a row WITHOUT the key can only be a bundle that predates it.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long', 'three count', '231 grams', 'next')
    expect(body.plant_id).toBe('p1')
    expect(body.harvest).toEqual(H(3, 'count', 231))
    expect(body.metadata).toEqual({ harvest_input_source: 'voice', assumed_units: [] })
  })

  it('(b) the one-breath path is spoken too — empty', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long three count 231 grams next')
    expect(body.plant_id).toBe('p1')
    expect(body.harvest).toEqual(H(3, 'count', 231))
    expect(body.metadata.assumed_units).toEqual([])
  })

  it('(c) "85" then "85 G" — a number restated with its unit is not assumed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long', 'three count', '85', '85 G', 'next')
    expect(body.plant_id).toBe('p1')
    expect(body.harvest).toEqual(H(3, 'count', 85))
    expect(body.metadata.assumed_units).toEqual([])
  })

  it('(c) a unit that WAS assumed and is then said out loud is no longer assumed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    for (const line of ['Suyo Long', 'three', 'text', '85', 'text']) await speak(rec, line)
    // Precondition, so this cannot pass by never assuming anything: both slots were inferred.
    expect(statusText()).toContain('85 g assumed')
    expect(record()).toContain('3 count')
    const [body] = await saveAfter(rec, 'three count', '85 G', 'next')
    expect(body.plant_id).toBe('p1')
    expect(body.harvest).toEqual(H(3, 'count', 85))
    expect(body.metadata.assumed_units).toEqual([])
  })

  it('(d) does not carry into the next record after a save', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [first] = await saveAfter(rec, 'Suyo Long', 'three', '231 grams', 'next')
    expect(first.plant_id).toBe('p1')
    expect(first.harvest).toEqual(H(3, 'count', 231))
    expect(first.metadata.assumed_units).toEqual(['count'])
    const [, second] = await saveAfter(rec, 'Marketmore', 'two count', '100 grams', 'next')
    expect(second.plant_id).toBe('p2')
    expect(second.harvest).toEqual(H(2, 'count', 100))
    expect(second.metadata.assumed_units).toEqual([])
  })

  it('(d) does not carry into the next record after "clear"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    for (const line of ['Suyo Long', 'three', 'text', 'clear']) await speak(rec, line)
    const [body] = await saveAfter(rec, 'Marketmore', 'two count', '100 grams', 'next')
    expect(body.plant_id).toBe('p2')
    expect(body.harvest).toEqual(H(2, 'count', 100))
    expect(body.metadata.assumed_units).toEqual([])
  })
})

// ── BUG-VOICETWOBARENUM-001 — two bare numbers are a count and a weight ───────────────────────────
//
// Dave's V5-VOICEVOCAB-001 directive (2026-09-13), in the ledger's words: "assume the unit and assume
// grams, so 'planting 2 165' replaces 'planting 2 count 165 grams'". e142054 shipped the assumed unit
// and described the rule for a second bare number — "the held one was the count; apply it, hold the
// new one" — but the hold branch answered first and simply re-held, so that exact phrase saved 165
// count and no weight, and the save banner never said a unit had been assumed. Reproduced through
// this page on 15db68c before the fix. These pin the rule as the directive states it, what fills the
// slot when one amount was already said, what happens to a number with no slot left, and that every
// assumption is said at the save as well as before it.
describe('BUG-VOICETWOBARENUM-001 — two bare numbers are a count and a weight', () => {
  afterEach(() => { vi.useRealTimers() })

  async function saveAfter(rec, ...lines) {
    for (const line of lines) await speak(rec, line)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    return harvestPosts().map(([, opts]) => JSON.parse(opts.body))
  }
  const misses = () => screen.queryAllByTestId('voice-harvest-miss').map((m) => m.textContent)
  const ledgerHead = () => screen.getByTestId('voice-harvest-ledger').firstChild.textContent
  const NO_SLOT = (n) => `Dropped ${n} — no unit was said, and the quantity and weight were already filled.`

  it('Dave\'s own example: "planting 2 165" then "next" posts 2 count and 165 g, both assumed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const posts = await saveAfter(rec, 'Suyo Long', '2', '165', 'next')
    expect(posts).toHaveLength(1)
    expect(posts[0].plant_id).toBe('p1')
    expect(posts[0].harvest)
      .toEqual({ quantity: 2, unit: 'count', quality_rating: null, weight: 165, weight_unit: 'g' })
    expect(posts[0].metadata).toEqual({ harvest_input_source: 'voice', assumed_units: ['count', 'g'] })
  })

  it('the count already said: the first bare number is the weight; the second has no slot and is dropped, out loud', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    for (const line of ['Suyo Long', 'three count', '231', '85']) await speak(rec, line)
    // Said while he can still act on it, not only in the miss row after the save.
    expect(statusText()).toContain('85 — the quantity and weight are both filled')
    expect(statusText()).toContain('(231 g assumed)')
    const [body] = await saveAfter(rec, 'next')
    expect(body.harvest)
      .toEqual({ quantity: 3, unit: 'count', quality_rating: null, weight: 231, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual(['g'])
    expect(misses()).toEqual([NO_SLOT(85)])
    expect(ledgerHead()).toBe('1 saved · 1 not captured')
  })

  it('the weight already said: the first bare number is the count', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long', '231 grams', '3', '5', 'next')
    expect(body.harvest)
      .toEqual({ quantity: 3, unit: 'count', quality_rating: null, weight: 231, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual(['count'])
    expect(misses()).toEqual([NO_SLOT(5)])
  })

  it('a THIRD bare number is dropped and said — never guessed onto a filled slot', async () => {
    // "2, 165, 7" does not say whether the 7 corrects the count or the weight. Either guess can write
    // a value he never meant over one he did; dropping it cannot, and it is said on the banner and the
    // hand the moment it lands, then kept in the miss row.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    for (const line of ['Suyo Long', '2', '165']) await speak(rec, line)
    haptics.hapticDigitAccepted.mockClear(); haptics.hapticDigitRejected.mockClear()
    await speak(rec, '7')
    expect(statusText()).toContain('7 — the quantity and weight are both filled')
    expect(statusText()).toContain('or it will be dropped')
    expect(haptics.hapticDigitRejected).toHaveBeenCalled()
    expect(haptics.hapticDigitAccepted).not.toHaveBeenCalled()
    const [body] = await saveAfter(rec, 'next')
    expect(body.harvest)
      .toEqual({ quantity: 2, unit: 'count', quality_rating: null, weight: 165, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual(['count', 'g'])
    expect(misses()).toEqual([NO_SLOT(7)])
  })

  it('a bare number after BOTH units were spoken no longer overwrites the spoken weight', async () => {
    // Before the fix the resolution site sent any held number to grams once the count was filled,
    // whether or not a weight was already there: this saved 3 count and 85 g, the spoken 231 g gone.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long', 'three count', '231 grams', '85', 'next')
    expect(body.harvest)
      .toEqual({ quantity: 3, unit: 'count', quality_rating: null, weight: 231, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual([])
    expect(misses()).toEqual([NO_SLOT(85)])
  })

  it('"say it with a unit to replace one" is true — a third number with its unit replaces that slot', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long', '2', '165', '7', 'count', 'next')
    expect(body.harvest)
      .toEqual({ quantity: 7, unit: 'count', quality_rating: null, weight: 165, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual(['g'])
    expect(misses()).toEqual([])
  })

  it('the second number still rejoins a unit that follows it — "165" then "grams" is spoken', async () => {
    // The reason the number is HELD at all (Chrome splits "165 grams" into two sessions); the second
    // bare number must keep that, or the pair would consume it before its unit could land.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long', '2', '165', 'grams', 'next')
    expect(body.harvest)
      .toEqual({ quantity: 2, unit: 'count', quality_rating: null, weight: 165, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual(['count'])
  })

  it('the second number restated with its unit is that number — "165" then "165 G"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long', '2', '165', '165 G', 'next')
    expect(body.harvest)
      .toEqual({ quantity: 2, unit: 'count', quality_rating: null, weight: 165, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual(['count'])
  })

  it('the SAME bare number twice is one number — a re-delivered final is not a count and a weight', async () => {
    // BUG-VOICEHELDREPEAT-001's equality rule, for the bare form. A duplicate final that crosses a
    // session boundary reaches the page as a second utterance; pairing it would save 85 count AND 85 g
    // from one spoken number.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long', '85', '85', 'next')
    expect(body.harvest).toEqual({ quantity: 85, unit: 'count', quality_rating: null })
    expect(body.metadata.assumed_units).toEqual(['count'])
  })

  it('a search still drops the number being HELD — the second one — and says so', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '2', '165', 'Marketmore']) await speak(rec, line)
    expect(statusText()).toContain('dropped 165')
    // BUG-VOICECROPSWITCHKEEPSAMOUNTS-001 — and the 2 already placed for Suyo Long goes with the crop.
    expect(misses()).toEqual([
      'Dropped 165 — no unit was said, and the crop changed before one was.',
      'Cleared 2 count for Suyo Long — the crop changed to Marketmore before it was saved.',
    ])
  })

  it('"next" that resolves the held number SAYS which units were assumed — banner and row', async () => {
    // The save used to overwrite the "(165 g assumed)" note in the same utterance, before it was ever
    // shown: "Saved Suyo Long — 165 count · no weight was said" read exactly like a spoken count.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await saveAfter(rec, 'Suyo Long', '2', '165', 'next')
    expect(statusText()).toBe('Saved Suyo Long — 2 count · 165 g (2 count assumed, 165 g assumed)')
    // The row is the durable half — the banner is overwritten by the next utterance, and the row is
    // what he reads when he corrects a guess later.
    expect(screen.getByTestId('voice-harvest-row').textContent).toContain('(2 count assumed, 165 g assumed)')
  })

  it('a weightless save names its assumed count as well as the missing weight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await saveAfter(rec, 'Suyo Long', '3', 'next')
    expect(statusText()).toBe('Saved Suyo Long — 3 count · no weight was said (3 count assumed)')
  })

  it('says nothing is assumed when both units were spoken — non-vacuity for the note', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await saveAfter(rec, 'Suyo Long', 'three count', '231 grams', 'next')
    expect(statusText()).toBe('Saved Suyo Long — 3 count · 231 g')
    expect(screen.getByTestId('voice-harvest-row').textContent).not.toContain('assumed')
  })
})

// ── V5-VOICEVOCAB-001 (lane D4) — a held number goes to the slot the resolving utterance does NOT fill ─
//
// BUG-VOICETWOBARENUM-001's out-of-scope finding 3, reproduced through this page on cb32814: "231"
// then "3 count" assumed 231 COUNT and the quantity branch overwrote it with the spoken 3 in the same
// utterance — 231 lost, and the banner said "3 count (231 count assumed)" about an assumption that no
// longer existed. The same held on the weight axis, and for a one-breath sentence that named a
// different planting (the 5 was assumed onto the record that sentence then cleared).
describe('V5-VOICEVOCAB-001 — a held number is never assumed onto the slot the next utterance fills', () => {
  afterEach(() => { vi.useRealTimers() })

  async function saveAfter(rec, ...lines) {
    for (const line of lines) await speak(rec, line)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    return harvestPosts().map(([, opts]) => JSON.parse(opts.body))
  }
  const misses = () => screen.queryAllByTestId('voice-harvest-miss').map((m) => m.textContent)

  it('"231" then "3 count": the 231 is the WEIGHT, and the banner says so truthfully', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    for (const line of ['Suyo Long', '231', '3 count']) await speak(rec, line)
    expect(statusText()).toBe('3 count (231 g assumed)')
    const [body] = await saveAfter(rec, 'next')
    expect(body.harvest)
      .toEqual({ quantity: 3, unit: 'count', quality_rating: null, weight: 231, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual(['g'])
    expect(misses()).toEqual([])
  })

  it('the count already said and a weight said next: the held number has no slot — dropped and said, never written under the spoken weight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    for (const line of ['Suyo Long', 'three count', '231', '85 grams']) await speak(rec, line)
    expect(statusText()).toBe('85 g (dropped 231 — no unit was said)')
    const [body] = await saveAfter(rec, 'next')
    expect(body.harvest)
      .toEqual({ quantity: 3, unit: 'count', quality_rating: null, weight: 85, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual([])
    expect(misses()).toEqual(['Dropped 231 — no unit was said, and 85 g left no open slot for it.'])
  })

  it('an open slot is still used — "231" then "85 grams" with nothing else said is 231 count', async () => {
    // Non-vacuity for the rule above: excluding the axis the utterance fills must not become
    // "drop whenever a unit follows".
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long', '231', '85 grams', 'next')
    expect(body.harvest)
      .toEqual({ quantity: 231, unit: 'count', quality_rating: null, weight: 85, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual(['count'])
  })

  it('a one-breath sentence naming a DIFFERENT planting drops the held number — it belonged to the old crop', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    for (const line of ['Suyo Long', '5', 'Marketmore three count 231 grams']) await speak(rec, line)
    expect(statusText()).toBe('Marketmore — 3 count · 231 g (dropped 5 — no unit was said)')
    const [body] = await saveAfter(rec, 'next')
    expect(body.plant_id).toBe('p2')
    expect(body.harvest)
      .toEqual({ quantity: 3, unit: 'count', quality_rating: null, weight: 231, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual([])
    expect(misses()).toEqual(['Dropped 5 — no unit was said, and the crop changed before one was.'])
  })

  it('a one-breath sentence for the SAME planting fills its axis and the held number takes the other', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    const [body] = await saveAfter(rec, 'Suyo Long', '5', 'Suyo Long 231 grams', 'next')
    expect(body.plant_id).toBe('p1')
    expect(body.harvest)
      .toEqual({ quantity: 5, unit: 'count', quality_rating: null, weight: 231, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual(['count'])
  })

  it('a nameless count-and-weight pair fills both slots — the held number is dropped and said', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    for (const line of ['Suyo Long', '5', 'three count 231 grams']) await speak(rec, line)
    expect(statusText()).toBe('3 count · 231 g (dropped 5 — no unit was said)')
    const [body] = await saveAfter(rec, 'next')
    expect(body.harvest)
      .toEqual({ quantity: 3, unit: 'count', quality_rating: null, weight: 231, weight_unit: 'g' })
    expect(body.metadata.assumed_units).toEqual([])
    expect(misses()).toEqual(['Dropped 5 — no unit was said, and 3 count · 231 g left no open slot for it.'])
  })
})

// ── BUG-VOICEREFUSEDNEXT-001 — a REFUSED "next" gives the write cooldown back ──────────────────────
//
// Pre-existing, found by lane D4 (V5-VOICEVOCAB-001) and measured before the fix: "Suyo Long", "next"
// (refused — no quantity yet), "3 count", "next" inside 1.5 s. The refusal's release ran inside the
// debouncer's commit handler, before the debouncer armed the cooldown, so it released nothing; the
// second "next" was then swallowed as a transport duplicate, NOTHING was saved, and the banner said
// "Heard "next" twice in a moment — saved once." — a false success on a lost log. The pair below pins
// both directions: the refused claim is given back, and a real save's claim is not.
describe('BUG-VOICEREFUSEDNEXT-001 — a refused "next" does not swallow the next one', () => {
  afterEach(() => { vi.useRealTimers() })
  const bodies = () => harvestPosts().map(([, opts]) => JSON.parse(opts.body))

  it('the measured sequence: the second "next" SAVES the 3 count, and nothing claims "saved once"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'next')
    // The refused write commits on its settle tick; the next "next" lands ~600 ms after it — inside
    // the 1500 ms cooldown, which is the whole point of the case.
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(statusText()).toBe('Not saved — still need a quantity. Say it, then "next".')
    await speak(rec, '3 count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(bodies()).toHaveLength(1)
    expect(bodies()[0].plant_id).toBe('p1')
    expect(bodies()[0].harvest).toEqual({ quantity: 3, unit: 'count', quality_rating: null })
    expect(statusText()).toBe('Saved Suyo Long — 3 count · no weight was said')
    expect(statusText()).not.toContain('saved once')
  })

  it('the duplicate guard still holds after a REAL save: a second "next" inside 1.5 s is suppressed, and that message is now true', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, '3 count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(bodies()).toHaveLength(1)
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(bodies()).toHaveLength(1)
    expect(statusText()).toBe('Heard "next" twice in a moment — saved once.')
  })

  it('…and a re-delivered one-breath final after a real save still saves ONCE — where the guard stops a double row', async () => {
    // After a plain save the record is cleared, so an unsuppressed duplicate "next" would only be
    // refused. A duplicated one-breath final re-fills the record before its "next", so only the
    // cooldown stands between it and a second harvest row.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long three count next')
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(bodies()).toHaveLength(1)
    await speak(rec, 'Suyo Long three count next')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(bodies()).toHaveLength(1)
    expect(statusText()).toBe('Heard "next" twice in a moment — saved once.')
  })
})
