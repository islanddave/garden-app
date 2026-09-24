// V5-VOICEVOCAB-001 (lane D4) — one breath, no units, against Dave's REAL planting names.
//
// Dave's directive (2026-09-13): "assume the unit and assume grams, so 'planting 2 165' replaces
// 'planting 2 count 165 grams'". BUG-VOICETWOBARENUM-001 made that work when Chrome delivers the parts
// as separate finals. These pin the same sentence delivered as ONE final — which is how his own example
// reads — and the hazard that makes it hard: thirteen of the 244 live plantings carry a digit or a
// number word in some alias, so a number next to a name can belong to either side. The rule under test,
// in one line: a one-breath final is read exactly as its parts would be read as separate finals, and it
// is REFUSED when the split into parts is not unique.
//
// The page-level cases drive the real page through the shared fake recogniser, as the rest of the
// VoiceHarvest suite does, and assert on the POSTed body: a card that looks right is not a row that is.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/haptics.js', () => ({
  hapticSaveCommitted: vi.fn(), hapticSaveFailed: vi.fn(),
  hapticDigitAccepted: vi.fn(), hapticDigitRejected: vi.fn(), hapticUndoApplied: vi.fn(),
  hapticMatchUncertain: vi.fn(),
}))
import * as haptics from '../lib/haptics.js'

import VoiceHarvest, {
  resolveOneBreath, resolveBareOneBreath, plantingOwnsNumbers, plantingsNamedExactly, digitRuns,
  aliasVarietyOf, indexAliasNames,
} from '../pages/VoiceHarvest.jsx'
import { segmentCandidates, oneBreathReadings, foldNumberWords } from '../lib/voiceHarvestGrammar.js'
import { indexAliases } from '../lib/voiceAliases.js'
import { looseKey } from '../lib/comboboxInput.js'
import { VOCAB, byName } from './voiceHarvest.vocabulary.fixture.js'

// Review BLOCKING-2 — DAVE'S TAUGHT ALIASES, served the way GET /api/varieties/voice-aliases serves them
// (lambda/varieties/index.js: heard_key, heard_text, variety_id, hit_count, last_used_at). Every page
// test in this file runs with them loaded: the first review's harness served an empty list, and so
// did every VoiceHarvest test, which is how "cucumber one" (his, prod voice_alias, taught 2026-09-15)
// came to be read as the crop plus an amount of 1. His list has 33 rows; the two with a number are
// the first two here. "damn i'll see you" is his too (voiceCareResolve.test.js); "studio long" is the
// mishearing the alias suite teaches.
const aliasRow = (heard, plantingName) => ({
  heard_key: looseKey(heard), heard_text: heard, variety_id: byName(plantingName).variety_ref.id,
  hit_count: 0, last_used_at: null,
})
const DAVE_ALIASES = [
  aliasRow('cucumber one', 'Suyo Long'),
  aliasRow('super sweet 100', 'Super Sweet 100'),
  aliasRow("damn i'll see you", 'Cucamelon'),
  aliasRow('studio long', 'Suyo Long'),
]

// The small garden the older VoiceHarvest tests use — two cucumbers, so "cucumber" alone is a
// question — for the cases that are about the flow rather than the vocabulary.
const planting = (id, name, slug, unit = null) => ({
  id, name, archived_at: null,
  variety_ref: { id: `v-${id}`, name: `${name} cultivar`, crop_type_slug: slug, default_unit: unit },
})
const PLANTS = [planting('p1', 'Suyo Long', 'cucumber'), planting('p2', 'Marketmore', 'cucumber')]

let mic
let plantsNow = PLANTS
let aliasesNow = DAVE_ALIASES
beforeEach(() => {
  // Call history is per TEST: restoreAllMocks (afterEach) does not clear a vi.fn's calls, so without
  // this a haptic assertion would see every cue fired by the tests before it.
  vi.clearAllMocks()
  mic = installFakeSpeechRecognition(vi)
  plantsNow = PLANTS
  aliasesNow = DAVE_ALIASES
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url, opts) => {
    if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: plantsNow })
    if (url === '/api/varieties/voice-aliases' && !opts?.method) return Promise.resolve({ aliases: aliasesNow })
    return Promise.resolve({ id: 'evt-1' })
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

async function startListening(plants = PLANTS) {
  plantsNow = plants
  vi.useFakeTimers({ shouldAdvanceTime: true })
  render(<VoiceHarvest />)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/varieties/voice-aliases'))
  await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
  return mic.latest()
}
// One final, settled: data commits at the session end, a write waits out the settle window.
async function speak(rec, text) {
  await act(async () => { rec.deliverFinal(text) })
  await act(async () => { rec.endSession() })
}
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(2000) }) }
const posts = () => apiFetchSpy.mock.calls
  .filter(([url, opts]) => url === '/api/events' && opts?.method === 'POST')
  .map(([, opts]) => JSON.parse(opts.body))
const statusText = () => screen.getByTestId('voice-harvest-status').textContent
const record = () => screen.getByTestId('voice-harvest-record').textContent
const misses = () => screen.queryAllByTestId('voice-harvest-miss').map((m) => m.textContent)
const H = (quantity, unit, weight) => (weight == null
  ? { quantity, unit, quality_rating: null }
  : { quantity, unit, quality_rating: null, weight, weight_unit: 'g' })
const SPLIT = "Didn't catch that — the name and the numbers could be split more than one way — say the planting, then the amounts."

// ── the unit-bearing one-breath reader: a number is never a name by substring ──────────────────────
//
// Measured on cb32814 with this fixture: "Suyo Long", "2 165 grams" SWITCHED the crop to Danvers 126
// Carrot (segmentCandidates offers the name "2"; the strict layer is character substring, and "2" is
// inside "126"). "4 …" went to 1884, "5 …" to Chinese 5-Color, "6 …" to Danvers. And "cucumber 3 231
// grams" kept 231 g on Suyo Long while the 3 disappeared into the name through the fuzzy layer.
describe('resolveOneBreath — the name half may keep only numbers the planting owns', () => {
  const reading = (s) => {
    const r = resolveOneBreath(VOCAB, segmentCandidates(s))
    return r && { planting: r.planting.name, values: r.values.map((v) => `${v.value} ${v.unit}`) }
  }

  it.each([
    '2 165 grams', '4 231 grams', '5 231 grams', '6 231 grams', '12 100 grams', '80 100 grams', '126 90 grams',
  ])('%j offers a bare number as a name — no planting may be chosen by a digit substring', (s) => {
    expect(reading(s)).toBeNull()
  })

  it.each([
    ['cucumber 3 231 grams'], ['suyo long 2 165 grams'], ['danvers 12 165 grams'], ['studio long 2 165 grams'],
  ])('%j — an amount is never swallowed into the name', (s) => {
    expect(reading(s)).toBeNull()
  })

  // The bounds must not cost a digit-named planting its own name — every census row still resolves.
  it.each([
    ['1884 two count', '1884', ['2 count']],
    ['eighteen eighty four two count 165 grams', '1884', ['2 count', '165 g']],
    ['danvers 126 3 count', 'Danvers 126 Carrot', ['3 count']],
    ['danvers one twenty six 3 count', 'Danvers 126 Carrot', ['3 count']],
    ['cherry rescue 1 3 count', 'Cherry Rescue 1', ['3 count']],
    ['cherry rescue one 3 count', 'Cherry Rescue 1', ['3 count']],
    ['clemson spineless 80 3 count', 'Clemson Spineless 80', ['3 count']],
    ['clemson spineless eighty 3 count', 'Clemson Spineless 80', ['3 count']],
    ['chinese 5 color 3 count', 'Chinese 5-Color', ['3 count']],
    ['chinese five color 3 count', 'Chinese 5-Color', ['3 count']],
    ['marvel of four seasons 3 count', 'Marvel of Four Seasons Butterhead Lettuce', ['3 count']],
    ['alaska mix nasturtium 1 3 count', 'Alaska Mix Nasturtium 1', ['3 count']],
    ['fairway orange coleus clone 1 3 count', 'Fairway Orange Coleus Clone 1', ['3 count']],
    ['super sweet 100 rescue 3 count', 'Super Sweet 100 Rescue', ['3 count']],
    ['armageddon f1 3 count', 'Armageddon', ['3 count']],
    ['peach tree 3 count', 'Peach tree', ['3 count']],
    ['1884 165 grams', '1884', ['165 g']],
  ])('%j still resolves to %s', (s, planting, values) => {
    expect(reading(s)).toEqual({ planting, values })
  })

  it('"super sweet 100" is two plantings (they share the variety name) — refused, as before', () => {
    expect(reading('super sweet 100 3 count')).toBeNull()
  })

  it('digit runs compare WHOLE — the helper the rule rests on', () => {
    expect(digitRuns('Danvers 126 Carrot')).toEqual(['126'])
    expect(digitRuns('Chinese 5-Color')).toEqual(['5'])
    expect(digitRuns('Megatron F1 (jumbo jalapeno)')).toEqual(['1'])
    expect(digitRuns('marvel of four seasons')).toEqual(['4'])
    expect(plantingOwnsNumbers(byName('Danvers 126 Carrot'), 'danvers 126')).toBe(true)
    expect(plantingOwnsNumbers(byName('Danvers 126 Carrot'), 'danvers 12')).toBe(false)
    expect(plantingOwnsNumbers(byName('Suyo Long'), 'suyo long 2')).toBe(false)
    expect(plantingOwnsNumbers(byName('Marvel of Four Seasons Butterhead Lettuce'), 'marvel of four seasons four'))
      .toBe(false)   // counted with multiplicity: the name has one 4
    expect(plantingsNamedExactly(VOCAB, '2').map((p) => p.name)).toEqual([])
    expect(plantingsNamedExactly(VOCAB, 'eighteen eighty four').map((p) => p.name)).toEqual(['1884'])
  })
})

// ── the page: Dave's example in ONE final, and the shapes around it ────────────────────────────────
describe('V5-VOICEVOCAB-001 — "planting 2 165" said in one breath', () => {
  it('"Suyo Long 2 165 next" saves 2 count and 165 g, both assumed, and says so', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long 2 165 next')
    await settle()
    const [body] = posts()
    expect(posts()).toHaveLength(1)
    expect(body.plant_id).toBe('p1')
    expect(body.harvest).toEqual(H(2, 'count', 165))
    expect(body.metadata).toEqual({ harvest_input_source: 'voice', assumed_units: ['count', 'g'] })
    expect(statusText()).toBe('Saved Suyo Long — 2 count · 165 g (2 count assumed, 165 g assumed)')
    expect(misses()).toEqual([])
  })

  it('"165 next" as one final resolves the held 2 and saves — finding 1', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '2', '165 next']) await speak(rec, line)
    await settle()
    expect(posts().map((b) => b.harvest)).toEqual([H(2, 'count', 165)])
    expect(posts()[0].metadata.assumed_units).toEqual(['count', 'g'])
  })

  it('"165 next" with nothing held saves 165 count and says no weight was said', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '165 next']) await speak(rec, line)
    await settle()
    expect(posts().map((b) => b.harvest)).toEqual([H(165, 'count')])
    expect(statusText()).toBe('Saved Suyo Long — 165 count · no weight was said (165 count assumed)')
  })

  it('"2 165" as one final is the count and the weight, the crop stays — finding 2', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '2 165']) await speak(rec, line)
    expect(statusText()).toBe('165 — say a unit to change it, or carry on. (2 count assumed)')
    expect(record()).toContain('Suyo Long')
    expect(record()).toContain('2 count')
    await speak(rec, 'next')
    await settle()
    expect(posts().map((b) => b.harvest)).toEqual([H(2, 'count', 165)])
  })

  it('the name read back in front when there is no save word, and a unit said next still rejoins', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long 2 165')
    expect(statusText()).toBe('Suyo Long — 165 — say a unit to change it, or carry on. (2 count assumed)')
    for (const line of ['grams', 'next']) await speak(rec, line)
    await settle()
    expect(posts().map((b) => b.harvest)).toEqual([H(2, 'count', 165)])
    expect(posts()[0].metadata.assumed_units).toEqual(['count'])   // 165 g was SAID, in two parts
  })

  it('a misheard save word keeps the amounts and refuses the save — "2 165 text"', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    haptics.hapticDigitRejected.mockClear()
    await speak(rec, '2 165 text')
    await settle()
    expect(posts()).toEqual([])
    expect(statusText()).toBe('Kept that. Didn\'t catch the last word — say "next" again.')
    // QA F5 — the refused save word is felt as well as read.
    expect(haptics.hapticDigitRejected).toHaveBeenCalledTimes(1)
    await speak(rec, 'next')
    await settle()
    expect(posts().map((b) => b.harvest)).toEqual([H(2, 'count', 165)])
  })

  it('a number word pair is never summed — "ten five" is refused, the crop kept, nothing saved', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', 'ten five', 'next']) await speak(rec, line)
    await settle()
    expect(posts()).toEqual([])
    expect(record()).toContain('Suyo Long')
    expect(misses()).toContain("Didn't catch that — heard “ten five”.")
  })

  it('"three two hundred thirty one" is not 531 — refused the same way', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', 'three two hundred thirty one']) await speak(rec, line)
    expect(statusText()).toBe("Didn't catch that — two numbers ran together — say them with a pause, or with their units.")
    expect(record()).toContain('Suyo Long')
    expect(record()).not.toContain('531')
  })

  it('three amounts in one breath are refused in place — the crop stays', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '2 165 7']) await speak(rec, line)
    expect(statusText()).toBe("Didn't catch that — more amounts than one record holds — say the count and the weight again.")
    expect(record()).toContain('Suyo Long')
    expect(record()).not.toContain('2 count')
  })

  it('before a crop is chosen "2 165 next" is still a search — the gate holds', async () => {
    const rec = await startListening()
    await speak(rec, '2 165 next')
    await settle()
    expect(posts()).toEqual([])
    expect(statusText()).toContain('Nothing matched')
  })

  it('a declined one-breath "next" does not swallow the real "next" that follows', async () => {
    // The trailing save word claims the one-write cooldown when the final commits; a final that did
    // not write must give the claim back, or this "next" is dropped as a duplicate ("saved once").
    const rec = await startListening()
    for (const line of ['2 165 next', 'Suyo Long', '165', 'next']) await speak(rec, line)
    await settle()
    expect(posts().map((b) => b.harvest)).toEqual([H(165, 'count')])
    expect(statusText()).not.toContain('saved once')
  })

  it('a REFUSED one-breath "next" gives the cooldown back too — the real "next" after it saves', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '3 count', 'ten five next', 'next']) await speak(rec, line)
    await settle()
    expect(posts().map((b) => b.harvest)).toEqual([H(3, 'count')])
    expect(statusText()).not.toContain('saved once')
  })

  it('a re-delivered one-breath final saves ONCE — the cooldown covers the new shape', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long 2 165 next', 'Suyo Long 2 165 next']) await speak(rec, line)
    await settle()
    expect(posts()).toHaveLength(1)
    expect(statusText()).toBe('Heard "next" twice in a moment — saved once.')
  })

  it('a DIFFERENT planting starts a new record: the held number is dropped and said', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '5', 'Marketmore 2 165 next']) await speak(rec, line)
    await settle()
    expect(posts().map((b) => [b.plant_id, b.harvest])).toEqual([['p2', H(2, 'count', 165)]])
    expect(misses()).toEqual(['Dropped 5 — no unit was said, and the crop changed before one was.'])
  })

  it('the SAME planting said again with both amounts restates the record; a number it left out is said', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '5', 'Suyo Long 2 165 next']) await speak(rec, line)
    await settle()
    expect(posts().map((b) => b.harvest)).toEqual([H(2, 'count', 165)])
    expect(misses()).toEqual(['Dropped 5 — no unit was said, and the record was said again without it.'])
  })

  it('"cucumber 3 231 grams next" with two cucumbers is a question, not a guess — listed, not saved', async () => {
    const rec = await startListening()
    await speak(rec, 'cucumber 3 231 grams next')
    await settle()
    expect(posts()).toEqual([])
    expect(statusText()).toBe('2 match “cucumber” — tap one, then say the amounts again.')
    expect(screen.getByTestId('voice-harvest-candidates').textContent).toContain('Marketmore')
    expect(misses()).toEqual(['Not kept — “cucumber 3 231 grams next”: “cucumber” matches 2 plantings.'])
  })

  it('leaves the unit-bearing one-breath exactly as it was', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long three count 231 grams next')
    await settle()
    expect(posts().map((b) => [b.harvest, b.metadata.assumed_units])).toEqual([[H(3, 'count', 231), []]])
    expect(statusText()).toBe('Saved Suyo Long — 3 count · 231 g')
  })
})

// ── the page against the 244 REAL names ─────────────────────────────────────────────────────────────
describe('V5-VOICEVOCAB-001 — one breath against the real planting names', () => {
  const idOf = (name) => byName(name).id
  const nameOfId = (id) => VOCAB.find((p) => p.id === id)?.name

  it.each([
    ['suyo long 2 165 next', 'Suyo Long', H(2, 'count', 165), ['count', 'g']],
    ['cucumber 3 231 grams next', 'Suyo Long', H(3, 'count', 231), ['count']],
    ['1884 2 165 next', '1884', H(2, 'count', 165), ['count', 'g']],
    ['eighteen eighty four 2 165 next', '1884', H(2, 'count', 165), ['count', 'g']],
    ['super sweet 100 rescue 3 200 next', 'Super Sweet 100 Rescue', H(3, 'count', 200), ['count', 'g']],
    ['danvers 126 3 200 next', 'Danvers 126 Carrot', H(3, 'count', 200), ['count', 'g']],
    ['danvers 3 200 next', 'Danvers 126 Carrot', H(3, 'count', 200), ['count', 'g']],
    ['cherry rescue 1 3 200 next', 'Cherry Rescue 1', H(3, 'count', 200), ['count', 'g']],
    ['cherry rescue one 3 200 next', 'Cherry Rescue 1', H(3, 'count', 200), ['count', 'g']],
    ['clemson spineless 80 3 200 next', 'Clemson Spineless 80', H(3, 'count', 200), ['count', 'g']],
    ['chinese five color 3 200 next', 'Chinese 5-Color', H(3, 'count', 200), ['count', 'g']],
    ['marvel of four seasons 3 200 next', 'Marvel of Four Seasons Butterhead Lettuce', H(3, 'count', 200), ['count', 'g']],
    ['peach tree 3 200 next', 'Peach tree', H(3, 'count', 200), ['count', 'g']],
  ])('%j saves to %s with only the spoken amounts', async (said, name, harvest, assumed) => {
    const rec = await startListening(VOCAB)
    await speak(rec, said)
    await settle()
    expect(posts().map((b) => [nameOfId(b.plant_id), b.harvest, b.metadata.assumed_units]))
      .toEqual([[name, harvest, assumed]])
    expect(posts()[0].plant_id).toBe(idOf(name))
  })

  // A number that could belong to the name OR be the first amount. Neither reading is guessed.
  it.each([
    ['danvers 126 200'], ['clemson 80 200'], ['cherry rescue 1 200'], ['chinese 5 200'], ['marvel 4 200'],
    ['peach tree 200'], ['suyo long to 165'], ['okra 80 200'],
  ])('%j is refused — the name and the numbers split more than one way', async (said) => {
    const rec = await startListening(VOCAB)
    for (const line of ['Suyo Long', '3 count']) await speak(rec, line)
    haptics.hapticDigitRejected.mockClear()
    await speak(rec, said)
    // QA F5 — the third channel: the refusal is felt, not only read.
    expect(haptics.hapticDigitRejected).toHaveBeenCalledTimes(1)
    await speak(rec, 'next')
    await settle()
    expect(posts()).toEqual([])
    // The sentence named a planting, so the record it could not read is not left standing behind the
    // refusal — neither the crop nor (QA F10) its amounts — and the "next" after it saves nothing.
    expect(misses()).toEqual([
      'Cleared 3 count for Suyo Long — the record was started over after a sentence that could not be read.',
      `Didn't catch that — heard “${said}”.`,
      'Not saved — still need a crop and a quantity.',
    ])
  })

  // DEFENSIVE, and said so: a homophone that is not the planting's own is caught for a name ENDING in
  // it by the alternative reading ("suyo long to 165" reads as "suyo long" + 2, 165 and disagrees).
  // Ownership is what still catches it when that alternative cannot be formed — here it would be three
  // amounts. Measured: with the ownership check removed this applied 7 and 165 to Suyo Long and the
  // "to" (the recogniser's "two") vanished into the name.
  it('"suyo long to 7 165" is refused — "to" may be a number, and it is not part of Suyo Long', () => {
    const d = resolveBareOneBreath(VOCAB, oneBreathReadings('suyo long to 7 165'))
    expect(d).toEqual({ kind: 'refuse', reason: 'ambiguous' })
  })

  it('"super sweet 100 3 200" is two plantings — both offered, nothing saved', async () => {
    const rec = await startListening(VOCAB)
    await speak(rec, 'super sweet 100 3 200')
    expect(statusText()).toBe('2 match “super sweet 100” — tap one, then say the amounts again.')
    const list = screen.getByTestId('voice-harvest-candidates').textContent
    expect(list).toContain('Super Sweet 100 Rescue')
    expect(misses()).toEqual(['Not kept — “super sweet 100 3 200”: “super sweet 100” matches 2 plantings.'])
  })

  it('"2 165 grams" no longer switches the crop to Danvers 126 Carrot — the bare 2 is the count', async () => {
    const rec = await startListening(VOCAB)
    for (const line of ['Suyo Long', '2 165 grams', 'next']) await speak(rec, line)
    await settle()
    expect(posts().map((b) => [nameOfId(b.plant_id), b.harvest, b.metadata.assumed_units]))
      .toEqual([['Suyo Long', H(2, 'count', 165), ['count']]])
  })

  it('a bare number that IS a planting name switches to it, as it does said alone — "1884 165"', async () => {
    const rec = await startListening(VOCAB)
    for (const line of ['Suyo Long', '1884 165', 'next']) await speak(rec, line)
    await settle()
    expect(posts().map((b) => [nameOfId(b.plant_id), b.harvest])).toEqual([['1884', H(165, 'count')]])
  })

  it('"tomato 1884 2 165 next" is not a name the matcher knows — a loud miss, no save', async () => {
    const rec = await startListening(VOCAB)
    await speak(rec, 'tomato 1884 2 165 next')
    await settle()
    expect(posts()).toEqual([])
    expect(statusText()).toContain('Nothing matched')
  })
})

// ── review BLOCKING-2: a name Dave TAUGHT is a name ─────────────────────────────────────────────────
//
// Measured by the regression seat at 4307524 with his real aliases loaded: 16 of 20 alias scripts saved
// differently from prod. "cucumber one", "3", "next" saved 1 count · 3 g (prod: 3 count); "cucumber one",
// "next" saved a 1 count he never said (prod: "still need a quantity"); "cucumber one three count 231
// grams next" saved nothing (prod: 3 count · 231 g). The expectations below are prod's POSTs for the same
// scripts (the seat's ALIAS set, re-measured on the prod replica for this round), except the two one-breath
// forms with no units, which prod cannot read at all and which save here what the same parts said as
// separate finals save.
describe('BLOCKING-2 — a name Dave taught is a name: his alias never splits into a crop and an amount', () => {
  const suyo = byName('Suyo Long')
  const idx = indexAliases(DAVE_ALIASES)
  const names = indexAliasNames(DAVE_ALIASES)
  const nameOfId = (id) => VOCAB.find((p) => p.id === id)?.name
  const saved = () => posts().map((b) => [nameOfId(b.plant_id), b.harvest, b.metadata.assumed_units ?? []])
  const bare = (said, selected = null, aliasNames = names) =>
    resolveBareOneBreath(VOCAB, oneBreathReadings(said), { selected, aliasIndex: idx, aliasNames })

  it('an alias is recognised whole — raw, or with number words folded either way', () => {
    expect(aliasVarietyOf(names, 'cucumber one')).toBe(suyo.variety_ref.id)
    expect(aliasVarietyOf(names, 'Cucumber One')).toBe(suyo.variety_ref.id)
    expect(aliasVarietyOf(names, 'cucumber 1')).toBe(suyo.variety_ref.id)   // Chrome's digit rendering
    expect(aliasVarietyOf(names, 'super sweet one hundred')).toBe(byName('Super Sweet 100').variety_ref.id)
    expect(aliasVarietyOf(names, 'cucumber')).toBeNull()
    expect(aliasVarietyOf(names, 'cucumber one 3')).toBeNull()
    expect(aliasVarietyOf(null, 'cucumber one')).toBeNull()
    // The search index alone — rows with no heard_text — still knows the raw key, not the folded one.
    expect(aliasVarietyOf(idx, 'cucumber one')).toBe(suyo.variety_ref.id)
    expect(aliasVarietyOf(idx, 'cucumber 1')).toBeNull()
    // Never under MIN_ALIAS_CHARS, which a folded key can fall below ("one two" folds to "12").
    const short = indexAliasNames([{ heard_key: looseKey('one two'), heard_text: 'one two', variety_id: 'v-x' }])
    expect(aliasVarietyOf(short, 'one two')).toBe('v-x')
    expect(aliasVarietyOf(short, '1 2')).toBeNull()
    // Taught in session: merged onto what was loaded, nothing lost.
    const more = indexAliasNames([{ heard_key: looseKey('wombat three'), heard_text: 'wombat three', variety_id: 'v-y' }], names)
    expect([aliasVarietyOf(more, 'wombat 3'), aliasVarietyOf(more, 'cucumber 1')]).toEqual(['v-y', suyo.variety_ref.id])
  })

  it('ownership — the whole alias owns its numbers, for its own variety only', () => {
    expect(plantingOwnsNumbers(suyo, 'cucumber one')).toBe(false)   // Suyo Long's own names carry no 1
    expect(plantingOwnsNumbers(suyo, 'cucumber one', names)).toBe(true)
    expect(plantingOwnsNumbers(suyo, 'cucumber 1', names)).toBe(true)
    expect(plantingOwnsNumbers(PLANTS[1], 'cucumber one', names)).toBe(false)   // a cucumber, another variety
    expect(plantingOwnsNumbers(byName('Big Boy'), 'cucumber one', names)).toBe(false)
    expect(plantingOwnsNumbers(suyo, 'suyo long one', names)).toBe(false)   // not the alias, said whole
  })

  it.each(['cucumber one', 'cucumber one next', 'Cucumber One', 'cucumber 1', 'cucumber 1 next'])(
    '%j is a name, not a record — not this reader\'s, with or without a crop chosen', (said) => {
      expect(bare(said)).toBeNull()
      expect(bare(said, suyo)).toBeNull()
    })

  it('without the alias the same words ARE a crop and an amount (MINOR-5) — the alias is the difference', () => {
    expect(resolveBareOneBreath(VOCAB, oneBreathReadings('cucumber one'))).toMatchObject({ kind: 'apply', groups: [{ value: 1 }] })
    expect(bare('cucumber one 3 count', null, null)).toMatchObject({ kind: 'apply', groups: [{ value: 1 }, { value: 3 }] })
  })

  // The head guard's own case — the one the reading guard cannot settle. Every NAMED reading of an alias
  // said whole is already caught (its name plus the words after it IS the alias), so the sentence would
  // fall through to the grammar's own verdict, and for words that read as a run of numbers that verdict
  // is a refusal. Synthetic alias: "cucumber one three" run together is "two numbers ran together".
  it('said whole, an alias is a name even where its words read as numbers run together', async () => {
    const rows = [aliasRow('cucumber one three', 'Suyo Long')]
    expect(resolveBareOneBreath(VOCAB, oneBreathReadings('cucumber one three'))).toEqual({ kind: 'refuse', reason: 'run' })
    expect(resolveBareOneBreath(VOCAB, oneBreathReadings('cucumber one three'),
      { aliasIndex: indexAliases(rows), aliasNames: indexAliasNames(rows) })).toBeNull()
    aliasesNow = rows
    const rec = await startListening(VOCAB)
    for (const line of ['cucumber one three', '3 count', 'next']) await speak(rec, line)
    await settle()
    expect(saved()).toEqual([['Suyo Long', H(3, 'count'), []]])
  })

  it('it is a name even when its variety has no live planting — the search answers for it, as on prod', () => {
    // The small garden has two cucumbers and neither is the alias's variety: split, "cucumber" + 1
    // would be a two-planting list; as a name it goes to the search, exactly as prod sends it.
    const opts = { aliasIndex: idx, aliasNames: names }
    expect(resolveBareOneBreath(PLANTS, oneBreathReadings('cucumber one'))).toMatchObject({ kind: 'refuse', reason: 'crowded' })
    expect(resolveBareOneBreath(PLANTS, oneBreathReadings('cucumber one'), opts)).toBeNull()
  })

  it.each([
    ['cucumber one 200', [200]], ['cucumber one 3 200', [3, 200]], ['cucumber 1 3 200', [3, 200]],
    ['cucumber one twenty 200', [20, 200]], ['cucumber one 3 200 next', [3, 200]],
  ])('%j keeps the alias whole as the name — only the amounts after it are amounts', (said, amounts) => {
    const d = bare(said)
    expect(d?.kind).toBe('apply')
    expect(d.planting.id).toBe(suyo.id)
    expect(d.groups.map((g) => g.value)).toEqual(amounts)
  })

  it('the unit reader: "cucumber one 3 count" is Suyo Long · 3 count, and the bare reader leaves it alone', () => {
    const unit = (said, aliasNames = names) => {
      const r = resolveOneBreath(VOCAB, segmentCandidates(said), idx, aliasNames)
      return r && [r.planting.name, r.values.map((v) => `${v.value} ${v.unit}`)]
    }
    expect(bare('cucumber one 3 count')).toBeNull()
    expect(unit('cucumber one 3 count')).toEqual(['Suyo Long', ['3 count']])
    expect(unit('cucumber one three count 231 grams')).toEqual(['Suyo Long', ['3 count', '231 g']])
    expect(unit('cucumber 1 3 count')).toEqual(['Suyo Long', ['3 count']])
    // Slice 3's ownership rule without the names: the alias's 1 is not Suyo Long's, so no reading.
    expect(unit('cucumber one 3 count', null)).toBeNull()
    // The search index alone still carries the raw key (the default for a caller that passes one map).
    expect(resolveOneBreath(VOCAB, segmentCandidates('cucumber one 3 count'), idx)?.planting.name).toBe('Suyo Long')
  })

  it('a number-only alias resolves by its key, second to a real name, like a number-only name', () => {
    const rows = [{ heard_key: looseKey('eighteen eighty five'), heard_text: 'eighteen eighty five', variety_id: byName('1884').variety_ref.id }]
    expect(plantingsNamedExactly(VOCAB, 'eighteen eighty five')).toEqual([])
    expect(plantingsNamedExactly(VOCAB, 'eighteen eighty five', indexAliasNames(rows)).map((p) => p.name)).toEqual(['1884'])
    expect(plantingsNamedExactly(VOCAB, '1884', indexAliasNames(rows)).map((p) => p.name)).toEqual(['1884'])
    const r = resolveOneBreath(VOCAB, segmentCandidates('eighteen eighty five two count'), indexAliases(rows), indexAliasNames(rows))
    expect(r && [r.planting.name, r.values.map((v) => `${v.value} ${v.unit}`)]).toEqual(['1884', ['2 count']])
    expect(resolveOneBreath(VOCAB, segmentCandidates('eighteen eighty five two count'), indexAliases(rows), null)).toBeNull()
    const d = resolveBareOneBreath(VOCAB, oneBreathReadings('eighteen eighty five 3 200'),
      { aliasIndex: indexAliases(rows), aliasNames: indexAliasNames(rows) })
    expect(d?.kind === 'apply' && [d.planting.name, d.groups.map((g) => g.value)]).toEqual(['1884', [3, 200]])
  })

  it('an alias for a variety with two plantings offers both, as a real name does', () => {
    // "celebrity two" (synthetic) → Celebrity, which is two plantings (Celebrity, Celebrity Rescue),
    // neither of whose own names carries a 2.
    const rows = [{ heard_key: looseKey('celebrity two'), heard_text: 'celebrity two', variety_id: byName('Celebrity').variety_ref.id }]
    const d = resolveBareOneBreath(VOCAB, oneBreathReadings('celebrity two 3 200'),
      { aliasIndex: indexAliases(rows), aliasNames: indexAliasNames(rows) })
    expect(d?.kind === 'refuse' && [d.reason, d.name, d.hits.map((p) => p.name)])
      .toEqual(['crowded', 'celebrity two', ['Celebrity', 'Celebrity Rescue']])
  })

  it('a taught alias owns its homophones too — "big boy to" (taught) is a name, not "big boy" + 2', () => {
    const rows = [{ heard_key: looseKey('big boy to'), heard_text: 'big boy to', variety_id: byName('Big Boy').variety_ref.id }]
    expect(resolveBareOneBreath(VOCAB, oneBreathReadings('big boy to 3 200'))).toEqual({ kind: 'refuse', reason: 'ambiguous' })
    const d = resolveBareOneBreath(VOCAB, oneBreathReadings('big boy to 3 200'),
      { aliasIndex: indexAliases(rows), aliasNames: indexAliasNames(rows) })
    expect(d?.kind).toBe('apply')
    expect([d.planting.name, d.groups.map((g) => g.value)]).toEqual(['Big Boy', [3, 200]])
  })

  // The seat's ALIAS set on the page, with prod's POSTs (see the header above).
  it.each([
    [['cucumber one', '3', 'next'], H(3, 'count'), ['count']],
    [['cucumber one', '3 count', 'next'], H(3, 'count'), []],
    [['cucumber one', 'three count', 'next'], H(3, 'count'), []],
    [['cucumber one 3 count next'], H(3, 'count'), []],
    [['cucumber one 3 count', 'next'], H(3, 'count'), []],
    [['Suyo Long', 'cucumber one 3 count next'], H(3, 'count'), []],
    [['cucumber one three count 231 grams next'], H(3, 'count', 231), []],
    [['cucumber one', '3 count', '231 grams', 'next'], H(3, 'count', 231), []],
    // BUG-VOICETWOBARENUM-001's pairing — prod keeps only the last number here (231 count), by design no more.
    [['cucumber one', 'three', '231', 'next'], H(3, 'count', 231), ['count', 'g']],
    // One breath, no units: prod reads nothing; this is what the same parts said separately save.
    [['cucumber one 3 200 next'], H(3, 'count', 200), ['count', 'g']],
    [['cucumber one 200 next'], H(200, 'count'), ['count']],
    // Chrome's digit rendering of the same alias.
    [['cucumber 1', '3', 'next'], H(3, 'count'), ['count']],
    [['cucumber 1 3 count next'], H(3, 'count'), []],
  ])('%j saves Suyo Long with only the spoken amounts', async (lines, harvest, assumed) => {
    const rec = await startListening(VOCAB)
    for (const line of lines) await speak(rec, line)
    await settle()
    expect(saved()).toEqual([['Suyo Long', harvest, assumed]])
  })

  it.each([[['cucumber one', 'next']], [['cucumber one', '231 grams', 'next']]])(
    '%j saves nothing — the alias names the crop, and no quantity was said (as on prod)', async (lines) => {
      const rec = await startListening(VOCAB)
      for (const line of lines) await speak(rec, line)
      await settle()
      expect(posts()).toEqual([])
      expect(statusText()).toBe('Not saved — still need a quantity. Say it, then "next".')
    })

  it('rows served without heard_text (the key alone) still make the alias a name', async () => {
    aliasesNow = DAVE_ALIASES.map(({ heard_text: _unused, ...row }) => row)
    const rec = await startListening(VOCAB)
    for (const line of ['cucumber one', '3', 'next']) await speak(rec, line)
    await settle()
    expect(saved()).toEqual([['Suyo Long', H(3, 'count'), ['count']]])
  })

  it('a name taught IN THIS SESSION is a name at once — its number is never an amount', async () => {
    const rec = await startListening(VOCAB)
    await speak(rec, 'zzqq three')
    const teach = screen.getByTestId('voice-harvest-teach')
    fireEvent.change(within(teach).getByLabelText('What did you mean by zzqq three'), { target: { value: 'suyo' } })
    await act(async () => { fireEvent.click(within(teach).getByRole('button', { name: /Suyo Long/ })) })
    const taught = apiFetchSpy.mock.calls.filter(([url, opts]) => url === '/api/varieties/voice-aliases' && opts?.method === 'POST')
    expect(taught.map(([, opts]) => JSON.parse(opts.body).heard_key)).toEqual([looseKey('zzqq three')])
    await speak(rec, 'zzqq three 3 count next')
    await settle()
    expect(saved()).toEqual([['Suyo Long', H(3, 'count'), []]])
  })
})

// ── THE CENSUS: every digit or number word in a real name, through every one-breath shape ─────────
//
// The brief's hard rule: a digit that belongs to a name must never become a quantity or weight, and
// a quantity must never be swallowed into a name. So every alias in the fixture that carries a digit
// or a number word is spoken as the name (as written, and with its digits said as words), followed by
// amounts that collide with no name (3, 200, 7), and — the adversarial half — followed by the name's
// OWN number as the first amount. An `apply` must land on that planting with exactly the spoken
// amounts; anything else must be a refusal or not this reader's. Never a value taken from the name.
describe('V5-VOICEVOCAB-001 — census: no digit of a real name lands in a value slot', () => {
  const NUMBER_WORD = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/
  const HOMOPHONE = /\b(to|too|for|fore|won|ate|tree)\b/
  const SPOKEN = {
    1: 'one', 4: 'four', 5: 'five', 80: 'eighty', 100: 'one hundred', 126: 'one twenty six', 1884: 'eighteen eighty four',
  }
  const aliasesOf = (p) => [p.name, p.variety_ref?.name, ...(p.crop_aliases ?? [])].filter(Boolean)
  const CENSUS = VOCAB.flatMap((p) => aliasesOf(p)
    .filter((a) => /\d/.test(a) || NUMBER_WORD.test(a.toLowerCase()) || HOMOPHONE.test(a.toLowerCase()))
    .map((alias) => ({ planting: p, alias })))

  it('covers the thirteen plantings the design census found, and knows how every digit is said', () => {
    expect(new Set(CENSUS.map((c) => c.planting.name)).size).toBe(13)
    for (const { alias } of CENSUS) {
      for (const d of digitRuns(alias)) expect(SPOKEN[d], `no spoken form for ${d} in "${alias}"`).toBeTruthy()
    }
  })

  const clean = (a) => a.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  const spokenForms = (alias) => {
    const written = clean(alias)
    // Whole digit tokens only — "f1" in Armageddon F1 is not said "f one".
    const words = written.split(' ').map((t) => (/^\d+$/.test(t) ? SPOKEN[t] : t)).join(' ')
    return [...new Set([written, words])]
  }
  const decide = (said, selected = null) => resolveBareOneBreath(VOCAB, oneBreathReadings(said), { selected })

  it('every spoken census name + amounts either lands on its own planting with exactly those amounts, or is refused', () => {
    const outcomes = []
    for (const { planting: p, alias } of CENSUS) {
      for (const name of spokenForms(alias)) {
        for (const [tail, amounts] of [['3 200', [3, 200]], ['3 200 next', [3, 200]], ['7', [7]]]) {
          const said = `${name} ${tail}`
          const d = decide(said)
          outcomes.push([said, d?.kind ?? 'not-mine', d?.planting?.name ?? null])
          if (d?.kind !== 'apply') continue
          expect(d.planting?.id, said).toBe(p.id)
          expect(d.groups.map((g) => g.value), said).toEqual(amounts)
        }
      }
    }
    // QA F7 — PINNED EXACTLY, not floored: the fixture is frozen, so any movement is a change in the
    // rules. Measured 2026-09-24 (lane D4) and independently by the QA seat: 105 sentences, 75 apply
    // and 30 refuse — the refusals are the names that end in their own number followed by ONE bare
    // amount ("cherry rescue 1 7"), and every Super Sweet 100 form (two plantings share that name).
    // A floor would let 15 applies turn silently into refusals.
    const kinds = outcomes.reduce((c, [, k]) => ({ ...c, [k]: (c[k] ?? 0) + 1 }), {})
    expect(kinds).toEqual({ apply: 75, refuse: 30 })
  })

  it("the name's OWN number as the first amount is never read as an amount", () => {
    const kinds = {}
    for (const { planting: p, alias } of CENSUS) {
      for (const d of digitRuns(alias)) {
        for (const name of spokenForms(alias)) {
          // The name cut just before its number, then the number, then a weight: "clemson spineless 80 200".
          const words = clean(alias).split(' ')
          const at = words.findIndex((w) => w === d || w === SPOKEN[d])
          if (at < 1) continue
          const cut = words.slice(0, at).join(' ')
          for (const said of [`${cut} ${d} 200`, `${cut} ${SPOKEN[d]} 200`, `${name} 200`]) {
            const r = decide(said)
            kinds[r?.kind ?? 'not-mine'] = (kinds[r?.kind ?? 'not-mine'] ?? 0) + 1
            if (r?.kind !== 'apply') continue
            // Allowed only as the name reading: the number stays in the name, 200 is the one amount.
            expect(r.groups.map((g) => g.value), `${said} → ${r.planting?.name}`).not.toContain(Number(d))
            expect(r.planting?.id, said).toBe(p.id)
          }
        }
      }
    }
    // QA F7 — the adversarial half is pinned too, or a loop that refused EVERYTHING would pass: 84
    // sentences, 69 refuse, 15 apply (each apply keeps the number in the name, checked above).
    expect(kinds).toEqual({ refuse: 69, apply: 15 })
  })

  it('with the census planting already selected, bare amounts attach to it and never re-select by digit', () => {
    for (const { planting: p } of CENSUS) {
      for (const [said, amounts] of [['3 200', [3, 200]], ['200 next', [200]], ['3 200 next', [3, 200]]]) {
        const d = decide(said, p)
        expect(d, `${p.name}: ${said}`).toMatchObject({ kind: 'apply', planting: null })
        expect(d.groups.map((g) => g.value)).toEqual(amounts)
      }
    }
  })

  // Review BLOCKING-2 — the census's own rule, for the names Dave TAUGHT: every served alias with a digit
  // or a number word, written, with digits said as words, and with number words as Chrome's digits.
  // Said alone it is a name; followed by amounts, an apply lands on that alias's variety with exactly the
  // spoken amounts, in the no-unit and in the unit form; anything else is a refusal or not the reader's.
  it("Dave's taught aliases: an alias's number never lands in a value slot", () => {
    const idx = indexAliases(DAVE_ALIASES)
    const names = indexAliasNames(DAVE_ALIASES)
    const TAUGHT = DAVE_ALIASES.filter((r) => /\d/.test(r.heard_text) || NUMBER_WORD.test(r.heard_text) || HOMOPHONE.test(r.heard_text))
    expect(TAUGHT.map((r) => r.heard_text)).toEqual(['cucumber one', 'super sweet 100'])
    const kinds = {}
    const tally = (k) => { kinds[k] = (kinds[k] ?? 0) + 1 }
    for (const row of TAUGHT) {
      const ofVariety = VOCAB.filter((p) => p.variety_ref?.id === row.variety_id).map((p) => p.id)
      for (const form of new Set([...spokenForms(row.heard_text), foldNumberWords(row.heard_text)])) {
        for (const said of [form, `${form} next`]) {
          expect(resolveBareOneBreath(VOCAB, oneBreathReadings(said), { aliasIndex: idx, aliasNames: names }), said).toBeNull()
          tally('name')
        }
        for (const [tail, amounts] of [['3 200', [3, 200]], ['3 200 next', [3, 200]], ['7', [7]], ['200', [200]], ['200 next', [200]]]) {
          const said = `${form} ${tail}`
          const d = resolveBareOneBreath(VOCAB, oneBreathReadings(said), { aliasIndex: idx, aliasNames: names })
          tally(d ? (d.kind === 'refuse' ? `refuse ${d.reason}` : d.kind) : 'not-mine')
          if (d?.kind !== 'apply') continue
          expect(ofVariety, said).toContain(d.planting?.id)
          expect(d.groups.map((g) => g.value), said).toEqual(amounts)
        }
        for (const [tail, values] of [['3 count', ['3 count']], ['three count 231 grams', ['3 count', '231 g']]]) {
          const said = `${form} ${tail}`
          const r = resolveOneBreath(VOCAB, segmentCandidates(said), idx, names)
          tally(r ? 'unit-apply' : 'unit-none')
          if (!r) continue
          expect(ofVariety, said).toContain(r.planting.id)
          expect(r.values.map((v) => `${v.value} ${v.unit}`), said).toEqual(values)
        }
      }
    }
    // Pinned exactly, as the census above is: 4 forms. Every "cucumber one"/"cucumber 1" sentence applies
    // to Suyo Long with its amounts (10 no-unit, 4 unit); every Super Sweet 100 form is two plantings —
    // offered as a list (10) or, in the unit form, not read (4).
    expect(kinds).toEqual({ name: 8, apply: 10, 'refuse crowded': 10, 'unit-apply': 4, 'unit-none': 4 })
  })

  it('a bare digit that sits INSIDE a name never selects that planting in one breath', () => {
    // "2" is in Danvers 1*2*6, "8" in 1884 and 80, "5" in Chinese 5-Color, "12" in 126: none of these
    // is a planting's whole name, so none may pick a crop.
    // 80 and 126 are WHOLE digit runs of Clemson Spineless 80 and Danvers 126 Carrot, so ownership
    // alone would admit them — only the number-only-name rule (exact equality) keeps them out.
    for (const n of [1, 2, 4, 5, 6, 8, 12, 18, 26, 80, 84, 88, 126]) {
      for (const said of [`${n} 200`, `${n} 200 next`, `${n} 165 grams`]) {
        const d = decide(said)
        expect(d?.kind === 'apply' ? d.planting?.name : null, said).toBeNull()
      }
    }
  })
})

// Two readings that are each valid on their own and disagree — no clash, no homophone, no crowd:
// only the agreement rule stands between this sentence and a guess.
describe('V5-VOICEVOCAB-001 — two valid readings that disagree are refused', () => {
  const TWO = [
    { id: 'a', name: 'Alpha', archived_at: null, variety_ref: { id: 'va', name: 'Alpha', crop_type_slug: 'bean' } },
    { id: 'a7', name: 'Alpha 7', archived_at: null, variety_ref: { id: 'va7', name: 'Alpha 7', crop_type_slug: 'bean' } },
  ]
  it('"alpha 7 200": Alpha with 7 and 200, or Alpha 7 with 200 — neither is chosen', () => {
    const info = oneBreathReadings('alpha 7 200')
    expect(info.readings.map((r) => r.name)).toEqual(['alpha', 'alpha 7'])
    expect(resolveBareOneBreath(TWO, info)).toEqual({ kind: 'refuse', reason: 'ambiguous' })
  })
  it('while the unambiguous sentences for each still apply', () => {
    expect(resolveBareOneBreath(TWO, oneBreathReadings('alpha 3 200'))).toMatchObject({ kind: 'apply', planting: { id: 'a' } })
    expect(resolveBareOneBreath(TWO, oneBreathReadings('alpha 7 3 200'))).toMatchObject({ kind: 'apply', planting: { id: 'a7' } })
  })
})

// ── review IMPORTANT-1 — a save word saves only what its own sentence set ──────────────────────────
//
// With a record standing ("Suyo Long", "5 count") a sentence naming another planting whose head is
// refused used to save the STANDING record — "danvers 12 three count 231 grams next" answered "Saved
// Suyo Long — 5 count" (lane build), and prod does the same for 20 of the review's 120 standing-record
// scripts. Every one of those 22 shapes, measured on the prod replica and the lane build (review §6):
describe('IMPORTANT-1 — a refused sentence never lets its save word save the record from before', () => {
  const STANDING_SAVED_ON_PROD_OR_LANE = [
    'super sweet 100 3 count next', 'super sweet 100 three count 231 grams next',
    'super sweet 100 3 count 231 grams next', 'super sweet 100 231 grams next',
    'super sweet one hundred 3 count next', 'super sweet one hundred three count 231 grams next',
    'super sweet one hundred 3 count 231 grams next', 'super sweet one hundred 231 grams next',
    'tomato 1884 3 count next', 'tomato 1884 three count 231 grams next', 'tomato 1884 3 count 231 grams next',
    'tomato 1884 231 grams next', 'marketmore 3 count next', 'marketmore three count 231 grams next',
    'marketmore 3 count 231 grams next', 'marketmore 231 grams next', 'clemson 80 3 count next',
    'clemson 80 three count 231 grams next', 'clemson 80 3 count 231 grams next', 'clemson 80 231 grams next',
    'danvers 12 three count 231 grams next', 'danvers 12 3 count 231 grams next',
  ]
  it.each(STANDING_SAVED_ON_PROD_OR_LANE)('"Suyo Long", "5 count", %j saves nothing', async (said) => {
    const rec = await startListening(VOCAB)
    for (const line of ['Suyo Long', '5 count', said]) await speak(rec, line)
    await settle()
    expect(posts()).toEqual([])
    expect(statusText()).not.toContain('Saved')
  })

  it('a refused unit head says nothing was saved, and the "next" he says after it is not swallowed', async () => {
    const rec = await startListening(VOCAB)
    for (const line of ['Suyo Long', '5 count', 'danvers 12 three count 231 grams next']) await speak(rec, line)
    expect(statusText()).toBe("Didn't catch that — say the planting, then the amount separately. Nothing was saved.")
    await settle()
    expect(posts()).toEqual([])
    // The refused sentence changed nothing: the record on the card is still Suyo Long's, and a real
    // "next" saves it — the cooldown the dropped save word claimed was given back.
    expect(record()).toContain('Suyo Long')
    expect(record()).toContain('5 count')
    await speak(rec, 'next')
    await settle()
    expect(posts().map((b) => [b.plant_id, b.harvest])).toEqual([[byName('Suyo Long').id, H(5, 'count')]])
  })

  it('"clear" after a refused head still clears — only the save is withheld', async () => {
    const rec = await startListening(VOCAB)
    for (const line of ['Suyo Long', '5 count', 'tomato 1884 3 count clear']) await speak(rec, line)
    expect(statusText()).toBe('Cleared. Say a crop to start the next one.')
    expect(record()).not.toContain('5 count')
  })

  it('a head that applies still saves with its own save word — the control', async () => {
    const rec = await startListening(VOCAB)
    for (const line of ['Suyo Long', '5 count', 'suyo long 231 grams next']) await speak(rec, line)
    await settle()
    expect(posts().map((b) => [b.plant_id, b.harvest])).toEqual([[byName('Suyo Long').id, H(5, 'count', 231)]])
  })
})

// ── QA F1 — a nameless pair applied twice is applied ONCE ──────────────────────────────────────────
//
// Chrome delivers the same pair twice in two measured shapes: a growing phrase whose partial a tick
// commits after a pause (the 2026-09-16 real-page trace: "pineapple" committed by tick 17 ms before
// "pineapple tomatillo"), and a re-delivered final in the next session 274 ms after its twin
// (BUG-VOICEDUPE). The row was saved right either way, but the second application found both slots
// full and wrote two FALSE "Dropped …" rows — "1 saved · 2 not captured" (QA probes P3/P4/P5/P12).
describe('QA F1 — a nameless no-unit pair said twice writes no false "not captured" rows', () => {
  const ledgerHead = () => screen.getByTestId('voice-harvest-ledger').firstChild.textContent
  // Several finals in ONE session, `gapMs` apart, then the session ends — Chrome's growing phrase.
  async function growing(finals, gapMs) {
    const rec = mic.latest()
    for (let i = 0; i < finals.length; i++) {
      await act(async () => { rec.deliverFinal(finals[i]) })
      if (i < finals.length - 1) await act(async () => { await vi.advanceTimersByTimeAsync(gapMs) })
    }
    await act(async () => { rec.endSession() })
  }

  it('P3: "2 165" then, after an 800 ms pause in the same session, "2 165 next"', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await growing(['2 165', '2 165 next'], 800)
    await settle()
    expect(posts().map((b) => [b.plant_id, b.harvest, b.metadata.assumed_units]))
      .toEqual([['p1', H(2, 'count', 165), ['count', 'g']]])
    expect(misses()).toEqual([])
    expect(ledgerHead()).toBe('1 saved')
  })

  it('P4: "2", then "2 165", then "2 165 next", 800 ms apart in one session', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await growing(['2', '2 165', '2 165 next'], 800)
    await settle()
    expect(posts().map((b) => b.harvest)).toEqual([H(2, 'count', 165)])
    expect(misses()).toEqual([])
    expect(ledgerHead()).toBe('1 saved')
  })

  it('P5: "2 165" re-delivered 274 ms later in the next session, then "next"', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(mic.latest(), '2 165')
    await act(async () => { await vi.advanceTimersByTimeAsync(274) })
    await speak(mic.latest(), '2 165')
    expect(haptics.hapticDigitRejected).not.toHaveBeenCalled()
    expect(statusText()).not.toContain('both filled')
    await speak(mic.latest(), 'next')
    await settle()
    expect(posts().map((b) => b.harvest)).toEqual([H(2, 'count', 165)])
    expect(misses()).toEqual([])
    expect(ledgerHead()).toBe('1 saved')
  })

  it('P12: the "drop count, keep grams" pair "2 165 grams" re-delivered, then "next"', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(mic.latest(), '2 165 grams')
    await act(async () => { await vi.advanceTimersByTimeAsync(274) })
    await speak(mic.latest(), '2 165 grams')
    await speak(mic.latest(), 'next')
    await settle()
    expect(posts().map((b) => [b.harvest, b.metadata.assumed_units])).toEqual([[H(2, 'count', 165), ['count']]])
    expect(misses()).toEqual([])
    expect(ledgerHead()).toBe('1 saved')
  })

  it('a pair restates the record: a held number it leaves out is dropped AND said', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '7', '2 165']) await speak(rec, line)
    expect(statusText()).toBe('165 — say a unit to change it, or carry on. (2 count assumed) (dropped 7 — no unit was said)')
    await speak(rec, 'next')
    await settle()
    expect(posts().map((b) => b.harvest)).toEqual([H(2, 'count', 165)])
    expect(misses()).toEqual(['Dropped 7 — no unit was said, and the record was said again without it.'])
  })
})

// ── QA F2 — one big number where a count goes may be two numbers run together ────────────────────
//
// QA probe P18: "Suyo Long 2165 next" (Chrome writing "two, one sixty-five" as one number) SAVED 2165
// count on the lane build — under MAX_PLAUSIBLE, so nothing warned; prod refused it. The rule: in a
// one-breath final, a LONE amount of 4+ digits, no unit, landing in the COUNT slot, is refused.
describe('QA F2 — a lone 4-digit amount that would be the count is refused, not saved', () => {
  it('P18: "Suyo Long 2165 next" saves nothing, says why, and keeps the planting it named', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long 2165 next')
    await settle()
    expect(posts()).toEqual([])
    expect(statusText()).toBe('Suyo Long — heard 2165 as one number. If that was a count and a weight, say them with a pause between, or say it with its unit.')
    expect(misses()).toEqual(['Not kept — heard “Suyo Long 2165 next”: 2165 may be two numbers run together.'])
    expect(haptics.hapticDigitRejected).toHaveBeenCalled()
    expect(record()).toContain('Suyo Long')
    // …and the corrected sentence straight after is not swallowed by the refused one's save word.
    await speak(rec, '2 165 next')
    await settle()
    expect(posts().map((b) => [b.plant_id, b.harvest])).toEqual([['p1', H(2, 'count', 165)]])
  })

  it('the same number where the WEIGHT goes is left alone — a count was already said', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '3 count', '2165 next']) await speak(rec, line)
    await settle()
    expect(posts().map((b) => [b.harvest, b.metadata.assumed_units])).toEqual([[H(3, 'count', 2165), ['g']]])
  })

  it('said with its unit it is a weight, as before — the refusal is for the bare form only', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long 2165 grams')
    expect(record()).toContain('2165 g')
    expect(misses()).toEqual([])
  })

  it('a 3-digit lone amount is read as before (the rule is 4+ digits)', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long 216 next')
    await settle()
    expect(posts().map((b) => b.harvest)).toEqual([H(216, 'count')])
  })
})

// ── QA F6 — an assumed value that looks high says so, like a spoken one ───────────────────────────
//
// QA probe P20: "Suyo Long", "3", "60000", "next" saved 60000 g with no "that looks high" — the spoken
// "60000 grams" warns (P21). The warning now comes when the number is HELD (where it would land), and
// the placed slot carries it into the saved banner and row.
describe('QA F6 — an assumed value above the plausible line is flagged on the way in and on the save', () => {
  it('P20: the held 60000 is flagged before "next", and the save says the guessed weight looks high', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '3', '60000']) await speak(rec, line)
    expect(statusText()).toBe('60000 — as grams that looks high. Say it again to correct it, or say a unit to change it. (3 count assumed)')
    await speak(rec, 'next')
    await settle()
    expect(posts().map((b) => [b.harvest, b.metadata.assumed_units])).toEqual([[H(3, 'count', 60000), ['count', 'g']]])
    expect(statusText()).toBe('Saved Suyo Long — 3 count · 60000 g (3 count assumed, 60000 g assumed — that looks high)')
    expect(screen.getByTestId('voice-harvest-row').textContent).toContain('60000 g assumed — that looks high')
  })

  it('a plausible held weight is not flagged — the control', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '3', '600']) await speak(rec, line)
    expect(statusText()).toBe('600 — say a unit to change it, or carry on. (3 count assumed)')
  })

  it('placed by an utterance that does not save, the flag rides on the banner with a warn tone', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '3 count', '60000', 'text']) await speak(rec, line)
    expect(statusText()).toBe('Didn\'t catch that — say "next" again. (60000 g assumed — that looks high)')
  })
})

// ── QA F4 — the card never reads "—" for a number that has been said ──────────────────────────────
//
// QA probe P16: after "Suyo Long", "2", "165" the card read Quantity "2 count", Weight "—" while 165 was
// held — on exactly the path the release notes advertise, against the card's own promise that "—" means
// the words have not been said. D3's slice B (312c90c) had the idea; the wording now matches the banner
// ("assumed … say a unit") instead of the stale "needs a unit" — units are optional.
describe('QA F4 — a held number shows where it will land, marked as assumed', () => {
  it('between the second number and "next", the Weight slot shows the held 165', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '2', '165']) await speak(rec, line)
    expect(record()).toContain('Quantity2 count')
    expect(record()).toContain('Weight165 g (assumed unless you say a unit)')
    expect(record()).not.toContain('Weight—')
  })

  it('the same after the one-breath "Suyo Long 2 165", and it becomes a plain 165 g once placed', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long 2 165')
    expect(record()).toContain('Weight165 g (assumed unless you say a unit)')
    await speak(rec, 'grams')
    expect(record()).toContain('Weight165 g')
    expect(record()).not.toContain('assumed unless you say a unit')
  })

  it('a first held number shows in the Quantity slot, in the crop\'s unit', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', '5']) await speak(rec, line)
    expect(record()).toContain('Quantity5 count (assumed unless you say a unit)')
    expect(record()).toContain('Weight—')
  })

  it('with both slots filled the held number has nowhere to land, and the card does not pretend it does', async () => {
    const rec = await startListening()
    for (const line of ['Suyo Long', 'three count', '231 grams', '85']) await speak(rec, line)
    expect(record()).toContain('Quantity3 count')
    expect(record()).toContain('Weight231 g')
    expect(record()).not.toContain('85')
    expect(statusText()).toContain('both filled')
  })
})

// ── QA F10 — a refused NAMED one-breath clears the record it abandons, and says what went ──────────
//
// QA probe P7: "Suyo Long", "3 count", "danvers 126 200" (refused), "danvers 126", "next" SAVED Danvers
// 126 Carrot · 3 count — a count said for Suyo Long, under a crop named afterwards, while the reselect
// banner said only "now say the count or the weight". Decision: the refusal clears the amounts along with
// the crop (it already dropped the crop), because clearing is the option that cannot save them under a
// different crop at all; what is cleared is said on the banner and in a miss row.
describe('QA F10 — a refused named sentence cannot carry old amounts onto the next crop', () => {
  it('P7: the 3 count said for Suyo Long is cleared and said, and cannot save under Danvers', async () => {
    const rec = await startListening(VOCAB)
    for (const line of ['Suyo Long', '3 count', 'danvers 126 200']) await speak(rec, line)
    expect(statusText()).toBe("Didn't catch that — the name and the numbers could be split more than one way — say the planting, then the amounts. (cleared 3 count)")
    expect(record()).toContain('Crop—')
    expect(record()).toContain('Quantity—')
    await speak(rec, 'danvers 126')
    expect(statusText()).toBe('Danvers 126 Carrot — now say the count or the weight.')
    await speak(rec, 'next')
    await settle()
    expect(posts()).toEqual([])
    expect(misses()).toEqual([
      'Cleared 3 count for Suyo Long — the record was started over after a sentence that could not be read.',
      "Didn't catch that — heard “danvers 126 200”.",
      'Not saved — still need a quantity.',
    ])
  })

  it('a refused crowded name clears too, and offers the plantings to pick from', async () => {
    const rec = await startListening(VOCAB)
    for (const line of ['Suyo Long', '3 count', '231 grams', 'super sweet 100 3 200']) await speak(rec, line)
    expect(statusText()).toBe('2 match “super sweet 100” — tap one, then say the amounts again. (cleared 3 count · 231 g)')
    expect(record()).toContain('Quantity—')
    expect(record()).toContain('Weight—')
    expect(screen.getByTestId('voice-harvest-candidates').textContent).toContain('Super Sweet 100 Rescue')
  })

  it('a refused sentence of numbers only changes nothing — the control', async () => {
    const rec = await startListening(VOCAB)
    for (const line of ['Suyo Long', '3 count', 'ten five']) await speak(rec, line)
    expect(record()).toContain('Suyo Long')
    expect(record()).toContain('Quantity3 count')
  })
})
