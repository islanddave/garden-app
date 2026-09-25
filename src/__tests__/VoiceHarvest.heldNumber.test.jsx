// What happens to a HELD number — one said without its unit, waiting for the next word to place it — when
// the next word names a crop. Both cases are device-proven on the real page (Dave's Android, 2026-09-25
// 11:48 ET, prod v4.150.0; gardening-docs project-state/voice-realpage-trace-20260925.md).
//
// BUG-VOICESAMECROPDROP-001 (M3 of that capture): he says "cucumber one 243", the 500 ms tick commits
// "cucumber" before "one" arrives, and every search was a crop change — so the held 243 was dropped
// "(crop changed)" although "cucumber" IS Suyo Long, the planting already chosen. A search whose hits are
// exactly the chosen planting now keeps the number held; every other search still drops it and says so.
//
// Page-level, through the shared fake recogniser, the real 244-name vocabulary and two of Dave's taught
// names, asserting the record card, the banner, the miss rows and the POSTed rows.
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
// Dave's taught names without "cucumber one", which he deleted on 2026-09-25 (voice_alias id 58).
const LIVE = [aliasRow('super sweet 100', 'Super Sweet 100'), aliasRow("damn i'll see you", 'Cucamelon')]

// Suyo Long is the only cucumber in the 2026-09-23 snapshot, as on prod (voice-realpage-trace-20260925.md),
// so "cucumber" names it alone. MARKETMORE is a second cucumber the snapshot does not hold, added only
// where a test needs "a different planting" or a crop name that answers with two.
const MARKETMORE = {
  id: '00000000-0000-4000-8000-00000000ffff', name: 'Marketmore', archived_at: null,
  variety_ref: { id: '00000000-0000-4000-9000-00000000ffff', name: 'Marketmore', crop_type_slug: 'cucumber', default_unit: null },
}

const ALIAS_URL = '/api/varieties/voice-aliases'
let mic
let plantings
beforeEach(() => {
  vi.clearAllMocks()
  mic = installFakeSpeechRecognition(vi)
  plantings = VOCAB
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url, opts) => {
    if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: plantings })
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
const nameOfId = (id) => [...VOCAB, MARKETMORE].find((p) => p.id === id)?.name
const saved = () => apiFetchSpy.mock.calls
  .filter(([url, opts]) => url === '/api/events' && opts?.method === 'POST')
  .map(([, opts]) => JSON.parse(opts.body))
  .map((b) => [nameOfId(b.plant_id), b.harvest.quantity, b.harvest.unit, b.harvest.weight ?? null, b.metadata.assumed_units])
const statusText = () => screen.getByTestId('voice-harvest-status').textContent
const misses = () => screen.queryAllByTestId('voice-harvest-miss').map((m) => m.textContent)
const slot = (label) => within(screen.getByTestId('voice-harvest-record')).getByText(label).nextSibling.textContent

describe('BUG-VOICESAMECROPDROP-001 — the same crop named again keeps the held number', () => {
  it('"Suyo Long", "243", "cucumber" — "cucumber" names Suyo Long alone, so 243 stays held', async () => {
    const rec = await startListening()
    await say(rec, 'Suyo Long', '243')
    expect(slot('Quantity')).toBe('243 count (assumed unless you say a unit)')
    await say(rec, 'cucumber')
    // Was: "Suyo Long — now say the count or the weight. (dropped 243 — no unit was said)" and a miss row.
    expect([slot('Crop'), slot('Quantity')]).toEqual(['Suyo Long', '243 count (assumed unless you say a unit)'])
    expect(statusText()).toBe('Suyo Long — now say the count or the weight.')
    expect(misses()).toEqual([])
    // Still held, not placed: the next word decides where it goes, exactly as if "cucumber" had not been said.
    await say(rec, 'next')
    expect(saved()).toEqual([['Suyo Long', 243, 'count', null, ['count']]])
  })

  it('the device shape: "Suyo Long", "1", "243", "cucumber", "next" saves the record he meant — 1 count · 243 g', async () => {
    const rec = await startListening()
    await say(rec, 'Suyo Long', '1', '243', 'cucumber', 'next')
    expect(saved()).toEqual([['Suyo Long', 1, 'count', 243, ['count', 'g']]])
    expect(misses()).toEqual([])
  })

  it('by the planting\'s own name and by a name he taught for it, too — the search\'s own taught names', async () => {
    const rec = await startListening()
    // "damn i'll see you" reaches Cucamelon only through his taught name (the learned layer); the check
    // asks the same matcher, with the same names, that the search branch then selects with.
    await say(rec, 'Cucamelon', '3', 'Cucamelon', "damn i'll see you")
    expect([slot('Crop'), slot('Quantity')]).toEqual(['Cucamelon', '3 count (assumed unless you say a unit)'])
    expect(misses()).toEqual([])
    await say(rec, '4', 'next')
    expect(saved()).toEqual([['Cucamelon', 3, 'count', 4, ['count', 'g']]])
  })

  it('"Suyo Long", "243", "Marketmore" — a different planting still drops the number, and says so', async () => {
    plantings = [...VOCAB, MARKETMORE]
    const rec = await startListening()
    await say(rec, 'Suyo Long', '243', 'Marketmore')
    expect([slot('Crop'), slot('Quantity')]).toEqual(['Marketmore', '—'])
    expect(statusText()).toBe('Marketmore — now say the count or the weight. (dropped 243 — no unit was said)')
    expect(misses()).toEqual(['Dropped 243 — no unit was said, and the crop changed before one was.'])
    await say(rec, 'next')
    expect(saved()).toEqual([])
  })

  it('a crop name that answers with more than the chosen planting is a list, not the same crop: dropped as before', async () => {
    plantings = [...VOCAB, MARKETMORE]
    const rec = await startListening()
    await say(rec, 'Suyo Long', '243', 'cucumber')
    expect(slot('Crop')).toBe('—')
    expect(statusText()).toBe('2 match “cucumber” — say more of the name, or tap one. (dropped 243 — no unit was said)')
    expect(misses()).toEqual(['Dropped 243 — no unit was said, and the crop changed before one was.'])
  })

  it('a name that matches nothing still drops it, and unselects the crop', async () => {
    const rec = await startListening()
    await say(rec, 'Suyo Long', '243', 'zzqq quux')
    expect(slot('Crop')).toBe('—')
    expect(misses()).toEqual([
      'Dropped 243 — no unit was said, and the crop changed before one was.',
      'Nothing matched “zzqq quux”.',
    ])
  })
})
