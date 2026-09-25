// src/__tests__/helpers/voiceTraceReplay.js
//
// REPLAYS A REAL DEVICE CAPTURE THROUGH THE REAL PAGE. Input is the text Voice debug
// (/admin/voice-debug) exports — formatVoiceDebugLog in src/lib/voiceDebug.js — pasted verbatim.
//
// WHY. Every page test before this one fed <VoiceHarvest /> "each quoted string is ONE final", one per
// session, ~700 ms apart. Chrome Android does not deliver speech that way. On Dave's phone (2026-09-16
// real-page trace, project-state/voice-realpage-trace-20260916.md in gardening-docs) every session
// opens with 1-6 EMPTY finals, each new result index carries the WHOLE phrase so far as a final
// ("big" -> "big boy" -> ... 12 finals for one sentence), results land 50-500 ms apart, and a speaker
// pause lets the page's own settle tick commit a PARTIAL phrase. A suite that cannot deliver that
// shape cannot see a defect that lives in it. This drives the page with the shape itself.
//
// WHAT IS REPLAYED AND WHAT IS NOT. `result`, `end`, `nomatch` and `error` lines are INPUTS: each is
// dispatched to the page's own recogniser at its recorded offset, with fake time advanced by the
// recorded gap, so the page's settle tick fires when it would have. `result` is fired through
// `onresult` with the recorded resultIndex and the FULL recorded results list, the object shape
// fakeSpeechRecognition's makeResult builds. `start` is NOT dispatched — the page re-arms itself on
// every `end` — it is a CHECK that the page's recogniser is live at that moment; a miss is recorded as
// a mismatch, never papered over by starting it for the page. The first `start` is the Start tap.
// `decision` and `hidden` lines are OUTPUTS the page wrote; they are never replayed. (`hidden` has no
// matching "visible" line in the format, so a replay cannot restore the page; it is reported, not
// guessed.)
//
// TIMING FIDELITY, and its limit. The page reads Date.now() for every final and schedules its tick
// with setTimeout, so under fake timers with shouldAdvanceTime OFF the replay is exact and
// deterministic: a tick lands exactly settle-window ms after its final, where the phone's landed 3-17
// ms later (timer latency). A final recorded within that 3-17 ms of a device tick could therefore
// reorder; the fidelity gate compares decisions, which is where that would show.

const EVENT_LINE = /^\+\s*(-?\d+)\s{2}(\S+)\s{2}(\S+)(?:\s(.*))?$/
const RESULT_HEAD = /^\s*resultIndex=(\S+)\s+len=(\d+)\s*$/
const RESULT_LINE = /^\s+\[(\d+)\]\s(FINAL {2}|interim)\s(".*")\s*$/

/**
 * Parse a Voice debug capture. Returns { startedAt, events, problems } where each event is
 * { t, src, kind, detail? } and a `result` event also carries { resultIndex, len, results: [{ i, final, text }] }.
 * `problems` lists lines that did not parse and result blocks whose rows disagree with their header —
 * a capture that was edited by hand is not evidence, so the caller is expected to assert it is empty.
 */
export function parseVoiceTrace(text) {
  const events = []
  const problems = []
  let startedAt = null
  let cur = null
  const lines = String(text ?? '').split(/\r?\n/)
  lines.forEach((line, n) => {
    if (!line.trim()) return
    if (line.startsWith('#')) {
      const m = /^# started (\S+)/.exec(line)
      if (m) startedAt = m[1]
      return
    }
    const ev = EVENT_LINE.exec(line)
    if (ev) {
      const [, t, src, kind, rest] = ev
      const e = { t: Number(t), src, kind }
      if (kind === 'result') {
        const h = RESULT_HEAD.exec(rest ?? '')
        if (!h) { problems.push(`line ${n + 1}: result header ${JSON.stringify(line)}`); cur = null; return }
        e.resultIndex = h[1] === 'null' ? null : Number(h[1])
        e.len = Number(h[2])
        e.results = []
        cur = e
      } else {
        e.detail = rest ?? null
        cur = null
      }
      events.push(e)
      return
    }
    const r = RESULT_LINE.exec(line)
    if (r && cur) {
      cur.results.push({ i: Number(r[1]), final: r[2].startsWith('FINAL'), text: JSON.parse(r[3]) })
      return
    }
    problems.push(`line ${n + 1}: ${JSON.stringify(line)}`)
  })
  for (const e of events) {
    if (e.kind !== 'result') continue
    if (e.results.length !== e.len || e.results.some((r, i) => r.i !== i)) {
      problems.push(`+${e.t} result: header len=${e.len}, rows ${e.results.map((r) => r.i).join(',')}`)
    }
  }
  return { startedAt, events, problems }
}

/** Render events back into the capture format (formatVoiceDebugLog's layout), for reports. */
export function formatTraceEvents(events, { src = 'voiceharvest' } = {}) {
  const out = []
  for (const e of events) {
    const dt = String(e.t).padStart(6, ' ')
    if (e.kind === 'result') {
      out.push(`+${dt}  ${e.src ?? src}  result  resultIndex=${e.resultIndex} len=${e.len}`)
      for (const r of e.results) out.push(`         [${r.i}] ${r.final ? 'FINAL  ' : 'interim'} ${JSON.stringify(r.text)}`)
    } else {
      out.push(`+${dt}  ${e.src ?? src}  ${e.kind}${e.detail ? ` ${e.detail}` : ''}`)
    }
  }
  return out.join('\n')
}

/** The recorded decision lines — the page's OUTPUT on the device — as { t, detail }. */
export function recordedDecisions(events) {
  return events.filter((e) => e.kind === 'decision').map((e) => ({ t: e.t, detail: e.detail }))
}

/** The page's own replayed log (readVoiceDebugLog entries) as { t, kind, detail }, t relative to its first entry. */
export function replayedEntries(log, src = 'voiceharvest') {
  const mine = (log ?? []).filter((e) => e.src === src)
  const t0 = mine.length ? mine[0].t : 0
  return mine.map((e) => ({ t: e.t - t0, kind: e.kind, detail: e.detail ?? null }))
}

// The object shape fakeSpeechRecognition.js's makeResult builds, so the page cannot tell a replayed
// result from one the shared fake delivers.
const toResult = (r) => Object.assign([{ transcript: r.text, confidence: 0.9 }], { isFinal: r.final })

/**
 * Drive a mounted <VoiceHarvest /> with parsed capture events.
 *
 * env:
 *   act      — @testing-library/react's act
 *   advance  — async (ms) => advance fake time by ms, flushing the page's timers and promises
 *   rec      — () => the page's live recogniser (the shared fake's latest instance), or null
 *   start    — async () => tap Start (called for the capture's first `start`)
 *   onEvent  — optional (event, index) => void, called after each dispatched input
 *
 * Returns { mismatches, dispatched, ignored }. A mismatch is a moment the page's recogniser was not in
 * the state the capture shows (not live at a recorded `start`, or a result/end aimed at a dead one).
 */
export async function replayVoiceTrace(events, env) {
  const mismatches = []
  const dispatched = { start: 0, result: 0, end: 0, nomatch: 0, error: 0 }
  const ignored = {}
  let now = null
  let started = false
  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx]
    if (now == null) now = e.t
    if (e.t > now) { await env.advance(e.t - now); now = e.t }
    const rec = env.rec()
    switch (e.kind) {
      case 'start': {
        if (!started) { await env.start(); started = true; dispatched.start += 1; break }
        const live = env.rec()
        if (!live || !live.started) mismatches.push({ t: e.t, kind: 'start', note: 'the page had not re-armed its recogniser' })
        break
      }
      case 'result': {
        if (!rec || !rec.started || typeof rec.onresult !== 'function') {
          mismatches.push({ t: e.t, kind: 'result', note: 'result delivered to a recogniser that is not live' })
        }
        const results = e.results.map(toResult)
        // Kept in step with the fake's own list so a later deliverFinal() on it appends after this.
        if (rec) rec._results = results.slice()
        await env.act(async () => { rec?.onresult?.({ resultIndex: e.resultIndex ?? 0, results }) })
        dispatched.result += 1
        break
      }
      case 'end': {
        if (!rec || !rec.started) mismatches.push({ t: e.t, kind: 'end', note: 'end for a recogniser that is not live' })
        await env.act(async () => { rec?.endSession() })
        dispatched.end += 1
        break
      }
      case 'nomatch':
        await env.act(async () => { rec?.onnomatch?.({}) })
        dispatched.nomatch += 1
        break
      case 'error':
        await env.act(async () => { rec?.onerror?.({ error: e.detail }) })
        dispatched.error += 1
        break
      default:
        ignored[e.kind] = (ignored[e.kind] ?? 0) + 1
        continue
    }
    env.onEvent?.(e, idx)
  }
  return { mismatches, dispatched, ignored }
}

/**
 * Pair recorded decisions with replayed ones. Each recorded decision is matched to the first unused
 * replayed decision with IDENTICAL text inside ±toleranceMs; failing that, to the first unused replayed
 * decision inside the window (a changed decision); failing that, it is `missing`. Replayed decisions
 * left over are `extra`. Order-preserving: a match never goes backwards in the replayed list.
 */
export function alignDecisions(recorded, replayed, toleranceMs = 60) {
  const used = new Set()
  let floor = 0
  const rows = recorded.map((r) => {
    const inWindow = (d, i) => !used.has(i) && i >= floor && Math.abs(d.t - r.t) <= toleranceMs
    let i = replayed.findIndex((d, k) => inWindow(d, k) && d.detail === r.detail)
    let status = 'same'
    if (i < 0) { i = replayed.findIndex((d, k) => inWindow(d, k)); status = 'changed' }
    if (i < 0) return { recorded: r, replayed: null, status: 'missing' }
    used.add(i)
    floor = i + 1
    return { recorded: r, replayed: replayed[i], status }
  })
  const extra = replayed.filter((_, i) => !used.has(i))
  return { rows, extra }
}

// ── SYNTHETIC CHROME-SHAPED SESSIONS ─────────────────────────────────────────────────────────────────
//
// MODELLED, NOT RECORDED. Everything below builds capture events in the delivery shape measured on
// 2026-09-16 — 1-4 empty finals opening each session, the whole phrase so far re-delivered as a final at
// each new index 150-450 ms apart, a same-text repeat now and then (as "big boy" x3 and "four count" x2
// were), a >=520 ms gap where a speaker pauses (long enough for the page's 500 ms settle tick to commit
// the partial phrase), `end` 1-6 ms after the last final, the re-arm 10-130 ms later. The transcripts
// are renderings chosen by the caller: they say what Chrome COULD return, not what it did.

/** mulberry32 — a seeded PRNG so a synthetic session is reproducible from its seed. */
export function makeRng(seed = 1) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const between = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))

/**
 * The cumulative finals Chrome delivers while a phrase is spoken word by word: "suyo", "suyo long",
 * "suyo long 2", ... `pauseBefore` holds word indexes the speaker pauses before.
 */
export function grow(text, pauseBefore = []) {
  const ws = String(text).split(' ').filter(Boolean)
  return ws.map((_, i) => ({ text: ws.slice(0, i + 1).join(' '), pause: pauseBefore.includes(i) }))
}

/**
 * Build capture events for a run of sessions. `sessions` is an array of sessions; a session is an array
 * of finals { text, pause? } in delivery order, each the cumulative phrase so far. The first event is
 * the Start tap's `start`. Returns the same event objects parseVoiceTrace produces.
 */
export function chromeTrace(sessions, { seed = 1, repeatP = 0.25, src = 'voiceharvest' } = {}) {
  const rng = makeRng(seed)
  const events = [{ t: 0, src, kind: 'start', detail: null }]
  let t = 0
  sessions.forEach((finals, si) => {
    if (si > 0) { t += between(rng, 10, 130); events.push({ t, src, kind: 'start', detail: null }) }
    const list = []
    const deliver = (text) => {
      list.push({ i: list.length, final: true, text })
      events.push({ t, src, kind: 'result', resultIndex: list.length - 1, len: list.length, results: list.map((r) => ({ ...r })) })
    }
    t += between(rng, 1000, 2600)
    const heads = between(rng, 1, 4)
    for (let h = 0; h < heads; h++) { if (h) t += between(rng, 20, 200); deliver('') }
    for (const f of finals) {
      t += f.pause ? between(rng, 520, 900) : between(rng, 150, 450)
      deliver(f.text)
      if (rng() < repeatP) { t += between(rng, 70, 415); deliver(f.text) }
    }
    t += between(rng, 1, 6)
    events.push({ t, src, kind: 'end', detail: null })
  })
  return events
}
