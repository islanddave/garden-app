// A REAL DEVICE CAPTURE, REPLAYED THROUGH THE REAL PAGE — the instrument, and its fidelity pins.
//
// The fixture is the verbatim capture Dave pasted from Voice debug after a run on /log/harvest on his
// Android phone, 2026-09-16 10:34 ET (139 entries, gardening-docs
// project-state/voice-realpage-trace-20260916.md, "Raw trace (verbatim, as pasted)"). Its `result`,
// `end` and `nomatch` lines are delivered to the page at their recorded offsets, in Chrome Android's own
// delivery shape (empty heads, cumulative finals, partial phrases a pause lets the tick commit); its 20
// `decision` lines are what the page on the phone DID, and are compared, never replayed. See
// helpers/voiceTraceReplay.js for what is replayed and why.
//
// WHAT IS PINNED HERE is the instrument, not the page's behaviour: that every recorded input reaches
// the page, that the page re-records each result exactly as the phone recorded it, and that every
// recorded decision has a replayed decision in the same moment. If the replayer stops delivering, the
// last two go red. What the page DECIDED in each window is reported (VOICE_REPLAY_OUT), not asserted —
// those are findings about the page, and a fix to one must not have to fight this file.
//
// Harness as the oneBreath and cropSwitch suites: the shared fake recogniser, the 244-name vocabulary,
// Dave's taught names, api and haptics mocked. Fake timers with shouldAdvanceTime OFF, so the page's
// settle tick fires exactly when the recorded gaps say it does.
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import {
  parseVoiceTrace, replayVoiceTrace, recordedDecisions, replayedEntries, alignDecisions,
} from './helpers/voiceTraceReplay.js'

installStoragePolyfill()

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/haptics.js', () => ({
  hapticSaveCommitted: vi.fn(), hapticSaveFailed: vi.fn(),
  hapticDigitAccepted: vi.fn(), hapticDigitRejected: vi.fn(), hapticUndoApplied: vi.fn(),
  hapticMatchUncertain: vi.fn(),
}))

import VoiceHarvest from '../pages/VoiceHarvest.jsx'
import { setVoiceDebugEnabled, readVoiceDebugLog } from '../lib/voiceDebug.js'
import { looseKey } from '../lib/comboboxInput.js'
import { VOCAB, byName } from './voiceHarvest.vocabulary.fixture.js'

const TRACE = fs.readFileSync(path.resolve(__dirname, 'fixtures/voicetrace-20260916.txt'), 'utf8')

// The taught names the oneBreath suite serves by default: three of Dave's (prod voice_alias) and the
// mishearing the alias suite teaches ("studio long").
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

let mic
let postSeq = 0
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  setVoiceDebugEnabled(true)
  mic = installFakeSpeechRecognition(vi)
  postSeq = 0
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url, opts) => {
    if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: VOCAB })
    if (url === '/api/varieties/voice-aliases' && !opts?.method) return Promise.resolve({ aliases: DAVE_ALIASES })
    if (url === '/api/events' && opts?.method === 'POST') return Promise.resolve({ id: `evt-${++postSeq}` })
    return Promise.resolve({})
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear() })

const advance = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const posts = () => apiFetchSpy.mock.calls
  .filter(([url, opts]) => url === '/api/events' && opts?.method === 'POST')
  .map(([, opts]) => JSON.parse(opts.body))
const nameOfId = (id) => VOCAB.find((p) => p.id === id)?.name ?? id

async function replayCapture(text) {
  const parsed = parseVoiceTrace(text)
  vi.useFakeTimers({ now: new Date(parsed.startedAt ?? '2026-09-16T14:34:06.488Z'), shouldAdvanceTime: false })
  render(<VoiceHarvest />)
  await advance(0)
  expect(apiFetchSpy).toHaveBeenCalledWith('/api/varieties/voice-aliases')
  const run = await replayVoiceTrace(parsed.events, {
    act,
    advance,
    rec: () => mic.latest() ?? null,
    start: async () => { await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) }) },
  })
  await advance(3000)   // let a trailing settle tick and any POST land
  const log = replayedEntries(readVoiceDebugLog())
  return { parsed, run, log }
}

describe('the 2026-09-16 capture parses as it was recorded', () => {
  it('139 entries, every result row consistent with its header, 20 decisions', () => {
    const { startedAt, events, problems } = parseVoiceTrace(TRACE)
    expect(problems).toEqual([])
    expect(startedAt).toBe('2026-09-16T14:34:06.488Z')
    expect(events).toHaveLength(139)
    const count = (k) => events.filter((e) => e.kind === k).length
    expect([count('start'), count('result'), count('end'), count('nomatch'), count('decision')]).toEqual([19, 78, 19, 3, 20])
    expect(recordedDecisions(events)[0]).toEqual({ t: 2715, detail: 'search "cucumber" <- "cucumber"' })
  })
})

describe('replayed through the real page', () => {
  it('delivers every recorded input, and the page re-records each result exactly as the phone did', async () => {
    const { parsed, run, log } = await replayCapture(TRACE)
    const recorded = parsed.events

    expect(run.mismatches).toEqual([])
    const n = (k) => recorded.filter((e) => e.kind === k).length
    expect(run.dispatched).toEqual({ start: 1, result: n('result'), end: n('end'), nomatch: n('nomatch'), error: 0 })

    // The page records every onresult FIRST, before its own filtering (VoiceHarvest.jsx arm()). So
    // its replayed log must hold the recorded result list, entry for entry, at the recorded offsets.
    const strip = (e) => ({ t: e.t, resultIndex: e.resultIndex, len: e.len, results: e.results })
    const replayedResults = readVoiceDebugLog().filter((e) => e.src === 'voiceharvest' && e.kind === 'result')
    const t0 = readVoiceDebugLog()[0].t
    expect(replayedResults.map((e) => strip({ ...e, t: e.t - t0 })))
      .toEqual(recorded.filter((e) => e.kind === 'result').map(strip))

    // Lifecycle marks at the recorded moments. `start` is the page's own re-arm, which the fake
    // performs synchronously at the `end`; the phone's came 10-130 ms later.
    for (const k of ['end', 'nomatch']) {
      expect(log.filter((e) => e.kind === k).map((e) => e.t)).toEqual(recorded.filter((e) => e.kind === k).map((e) => e.t))
    }
  })

  it('every recorded decision has a replayed decision in the same moment (±60 ms)', async () => {
    const { parsed, log } = await replayCapture(TRACE)
    const recorded = recordedDecisions(parsed.events)
    const replayed = log.filter((e) => e.kind === 'decision').map(({ t, detail }) => ({ t, detail }))
    const { rows, extra } = alignDecisions(recorded, replayed, 60)

    if (process.env.VOICE_REPLAY_OUT) {
      fs.writeFileSync(process.env.VOICE_REPLAY_OUT, JSON.stringify({
        rows, extra,
        posts: posts().map((b) => ({
          planting: nameOfId(b.plant_id), quantity: b.harvest.quantity, unit: b.harvest.unit,
          weight_grams: b.harvest.weight ?? null, assumed_units: b.metadata?.assumed_units ?? null,
        })),
        banner: screen.getByTestId('voice-harvest-status').textContent,
        misses: screen.queryAllByTestId('voice-harvest-miss').map((m) => m.textContent),
        log,
      }, null, 2))
    }

    expect(rows.filter((r) => r.status === 'missing').map((r) => r.recorded)).toEqual([])
    expect(rows).toHaveLength(20)
  })
})
