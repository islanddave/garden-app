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
})
