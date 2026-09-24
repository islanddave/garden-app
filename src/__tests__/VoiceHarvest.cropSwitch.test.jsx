// BUG-VOICECROPSWITCHKEEPSAMOUNTS-001 — naming a different crop clears the amounts said for the old one.
//
// Dave, 2026-09-24 (AUQ, first-hand): "When you name a different plant partway through a voice harvest, the
// amounts you already said move to the new plant without a word. For example, 'Stupice, 5 count, cucumber
// one, next' saves Suyo Long with 5 count." He chose "Clear them on a switch", knowing a correction
// ("Stupice… no, cucumber one") then means saying the amounts again.
//
// A SWITCH, as tested here: a planting is chosen — by any door — while the record holds an amount that was
// said while a DIFFERENT planting was chosen. Different means another planting row (the plant_id the harvest
// is saved under), so a second planting of the same variety is a switch too, as it already was for the
// one-breath readers. An amount said before any planting was chosen belongs to the one chosen next.
//
// Page-level, through the shared fake recogniser, the real 244-name vocabulary and three of Dave's taught
// names, asserting the POSTed rows and what the banner says.
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

import VoiceHarvest from '../pages/VoiceHarvest.jsx'
import { hapticSaveCommitted, hapticSaveFailed } from '../lib/haptics.js'
import { looseKey } from '../lib/comboboxInput.js'
import { VOCAB, byName } from './voiceHarvest.vocabulary.fixture.js'

const aliasRow = (heard, plantingName) => ({
  heard_key: looseKey(heard), heard_text: heard, variety_id: byName(plantingName).variety_ref.id,
  hit_count: 0, last_used_at: null,
})
// Three of Dave's live taught names (prod voice_alias, read-only 2026-09-24).
const LIVE = [
  aliasRow('cucumber one', 'Suyo Long'),
  aliasRow('super sweet 100', 'Super Sweet 100'),
  aliasRow('stupid chica', 'Stupice'),
]

const ALIAS_URL = '/api/varieties/voice-aliases'
let mic
beforeEach(() => {
  vi.clearAllMocks()
  mic = installFakeSpeechRecognition(vi)
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url, opts) => {
    if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: VOCAB })
    if (url === ALIAS_URL && !opts?.method) return Promise.resolve({ aliases: LIVE })
    return Promise.resolve({ id: 'evt-1' })
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

async function startListening() {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  render(<VoiceHarvest />)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith(ALIAS_URL))
  await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
  return mic.latest()
}
async function advance(ms) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
// Each line is said, its session ends, and the settle window passes before the next one.
async function say(rec, ...lines) {
  for (const line of lines) {
    await act(async () => { rec.deliverFinal(line) })
    await act(async () => { rec.endSession() })
    await advance(2000)
  }
}
// A planting's button reads "<name> · <crop>", in the list and in the teach box alike.
const button = (name) => ({ name: `${name} · ${byName(name).variety_ref.crop_type_slug}` })
async function tapCandidate(name) {
  const card = screen.getByTestId('voice-harvest-candidates')
  await act(async () => { fireEvent.click(within(card).getByRole('button', button(name))) })
}
async function teachPick(phrase, typed, name) {
  const teach = screen.getByTestId('voice-harvest-teach')
  fireEvent.change(within(teach).getByLabelText(`What did you mean by ${phrase}`), { target: { value: typed } })
  await act(async () => { fireEvent.click(within(teach).getByRole('button', button(name))) })
}
const nameOfId = (id) => VOCAB.find((p) => p.id === id)?.name
const saved = () => apiFetchSpy.mock.calls
  .filter(([url, opts]) => url === '/api/events' && opts?.method === 'POST')
  .map(([, opts]) => JSON.parse(opts.body))
  .map((b) => [nameOfId(b.plant_id), b.harvest.quantity, b.harvest.unit, b.harvest.weight ?? null, b.metadata.assumed_units])
const statusText = () => screen.getByTestId('voice-harvest-status').textContent
const misses = () => screen.queryAllByTestId('voice-harvest-miss').map((m) => m.textContent)
const cleared = () => misses().filter((m) => m.startsWith('Cleared'))
const slot = (label) => within(screen.getByTestId('voice-harvest-record')).getByText(label).nextSibling.textContent

describe('a spoken name for a different crop clears what was said for the old one', () => {
  it("Dave's example: Stupice, 5 count, cucumber one, next — saves nothing, and says why", async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', 'cucumber one')
    expect([slot('Crop'), slot('Quantity')]).toEqual(['Suyo Long', '—'])
    expect(statusText()).toBe('Heard “cucumber one” — matched Suyo Long, cleared 5 count from Stupice. Say the count, or say it again to change it.')
    expect(misses()).toEqual(['Cleared 5 count for Stupice — the crop changed to Suyo Long before it was saved.'])
    await say(rec, 'next')
    expect(saved()).toEqual([])
    // The refusal names the clear too: it is the banner he sees when "next" follows the name at once.
    expect(statusText()).toBe('Not saved — still need a quantity. Say it, then "next". (cleared 5 count from Stupice)')
  })

  it('a strict name clears too, and both amounts go', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', '231 grams', 'Suyo Long')
    expect(statusText()).toBe('Suyo Long — cleared 5 count · 231 g from Stupice. Now say the count or the weight.')
    expect([slot('Quantity'), slot('Weight')]).toEqual(['—', '—'])
    await say(rec, '3 count', 'next')
    // Only what was said for Suyo Long; before the fix Stupice's 231 g rode along.
    expect(saved()).toEqual([['Suyo Long', 3, 'count', null, []]])
    expect(statusText()).toBe('Saved Suyo Long — 3 count · no weight was said (cleared 5 count · 231 g from Stupice)')
  })

  it('an assumed unit goes with the crop, and a held number is still dropped and said', async () => {
    const rec = await startListening()
    // "5" then "231": 5 lands as an assumed count and 231 waits for its unit.
    await say(rec, 'Stupice', '5', '231', 'cucumber one')
    expect(statusText()).toBe('Heard “cucumber one” — matched Suyo Long, cleared 5 count from Stupice. Say the count, or say it again to change it. (dropped 231 — no unit was said)')
    await say(rec, 'next')
    expect(saved()).toEqual([])
  })

  it('an amount said before any crop belongs to the crop chosen next, and goes when that crop changes', async () => {
    const rec = await startListening()
    await say(rec, '5 count', 'Stupice', 'cucumber one', 'next')
    expect(saved()).toEqual([])
    expect(cleared()).toEqual(['Cleared 5 count for Stupice — the crop changed to Suyo Long before it was saved.'])
  })

  it('a name that matched nothing does not carry the amounts onto the next crop named', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', 'zzqq quux', 'Suyo Long', 'next')
    expect(saved()).toEqual([])
    expect(cleared()).toEqual(['Cleared 5 count for Stupice — the crop changed to Suyo Long before it was saved.'])
  })

  it('a second planting of the same variety is a different crop', async () => {
    const rec = await startListening()
    // "super sweet 100" names two plantings, so it asks; "super sweet 100 rescue" names one.
    await say(rec, 'super sweet 100')
    await tapCandidate('Super Sweet 100')
    await say(rec, '5 count', 'super sweet 100 rescue')
    expect(statusText()).toBe('Super Sweet 100 Rescue — cleared 5 count from Super Sweet 100. Now say the count or the weight.')
    await say(rec, 'next')
    expect(saved()).toEqual([])
  })

  // Review MINOR-1 — the two slot writers no other test here reaches: the nameless pair ("Dave's common case")
  // and the values of a one-breath sentence with units. Written straight to the slot instead of through
  // fillSlot, each loses its crop stamp and the leak comes back (review mutants X3 and X4).
  it.each([
    ['the nameless pair', ['Stupice', '5 count 231 grams', 'Suyo Long', 'next'],
      'Cleared 5 count · 231 g for Stupice — the crop changed to Suyo Long before it was saved.'],
    ['a one-breath sentence with units', ['suyo long 3 count 231 grams', 'Stupice', 'next'],
      'Cleared 3 count · 231 g for Suyo Long — the crop changed to Stupice before it was saved.'],
  ])('amounts from %s go too', async (_label, lines, row) => {
    const rec = await startListening()
    await say(rec, ...lines)
    expect(saved()).toEqual([])
    expect(cleared()).toEqual([row])
  })
})

describe('a tap on a different crop clears too', () => {
  it('a pick from the "Which one?" list', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', 'tomato')
    await tapCandidate('Big Boy')
    // A pick from a list a search offered also teaches that search (unchanged); the clear rides along.
    expect(statusText()).toBe('Big Boy — learned “tomato”, cleared 5 count from Stupice. Now say the count or the weight.')
    await say(rec, 'next')
    expect(saved()).toEqual([])
  })

  it('a pick of the other planting of the same variety', async () => {
    const rec = await startListening()
    await say(rec, 'celebrity')
    await tapCandidate('Celebrity')
    await say(rec, '5 count', 'celebrity')
    await tapCandidate('Celebrity Rescue')
    expect(cleared()).toEqual(['Cleared 5 count for Celebrity — the crop changed to Celebrity Rescue before it was saved.'])
    await say(rec, 'next')
    expect(saved()).toEqual([])
  })

  it('a pick in the teach box still teaches, and says what it cleared', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', 'zzqq quux')
    await teachPick('zzqq quux', 'suyo', 'Suyo Long')
    const teachPost = apiFetchSpy.mock.calls.find(([url, opts]) => url === ALIAS_URL && opts?.method === 'POST')
    expect(JSON.parse(teachPost[1].body)).toMatchObject({ heard_text: 'zzqq quux', variety_id: byName('Suyo Long').variety_ref.id })
    expect(statusText()).toBe('Suyo Long — learned “zzqq quux”, cleared 5 count from Stupice. Now say the count or the weight.')
    await say(rec, 'next')
    expect(saved()).toEqual([])
  })

  it('a pick whose teach fails still says what it cleared', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', 'zzqq quux')
    apiFetchSpy.mockImplementation((url, opts) => (url === ALIAS_URL && opts?.method === 'POST'
      ? Promise.reject(new Error('Service Unavailable')) : Promise.resolve({ id: 'evt-1' })))
    await teachPick('zzqq quux', 'suyo', 'Suyo Long')
    expect(statusText()).toBe('Suyo Long selected, but I could not remember “zzqq quux” — Service Unavailable. (cleared 5 count from Stupice)')
  })

  it('amounts said after the list came up belong to the crop tapped; only the old crop’s go', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', 'tomato', '231 grams')
    await tapCandidate('Big Boy')
    expect(cleared()).toEqual(['Cleared 5 count for Stupice — the crop changed to Big Boy before it was saved.'])
    await say(rec, '3 count', 'next')
    expect(saved()).toEqual([['Big Boy', 3, 'count', 231, []]])
  })
})

describe('the one-breath readers already started a new record — now they say what went', () => {
  it('no unit: the sentence’s own amounts still apply after the clear', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', 'suyo long 3 231')
    expect(statusText()).toBe('Suyo Long — 231 — say a unit to change it, or carry on. (3 count assumed) (cleared 5 count from Stupice)')
    await say(rec, 'next')
    expect(saved()).toEqual([['Suyo Long', 3, 'count', 231, ['count', 'g']]])
  })

  it('no unit, with "next" in the same breath: the save says it', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', 'suyo long 3 231 next')
    expect(saved()).toEqual([['Suyo Long', 3, 'count', 231, ['count', 'g']]])
    expect(statusText()).toBe('Saved Suyo Long — 3 count · 231 g (3 count assumed, 231 g assumed) (cleared 5 count from Stupice)')
    expect(cleared()).toEqual(['Cleared 5 count for Stupice — the crop changed to Suyo Long before it was saved.'])
  })

  it('with units', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', 'suyo long 3 count 231 grams')
    expect(statusText()).toBe('Suyo Long — 3 count · 231 g (cleared 5 count from Stupice)')
    await say(rec, 'next')
    expect(saved()).toEqual([['Suyo Long', 3, 'count', 231, []]])
  })

  it('a refused run-together amount still selects the crop, and says what went', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', 'suyo long 2165 next')
    expect(statusText()).toBe('Suyo Long — heard 2165 as one number. If that was a count and a weight, say them with a pause between, or say it with its unit. (cleared 5 count from Stupice)')
    expect(saved()).toEqual([])
  })

  it('a second planting of the same variety, as before', async () => {
    const rec = await startListening()
    await say(rec, 'super sweet 100')
    await tapCandidate('Super Sweet 100')
    await say(rec, '5 count', 'super sweet 100 rescue 3 231', 'next')
    expect(saved()).toEqual([['Super Sweet 100 Rescue', 3, 'count', 231, ['count', 'g']]])
  })
})

describe('what must not change', () => {
  it.each([
    ['amounts said before any crop', ['5 count', 'Stupice', 'next'], [['Stupice', 5, 'count', null, []]]],
    ['the same crop said again', ['Stupice', '5 count', 'Stupice', 'next'], [['Stupice', 5, 'count', null, []]]],
    ['the same crop by a taught name', ['Stupice', '5 count', 'stupid chica', 'next'], [['Stupice', 5, 'count', null, []]]],
    ['the same crop after a name that matched nothing', ['Stupice', '5 count', 'zzqq quux', 'Stupice', 'next'], [['Stupice', 5, 'count', null, []]]],
    ['the same crop after a list', ['Stupice', '5 count', 'tomato', 'stupice', 'next'], [['Stupice', 5, 'count', null, []]]],
    ['amounts said after a name that matched nothing', ['Stupice', 'zzqq quux', '5 count', 'Suyo Long', 'next'], [['Suyo Long', 5, 'count', null, []]]],
    ['a one-breath sentence for the same crop', ['Suyo Long', '5 count', 'cucumber 231 grams next'], [['Suyo Long', 5, 'count', 231, []]]],
    ['a crop change after a save', ['Stupice', '5 count', 'next', 'Suyo Long', '3 count', 'next'],
      [['Stupice', 5, 'count', null, []], ['Suyo Long', 3, 'count', null, []]]],
    ['clear, then another crop', ['Stupice', '5 count', 'clear', 'Suyo Long', '3 count', 'next'], [['Suyo Long', 3, 'count', null, []]]],
  ])('%s', async (_label, lines, rows) => {
    const rec = await startListening()
    await say(rec, ...lines)
    expect(saved()).toEqual(rows)
    expect(cleared()).toEqual([])
  })

  it('a crop chosen with nothing said yet reads exactly as before', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', 'Suyo Long')
    expect(statusText()).toBe('Suyo Long — now say the count or the weight.')
    await say(rec, 'Stupice', 'cucumber one')
    expect(statusText()).toBe('Heard “cucumber one” — matched Suyo Long. Say the count, or say it again to change it.')
    expect(misses()).toEqual([])
  })

  it('the same crop tapped from the list keeps the amounts', async () => {
    const rec = await startListening()
    await say(rec, 'celebrity')
    await tapCandidate('Celebrity')
    await say(rec, '5 count', 'celebrity')
    await tapCandidate('Celebrity')
    expect(statusText()).toBe('Celebrity — learned “celebrity”. Now say the count or the weight.')
    await say(rec, 'next')
    expect(saved()).toEqual([['Celebrity', 5, 'count', null, []]])
  })

  it('amounts said while the list is up belong to the crop tapped', async () => {
    const rec = await startListening()
    await say(rec, 'tomato', '5 count')
    await tapCandidate('Big Boy')
    await say(rec, 'next')
    expect(saved()).toEqual([['Big Boy', 5, 'count', null, []]])
    expect(cleared()).toEqual([])
  })

  it('a teach with nothing to clear reads exactly as before', async () => {
    const rec = await startListening()
    await say(rec, 'zzqq quux')
    await teachPick('zzqq quux', 'suyo', 'Suyo Long')
    expect(statusText()).toBe('Suyo Long — learned “zzqq quux”. Now say the count or the weight.')
  })

  it('Undo still removes a row saved after a switch', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', 'Suyo Long', '3 count', 'next')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Undo Suyo Long/ })) })
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/evt-1', { method: 'DELETE' })
    expect(statusText()).toBe('Removed Suyo Long — 3 count · no weight was said')
  })

  it('the note is said once: the save after it does not repeat it', async () => {
    const rec = await startListening()
    await say(rec, 'Stupice', '5 count', 'Suyo Long', '3 count', 'next')
    await say(rec, 'Suyo Long', '4 count', 'next')
    expect(statusText()).toBe('Saved Suyo Long — 4 count · no weight was said')
  })

  // Review MINOR-2 — a crop chosen with nothing to clear drops the last switch's note, or a record started over
  // (by "clear", or after a name that matched nothing) repeats a clear that belonged to the one abandoned
  // (review mutant X1).
  it.each([
    ['after "clear"', ['Stupice', '5 count', 'Suyo Long', 'clear', 'Suyo Long', '3 count', 'next']],
    ['after a name that matched nothing', ['Stupice', '5 count', 'Suyo Long', 'zzqq quux', 'Suyo Long', '3 count', 'next']],
  ])('an earlier switch’s note is not repeated %s', async (_label, lines) => {
    const rec = await startListening()
    await say(rec, ...lines)
    expect(saved()).toEqual([['Suyo Long', 3, 'count', null, []]])
    expect(statusText()).toBe('Saved Suyo Long — 3 count · no weight was said')
  })
})

// Review IMPORTANT-1 and PE-1 — THE WINDOW A SLOW SAVE OPENS. Every test above answers each POST at once, and
// that hides it: "next" sends the record, and until the POST answers the values sent are still on it. Naming a
// crop in that window wrote a false "Cleared … before it was saved" row beside the row that saved them, and the
// save's answer then cleared the whole record — wiping whatever had been said while it was out. These hold the
// POST open.
function holdPosts() {
  const held = []
  apiFetchSpy.mockImplementation((url, opts) => {
    if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: VOCAB })
    if (url === ALIAS_URL && !opts?.method) return Promise.resolve({ aliases: LIVE })
    if (url === '/api/events' && opts?.method === 'POST') {
      return new Promise((resolve, reject) => { held.push({ resolve, reject }) })
    }
    return Promise.resolve({ id: 'evt-1' })
  })
  const answer = async (fn) => { await act(async () => { fn() }); await advance(50) }
  return {
    count: () => held.length,
    resolve: (i = 0) => answer(() => held[i].resolve({ id: `evt-${i + 1}` })),
    reject: (i = 0) => answer(() => held[i].reject(new Error('Network error'))),
  }
}
const header = () => screen.getByTestId('voice-harvest-ledger').firstChild.textContent
const record = () => [slot('Crop'), slot('Quantity'), slot('Weight')]

describe('a save still being sent when the next crop is named', () => {
  it('the POST lands: no Cleared row, "1 saved", and the new crop’s amounts stay', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    expect(posts.count()).toBe(1)
    await say(rec, 'Suyo Long')
    // The 5 count is being sent, not lost: nothing is said about it.
    expect(statusText()).toBe('Suyo Long — now say the count or the weight.')
    await say(rec, '3 count')
    await posts.resolve()
    expect(statusText()).toBe('Saved Stupice — 5 count · no weight was said')
    expect(header()).toBe('1 saved')
    expect(misses()).toEqual([])
    expect(record()).toEqual(['Suyo Long', '3 count', '—'])
    await say(rec, 'next')
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []], ['Suyo Long', 3, 'count', null, []]])
  })

  it('the POST fails: the Cleared row is true now, and "next" still cannot move the count to the new crop', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await say(rec, 'Suyo Long')
    expect(misses()).toEqual([])
    await posts.reject()
    expect(misses()).toEqual([
      'NOT SAVED — Network error. Stupice · 5 count was not saved; say it again to log it.',
      'Cleared 5 count for Stupice — the crop changed to Suyo Long before it was saved.',
    ])
    // Not "say next to try again": next saves the record on screen, which is Suyo Long's.
    expect(statusText()).toBe('NOT SAVED — Network error. Stupice · 5 count was not saved; say it again to log it.')
    await say(rec, 'next')
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []]])
    expect(statusText()).toBe('Not saved — still need a quantity. Say it, then "next". (cleared 5 count from Stupice)')
  })

  it('a record for another crop said while the POST is out is still there when it lands, and saves on "next"', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, 'suyo long 3 count 231 grams')
    await posts.resolve()
    expect(header()).toBe('1 saved')
    expect(misses()).toEqual([])
    expect(record()).toEqual(['Suyo Long', '3 count', '231 g'])
    await say(rec, 'next')
    expect(saved()).toEqual([['Stupice', 5, 'count', 231, []], ['Suyo Long', 3, 'count', 231, []]])
  })

  it('an amount for the same crop said while the POST is out stays, and the weight just saved does not go twice', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, '3 count')
    await posts.resolve()
    expect(record()).toEqual(['Stupice', '3 count', '—'])
    await say(rec, 'next')
    expect(saved()).toEqual([['Stupice', 5, 'count', 231, []], ['Stupice', 3, 'count', null, []]])
  })

  it('the crop being saved, named again while the POST is out, stays chosen', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await say(rec, 'stupid chica')
    await posts.resolve()
    expect(record()).toEqual(['Stupice', '—', '—'])
    await say(rec, '4 count', 'next')
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []], ['Stupice', 4, 'count', null, []]])
  })

  it('nothing said while the POST is out: the record clears exactly as before', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    expect(record()).toEqual(['Stupice', '5 count', '—'])
    await posts.resolve()
    expect(record()).toEqual(['—', '—', '—'])
    expect(header()).toBe('1 saved')
    await say(rec, 'next')
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []]])
    expect(statusText()).toBe('Not saved — still need a crop and a quantity. Say it, then "next".')
  })

  it('an amount said after "next" but never sent is still cleared out loud, and its note rides to the new crop’s save', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await say(rec, '231 grams', 'Suyo Long')
    expect(statusText()).toBe('Suyo Long — cleared 231 g from Stupice. Now say the count or the weight.')
    await posts.resolve()
    // The 5 count was saved, so only the 231 g is a Cleared row.
    expect(cleared()).toEqual(['Cleared 231 g for Stupice — the crop changed to Suyo Long before it was saved.'])
    await say(rec, '3 count', 'next')
    await posts.resolve(1)
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []], ['Suyo Long', 3, 'count', null, []]])
    expect(statusText()).toBe('Saved Suyo Long — 3 count · no weight was said (cleared 231 g from Stupice)')
  })

  it('a taught name that chose the crop is counted once, even when a record for that crop is kept after the save', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupid chica', '5 count', 'next')
    await say(rec, '4 count')
    await posts.resolve()
    await say(rec, 'next')
    await posts.resolve(1)
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []], ['Stupice', 4, 'count', null, []]])
    const uses = apiFetchSpy.mock.calls.filter(([url, opts]) => url === ALIAS_URL && opts?.method === 'PATCH')
    expect(uses).toHaveLength(1)
  })

  it('a record kept for the same crop does not repeat the note already said on the save', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Suyo Long', '5 count', 'Stupice', '3 count', 'next')
    await say(rec, '4 count')
    await posts.resolve()
    expect(statusText()).toBe('Saved Stupice — 3 count · no weight was said (cleared 5 count from Suyo Long)')
    await say(rec, 'next')
    await posts.resolve(1)
    expect(statusText()).toBe('Saved Stupice — 4 count · no weight was said')
  })

})

// Lane V3 F3.2 — A SAVE WORD WHILE THE LAST HARVEST IS STILL BEING SENT. The write cooldown lasts 1.5 s and a slow
// POST lasts longer, so a repeated "next" sent the same harvest twice ("2 saved"). It is refused and said, and
// only while the record holds a value that POST is sending: a record said since saves as always.
describe('a save word while the last harvest is still being sent', () => {
  // One line said and its session ended, then `ms` passed — finer than say(), to land inside the 1.5 s cooldown.
  async function sayWithin(rec, line, ms) {
    await act(async () => { rec.deliverFinal(line) })
    await act(async () => { rec.endSession() })
    await advance(ms)
  }

  it('a second "next" sends nothing and says so; the save lands once', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next', 'next')
    expect(posts.count()).toBe(1)
    expect(statusText()).toBe('Still saving the last one.')
    expect(misses()).toEqual([])
    await posts.resolve()
    expect(statusText()).toBe('Saved Stupice — 5 count · no weight was said')
    expect(header()).toBe('1 saved')
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []]])
  })

  it('naming the same crop again before "next" is still the same harvest', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, 'Stupice', 'next')
    expect(posts.count()).toBe(1)
    expect(statusText()).toBe('Still saving the last one.')
  })

  it('if that POST fails, the normal NOT SAVED shows and a later "next" retries', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next', 'next')
    await posts.reject()
    expect(statusText()).toBe('NOT SAVED — Network error. Say "next" to try again.')
    await say(rec, 'next')
    expect(posts.count()).toBe(2)
    await posts.resolve(1)
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []], ['Stupice', 5, 'count', null, []]])
    expect(statusText()).toBe('Saved Stupice — 5 count · no weight was said')
    expect(header()).toBe('1 saved · 1 not captured')
  })

  it('a new record for another crop said while the POST is out still saves on "next", even with the same amount', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await say(rec, 'Suyo Long', '5 count', 'next')
    expect(posts.count()).toBe(2)
    await posts.resolve(0)
    await posts.resolve(1)
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []], ['Suyo Long', 5, 'count', null, []]])
    expect(header()).toBe('2 saved')
    expect(misses()).toEqual([])
  })

  it('a "next" after a name that matched nothing is still the harvest being sent, not a missing crop', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await say(rec, 'zzqq quux', 'next')
    expect(posts.count()).toBe(1)
    expect(statusText()).toBe('Still saving the last one.')
    // Only the name's own row: no "Not saved — still need a crop" for a harvest that is being saved.
    expect(misses()).toEqual(['Nothing matched “zzqq quux”.'])
    await posts.resolve()
    expect(header()).toBe('1 saved · 1 not captured')
  })

  it('a new amount for the same crop waits until the amount still being sent has landed, then saves by itself', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, '3 count', 'next')
    // Sending now would send the 231 g a second time.
    expect(posts.count()).toBe(1)
    expect(statusText()).toBe('Still saving the last one — then 3 count.')
    await posts.resolve()
    // Lane V3 F8 — the queued "next" goes through once the POST in its way has answered: 3 count alone.
    expect(posts.count()).toBe(2)
    await posts.resolve(1)
    expect(saved()).toEqual([['Stupice', 5, 'count', 231, []], ['Stupice', 3, 'count', null, []]])
    expect(statusText()).toBe('Saved Stupice — 3 count · no weight was said')
    expect(header()).toBe('2 saved')
    expect(misses()).toEqual([])
    // Its own buzz: by feel, a queued save that went through is not the same as one that never did.
    expect(hapticSaveCommitted).toHaveBeenCalledTimes(2)
  })

  it('the refused "next" does not swallow a real one said within 1.5 s of it', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await sayWithin(rec, 'next', 600)
    expect(statusText()).toBe('Still saving the last one.')
    await sayWithin(rec, 'Suyo Long', 100)
    await sayWithin(rec, '3 count', 100)
    await sayWithin(rec, 'next', 600)
    expect(posts.count()).toBe(2)
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []], ['Suyo Long', 3, 'count', null, []]])
    expect(statusText()).not.toContain('saved once')
  })
})

// BUG-VOICESLOWSAVEFALSEROWS-001 — THE TWO OTHER DOORS THAT TAKE VALUES OFF THE RECORD, DURING A SLOW SAVE. A named
// sentence refused and started over (QA F10) and amounts said again without units (review MINOR-6) wrote "Cleared …"
// and "Replaced …" rows for values a POST was still sending — false when it saved them. Their rows now wait for that
// POST, like the switch's. With no POST out, both still write their rows at once (VoiceHarvest.oneBreath.test.jsx).
describe('the other doors that take values off the record while a save is still being sent', () => {
  it('a refused sentence, and the POST lands: no Cleared row; only the refusal is not captured', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Suyo Long', '3 count', 'next')
    await say(rec, 'danvers 126 200')
    expect(statusText()).toBe("Didn't catch that — the name and the numbers could be split more than one way — say the planting, then the amounts.")
    await posts.resolve()
    expect(misses()).toEqual(["Didn't catch that — heard “danvers 126 200”."])
    expect(header()).toBe('1 saved · 1 not captured')
    expect(saved()).toEqual([['Suyo Long', 3, 'count', null, []]])
  })

  it('a refused sentence, and the POST fails: the Cleared row is written then, in its own words', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Suyo Long', '3 count', 'next')
    await say(rec, 'danvers 126 200')
    await posts.reject()
    expect(misses()).toEqual([
      "Didn't catch that — heard “danvers 126 200”.",
      'NOT SAVED — Network error. Suyo Long · 3 count was not saved; say it again to log it.',
      'Cleared 3 count for Suyo Long — the record was started over after a sentence that could not be read.',
    ])
    expect(statusText()).toBe('NOT SAVED — Network error. Suyo Long · 3 count was not saved; say it again to log it.')
    expect(header()).toBe('0 saved · 3 not captured')
  })

  it('amounts said again without units, and the POST lands: no Replaced rows, and the restated record still saves', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'suyo long 3 count 231 grams next')
    await say(rec, '2 165')
    expect(misses()).toEqual([])
    await posts.resolve()
    expect(header()).toBe('1 saved')
    expect(misses()).toEqual([])
    await say(rec, 'next')
    expect(saved()).toEqual([['Suyo Long', 3, 'count', 231, []], ['Suyo Long', 2, 'count', 165, ['count', 'g']]])
  })

  it('amounts said again without units, and the POST fails: the Replaced rows are written then', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'suyo long 3 count 231 grams next')
    await say(rec, '2 165')
    await posts.reject()
    expect(misses()).toEqual([
      'NOT SAVED — Network error. Suyo Long · 3 count · 231 g was not saved; say it again to log it.',
      'Replaced 3 count with 2 count (assumed) — the amounts were said again without units.',
      'Replaced 231 g with 165 g (assumed) — the amounts were said again without units.',
    ])
    expect(statusText()).toBe('NOT SAVED — Network error. Suyo Long · 3 count · 231 g was not saved; say it again to log it.')
    expect(header()).toBe('0 saved · 3 not captured')
  })

  it('a refused sentence during the save still says what it cleared that was never sent', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Suyo Long', '3 count', 'next')
    // Said after "next", so not part of what is being sent.
    await say(rec, '231 grams', 'danvers 126 200')
    expect(misses()).toEqual([
      'Cleared 231 g for Suyo Long — the record was started over after a sentence that could not be read.',
      "Didn't catch that — heard “danvers 126 200”.",
    ])
    expect(statusText()).toBe("Didn't catch that — the name and the numbers could be split more than one way — say the planting, then the amounts. (cleared 231 g)")
    await posts.resolve()
    expect(header()).toBe('1 saved · 2 not captured')
  })
})

// Review v4.150.0 QA I1 and M1 — THE LANDING KEEPS WHAT WAS SAID WHILE THE POST WAS OUT, pinned where nothing did: the
// same amount said again is a new value, not the one sent (identity, not value); a bare number held during the save
// keeps it and its crop; a name that matched nothing keeps its teach box. Adapted from the QA seat's probes P-VA,
// P-VB and P-VD, which killed its mutants VA, VB and VD where this suite could not.
describe('what was said while a save was out survives the save landing', () => {
  it('the same amount said again for the same crop is a new harvest, not the one sent', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await say(rec, '5 count')
    await posts.resolve()
    expect(record()).toEqual(['Stupice', '5 count', '—'])
    expect(header()).toBe('1 saved')
    expect(misses()).toEqual([])
    await say(rec, 'next')
    await posts.resolve(1)
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []], ['Stupice', 5, 'count', null, []]])
    expect(header()).toBe('2 saved')
  })

  it('a bare number said during the save stays held for its crop, and saves on "next"', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, '4')
    await posts.resolve()
    expect(record()).toEqual(['Stupice', '4 count (assumed unless you say a unit)', '—'])
    await say(rec, 'next')
    await posts.resolve(1)
    expect(saved()).toEqual([['Stupice', 5, 'count', 231, []], ['Stupice', 4, 'count', null, ['count']]])
  })

  it('a name that matched nothing during the save keeps its teach box when the save lands', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await say(rec, 'zzqq quux')
    await posts.resolve()
    expect(within(screen.getByTestId('voice-harvest-teach')).getByText('What did you mean by “zzqq quux”?')).toBeTruthy()
    expect(record()).toEqual(['—', '—', '—'])
    expect(header()).toBe('1 saved · 1 not captured')
  })
})

// Review v4.150.0 QA M2 — A FAILED SAVE AFTER SOMETHING WAS SAID FOR THE RECORD. The landing already keeps only what
// was said since "next"; a failed POST kept the whole record, so a retry merged the two: "stupice 5 count 231 grams
// next", "3 count", a failed POST and "next" saved Stupice · 3 count · 231 g, and the 5 count was never saved or named.
// Now the sent values leave the record, the row names what did not save, and the banner asks for it again. With
// nothing said since — or only the same crop named again — the record stays whole for the retry, as before.
describe('a failed save, when something was said while it was out', () => {
  it('nothing new said (the same crop only named again): the record stays whole and "next" retries it', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, 'Stupice')
    await posts.reject()
    expect(record()).toEqual(['Stupice', '5 count', '231 g'])
    expect(misses()).toEqual(['NOT SAVED — Network error.'])
    expect(statusText()).toBe('NOT SAVED — Network error. Say "next" to try again.')
    await say(rec, 'next')
    expect(saved()).toEqual([['Stupice', 5, 'count', 231, []], ['Stupice', 5, 'count', 231, []]])
  })

  it('an amount said since "next": the sent record leaves and is named; "next" saves only what was said since', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, '3 count')
    await posts.reject()
    expect(record()).toEqual(['Stupice', '3 count', '—'])
    expect(misses()).toEqual(['NOT SAVED — Network error. Stupice · 5 count · 231 g was not saved; say it again to log it.'])
    expect(statusText()).toBe('NOT SAVED — Network error. Stupice · 5 count · 231 g was not saved; say it again to log it.')
    await say(rec, 'next')
    // Not 3 count · 231 g: the weight went with the 5 count it was weighed with.
    expect(saved()).toEqual([['Stupice', 5, 'count', 231, []], ['Stupice', 3, 'count', null, []]])
  })

  it('an amount said since "next" into an empty slot is not merged with the failed record either', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await say(rec, '231 grams')
    await posts.reject()
    expect(record()).toEqual(['Stupice', '—', '231 g'])
    expect(misses()).toEqual(['NOT SAVED — Network error. Stupice · 5 count was not saved; say it again to log it.'])
  })

  it('the same amount said again since "next" is kept: it is new, not the one that failed', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await say(rec, '5 count')
    await posts.reject()
    expect(record()).toEqual(['Stupice', '5 count', '—'])
    await say(rec, 'next')
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []], ['Stupice', 5, 'count', null, []]])
  })

  it('a bare number held since "next" keeps its crop, and the failed record is named', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, '4')
    await posts.reject()
    expect(record()).toEqual(['Stupice', '4 count (assumed unless you say a unit)', '—'])
    expect(misses()).toEqual(['NOT SAVED — Network error. Stupice · 5 count · 231 g was not saved; say it again to log it.'])
    await say(rec, 'next')
    expect(saved()).toEqual([['Stupice', 5, 'count', 231, []], ['Stupice', 4, 'count', null, ['count']]])
  })

  it('a name that matched nothing since "next": the failed record is named and its teach box stays', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await say(rec, 'zzqq quux')
    await posts.reject()
    expect(record()).toEqual(['—', '—', '—'])
    expect(misses()).toEqual([
      'Nothing matched “zzqq quux”.',
      'NOT SAVED — Network error. Stupice · 5 count was not saved; say it again to log it.',
    ])
    expect(within(screen.getByTestId('voice-harvest-teach')).getByText('What did you mean by “zzqq quux”?')).toBeTruthy()
  })
})

// Lane V3 F8 — A "NEXT" FOR A NEW AMOUNT, SAID WHILE THE LAST HARVEST IS STILL SAVING, IS QUEUED. Refused and told to
// say it again, it could end in nothing: the POST landed with the success buzz and the new amount sat on the card
// unsaved and uncounted (Seat A, v4.150.0 delta pass). Now it goes through when the POST in its way answers, as a
// spoken "next" would. The shape where the POST lands and 3 count saves by itself is the test above ("…then saves by
// itself"). Later words: the same crop's amounts join it; another crop or "clear" cancels it; "next" again replaces
// it; a repeated "next" with nothing new queues nothing.
describe('a "next" queued behind the save still being sent', () => {
  it('only a weight said since "next" cannot be saved alone: the queued "next" refuses out loud when the POST lands', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await say(rec, '231 grams', 'next')
    expect(statusText()).toBe('Still saving the last one — 231 g still needs a quantity.')
    await posts.resolve()
    expect(posts.count()).toBe(1)
    expect(statusText()).toBe('Not saved — still need a quantity. Say it, then "next".')
    expect(misses()).toEqual(['Not saved — still need a quantity.'])
    expect(header()).toBe('1 saved · 1 not captured')
    expect(record()).toEqual(['Stupice', '—', '231 g'])
    expect(hapticSaveFailed).toHaveBeenCalledTimes(1)
  })

  it('…and a quantity said before the POST lands completes it, and it saves by itself', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next')
    await say(rec, '231 grams', 'next', '3 count')
    await posts.resolve()
    expect(saved()).toEqual([['Stupice', 5, 'count', null, []], ['Stupice', 3, 'count', 231, []]])
  })

  it('a repeated "next" with nothing new queues nothing: one POST, and nothing more is said when it lands', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next', 'next')
    expect(statusText()).toBe('Still saving the last one.')
    await posts.resolve()
    await advance(2000)
    expect(posts.count()).toBe(1)
    expect(statusText()).toBe('Saved Stupice — 5 count · no weight was said')
    expect(misses()).toEqual([])
    expect(hapticSaveCommitted).toHaveBeenCalledTimes(1)
  })

  it('an amount said after a repeated "next" is a new record: it waits for its own "next"', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next', 'next', '3 count')
    await posts.resolve()
    expect(posts.count()).toBe(1)
    expect(record()).toEqual(['Stupice', '3 count', '—'])
  })

  it('the POST in its way fails: the failed record is named, and the queued "next" still saves what was said since', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, '3 count', 'next')
    await posts.reject()
    expect(misses()).toEqual(['NOT SAVED — Network error. Stupice · 5 count · 231 g was not saved; say it again to log it.'])
    expect(posts.count()).toBe(2)
    await posts.resolve(1)
    expect(saved()).toEqual([['Stupice', 5, 'count', 231, []], ['Stupice', 3, 'count', null, []]])
    expect(statusText()).toBe('Saved Stupice — 3 count · no weight was said')
    expect(header()).toBe('1 saved · 1 not captured')
  })

  it('the POST in its way fails after a repeated "next": nothing retries by itself, and a later "next" does', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'Stupice', '5 count', 'next', 'next')
    await posts.reject()
    await advance(2000)
    expect(posts.count()).toBe(1)
    expect(statusText()).toBe('NOT SAVED — Network error. Say "next" to try again.')
    await say(rec, 'next')
    expect(posts.count()).toBe(2)
  })

  it('a weight said before the POST lands joins the queued save', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, '3 count', 'next', '200 grams')
    await posts.resolve()
    expect(saved()).toEqual([['Stupice', 5, 'count', 231, []], ['Stupice', 3, 'count', 200, []]])
  })

  it('a queued record completed and sent before the POST lands leaves nothing queued behind it', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    // "200 grams" takes the weight's place, so nothing on the record is being sent and this "next" sends at once.
    await say(rec, '3 count', 'next', '200 grams', 'next')
    expect(posts.count()).toBe(2)
    await posts.resolve(0)
    expect(statusText()).toBe('Saved Stupice — 5 count · 231 g')
    expect(posts.count()).toBe(2)
    await posts.resolve(1)
    expect(saved()).toEqual([['Stupice', 5, 'count', 231, []], ['Stupice', 3, 'count', 200, []]])
  })

  it('"next" said again before the POST lands replaces the queued save: one save, not two', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, '3 count', 'next', 'next')
    expect(statusText()).toBe('Still saving the last one — then 3 count.')
    await posts.resolve()
    expect(posts.count()).toBe(2)
    await posts.resolve(1)
    expect(saved()).toEqual([['Stupice', 5, 'count', 231, []], ['Stupice', 3, 'count', null, []]])
    expect(header()).toBe('2 saved')
  })

  it('another crop named before the POST lands cancels it: the amount is cleared and said, and the new crop waits for its own "next"', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, '3 count', 'next', 'Suyo Long', '4 count')
    expect(cleared()).toEqual(['Cleared 3 count for Stupice — the crop changed to Suyo Long before it was saved.'])
    await posts.resolve()
    expect(posts.count()).toBe(1)
    expect(record()).toEqual(['Suyo Long', '4 count', '—'])
  })

  it('"clear" before the POST lands cancels it', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, '3 count', 'next', 'clear', 'Stupice', '4 count')
    await posts.resolve()
    expect(posts.count()).toBe(1)
    expect(record()).toEqual(['Stupice', '4 count', '—'])
  })

  it('a new amount and "next" with no crop chosen is refused at once for a crop, and nothing is queued', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, 'zzqq quux', '3 count', 'next')
    expect(statusText()).toBe('Not saved — still need a crop. Say it, then "next".')
    expect(misses()).toEqual(['Nothing matched “zzqq quux”.', 'Not saved — still need a crop.'])
    await posts.resolve()
    expect(posts.count()).toBe(1)
  })

  it('a name that matched nothing before the POST lands: the queued "next" refuses out loud for want of a crop', async () => {
    const rec = await startListening()
    const posts = holdPosts()
    await say(rec, 'stupice 5 count 231 grams next')
    await say(rec, '3 count', 'next', 'zzqq quux')
    await posts.resolve()
    expect(posts.count()).toBe(1)
    expect(statusText()).toBe('Not saved — still need a crop. Say it, then "next".')
    expect(misses()).toEqual(['Nothing matched “zzqq quux”.', 'Not saved — still need a crop.'])
  })
})
