// BUG-VOICEALIASHITCOUNT-001 — a harvest saved through a taught name counts one use of that name.
//
// voice_alias.hit_count and last_used_at were read by the GET and reset by the teach, and written by
// nothing: all 33 of Dave's aliases read 0 on prod (2026-09-24), so nothing could tell a load-bearing
// alias from one-off noise. The page now remembers which taught name chose the planting on the record
// and, AFTER the harvest it named is saved, sends PATCH /api/varieties/voice-aliases — fire and forget,
// so a count can never block, delay or fail a save.
//
// Page level, through the shared fake recogniser, against the 244-name fixture with his aliases served
// the way the GET serves them. Assertions are on what went over the wire, in order.
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

import VoiceHarvest, { aliasUseOf, indexAliasUses } from '../pages/VoiceHarvest.jsx'
import { looseKey } from '../lib/comboboxInput.js'
import { VOCAB, byName } from './voiceHarvest.vocabulary.fixture.js'

const aliasRow = (heard, plantingName) => ({
  heard_key: looseKey(heard), heard_text: heard, variety_id: byName(plantingName).variety_ref.id,
  hit_count: 0, last_used_at: null,
})
// His two number-bearing aliases and two word ones (prod voice_alias, 2026-09-24), plus a synthetic
// phrase no planting name contains, taught for a variety with two plantings (Celebrity, Celebrity Rescue).
const LIVE = [
  aliasRow('cucumber one', 'Suyo Long'),
  aliasRow('super sweet 100', 'Super Sweet 100'),
  aliasRow('stupid chica', 'Stupice'),
  aliasRow('gumball', 'Gong Bao'),
  aliasRow('celery tea', 'Celebrity'),
]
const SUYO = byName('Suyo Long')
const ALIAS_URL = '/api/varieties/voice-aliases'

let mic
let aliasAnswer
let eventAnswer
let patchAnswer
beforeEach(() => {
  vi.clearAllMocks()
  mic = installFakeSpeechRecognition(vi)
  aliasAnswer = () => Promise.resolve({ aliases: LIVE })
  eventAnswer = () => Promise.resolve({ id: 'evt-1' })
  patchAnswer = () => Promise.resolve({ counted: 1 })
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url, opts) => {
    if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: VOCAB })
    if (url === ALIAS_URL && !opts?.method) return aliasAnswer()
    if (url === ALIAS_URL && opts?.method === 'PATCH') return patchAnswer()
    if (url === '/api/events' && opts?.method === 'POST') return eventAnswer()
    return Promise.resolve({ id: 'evt-1' })
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

async function startListening() {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  render(<VoiceHarvest />)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith(ALIAS_URL))
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
  return mic.latest()
}
async function speak(rec, text) {
  await act(async () => { rec.deliverFinal(text) })
  await act(async () => { rec.endSession() })
}
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(2000) }) }
async function say(lines) {
  const rec = await startListening()
  for (const line of lines) await speak(rec, line)
  await settle()
  return rec
}
// The writes, in the order they went out: ['save', plant name] and ['count', [heard_key, variety]].
const nameOfId = (id) => VOCAB.find((p) => p.id === id)?.name
const wire = () => apiFetchSpy.mock.calls.flatMap(([url, opts]) => {
  if (url === '/api/events' && opts?.method === 'POST') return [['save', nameOfId(JSON.parse(opts.body).plant_id)]]
  if (url === ALIAS_URL && opts?.method === 'PATCH') return [['count', JSON.parse(opts.body).used.map((u) => [u.heard_key, u.variety_id])]]
  return []
})
const counts = () => wire().filter(([kind]) => kind === 'count')

describe('a save through a taught name counts one use of it, after the save', () => {
  it.each([
    [['cucumber one', '3', 'next']],
    [['cucumber one', '3 count', '231 grams', 'next']],
    [['cucumber one 3 200 next']],                              // the one-breath reader, no units
    [['cucumber one three count 231 grams next']],              // the one-breath reader, with units
    [['Suyo Long', 'cucumber one 3 count next']],               // said over a record of the same crop
    [['cucumber 1', '3', 'next']],                              // Chrome's digits for the same name
  ])('%j', async (lines) => {
    await say(lines)
    expect(wire()).toEqual([['save', 'Suyo Long'], ['count', [[looseKey('cucumber one'), SUYO.variety_ref.id]]]])
  })

  it('a word alias counts the same way', async () => {
    await say(['stupid chica', '3 count', 'next'])
    expect(wire()).toEqual([['save', 'Stupice'], ['count', [[looseKey('stupid chica'), byName('Stupice').variety_ref.id]]]])
  })

  it('a pick from a taught name\'s list of two plantings is a use of it', async () => {
    const rec = await startListening()
    await speak(rec, 'celery tea')
    const list = screen.getByTestId('voice-harvest-candidates')
    await act(async () => { fireEvent.click(within(list).getByRole('button', { name: /Celebrity Rescue/ })) })
    await speak(rec, '3 count')
    await speak(rec, 'next')
    await settle()
    expect(counts()).toEqual([['count', [[looseKey('celery tea'), byName('Celebrity').variety_ref.id]]]])
  })

  it('each save through the name is one more use', async () => {
    const rec = await startListening()
    for (const line of ['cucumber one', '3', 'next']) await speak(rec, line)
    await settle()
    for (const line of ['cucumber one', '4', 'next']) await speak(rec, line)
    await settle()
    expect(wire().filter(([k]) => k === 'save')).toHaveLength(2)
    expect(counts()).toHaveLength(2)
  })
})

describe('nothing is counted when the taught name did not choose what was saved', () => {
  it.each([
    [['Suyo Long', '3', 'next']],                        // the planting's own name
    [['cucumber', '3', 'next']],                         // its crop — a strict name
    [['cucumber one', 'Suyo Long', '3', 'next']],        // re-chosen by its own name before the save
    [['cucumber one', 'Stupice', '3', 'next']],          // another crop chosen before the save
    [['cucumber one', 'next']],                          // refused: no quantity
    [['cucumber one', 'clear', 'Suyo Long', '3', 'next']],
  ])('%j', async (lines) => {
    await say(lines)
    expect(counts()).toEqual([])
  })

  it('a taught name that is also a real name answers strictly, not as a use', async () => {
    // "super sweet 100" is taught, and is also Super Sweet 100's own name — the strict layer answers.
    const rec = await startListening()
    await speak(rec, 'super sweet 100')
    const list = screen.getByTestId('voice-harvest-candidates')
    await act(async () => { fireEvent.click(within(list).getAllByRole('button')[0]) })
    await speak(rec, '3 count')
    await speak(rec, 'next')
    await settle()
    expect(wire().filter(([k]) => k === 'save')).toHaveLength(1)
    expect(counts()).toEqual([])
  })

  it('a save that fails is not a use', async () => {
    eventAnswer = () => Promise.reject(new Error('Gateway Timeout'))
    await say(['cucumber one', '3', 'next'])
    expect(counts()).toEqual([])
    expect(screen.getByTestId('voice-harvest-status').textContent).toMatch(/^NOT SAVED/)
  })

  it('with the list failed nothing resolves through a taught name, so nothing is counted', async () => {
    aliasAnswer = () => Promise.reject(new Error('offline'))
    await say(['stupid chica', '3 count', 'next', 'Suyo Long', '3', 'next'])
    expect(counts()).toEqual([])
  })
})

describe('the count can never cost the save anything', () => {
  it('a count that fails leaves the save announced, recorded and undoable', async () => {
    patchAnswer = () => Promise.reject(new Error('Gateway Timeout'))
    await say(['cucumber one', '3', 'next'])
    expect(wire()).toEqual([['save', 'Suyo Long'], ['count', [[looseKey('cucumber one'), SUYO.variety_ref.id]]]])
    expect(screen.getByTestId('voice-harvest-status').textContent).toBe('Saved Suyo Long — 3 count · no weight was said (3 count assumed)')
    expect(screen.getAllByTestId('voice-harvest-row')).toHaveLength(1)
    expect(screen.queryAllByTestId('voice-harvest-miss')).toEqual([])
  })

  it('a count that never answers does not hold up the next record', async () => {
    patchAnswer = () => new Promise(() => {})
    const rec = await startListening()
    for (const line of ['cucumber one', '3', 'next']) await speak(rec, line)
    await settle()
    for (const line of ['Stupice', '5 count', 'next']) await speak(rec, line)
    await settle()
    expect(wire().filter(([k]) => k === 'save')).toEqual([['save', 'Suyo Long'], ['save', 'Stupice']])
    expect(screen.getByTestId('voice-harvest-status').textContent).toMatch(/^Saved Stupice/)
  })

  it('the count goes out only after the save has landed', async () => {
    let land
    eventAnswer = () => new Promise((res) => { land = () => res({ id: 'evt-1' }) })
    const rec = await startListening()
    for (const line of ['cucumber one', '3', 'next']) await speak(rec, line)
    await settle()
    expect(wire()).toEqual([['save', 'Suyo Long']])
    await act(async () => { land() })
    expect(wire()).toEqual([['save', 'Suyo Long'], ['count', [[looseKey('cucumber one'), SUYO.variety_ref.id]]]])
  })
})

describe('aliasUseOf', () => {
  const uses = indexAliasUses(LIVE)
  it('names the stored key and variety of the alias that chose the planting', () => {
    expect(aliasUseOf(uses, VOCAB, 'cucumber one', SUYO)).toEqual({ heard_key: 'cucumberone', variety_id: SUYO.variety_ref.id })
    expect(aliasUseOf(uses, VOCAB, 'Cucumber 1', SUYO)).toEqual({ heard_key: 'cucumberone', variety_id: SUYO.variety_ref.id })
  })
  it('never for another variety, a strict name, or no list', () => {
    expect(aliasUseOf(uses, VOCAB, 'cucumber one', byName('Big Boy'))).toBeNull()
    expect(aliasUseOf(uses, VOCAB, 'super sweet 100', byName('Super Sweet 100'))).toBeNull()
    expect(aliasUseOf(uses, VOCAB, 'suyo long', SUYO)).toBeNull()
    expect(aliasUseOf(null, VOCAB, 'cucumber one', SUYO)).toBeNull()
    expect(aliasUseOf(uses, VOCAB, null, SUYO)).toBeNull()
  })
})
