// REAL DEVICE CAPTURES, REPLAYED THROUGH THE REAL PAGE — the instrument, and its fidelity pins.
//
// Each fixture is a verbatim capture Dave pasted from Voice debug after a run on /log/harvest on his
// Android phone (gardening-docs project-state/, "Raw trace (verbatim, as pasted)"):
//   voicetrace-20260916.txt — 2026-09-16 10:34 ET, 139 entries, prod of that day (voice-realpage-trace-20260916.md)
//   voicetrace-20260925.txt — 2026-09-25 11:48 ET, 83 entries, prod v4.150.0 (voice-realpage-trace-20260925.md)
// Their `result`, `end` and `nomatch` lines are delivered to the page at their recorded offsets, in
// Chrome Android's own delivery shape (empty heads, cumulative finals, partial phrases a pause lets the
// tick commit); their `decision` lines are what the page on the phone DID, and are compared, never
// replayed. See helpers/voiceTraceReplay.js for what is replayed and why.
//
// WHAT IS PINNED, per capture: that every recorded input reaches the page, that the page re-records each
// result exactly as the phone recorded it, and that every recorded decision has a replayed decision in
// the same moment. If the replayer stops delivering, the last two go red.
//
// THE 09-16 DECISIONS ARE REPORTED, NOT ASSERTED (VOICE_REPLAY_OUT): that run was recorded on an older
// build, and one of its decisions has since changed on purpose (BUG-VOICEVALPAIRNOSEL-001). THE 09-25
// DECISIONS ARE ASSERTED, as a CHARACTERIZATION of the build that recorded them: they pin three open
// defects that capture shows (M1-M3 below), so the fix for each flips its assertion deliberately rather
// than passing unnoticed. Flip the one you fixed, and say so in the commit.
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

const fixture = (f) => fs.readFileSync(path.resolve(__dirname, 'fixtures', f), 'utf8')
const TRACE_0916 = fixture('voicetrace-20260916.txt')
const TRACE_0925 = fixture('voicetrace-20260925.txt')

// The taught names the oneBreath suite serves by default: three of Dave's (prod voice_alias) and the
// mishearing the alias suite teaches ("studio long"). "cucumber one" is his voice_alias id 58, taught
// 2026-09-15 08:09 ET against Suyo Long's variety; the 09-25 capture's one-breath decisions depend on it.
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
const text = (id) => screen.queryByTestId(id)?.textContent ?? null

// Replays a capture and returns what it delivered, the page's own replayed log, and a snapshot of the
// record card and banner after each dispatched input (keyed by the input's recorded offset).
async function replayCapture(capture) {
  const parsed = parseVoiceTrace(capture)
  vi.useFakeTimers({ now: new Date(parsed.startedAt), shouldAdvanceTime: false })
  render(<VoiceHarvest />)
  await advance(0)
  expect(apiFetchSpy).toHaveBeenCalledWith('/api/varieties/voice-aliases')
  const after = new Map()
  const run = await replayVoiceTrace(parsed.events, {
    act,
    advance,
    rec: () => mic.latest() ?? null,
    start: async () => { await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) }) },
    onEvent: (e) => { after.set(e.t, { record: text('voice-harvest-record'), banner: text('voice-harvest-status') }) },
  })
  await advance(3000)   // let a trailing settle tick and any POST land
  const log = replayedEntries(readVoiceDebugLog())
  const decisions = log.filter((e) => e.kind === 'decision').map(({ t, detail }) => ({ t, detail }))
  const out = {
    parsed, run, log, decisions, after,
    posts: posts().map((b) => ({
      planting: nameOfId(b.plant_id), quantity: b.harvest.quantity, unit: b.harvest.unit,
      weight_grams: b.harvest.weight ?? null, assumed_units: b.metadata?.assumed_units ?? null,
    })),
    banner: text('voice-harvest-status'),
    misses: screen.queryAllByTestId('voice-harvest-miss').map((m) => m.textContent),
  }
  return out
}

function report(name, r, rows, extra) {
  if (!process.env.VOICE_REPLAY_OUT) return
  fs.writeFileSync(`${process.env.VOICE_REPLAY_OUT}-${name}.json`, JSON.stringify({
    rows, extra, posts: r.posts, banner: r.banner, misses: r.misses, log: r.log, mismatches: r.run.mismatches,
    after: Object.fromEntries(r.after),
  }, null, 2))
}

describe.each([
  ['20260916', TRACE_0916, { startedAt: '2026-09-16T14:34:06.488Z', entries: 139, counts: [19, 78, 19, 3, 20],
    first: { t: 2715, detail: 'search "cucumber" <- "cucumber"' } }],
  ['20260925', TRACE_0925, { startedAt: '2026-09-25T15:48:50.800Z', entries: 83, counts: [9, 42, 9, 3, 20],
    first: { t: 3783, detail: 'search "cucumber one" <- "cucumber one"' } }],
])('the %s capture', (name, capture, want) => {
  it('parses as it was recorded — every result row consistent with its header', () => {
    const { startedAt, events, problems } = parseVoiceTrace(capture)
    expect(problems).toEqual([])
    expect(startedAt).toBe(want.startedAt)
    expect(events).toHaveLength(want.entries)
    const count = (k) => events.filter((e) => e.kind === k).length
    expect([count('start'), count('result'), count('end'), count('nomatch'), count('decision')]).toEqual(want.counts)
    expect(recordedDecisions(events)[0]).toEqual(want.first)
  })

  it('delivers every recorded input, and the page re-records each result exactly as the phone did', async () => {
    const { parsed, run, log } = await replayCapture(capture)
    const recorded = parsed.events

    expect(run.mismatches).toEqual([])
    const n = (k) => recorded.filter((e) => e.kind === k).length
    expect(run.dispatched).toEqual({ start: 1, result: n('result'), end: n('end'), nomatch: n('nomatch'), error: 0 })

    // The page records every onresult FIRST, before its own filtering (VoiceHarvest.jsx arm()). So
    // its replayed log must hold the recorded result list, entry for entry, at the recorded offsets.
    const strip = (e) => ({ t: e.t, resultIndex: e.resultIndex, len: e.len, results: e.results })
    const raw = readVoiceDebugLog()
    const replayedResults = raw.filter((e) => e.src === 'voiceharvest' && e.kind === 'result')
    expect(replayedResults.map((e) => strip({ ...e, t: e.t - raw[0].t })))
      .toEqual(recorded.filter((e) => e.kind === 'result').map(strip))

    // Lifecycle marks at the recorded moments. `start` is the page's own re-arm, which the fake
    // performs synchronously at the `end`; the phone's came 10-130 ms later.
    for (const k of ['end', 'nomatch']) {
      expect(log.filter((e) => e.kind === k).map((e) => e.t)).toEqual(recorded.filter((e) => e.kind === k).map((e) => e.t))
    }
  })

  it('every recorded decision has a replayed decision in the same moment (±60 ms)', async () => {
    const r = await replayCapture(capture)
    const recorded = recordedDecisions(r.parsed.events)
    const { rows, extra } = alignDecisions(recorded, r.decisions, 60)
    report(name, r, rows, extra)
    // A WINDOW TEST, NOT A 1:1 MATCH: the page decided SOMETHING at each recorded moment. What it decided
    // is the page's business (reported above, characterized below); a replayer that stops delivering
    // leaves windows empty, and that is what this catches. Mutation-checked: a product change that
    // removes one decision of a pair still passes here, and no delivery / no end / no clock fails it.
    const empty = recorded.filter((d) => !r.decisions.some((x) => Math.abs(x.t - d.t) <= 60))
    expect(empty).toEqual([])
    expect(r.decisions.length).toBeGreaterThan(0)
  })
})

// ── CHARACTERIZATION: 2026-09-25, replayed on the build that recorded it ──────────────────────────────
//
// Dave meant Suyo Long, 1 count, 243 g, four times in 38 s (analysis: voice-realpage-trace-20260925.md).
// Nothing saved. Each pin below is a defect that capture shows, stated as the build does it today; the
// comment on each says what its fix should turn it into. Flip only the one you fixed.
describe('the 2026-09-25 capture on the build that recorded it — CHARACTERIZATION of three open defects', () => {
  const idx = (list, detail, from = 0) => list.findIndex((d, i) => i >= from && d === detail)

  it('reproduces every recorded decision, verbatim and in order, and saves nothing (as on prod)', async () => {
    const r = await replayCapture(TRACE_0925)
    expect(r.decisions.map((d) => d.detail)).toEqual(recordedDecisions(r.parsed.events).map((d) => d.detail))
    expect(r.posts).toEqual([])
  })

  it('M1 — the taught name "cucumber one" takes the spoken count: 243 lands as the COUNT, no 1 anywhere', async () => {
    // judgeBareReading (VoiceHarvest.jsx:502-508, lane D4 BLOCKING-2) marks "cucumber" + [1, 243]
    // invalid because the name runs on into the taught alias, leaving "cucumber one" + [243]. A fix
    // reads 1 count · 243 g here (or refuses out loud) — it must not hold 243 for the count slot.
    const r = await replayCapture(TRACE_0925)
    const ds = r.decisions.map((d) => d.detail)
    const oneBreath = 'one-breath-bare Suyo Long 243 <- "cucumber one 243"'
    expect(ds.filter((d) => d === oneBreath)).toHaveLength(3)
    for (let from = 0, i; (i = idx(ds, oneBreath, from)) >= 0; from = i + 1) {
      expect(ds[i + 1]).toBe('held-number 243 <- "243"')
    }
    const card = r.after.get(4000).record   // the session end that committed "cucumber one 243"
    expect(card).toContain('CropSuyo Long')
    expect(card).toContain('Quantity243 count (assumed unless you say a unit)')
    expect(card).toContain('Weight—')
  })

  it('M2 — Chrome\'s re-render "1 to" -> "1 243" is committed as TWO utterances, and the first drops 243 and the crop', async () => {
    // voiceCommitDebounce.js:186 supersedes only a TEXT extension; "1 243" does not extend "1 to", so
    // case 4 (:206-208) commits "1 to" as its own utterance — a search, which is a crop change
    // (VoiceHarvest.jsx:1606). A fix keeps the revision one utterance: no "1 to" search, 243 not dropped.
    const r = await replayCapture(TRACE_0925)
    const ds = r.decisions.map((d) => d.detail)
    const i = idx(ds, 'search "1 to" <- "1 to"')
    expect(i).toBeGreaterThan(0)
    expect(ds.slice(i - 1, i + 2)).toEqual([
      'held-dropped 243 (crop changed)', 'search "1 to" <- "1 to"', 'search "1 243" <- "1 243"',
    ])
    expect(r.after.get(14838).record).toContain('Crop—')
    expect(r.after.get(14838).banner).toBe('Nothing matched “1 to”. Say it again, or pick it below to teach me. (dropped 243 — no unit was said)')
    expect(r.after.get(14858).banner).toBe('Nothing matched “1 243”. Say it again, or pick it below to teach me.')
  })

  it('M3 — "cucumber" re-selecting the SAME planting still drops the held number', async () => {
    // changesCrop (VoiceHarvest.jsx:1606) is true for every search, so a held number is dropped even when
    // the search lands on the planting already selected. A fix keeps it ("the same crop named again keeps
    // it", Dave's rule for the queued "next").
    const r = await replayCapture(TRACE_0925)
    const ds = r.decisions.map((d) => d.detail)
    const droppedBySameCrop = ds.flatMap((d, i) => {
      const m = /^held-dropped (\d+) \(crop changed\)$/.exec(d)
      return m && ds[i + 1] === 'search "cucumber" <- "cucumber"' ? [m[1]] : []
    })
    expect(droppedBySameCrop).toEqual(['243', '3'])
    // Before the tick: Suyo Long with a held number. After it: still Suyo Long, the number gone.
    for (const [before, afterTick, held] of [[25122, 25914, '243'], [32057, 32854, '3']]) {
      expect(r.after.get(before).record).toContain(`CropSuyo LongQuantity${held} count (assumed`)
      expect(r.after.get(afterTick).record).toContain('CropSuyo LongQuantity—')
      expect(r.after.get(afterTick).banner).toBe(`Suyo Long — now say the count or the weight. (dropped ${held} — no unit was said)`)
    }
  })
})
