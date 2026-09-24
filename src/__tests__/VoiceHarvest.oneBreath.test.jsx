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
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
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
} from '../pages/VoiceHarvest.jsx'
import { segmentCandidates, oneBreathReadings } from '../lib/voiceHarvestGrammar.js'
import { VOCAB, byName } from './voiceHarvest.vocabulary.fixture.js'

// The small garden the older VoiceHarvest tests use — two cucumbers, so "cucumber" alone is a
// question — for the cases that are about the flow rather than the vocabulary.
const planting = (id, name, slug, unit = null) => ({
  id, name, archived_at: null,
  variety_ref: { id: `v-${id}`, name: `${name} cultivar`, crop_type_slug: slug, default_unit: unit },
})
const PLANTS = [planting('p1', 'Suyo Long', 'cucumber'), planting('p2', 'Marketmore', 'cucumber')]

let mic
let plantsNow = PLANTS
beforeEach(() => {
  mic = installFakeSpeechRecognition(vi)
  plantsNow = PLANTS
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url) => {
    if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: plantsNow })
    return Promise.resolve({ id: 'evt-1' })
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

async function startListening(plants = PLANTS) {
  plantsNow = plants
  vi.useFakeTimers({ shouldAdvanceTime: true })
  render(<VoiceHarvest />)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
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
    for (const line of ['Suyo Long', '2 165 text']) await speak(rec, line)
    await settle()
    expect(posts()).toEqual([])
    expect(statusText()).toBe('Kept that. Didn\'t catch the last word — say "next" again.')
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
    for (const line of ['Suyo Long', '3 count', said, 'next']) await speak(rec, line)
    await settle()
    expect(posts()).toEqual([])
    expect(misses()).toContain(`Didn't catch that — heard “${said}”.`)
    // The sentence named a planting, so the old crop does not stay selected behind the refusal —
    // the "next" after it cannot save Suyo Long's record.
    expect(misses()).toContain('Not saved — still need a crop.')
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
    // Not a vacuous sweep: most of it must actually APPLY.
    // Not a vacuous sweep: most of it must actually APPLY (measured 2026-09-24: 75 of 105), and the
    // refusals are the names that end in their own number followed by ONE amount, and Super Sweet 100.
    expect(outcomes.filter(([, k]) => k === 'apply').length).toBeGreaterThanOrEqual(60)
  })

  it("the name's OWN number as the first amount is never read as an amount", () => {
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
            if (r?.kind !== 'apply') continue
            // Allowed only as the name reading: the number stays in the name, 200 is the one amount.
            expect(r.groups.map((g) => g.value), `${said} → ${r.planting?.name}`).not.toContain(Number(d))
            expect(r.planting?.id, said).toBe(p.id)
          }
        }
      }
    }
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
