// MEASUREMENT, NOT A GUARD. Skipped unless VOICE_REPLAY_BATTERY names a JSON file to write, so it pins
// nothing and cannot go red; a skipped run here means "not measured", never "passed".
//
//   VOICE_REPLAY_BATTERY=/tmp/battery.json [VOICE_REPLAY_SEEDS=1,2,3] [VOICE_REPLAY_POST_MS=0,1500] \
//     npx vitest run src/__tests__/VoiceHarvest.traceBattery.measure.test.jsx
//
// V5-VOICEVOCAB-001 (a count and a weight said WITHOUT "count"/"grams") under Chrome Android's real
// delivery shape, which none of its verification ever used: every page test fed one final per quoted
// string. The sessions here are SYNTHETIC — built by helpers/voiceTraceReplay.js chromeTrace() in the
// shape measured on Dave's phone 2026-09-16 (empty heads, cumulative finals 150-450 ms apart, a >=520 ms
// pause the settle tick commits a partial phrase in, end, re-arm) — and the transcripts are MODELLED
// renderings of what Chrome could return, not device evidence. The plants and values are the ones Dave
// harvested by voice on 2026-09-25 (prod rows, count / grams).
//
// Each case is a fresh page, one record, replayed through the real page with the 244-name vocabulary and
// Dave's taught names; the SEQUENCE runs say all twelve records in one page visit, optionally with a
// slow POST, to catch what one record leaves behind for the next. Every POST, the final banner and every
// miss row are written out; classification (CORRECT / REFUSED-LOUD / WRONG-SAVE / SILENT) is done here
// against what the rendering SAID.
import React from 'react'
import fs from 'node:fs'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { chromeTrace, grow, replayVoiceTrace, replayedEntries } from './helpers/voiceTraceReplay.js'

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

const OUT = process.env.VOICE_REPLAY_BATTERY
const SEEDS = (process.env.VOICE_REPLAY_SEEDS ?? '1').split(',').map(Number)
const POST_MS = (process.env.VOICE_REPLAY_POST_MS ?? '0').split(',').map(Number)

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

// 2026-09-25's voice harvests, count / grams, as saved on prod. `say` is the name as Chrome is modelled
// to return it: lowercase, and "Cherry Rescue 1" with its digit (Chrome re-renders number words late).
const PLANTS = [
  { name: 'Suyo Long', say: 'suyo long', c: 2, w: 126 },
  { name: 'Dragon Roll', say: 'dragon roll', c: 2, w: 22 },
  { name: 'Ghost', say: 'ghost', c: 1, w: 3 },
  { name: 'Piri Piri', say: 'piri piri', c: 1, w: 1 },
  { name: 'Pineapple Tomatillo', say: 'pineapple tomatillo', c: 5, w: 7 },
  { name: 'Peach tree', say: 'peach tree', c: 8, w: 763 },
  { name: 'Black Cherry', say: 'black cherry', c: 3, w: 43 },
  { name: 'Cherry Rescue 1', say: 'cherry rescue 1', c: 1, w: 47 },
  { name: "Czech's Bush", say: "czech's bush", c: 1, w: 18 },
  { name: 'San Marzano Roma', say: 'san marzano roma', c: 1, w: 23 },
  { name: 'Sun Sugar', say: 'sun sugar', c: 3, w: 17 },
  { name: 'Yellow Pear', say: 'yellow pear', c: 1, w: 13 },
]
const HOMOPHONE = { 1: 'won', 2: 'to', 4: 'for', 8: 'ate' }
const WORD = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine' }

const NEXT = [{ text: 'next' }]
const nWords = (s) => s.split(' ').filter(Boolean).length
const cat = (...parts) => parts.filter(Boolean).join(' ')

// Every rendering for one plant. `units` false = the unit-less form under test; true = the control, with
// "count" and "G" spoken (Chrome's usual rendering of grams). Ids follow the brief: R1..R7, R4a-d.
function renderings(p, units) {
  const c = String(p.c)
  const w = String(p.w)
  const cTok = units ? `${c} count` : c
  const wTok = units ? `${w} G` : w
  const n = nWords(p.say)
  const out = [
    { id: 'R1', label: 'separate sessions, digits', sessions: [grow(p.say), grow(cTok), grow(wTok), NEXT] },
    { id: 'R2', label: 'one session, pauses after the name and after the count',
      sessions: [grow(cat(p.say, cTok, wTok), [n, n + nWords(cTok)]), NEXT] },
    { id: 'R3', label: 'one breath, "next" included', sessions: [grow(cat(p.say, cTok, wTok, 'next'))] },
  ]
  // After a pause, Chrome's next final re-renders the whole phrase with digits; with units spoken it
  // arrives without its trailing "G" first, then with it (as "big boy one count 100" -> "... 100 G").
  const rerendered = units
    ? [{ text: cat(p.say, cTok, w), pause: true }, { text: cat(p.say, cTok, wTok) }]
    : [{ text: cat(p.say, cTok, wTok), pause: true }]
  // The same re-render arriving INSIDE the settle window, no pause; `head` is everything before the weight.
  const rerenderedNow = (head) => (units ? [{ text: cat(head, w) }, { text: cat(head, wTok) }] : [{ text: cat(head, wTok) }])
  const h = HOMOPHONE[p.c]
  if (h) {
    const hTok = units ? `${h} count` : h
    // R1 shape: the count's own session delivers the homophone, then (WITH) Chrome's digit re-render.
    out.push({ id: 'R4a', label: `R1 shape, "${h}" then re-rendered "${cTok}"`,
      sessions: [grow(p.say), [...grow(hTok), { text: cTok }], grow(wTok), NEXT] })
    out.push({ id: 'R4b', label: `R1 shape, "${h}" never re-rendered`,
      sessions: [grow(p.say), grow(hTok), grow(wTok), NEXT] })
    // R2 shape: the tick commits "<name> <homophone>" in the pause; the next final re-renders it (WITH)
    // or keeps it (WITHOUT).
    out.push({ id: 'R4c', label: `R2 shape, "${cat(p.say, h)}" then re-rendered "${cat(p.say, cTok, wTok)}"`,
      sessions: [[...grow(cat(p.say, hTok), [n]), ...rerendered], NEXT] })
    out.push({ id: 'R4d', label: `R2 shape, "${cat(p.say, h)}" kept, "${cat(p.say, hTok, wTok)}"`,
      sessions: [grow(cat(p.say, hTok, wTok), [n, n + nWords(hTok)]), NEXT] })
    // DEVICE-CONFIRMED SHAPE, 2026-09-25 capture (M2): the homophone is re-rendered as digits in the NEXT
    // final of the same session, inside the settle window — "1" -> "1 to" -> "1 243", 339 ms — not after a
    // pause. Added beyond the brief's R4 list: R4e with the name, R8hc as its own session after the name.
    out.push({ id: 'R4e', label: `"${cat(p.say, h)}" re-rendered inside the settle window`,
      sessions: [[...grow(cat(p.say, hTok)), ...rerenderedNow(cat(p.say, cTok))], NEXT] })
    out.push({ id: 'R8hc', label: `"<name>" | "${h}" -> "${cat(cTok, wTok)}" inside the window | "next"`,
      sessions: [grow(p.say), [...grow(hTok), ...rerenderedNow(cTok)], NEXT] })
  }
  // The same device shape with the homophone at the start of the WEIGHT ("forty three" heard first as
  // "for"), which is where the 09-25 capture had it ("two forty three" -> "to").
  const hw = p.w >= 40 && p.w < 50 ? 'for' : p.w >= 200 && p.w < 300 ? 'to' : (p.w >= 80 && p.w < 90) || (p.w >= 800 && p.w < 900) ? 'ate' : null
  if (hw) {
    out.push({ id: 'R8hw', label: `"<name>" | "${cTok}" -> "${cat(cTok, hw)}" -> "${cat(cTok, wTok)}" inside the window | "next"`,
      sessions: [grow(p.say), [...grow(cTok), { text: cat(cTok, hw) }, ...rerenderedNow(cTok)], NEXT] })
  }
  const word = WORD[p.c]
  if (word) {
    const wordTok = units ? `${word} count` : word
    out.push({ id: 'R5', label: `"${cat(p.say, word)}" kept early, then digits`,
      sessions: [[...grow(cat(p.say, wordTok)), ...rerendered], NEXT] })
  }
  if (!units) out.push({ id: 'R6', label: 'count and weight merged into one number', sessions: [grow(cat(p.say, `${c}${w}`)), NEXT] })
  // ADDED BEYOND THE BRIEF — the merged number in a session of its own, which reaches the page as a
  // bare number with a crop chosen rather than as a one-breath sentence.
  if (!units) out.push({ id: 'R6s', label: 'merged number in its own session', sessions: [grow(p.say), grow(`${c}${w}`), NEXT] })
  out.push({ id: 'R7', label: 'pair split across sessions, "next" with the weight',
    sessions: [grow(cat(p.say, cTok)), grow(cat(wTok, 'next'))] })
  // ADDED BEYOND THE BRIEF — three more segmentations of the same speech, each one Chrome's session
  // boundary could produce: the whole record in one breath with "next" said after it (R3n), the name
  // and count together with the weight and "next" each on their own (R7n), and the name, then the two
  // numbers together, then "next" (R8 — the shape the page's own comments call his common case).
  out.push({ id: 'R3n', label: 'one breath without "next", then "next"', sessions: [grow(cat(p.say, cTok, wTok)), NEXT] })
  out.push({ id: 'R7n', label: '"<name> <c>" | "<w>" | "next"', sessions: [grow(cat(p.say, cTok)), grow(wTok), NEXT] })
  out.push({ id: 'R8', label: '"<name>" | "<c> <w>" | "next"', sessions: [grow(p.say), grow(cat(cTok, wTok)), NEXT] })
  return out
}

let mic
let postSeq = 0
let postMs = 0
let postTimes = []
const results = { cases: [], sequences: [] }

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear() })
afterAll(() => { if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2)) })

const advance = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const nameOfId = (id) => VOCAB.find((p) => p.id === id)?.name ?? id

async function run(sessions, { seed = 1, post = 0 } = {}) {
  cleanup()
  localStorage.clear()
  setVoiceDebugEnabled(true)
  mic = installFakeSpeechRecognition(vi)
  postSeq = 0
  postMs = post
  postTimes = []
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url, opts) => {
    if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: VOCAB })
    if (url === '/api/varieties/voice-aliases' && !opts?.method) return Promise.resolve({ aliases: DAVE_ALIASES })
    if (url === '/api/events' && opts?.method === 'POST') {
      postTimes.push(Date.now())
      const id = `evt-${++postSeq}`
      return postMs > 0 ? new Promise((r) => { setTimeout(() => r({ id }), postMs) }) : Promise.resolve({ id })
    }
    return Promise.resolve({})
  })
  vi.useFakeTimers({ now: new Date('2026-09-25T14:40:00.000Z'), shouldAdvanceTime: false })
  const t0 = Date.now()
  render(<VoiceHarvest />)
  await advance(0)
  const events = chromeTrace(sessions, { seed })
  const replay = await replayVoiceTrace(events, {
    act, advance,
    rec: () => mic.latest() ?? null,
    start: async () => { await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) }) },
  })
  await advance(4000 + post)
  const rawLog = readVoiceDebugLog()
  const log = replayedEntries(rawLog)
  const out = {
    mismatches: replay.mismatches,
    logEntries: rawLog.length,
    posts: apiFetchSpy.mock.calls
      .filter(([url, opts]) => url === '/api/events' && opts?.method === 'POST')
      .map(([, opts], i) => {
        const b = JSON.parse(opts.body)
        return {
          t: postTimes[i] - t0, planting: nameOfId(b.plant_id), quantity: b.harvest.quantity, unit: b.harvest.unit,
          weight_grams: b.harvest.weight ?? null, assumed_units: b.metadata?.assumed_units ?? null,
        }
      }),
    banner: screen.getByTestId('voice-harvest-status').textContent,
    record: screen.getByTestId('voice-harvest-record').textContent,
    misses: screen.queryAllByTestId('voice-harvest-miss').map((m) => m.textContent),
    // What was delivered (the new final at each result index) and what the page decided, on one clock.
    timeline: [
      ...events.filter((e) => e.kind === 'result' && e.results[e.resultIndex]?.text)
        .map((e) => ({ t: e.t, what: `final[${e.resultIndex}] ${JSON.stringify(e.results[e.resultIndex].text)}` })),
      ...events.filter((e) => e.kind === 'end').map((e) => ({ t: e.t, what: 'end' })),
      ...log.filter((e) => e.kind === 'decision').map((e) => ({ t: e.t, what: `  decision ${e.detail}` })),
      ...postTimes.map((pt, i) => ({ t: pt - t0, what: `  POST #${i + 1}` })),
    ].sort((a, b) => a.t - b.t || (a.what.startsWith('  ') ? 1 : 0) - (b.what.startsWith('  ') ? 1 : 0)),
  }
  cleanup()
  vi.useRealTimers()
  return out
}

const matches = (post, p) => post.planting === p.name && post.quantity === p.c && post.unit === 'count' && post.weight_grams === p.w

function classifyOutcome(outcome, p, units) {
  const { posts, misses } = outcome
  if (posts.length === 0) return misses.length ? 'REFUSED-LOUD' : 'SILENT'
  if (posts.length === 1 && matches(posts[0], p)) {
    const want = units ? [] : ['count', 'g']
    const a = posts[0].assumed_units ?? []
    if (!(a.length === want.length && a.every((u, i) => u === want[i]))) return 'CORRECT(assumed_units differ)'
    // Saved right, but the ledger also says something was NOT captured — a false miss row.
    return misses.length ? 'CORRECT+MISSROWS' : 'CORRECT'
  }
  return 'WRONG-SAVE'
}

// Without an output file there is nothing to measure into: ONE labelled skip, not hundreds.
const CASES = !OUT ? [] : PLANTS.flatMap((p) => [false, true].flatMap((units) => renderings(p, units)
  .map((r) => ({ key: `${units ? 'C' : 'U'} ${r.id} ${p.name}`, p, units, r }))))

if (!OUT) it.skip('measurement battery — set VOICE_REPLAY_BATTERY=<file.json> to run it', () => {})

describe.skipIf(!OUT)('V5-VOICEVOCAB-001 under Chrome-shaped delivery — one record per page (SYNTHETIC)', () => {
  it.each(CASES.map((c) => [c.key, c]))('%s', async (_key, { p, units, r }) => {
    const bySeed = []
    for (const seed of SEEDS) {
      const o = await run(r.sessions, { seed })
      bySeed.push({ seed, outcome: classifyOutcome(o, p, units), ...o })
    }
    results.cases.push({
      plant: p.name, said: `${p.c} count / ${p.w} g`, units, rendering: r.id, label: r.label,
      finals: r.sessions.map((s) => s.map((f) => `${f.pause ? '(pause) ' : ''}${f.text}`).join(' → ')),
      outcomes: [...new Set(bySeed.map((b) => b.outcome))],
      runs: bySeed,
    })
    expect(bySeed.every((b) => b.mismatches.length === 0)).toBe(true)
  })
})

const SEQ = !OUT ? [] : [false, true].flatMap((units) => ['R1', 'R2', 'R3', 'R3n', 'R4a', 'R4b', 'R4c', 'R4d', 'R4e', 'R5', 'R6', 'R6s', 'R7', 'R7n', 'R8', 'R8hc', 'R8hw']
  .map((id) => ({ units, id, plants: PLANTS.filter((p) => renderings(p, units).some((r) => r.id === id)) }))
  .filter((s) => s.plants.length))
  .flatMap((s) => POST_MS.map((post) => ({ ...s, post, key: `${s.units ? 'C' : 'U'} ${s.id} x${s.plants.length} post=${post}ms` })))

describe.skipIf(!OUT)('the same renderings, all records in one visit (SYNTHETIC)', () => {
  it.each(SEQ.map((s) => [s.key, s]))('%s', async (_key, { units, id, plants, post }) => {
    const sessions = plants.flatMap((p) => renderings(p, units).find((r) => r.id === id).sessions)
    const o = await run(sessions, { seed: SEEDS[0], post })
    // Posts are matched to records in order; anything unmatched is reported as it stands.
    const expected = plants.map((p) => ({ plant: p.name, said: `${p.c} count / ${p.w} g` }))
    const matched = plants.map((p) => o.posts.filter((x) => matches(x, p)).length)
    results.sequences.push({ units, rendering: id, post, expected, matched, ...o })
    expect(o.mismatches).toEqual([])
  })
})
