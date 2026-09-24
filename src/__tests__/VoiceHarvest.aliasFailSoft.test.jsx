// BUG-VOICEALIASFAILSOFT-001 — his taught names survive a slow or failed name list.
//
// Review MINOR-9 (review-regression-impact.md F.5, accepted for v4.143.1 with this follow-up): when the
// GET /api/varieties/voice-aliases request failed or answered late, fetchAliases handed the page [] and
// the one-breath reader could not tell "he taught none" from "we could not read them". Dave's taught
// "cucumber one" (Suyo Long, prod voice_alias since 2026-09-15) was then read as the crop "cucumber"
// plus an amount of 1: "cucumber one", "next" saved a 1 count he never said, and "cucumber one", "3",
// "next" saved 1 count · 3 g, where the live app refused. A GET one second late was enough.
//
// The fix under test, in one line each:
//   * a failed or unreadable list is UNKNOWN (fetchAliases → null), and while it is unknown a NAMED
//     one-breath sentence goes the ordinary way — a search cannot put a number in a slot;
//   * what is said before the list has loaded is HELD, in order, until it answers or ALIAS_WAIT_MS
//     passes, so a merely slow list costs a moment, not the taught name;
//   * a failed list is asked for again.
//
// Page-level, through the shared fake recogniser, asserting the POSTed rows — the only thing that
// matters here is what gets saved.
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

import VoiceHarvest, { resolveBareOneBreath, ALIAS_WAIT_MS, ALIAS_RETRY_MS } from '../pages/VoiceHarvest.jsx'
import { oneBreathReadings } from '../lib/voiceHarvestGrammar.js'
import { indexAliases } from '../lib/voiceAliases.js'
import { looseKey } from '../lib/comboboxInput.js'
import { VOCAB, byName } from './voiceHarvest.vocabulary.fixture.js'

// Dave's two number-bearing aliases (prod voice_alias, read-only 2026-09-24: 33 rows, these are the only
// two with a digit or a number word) plus one ordinary one, in the GET's own row shape.
const aliasRow = (heard, plantingName) => ({
  heard_key: looseKey(heard), heard_text: heard, variety_id: byName(plantingName).variety_ref.id,
  hit_count: 0, last_used_at: null,
})
const LIVE = [
  aliasRow('cucumber one', 'Suyo Long'),
  aliasRow('super sweet 100', 'Super Sweet 100'),
  aliasRow('stupid chica', 'Stupice'),
]

const ALIAS_URL = '/api/varieties/voice-aliases'
let mic
// How the alias GET answers, per attempt: 'live' | 'empty' | 'fail' | 'malformed' | { lateMs }.
let answers
beforeEach(() => {
  vi.clearAllMocks()
  mic = installFakeSpeechRecognition(vi)
  answers = ['live']
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url, opts) => {
    if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: VOCAB })
    if (url === ALIAS_URL && !opts?.method) {
      const a = answers.length > 1 ? answers.shift() : answers[0]
      if (a === 'fail') return Promise.reject(Object.assign(new Error('Gateway Timeout'), { status: 504 }))
      if (a === 'malformed') return Promise.resolve({ id: 'evt-1' })
      if (a === 'empty') return Promise.resolve({ aliases: [] })
      if (a?.lateMs != null) return new Promise((res) => setTimeout(() => res({ aliases: LIVE }), a.lateMs))
      return Promise.resolve({ aliases: LIVE })
    }
    return Promise.resolve({ id: 'evt-1' })
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

async function mountPage() {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  render(<VoiceHarvest />)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith(ALIAS_URL))
}
async function startListening() {
  await mountPage()
  await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
  return mic.latest()
}
async function speak(rec, text) {
  await act(async () => { rec.deliverFinal(text) })
  await act(async () => { rec.endSession() })
}
async function advance(ms) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const settle = () => advance(2000)
const nameOfId = (id) => VOCAB.find((p) => p.id === id)?.name
const saved = () => apiFetchSpy.mock.calls
  .filter(([url, opts]) => url === '/api/events' && opts?.method === 'POST')
  .map(([, opts]) => JSON.parse(opts.body))
  .map((b) => [nameOfId(b.plant_id), b.harvest.quantity, b.harvest.unit, b.harvest.weight ?? null])
const aliasGets = () => apiFetchSpy.mock.calls.filter(([url, opts]) => url === ALIAS_URL && !opts?.method).length
const statusText = () => screen.getByTestId('voice-harvest-status').textContent

// What prod saves with the list loaded, the reference every "unknown" case below is held to.
const TAUGHT = [
  [['cucumber one', 'next'], []],
  [['cucumber one', '3', 'next'], [['Suyo Long', 3, 'count', null]]],
  [['cucumber one', '3 count', 'next'], [['Suyo Long', 3, 'count', null]]],
  [['cucumber one', '231 grams', 'next'], []],
  [['cucumber one 3 200 next'], [['Suyo Long', 3, 'count', 200]]],
  [['cucumber one 200 next'], [['Suyo Long', 200, 'count', null]]],
]

describe('the list is a loaded answer — the taught name is a name', () => {
  it.each(TAUGHT)('%j', async (lines, rows) => {
    const rec = await startListening()
    for (const line of lines) await speak(rec, line)
    await settle()
    expect(saved()).toEqual(rows)
  })
})

describe('the list FAILED — nothing is saved from a taught name read as a crop and a number', () => {
  // The ordinary path's answer to "cucumber one" with no taught names is "Nothing matched" — the live
  // app's answer too — so every one of these ends with nothing saved, never with a guess.
  it.each(['fail', 'malformed'].flatMap((how) => TAUGHT.map(([lines]) => [how, lines])))(
    '%s: %j saves nothing — no 1 count, no 1 g', async (how, lines) => {
      answers = [how]
      const rec = await startListening()
      for (const line of lines) await speak(rec, line)
      await settle()
      expect(saved()).toEqual([])
    })

  it('names still work, and a sentence of numbers with a crop chosen is still read', async () => {
    answers = ['fail']
    const rec = await startListening()
    for (const line of ['Suyo Long', '3 231', 'next']) await speak(rec, line)
    await settle()
    for (const line of ['Stupice', 'three count', '85 grams', 'next']) await speak(rec, line)
    await settle()
    expect(saved()).toEqual([['Suyo Long', 3, 'count', 231], ['Stupice', 3, 'count', 85]])
  })

  it('a named one-breath sentence is left to the ordinary path — never split with the names unknown', async () => {
    answers = ['fail']
    const rec = await startListening()
    await speak(rec, 'suyo long 2 165 next')
    await settle()
    expect(saved()).toEqual([])
    // Said with units, the unit reader owns it and the names do not matter to it.
    await speak(rec, 'suyo long three count 231 grams next')
    await settle()
    expect(saved()).toEqual([['Suyo Long', 3, 'count', 231]])
  })

  it('an EMPTY list is an answer — he taught nothing, and the one-breath reader reads names', async () => {
    answers = ['empty']
    const rec = await startListening()
    await speak(rec, 'suyo long 2 165 next')
    await settle()
    expect(saved()).toEqual([['Suyo Long', 2, 'count', 165]])
  })

  it('a failed list is asked for again, and once it loads the taught name is a name', async () => {
    answers = ['fail', 'live']
    await mountPage()
    expect(aliasGets()).toBe(1)
    await advance(ALIAS_RETRY_MS[0])
    await waitFor(() => expect(aliasGets()).toBe(2))
    await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
    const rec = mic.latest()
    for (const line of ['cucumber one', '3', 'next']) await speak(rec, line)
    await settle()
    expect(saved()).toEqual([['Suyo Long', 3, 'count', null]])
  })

  it('a name taught while the list was failing survives the list loading later', async () => {
    // Fails on mount and again on Start; loads on the retry after the teach.
    answers = ['fail', 'fail', 'live']
    const rec = await startListening()
    expect(aliasGets()).toBe(2)
    await speak(rec, 'zzqq three')
    const teach = screen.getByTestId('voice-harvest-teach')
    fireEvent.change(within(teach).getByLabelText('What did you mean by zzqq three'), { target: { value: 'suyo' } })
    await act(async () => { fireEvent.click(within(teach).getByRole('button', { name: /Suyo Long/ })) })
    await advance(ALIAS_RETRY_MS[0] + ALIAS_RETRY_MS[1])
    expect(aliasGets()).toBeGreaterThan(1)
    for (const line of ['zzqq three', '3 count', 'next']) await speak(rec, line)
    await settle()
    expect(saved()).toEqual([['Suyo Long', 3, 'count', null]])
  })

  it('the retries stop — a list that keeps failing is asked for a bounded number of times', async () => {
    answers = ['fail']
    await mountPage()
    await advance(ALIAS_RETRY_MS.reduce((a, b) => a + b, 0) + 60000)
    expect(aliasGets()).toBe(1 + ALIAS_RETRY_MS.length)
  })

  it('Start asks again for a list that is still failing', async () => {
    answers = ['fail']
    await mountPage()
    await advance(ALIAS_RETRY_MS.reduce((a, b) => a + b, 0) + 60000)
    const before = aliasGets()
    await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
    expect(aliasGets()).toBe(before + 1)
  })

  it('Start does not ask again for a list that loaded', async () => {
    await mountPage()
    await advance(100)
    await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
    await advance(ALIAS_RETRY_MS.reduce((a, b) => a + b, 0) + 1000)
    expect(aliasGets()).toBe(1)
  })
})

describe('the list is LATE — what is said waits for it, in order, then reads as taught', () => {
  it.each(TAUGHT)('%j said before a list that lands in 1 s saves what prod saves', async (lines, rows) => {
    answers = [{ lateMs: 1000 }]
    const rec = await startListening()
    for (const line of lines) await speak(rec, line)
    await settle()
    expect(saved()).toEqual(rows)
  })

  it('says why nothing has happened yet, and nothing is written while it waits', async () => {
    answers = [{ lateMs: 2000 }]
    const rec = await startListening()
    await speak(rec, 'cucumber one')
    expect(statusText()).toBe('Heard “cucumber one” — one moment, loading the names you taught me.')
    await speak(rec, '3 count')
    await speak(rec, 'next')
    await advance(1500)
    expect(saved()).toEqual([])
    await advance(1000)
    expect(saved()).toEqual([['Suyo Long', 3, 'count', null]])
  })

  it('an ordinary record said before the list lands is only late, never lost', async () => {
    answers = [{ lateMs: 1500 }]
    const rec = await startListening()
    for (const line of ['Suyo Long', '3 231', 'next']) await speak(rec, line)
    await settle()
    expect(saved()).toEqual([['Suyo Long', 3, 'count', 231]])
  })

  it(`waits at most ${ALIAS_WAIT_MS} ms, once: past that the held words are read with the names unknown`, async () => {
    answers = [{ lateMs: ALIAS_WAIT_MS + 3000 }]
    const rec = await startListening()
    for (const line of ['cucumber one', '3', 'next']) await speak(rec, line)
    await advance(ALIAS_WAIT_MS + 100)
    // Read at the deadline, names unknown: no 1 count, no 1 g — nothing, as the live app did.
    expect(saved()).toEqual([])
    // Not held a second time while the list is still loading.
    await speak(rec, 'Suyo Long')
    await speak(rec, '3 231')
    await speak(rec, 'next')
    await settle()
    expect(saved()).toEqual([['Suyo Long', 3, 'count', 231]])
    // And once it lands, the taught name is a name again.
    await advance(5000)
    for (const line of ['cucumber one', '5', 'next']) await speak(rec, line)
    await settle()
    expect(saved()).toEqual([['Suyo Long', 3, 'count', 231], ['Suyo Long', 5, 'count', null]])
  })
})

describe('resolveBareOneBreath — aliasesKnown', () => {
  const suyo = byName('Suyo Long')
  it('with the names unknown a NAMED sentence is not this reader\'s', () => {
    for (const said of ['cucumber one', 'cucumber one next', 'cucumber one 3 200', 'suyo long 2 165', 'suyo long 2 165 next']) {
      expect(resolveBareOneBreath(VOCAB, oneBreathReadings(said), { aliasesKnown: false }), said).toBeNull()
      expect(resolveBareOneBreath(VOCAB, oneBreathReadings(said), { selected: suyo, aliasesKnown: false }), said).toBeNull()
    }
  })

  it('a sentence of numbers is still read with a crop chosen, names unknown or not', () => {
    for (const aliasesKnown of [false, true]) {
      const d = resolveBareOneBreath(VOCAB, oneBreathReadings('3 231'), { selected: suyo, aliasesKnown })
      expect(d?.kind === 'apply' && d.groups.map((g) => g.value)).toEqual([3, 231])
    }
  })

  it('known — with or without a list — is unchanged: no list means none taught', () => {
    expect(resolveBareOneBreath(VOCAB, oneBreathReadings('cucumber one'))).toMatchObject({ kind: 'apply', groups: [{ value: 1 }] })
    const idx = indexAliases(LIVE)
    expect(resolveBareOneBreath(VOCAB, oneBreathReadings('suyo long 2 165'), { aliasIndex: idx }))
      .toMatchObject({ kind: 'apply', groups: [{ value: 2 }, { value: 165 }] })
  })
})
