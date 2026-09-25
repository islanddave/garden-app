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
// DECISIONS ARE ASSERTED, as a CHARACTERIZATION: first of the build that recorded them (the phone's own
// decisions, verbatim), now of this build. They pin three defects that capture shows (M1-M3 below), so
// the fix for each flips its assertion deliberately rather than passing unnoticed. Flip the one you
// fixed, and say so in the commit; a fix that changes what later decisions see updates those too.
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
// The same set as it stands since Dave deleted "cucumber one" (voice_alias id 58, 2026-09-25 ~12:15 ET) —
// M1 resolved as data, on his approval, rather than in code.
const CURRENT_ALIASES = DAVE_ALIASES.filter((a) => a.heard_text !== 'cucumber one')

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
// record card and banner after each dispatched input (keyed by the input's recorded offset). `aliases`
// is the taught-name list the page loads; the default is the set the captures were recorded with.
async function replayCapture(capture, { aliases = DAVE_ALIASES } = {}) {
  if (aliases !== DAVE_ALIASES) {
    const base = apiFetchSpy.getMockImplementation()
    apiFetchSpy.mockImplementation((url, opts) => (url === '/api/varieties/voice-aliases' && !opts?.method
      ? Promise.resolve({ aliases }) : base(url, opts)))
  }
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
    record: text('voice-harvest-record'),
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

// ── CHARACTERIZATION: 2026-09-25, replayed on THIS build, with the taught names it was recorded with ───
//
// Dave meant Suyo Long, 1 count, 243 g, four times in 38 s (analysis: voice-realpage-trace-20260925.md).
// Nothing saved. The replay lane pinned three defects that capture shows, as the recording build did them;
// each fix flips its own pin and says so in its commit, and a fix that changes the record the LATER
// decisions see updates their pins too, saying so where it does:
//   M1 — the taught name "cucumber one" takes the spoken count. Open in code by decision: it was resolved as
//        DATA (Dave deleted the name, voice_alias id 58, 2026-09-25 ~12:15 ET). Pinned with the name loaded.
//   M2 — Chrome's re-render "1 to" -> "1 243" committed as two utterances. FIXED, BUG-VOICEREVISIONSPLIT-001.
//   M3 — naming the same crop again drops the held number. FIXED, BUG-VOICESAMECROPDROP-001.
// On the recording build this list was the phone's own, verbatim (the replay lane's fidelity result).
const EXPECTED_0925 = [
  'search "cucumber one" <- "cucumber one"',
  'one-breath-bare Suyo Long 243 <- "cucumber one 243"',
  'held-number 243 <- "243"',
  // M2 FIXED — was: held-dropped 243 (crop changed) · search "1 to" · search "1 243".
  'one-breath-bare (selected crop) 1 | 243 <- "1 243"',
  'held-number 1 <- "1"',
  'assumed-unit 1 count (held number resolved)',
  'held-number 243 <- "243"',
  // M3 FIXED — every "cucumber" / "cucumber one" below names the chosen planting only, so the held number
  // stays held (was: held-dropped … (crop changed) before three of them).
  'held-kept 243 (same crop named again)',
  'search "cucumber" <- "cucumber"',
  'held-kept 243 (same crop named again)',
  'search "cucumber one" <- "cucumber one"',
  'one-breath-bare Suyo Long 243 <- "cucumber one 243"',
  'held-repeat 243 <- "243"',
  'held-kept 243 (same crop named again)',
  'search "cucumber" <- "cucumber"',
  'held-kept 243 (same crop named again)',
  'search "cucumber one" <- "cucumber one"',
  // The 243 kept this long takes the weight when "three" arrives: 1 count · 243 g, and 3 held with no slot.
  'assumed-unit 243 g (held number resolved)',
  'held-number 3 <- "three"',
  'held-kept 3 (same crop named again)',
  'search "cucumber" <- "cucumber"',
  'held-kept 3 (same crop named again)',
  'search "cucumber" <- "cucumber"',
  'held-kept 3 (same crop named again)',
  'search "cucumber one" <- "cucumber one"',
  'one-breath-bare Suyo Long 243 <- "cucumber one 243"',
  // Both slots are full, so the 3 is dropped by the filled-slot rule (placeHeld) — said, not a crop change.
  'held-dropped 3 (no empty slot)',
  'held-number 243 <- "243"',
]

describe('the 2026-09-25 capture on this build — CHARACTERIZATION (M1 open, M2 and M3 fixed)', () => {
  const idx = (list, detail, from = 0) => list.findIndex((d, i) => i >= from && d === detail)

  it('makes exactly these decisions, in order, and saves nothing (the capture has no "next")', async () => {
    const r = await replayCapture(TRACE_0925)
    expect(r.decisions.map((d) => d.detail)).toEqual(EXPECTED_0925)
    expect(r.posts).toEqual([])
  })

  it('M1 — the taught name "cucumber one" takes the spoken count: 243 lands as the COUNT, no 1 from the sentence', async () => {
    // judgeBareReading (VoiceHarvest.jsx:502-508, lane D4 BLOCKING-2) marks "cucumber" + [1, 243]
    // invalid because the name runs on into the taught alias, leaving "cucumber one" + [243]. Resolved as
    // data, not code: the name is deleted (see the current-aliases replay below).
    const r = await replayCapture(TRACE_0925)
    const oneBreath = 'one-breath-bare Suyo Long 243 <- "cucumber one 243"'
    // What each reading did with its amounts: the decisions made for the same utterance. Only ever the 243;
    // what happens to it depends on the record it meets, which M2's and M3's fixes changed (was: a fresh
    // held-number 243 all three times).
    const followUps = r.decisions.flatMap((d, i) => (d.detail !== oneBreath ? []
      : [r.decisions.slice(i + 1).filter((x) => x.t === d.t).map((x) => x.detail)]))
    expect(followUps).toEqual([
      ['held-number 243 <- "243"'],
      ['held-repeat 243 <- "243"'],
      ['held-dropped 3 (no empty slot)', 'held-number 243 <- "243"'],
    ])
    const card = r.after.get(4000).record   // the session end that committed "cucumber one 243"
    expect(card).toContain('CropSuyo Long')
    expect(card).toContain('Quantity243 count (assumed unless you say a unit)')
    expect(card).toContain('Weight—')
  })

  it('M2 FIXED (BUG-VOICEREVISIONSPLIT-001) — Chrome\'s re-render "1 to" -> "1 243" is ONE utterance: no "1 to", the crop and 243 kept', async () => {
    // WAS, on the recording build: the debouncer superseded only a TEXT extension, "1 243" does not extend
    // "1 to", so "1 to" committed as its own utterance — a search, a crop change: held-dropped 243 (crop
    // changed), search "1 to", search "1 243", the crop cleared and "Nothing matched" twice. NOW the
    // supersede rule is asked of the number-folded text too ("1 to" folds to "1 2", a prefix of "1 243"),
    // so the revision commits once, at the session end, and is read with Suyo Long still chosen.
    const r = await replayCapture(TRACE_0925)
    const ds = r.decisions.map((d) => d.detail)
    expect(ds.filter((d) => d.includes('"1 to"'))).toEqual([])
    const i = idx(ds, 'one-breath-bare (selected crop) 1 | 243 <- "1 243"')
    expect(i).toBeGreaterThan(0)
    expect(ds.slice(i, i + 4)).toEqual([
      'one-breath-bare (selected crop) 1 | 243 <- "1 243"', 'held-number 1 <- "1"',
      'assumed-unit 1 count (held number resolved)', 'held-number 243 <- "243"',
    ])
    // "1 243" is still pending when it arrives; nothing was committed in between, so nothing changed.
    expect(r.after.get(14838).record).toContain('CropSuyo LongQuantity243 count (assumed unless you say a unit)')
    expect(r.after.get(14858).record).toContain('CropSuyo LongQuantity1 countWeight243 g (assumed unless you say a unit)')
    expect(r.after.get(14858).banner).toBe('243 — say a unit to change it, or carry on. (1 count assumed)')
    expect(r.misses.filter((m) => m.startsWith('Nothing matched'))).toEqual([])
  })

  it('M3 FIXED (BUG-VOICESAMECROPDROP-001) — "cucumber" re-selecting the SAME planting keeps the held number', async () => {
    // WAS, on the recording build: changesCrop was true for every search, so the tick-committed "cucumber"
    // dropped the held 243 (+25626) and the held 3 (+32562) "(crop changed)" although "cucumber" IS Suyo
    // Long, already chosen. NOW a search whose hits are exactly the chosen planting keeps the number held —
    // "the same crop named again keeps it", Dave's rule for the queued "next".
    const r = await replayCapture(TRACE_0925)
    const ds = r.decisions.map((d) => d.detail)
    expect(ds.filter((d) => d.endsWith('(crop changed)'))).toEqual([])
    const kept = ds.flatMap((d, i) => {
      const m = /^held-kept (\d+) \(same crop named again\)$/.exec(d)
      return m ? [[m[1], ds[i + 1]]] : []
    })
    expect(kept).toEqual([
      ['243', 'search "cucumber" <- "cucumber"'], ['243', 'search "cucumber one" <- "cucumber one"'],
      ['243', 'search "cucumber" <- "cucumber"'], ['243', 'search "cucumber one" <- "cucumber one"'],
      ['3', 'search "cucumber" <- "cucumber"'], ['3', 'search "cucumber" <- "cucumber"'],
      ['3', 'search "cucumber one" <- "cucumber one"'],
    ])
    // Before the tick and after it: Suyo Long, 1 count, the held number still on the card — the two moments
    // the recording build dropped it, and the new first one M2's fix creates (+17969).
    for (const [before, afterTick] of [[17465, 18252], [25122, 25914]]) {
      expect(r.after.get(before).record).toContain('CropSuyo LongQuantity1 countWeight243 g (assumed unless you say a unit)')
      expect(r.after.get(afterTick).record).toContain('CropSuyo LongQuantity1 countWeight243 g (assumed unless you say a unit)')
      expect(r.after.get(afterTick).banner).toBe('Suyo Long — now say the count or the weight.')
    }
    // The held 3 meets a full record (1 count · 243 g): kept through three namings, dropped only by the
    // filled-slot rule when the next amount arrives, and said.
    expect(r.after.get(32854).banner).toBe('Suyo Long — now say the count or the weight.')
    expect(r.misses.filter((m) => m.startsWith('Dropped'))).toEqual([
      'Dropped 3 — no unit was said, and the quantity and weight were already filled.',
    ])
  })
})

// ── The same capture with the taught names Dave has NOW ────────────────────────────────────────────────
//
// M1 was resolved as data: Dave deleted "cucumber one" (voice_alias id 58) at ~12:15 ET on 2026-09-25, on his
// own approval. With it gone, "cucumber one 243" reads as "cucumber" + 1, 243 — the record he meant — and
// with M2 and M3 fixed nothing he said about it is lost. The capture has no "next", so this asserts the
// record card (the refs it renders: the crop, the quantity, the held number in the slot it will take), not
// a POST.
describe('the 2026-09-25 capture on this build, with the taught names as they stand now ("cucumber one" deleted)', () => {
  it('ends as Suyo Long · 1 count · 243 g, and never drops the 243', async () => {
    const r = await replayCapture(TRACE_0925, { aliases: CURRENT_ALIASES })
    const ds = r.decisions.map((d) => d.detail)
    expect(r.posts).toEqual([])
    // Each of the four tries now reads the count: "cucumber one 243" as "cucumber" + 1 | 243, and "1 243".
    expect(ds.filter((d) => d === 'one-breath-bare Suyo Long one | 243 <- "cucumber one 243"')).toHaveLength(3)
    expect(ds).toContain('one-breath-bare (selected crop) 1 | 243 <- "1 243"')
    // The first try already reaches the record he meant, and every later one restates it.
    expect(r.after.get(4000).record).toContain('CropSuyo LongQuantity1 countWeight243 g (assumed unless you say a unit)')
    expect(r.record).toContain('CropSuyo LongQuantity1 countWeight243 g (assumed unless you say a unit)')
    // No crop change, no search that matched nothing, and the 243 is never dropped.
    expect(ds.filter((d) => d.endsWith('(crop changed)'))).toEqual([])
    expect(ds.filter((d) => /^held-dropped 243\b/.test(d))).toEqual([])
    expect(r.misses.filter((m) => m.startsWith('Nothing matched'))).toEqual([])
    // NOT "no drops at all", and on purpose. Each "cucumber one" the 500 ms tick commits ahead of its "243"
    // is a sentence of its own — Suyo Long + 1 — and twice that 1 (and once a lone "three") meets a record
    // whose count and weight are both filled, where the filled-slot rule drops a unit-less number and says
    // so rather than overwrite a slot with a guess. Those two rows restate values already on the record;
    // they are pinned here as what this build does, and reported (voice-fixes-20260925.md).
    expect(r.misses.filter((m) => m.startsWith('Dropped'))).toEqual([
      'Dropped 1 — no unit was said, and the quantity and weight were already filled.',
      'Dropped 3 — no unit was said, and the quantity and weight were already filled.',
    ])
    expect(ds.filter((d) => d.startsWith('held-dropped'))).toEqual(['held-dropped 1 (no empty slot)', 'held-dropped 3 (no empty slot)'])
  })
})
