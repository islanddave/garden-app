// src/components/ContinuousVoiceProbe.jsx
//
// V5-HARVESTVOICEFLOW-001 (BD-068) — a device-truth INSTRUMENT, not a feature: it renders only inside
// the unlinked /admin/voice-debug route and is not wired into any user-facing surface.
//
// WHY IT DOES NOT USE lib/transcribe.js: that wrapper deliberately ends a session on `onend`
// (endedFired guard, no restart) and layers two iOS watchdogs plus a duplicate-collapsing accumulator
// on the raw stream. Measuring through it would measure the wrapper. This talks to SpeechRecognition
// directly and reports what Chrome actually dispatches.
//
// THE FOUR QUESTIONS IT ANSWERS:
//   1. Does `continuous = true` survive several utterances in ONE session on Chrome Android, or does
//      `onend` fire per-utterance? The counter that settles it is sessions-vs-utterances: 1 session
//      and 4 finals = continuous works; 4 sessions and 4 finals = it is re-arming behind the scenes.
//   2. HOW LONG the re-arm takes. The gap is dead air where speech is LOST with no error and no
//      signal, so this number decides whether the whole flow is viable.
//   3. Whether re-arming re-prompts for microphone permission. Read from the Permissions API before
//      and after rather than by watching for a dialog.
//   4. Whether an async round-trip mid-session kills recognition. ANSWERED: it does not. The
//      simulation is opt-in and OFF by default (see C4), because it confounded the supersede-gap
//      measurement.
//
// Every final transcript also runs through the grammar (lib/voiceHarvestGrammar.js), so the
// classification is visible next to the raw text.
//
// S0: THE DEBOUNCE LAYER (lib/voiceCommitDebounce.js) IS WIRED IN HERE, AND THIS IS THE ONLY PLACE
// IT RUNS. The probe adds a HOST (a timer and callbacks) around the layer and changes none of it.
// Reverting is deleting one import.
//
// WHY THE PROBE AND NOT A REAL SURFACE: the debouncer cannot sit above transcribe.js. That wrapper's
// BUG-VOICEDUPE-003 fix pins `onResult` to never deliver a revised final (transcribe.rawEvents.test
// .js), and the supersede rule needs exactly that revision, so behind the wrapper it would commit
// the PREFIX ("231", not "231 G"), a silently wrong harvest weight. The probe reads the RAW stream,
// the only stream the layer is correct above.
//
// THE THREE INSTRUMENTS S0 OWES, all on screen and in the copyable log:
//   * `dueAt()` — when the pending utterance would commit on its own; without it a window that never
//     elapsed and one that elapsed silently look identical.
//   * TICK DRIFT — fired-at minus due-at. Android freezes timers on hidden pages; a 500 ms window that
//     fires at +40 000 ms is the staleness case `tick()` discards, and this shows it happening.
//   * HELD WRITES THAT NEVER TICKED — `sessionEnd` deliberately refuses to flush a write command, so
//     every save depends on a tick landing. A held write that leaves the pending slot without
//     committing is that failure, counted.
// Commits are also split BY PATH (tick / sessionEnd / final) for the same reason: "it committed" is
// not the finding — WHICH path committed it is.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { P } from '../lib/constants.js'
import { classify } from '../lib/voiceHarvestGrammar.js'
import { createCommitDebouncer, WRITE_CLASS } from '../lib/voiceCommitDebounce.js'
import { acquireMic, releaseMic } from '../lib/micArbiter.js'

// RUN BUDGETS (C3). Two hard stops, so a forgotten probe cannot hold the mic open forever: a re-arm
// count and a wall clock. The short pair suits the 4-phrase fixture and is WRONG for gate B6.
const SHORT_BUDGET = { restarts: 24, runMs: 4 * 60 * 1000, label: '24 re-arms / 4 min' }

// Gate B6 asks for >=20 utterances outdoors in one session; at ~5 sessions per 4 utterances that is
// ~25 re-arms, so the short budget would hard-stop INSIDE the fixture. This one is sized for that run
// plus mis-hears and retries. It is still BOUNDED and opt-in per run: live mic for twenty minutes is
// the cost of the measurement, not a licence.
const LONG_BUDGET = { restarts: 150, runMs: 20 * 60 * 1000, label: '150 re-arms / 20 min' }

function ctor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

// A pending WRITE is the only pending state that sessionEnd will not flush, so it is the only one
// whose fate depends entirely on the host's timer. Everything held-write is keyed off this.
const isWriteResult = (r) => !!r && r.kind === 'command' && !!WRITE_CLASS[r.command]

function describe(c) {
  if (!c) return '—'
  return c.kind === 'quantity' ? `quantity ${c.value} ${c.unit}`
    : c.kind === 'weight' ? `weight ${c.value} ${c.unit} (${Math.round(c.grams)}g)`
    : c.kind === 'command' ? `COMMAND ${c.command}`
    : c.kind === 'search' ? `search "${c.text}"`
    : `unparsed (${c.reason})`
}

const emptyHostMetrics = () => ({
  ticksScheduled: 0,
  ticksFired: 0,
  drifts: [],
  commitsByPath: { tick: 0, sessionEnd: 0, final: 0 },
  writesHeld: 0,
  writesHeldCommitted: 0,
  writesHeldSuppressed: 0,
  writesHeldSuperseded: 0,
  writesHeldLost: 0,
  suppressedByReason: {},
})

async function probeOnDevice() {
  const C = ctor()
  if (!C) return 'no SpeechRecognition'
  if (typeof C.available !== 'function') return 'available() not exposed (pre-139 or unsupported)'
  try {
    const r = await C.available({ langs: ['en-US'], processLocally: true })
    return `available(): ${JSON.stringify(r)}`
  } catch (e) {
    return `available() threw: ${e?.message ?? String(e)}`
  }
}

async function micPermission() {
  try {
    if (!navigator.permissions?.query) return 'Permissions API absent'
    const s = await navigator.permissions.query({ name: 'microphone' })
    return s.state
  } catch (e) {
    return `query threw: ${e?.message ?? String(e)}`
  }
}

export default function ContinuousVoiceProbe() {
  const [running, setRunning] = useState(false)
  const micTokenRef = useRef(null)
  const [lines, setLines] = useState([])
  const [stats, setStats] = useState({ sessions: 0, finals: 0, interims: 0, gaps: [] })
  const [env, setEnv] = useState({ onDevice: '…', permBefore: '…', permAfter: '—' })

  // S0 host state. `commits` is the echo, a stand-in for the shipped harvest session ledger. It is a
  // LEDGER, not a pending indicator: a pending echo spends most of its screen time showing values
  // already discarded. So what persists here is what committed; what is pending is a recessive line
  // beneath it.
  const [commits, setCommits] = useState([])
  const [pendingEcho, setPendingEcho] = useState(null)
  const [dueAtMs, setDueAtMs] = useState(null)
  const [debStats, setDebStats] = useState(null)
  const [hostMetrics, setHostMetrics] = useState(emptyHostMetrics)
  const [heldOutstanding, setHeldOutstanding] = useState(false)
  const [longRun, setLongRun] = useState(false)
  // C4. Q4 is answered, so the simulated round-trip fetch contaminates the measurement it sits inside
  // (the one supersede gap that appeared to break the 500ms settle window had this fetch in it).
  // Off unless someone is deliberately re-asking Q4.
  const [roundTrip, setRoundTrip] = useState(false)

  const recRef = useRef(null)
  const t0Ref = useRef(0)
  const endedAtRef = useRef(0)
  const stopRequestedRef = useRef(false)
  const restartsRef = useRef(0)
  const runTimerRef = useRef(null)
  const wallClockTimerRef = useRef(null)
  // CAPTURED AT START, never read live: a budget that can change under a run makes the run's own stop
  // condition unknowable afterwards. The toggle is also disabled while running. roundTripRef is
  // captured for the same reason, so the log describes the run that actually happened.
  const budgetRef = useRef(SHORT_BUDGET)
  const roundTripRef = useRef(false)

  const debRef = useRef(null)
  const tickTimerRef = useRef(null)
  const metricsRef = useRef(emptyHostMetrics())
  // WHICH ENTRY POINT IS ON THE STACK. onCommit fires synchronously from inside final()/sessionEnd()
  // /tick(), so the path is known exactly.
  const commitPathRef = useRef(null)
  // The pending write we are waiting on a tick for, held BY REFERENCE: the layer builds a fresh result
  // object per final(), so object identity tells "still the same pending utterance" without an id.
  const heldWriteRef = useRef(null)

  const log = useCallback((msg) => {
    const dt = t0Ref.current ? Date.now() - t0Ref.current : 0
    setLines(l => [...l, `+${String(dt).padStart(6, ' ')}ms  ${msg}`])
  }, [])

  const syncStats = useCallback(() => {
    const deb = debRef.current
    setDebStats(deb ? deb.stats() : null)
    setDueAtMs(deb ? deb.dueAt() : null)
    setHostMetrics({
      ...metricsRef.current,
      drifts: [...metricsRef.current.drifts],
      commitsByPath: { ...metricsRef.current.commitsByPath },
      suppressedByReason: { ...metricsRef.current.suppressedByReason },
    })
    setHeldOutstanding(!!heldWriteRef.current)
  }, [])

  // Reconciles the held-write token against the layer's pending slot after every entry point. A held
  // write gone from the slot WITHOUT onCommit or onSuppressed clearing it did not commit, and the two
  // ways that happens are different findings, so they get separate counters.
  //
  // SUPERSEDED is the design working: "next" pending, then the rest of "next to the fence" arrives
  // inside the window, so the save is correctly replaced by a search and no write fires. Scoring it
  // as a failure would report the feature succeeding as the feature breaking.
  //
  // LOST is the real defect: the slot emptied with nothing in its place and no commit or suppression.
  // Nothing in this host does that, so it should read 0; non-zero means the model here is wrong.
  const reconcileHeld = useCallback((ctx) => {
    const deb = debRef.current
    const pending = deb ? deb.peek() : null
    if (heldWriteRef.current && pending !== heldWriteRef.current) {
      if (pending) {
        metricsRef.current.writesHeldSuperseded += 1
        log(`held     write superseded (${ctx}) by ${describe(pending)} — no save fired, by design`)
      } else {
        metricsRef.current.writesHeldLost += 1
        log(`HELD-WRITE LOST (${ctx}) — left the pending slot without committing`)
      }
      heldWriteRef.current = null
    }
    if (isWriteResult(pending) && heldWriteRef.current !== pending) {
      heldWriteRef.current = pending
      metricsRef.current.writesHeld += 1
      log(`held     write "${pending.command}" pending — sessionEnd will not flush it, only a tick can`)
    }
  }, [log])

  // THE HOST TIMER. The layer is a pure state machine with no clock; `dueAt()` is its contract with
  // whoever owns one. Rescheduled after every entry point because a supersede moves the deadline.
  const scheduleTickRef = useRef(null)
  const scheduleTick = useCallback(() => {
    const deb = debRef.current
    if (tickTimerRef.current) { clearTimeout(tickTimerRef.current); tickTimerRef.current = null }
    if (!deb) return
    const due = deb.dueAt()
    if (due == null) return
    metricsRef.current.ticksScheduled += 1
    tickTimerRef.current = setTimeout(() => {
      tickTimerRef.current = null
      const firedAt = Date.now()
      const drift = firedAt - due
      metricsRef.current.ticksFired += 1
      metricsRef.current.drifts.push(drift)
      commitPathRef.current = 'tick'
      try { deb.tick(firedAt) } finally { commitPathRef.current = null }
      log(`tick     fired ${drift >= 0 ? '+' : ''}${drift}ms vs dueAt`)
      reconcileHeld('tick')
      scheduleTickRef.current?.()
      syncStats()
    }, Math.max(0, due - Date.now()))
  }, [log, reconcileHeld, syncStats])
  useEffect(() => { scheduleTickRef.current = scheduleTick }, [scheduleTick])

  useEffect(() => {
    probeOnDevice().then(onDevice => setEnv(e => ({ ...e, onDevice })))
  }, [])

  // Release the mic on unmount no matter how the page is left; the three timers go with it, since a
  // tick firing into an unmounted host would commit against nothing and warn in React.
  useEffect(() => () => {
    stopRequestedRef.current = true
    if (runTimerRef.current) clearTimeout(runTimerRef.current)
    if (wallClockTimerRef.current) clearTimeout(wallClockTimerRef.current)
    if (tickTimerRef.current) clearTimeout(tickTimerRef.current)
    try { recRef.current?.abort() } catch { /* already gone */ }
    recRef.current = null
    releaseMic(micTokenRef.current)
    micTokenRef.current = null
    debRef.current = null
  }, [])

  // S1 — hand the mic back whenever the run stops, however it stopped. Same shape as VoiceHarvest: the
  // run has several exits, so `running` going false is the single release point. Never acquires;
  // mounting the probe must not take the mic.
  useEffect(() => {
    if (running) return
    releaseMic(micTokenRef.current)
    micTokenRef.current = null
  }, [running])

  const arm = useCallback(() => {
    const C = ctor()
    if (!C) { log('FATAL: no SpeechRecognition on this browser'); setRunning(false); return }

    const rec = new C()
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.lang = 'en-US'
    recRef.current = rec

    rec.onstart = () => {
      // THE MEASUREMENT THAT MATTERS: the gap between the previous session ending and this one
      // being live is dead air. Recorded only for re-arms (endedAt is 0 on the first start).
      const gap = endedAtRef.current ? Date.now() - endedAtRef.current : null
      setStats(s => ({ ...s, sessions: s.sessions + 1, gaps: gap == null ? s.gaps : [...s.gaps, gap] }))
      log(gap == null ? 'onstart  (session 1 — mic live)' : `onstart  RE-ARMED after ${gap}ms of dead air`)
    }

    rec.onresult = (ev) => {
      // GATE B1: log resultIndex and results.length. Without the pair, a re-delivery at the SAME
      // index (the VOICEDUPE signature) is indistinguishable from a new result at the next one.
      log(`result   resultIndex=${ev.resultIndex} len=${ev.results.length}`)
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i]
        const text = r[0]?.transcript ?? ''
        if (r.isFinal) {
          setStats(s => ({ ...s, finals: s.finals + 1 }))
          // RAW, via JSON.stringify — BUG-VOICEDUPE-005. An instrument that normalises (trims) before
          // it reports decides what a fixture transcribed from this log can say: the device may emit
          // " 310 G" against "310 G", and a trimmed line hides that.
          log(`  [${i}] FINAL   ${JSON.stringify(text)}  ->  ${describe(classify(text))}`)
          const deb = debRef.current
          if (deb) {
            commitPathRef.current = 'final'
            try { deb.final(text, Date.now()) } finally { commitPathRef.current = null }
            reconcileHeld('final')
            scheduleTick()
            syncStats()
          }
        } else {
          setStats(s => ({ ...s, interims: s.interims + 1 }))
        }
      }
    }

    rec.onerror = (ev) => log(`onerror  ${ev?.error ?? 'unknown'}`)

    rec.onend = () => {
      endedAtRef.current = Date.now()
      log('onend')
      const deb = debRef.current
      if (deb) {
        commitPathRef.current = 'sessionEnd'
        try { deb.sessionEnd(Date.now()) } finally { commitPathRef.current = null }
        reconcileHeld('sessionEnd')
        scheduleTick()
        syncStats()
      }
      if (stopRequestedRef.current) { setRunning(false); log('— probe stopped —'); return }
      if (restartsRef.current >= budgetRef.current.restarts) {
        setRunning(false)
        log(`— cap reached (${budgetRef.current.restarts} re-arms) — turn on Long run for the ≥20-utterance fixture`)
        return
      }
      restartsRef.current += 1
      // THE RESTART, with NO user gesture. Whether this succeeds is itself a finding: if Chrome needs a
      // fresh gesture per session, hands-free across a save is impossible. An error here is the
      // answer, not a bug in the probe.
      try {
        rec.start()
      } catch (e) {
        log(`restart THREW: ${e?.message ?? String(e)} — programmatic re-arm is not permitted`)
        setRunning(false)
      }
    }

    try { rec.start() } catch (e) { log(`start threw: ${e?.message ?? String(e)}`); setRunning(false) }
  }, [log, reconcileHeld, scheduleTick, syncStats])

  const start = useCallback(async () => {
    setLines([]); setStats({ sessions: 0, finals: 0, interims: 0, gaps: [] })
    setCommits([]); setPendingEcho(null); setDueAtMs(null); setHeldOutstanding(false)
    stopRequestedRef.current = false
    restartsRef.current = 0
    endedAtRef.current = 0
    t0Ref.current = Date.now()
    setRunning(true)
    // S1 — held for the whole run, like VoiceHarvest: this probe re-arms on every onend. The eviction
    // is LOGGED rather than silent, so a run ended by another surface taking the mic does not read as
    // a spontaneous stop and pollute the restart-budget numbers.
    micTokenRef.current = acquireMic('ContinuousVoiceProbe', () => {
      stopRequestedRef.current = true
      if (runTimerRef.current) { clearTimeout(runTimerRef.current); runTimerRef.current = null }
      if (wallClockTimerRef.current) { clearTimeout(wallClockTimerRef.current); wallClockTimerRef.current = null }
      if (tickTimerRef.current) { clearTimeout(tickTimerRef.current); tickTimerRef.current = null }
      const dying = recRef.current
      recRef.current = null
      if (dying) {
        dying.onstart = null; dying.onresult = null; dying.onerror = null; dying.onend = null
        try { dying.abort() } catch { /* already gone */ }
      }
      setRunning(false)
      log('— probe stopped: another microphone took over —')
    })

    if (tickTimerRef.current) { clearTimeout(tickTimerRef.current); tickTimerRef.current = null }
    metricsRef.current = emptyHostMetrics()
    heldWriteRef.current = null
    commitPathRef.current = null
    budgetRef.current = longRun ? LONG_BUDGET : SHORT_BUDGET
    roundTripRef.current = roundTrip
    log(`run budget: ${budgetRef.current.label}${longRun ? '  (LONG RUN — mic can stay live for 20 minutes)' : ''}`)
    // STATED EITHER WAY, so a log with no round-trip line is not ambiguous between "off" and "predates
    // the toggle".
    log(`search round-trip simulation: ${roundTrip ? 'ON — any gap spanning +6000ms is CONFOUNDED' : 'OFF — gaps are clean'}`)
    // SCOPE, STATED IN THE LOG ITSELF. The log LOOKS like an end-to-end trace of /log/voice and is not:
    // this component imports `classify` and nothing else, while VoiceHarvest also runs
    // splitTrailingCommand, segmentCandidates, parseValueSequence and classifyPartial, and the probe
    // performs NO writes. The line travels with every pasted log and is the only thing separating
    // "classify() said search" from "the app searched". Do not drop it to tidy the header; the
    // import-scan test in ContinuousVoiceProbe.test.jsx keeps it true.
    log('scope: this probe runs classify() ONLY and never writes. splitTrailingCommand,')
    log('  segmentCandidates, parseValueSequence, oneBreathReadings and classifyPartial run in /log/voice,')
    log('  NOT here — so a one-breath phrase, a trailing command, or a bare number may resolve on the real')
    log('  page and still read as unparsed/search below. A COMMIT line is a classification, not a save.')
    // The debouncer claims the write cooldown for a one-breath final ending in a save word ("165
    // next"), and the PAGE gives that claim back when the sentence writes nothing (VoiceHarvest
    // applyCommitted, releaseUnwritten). This probe writes nothing and releases nothing, so a real
    // "next" said straight after reads SUPPRESSED here while the page would commit it. Labelled
    // rather than re-implemented, because the probe shows the debouncer as it is.
    log('  A SUPPRESSED (cooldown) line is the debouncer\'s own view: after a one-breath "… next" that')
    log('  saves nothing, /log/voice gives the cooldown back, so a "next" said straight after commits there.')

    // A FRESH DEBOUNCER PER RUN: `resetSession()` would clear the duplicate-suppression memory of a
    // layer that might still hold a pending utterance from the previous run.
    debRef.current = createCommitDebouncer({
      onCommit: (result, meta) => {
        const path = commitPathRef.current ?? 'unknown'
        const m = metricsRef.current
        m.commitsByPath[path] = (m.commitsByPath[path] ?? 0) + 1
        if (heldWriteRef.current === result) { heldWriteRef.current = null; m.writesHeldCommitted += 1 }
        setCommits(c => [...c, { atMs: meta?.atMs ?? Date.now(), path, result }])
        log(`COMMIT   via ${path}: ${describe(result)}`)
      },
      onPending: (result) => setPendingEcho(result),
      onSuppressed: (result, reason) => {
        const m = metricsRef.current
        m.suppressedByReason[reason] = (m.suppressedByReason[reason] ?? 0) + 1
        if (heldWriteRef.current === result) { heldWriteRef.current = null; m.writesHeldSuppressed += 1 }
        log(`SUPPRESSED (${reason}): ${describe(result)}`)
      },
      onCommitError: (result, err) => log(`COMMIT THREW: ${err?.message ?? String(err)}`),
    })
    setDebStats(debRef.current.stats())
    setHostMetrics(emptyHostMetrics())

    const permBefore = await micPermission()
    setEnv(e => ({ ...e, permBefore, permAfter: '—' }))
    log(`mic permission before: ${permBefore}`)
    // THE UNIT WORDS STAY IN THIS PROMPT even though they are optional on the real page
    // (V5-VOICEVOCAB-001): that assumption lives in VoiceHarvest, not classify(), and the probe's
    // unique measurement is how Chrome TRANSCRIBES "count" and "grams" ("three count" has come back
    // as "recount", "grams" as "G").
    log('SAY: "cucumber" … "three count" … "231 grams" … "next"  (pause between each)')
    log('  (say the unit words HERE even though /log/voice no longer needs them — this run measures')
    log('   how Chrome transcribes them, which is a different question from whether the app needs them)')

    arm()

    // Question 4 — an async round-trip mid-session, about when the real flow would be searching for
    // the spoken crop. A real deferred call, so a disturbance shows as an onend/onerror right after
    // this line. Fires only when someone opts in.
    if (roundTripRef.current) {
      runTimerRef.current = setTimeout(() => {
        log('— simulating the search round-trip (keep talking) —')
        fetch('/manifest.webmanifest', { cache: 'no-store' })
          .then(() => log('round-trip resolved; recognition still armed?  see next event'))
          .catch(() => log('round-trip failed (offline?) — inconclusive for question 4'))
      }, 6000)
    }

    // Wall-clock stop.
    wallClockTimerRef.current = setTimeout(() => {
      if (stopRequestedRef.current) return
      stopRequestedRef.current = true
      log('— wall-clock budget reached —')
      try { recRef.current?.stop() } catch { /* ignore */ }
    }, budgetRef.current.runMs)
  }, [arm, log, longRun, roundTrip])

  // NOTE: the tick timer is deliberately NOT cleared here. A write pending when the user taps stop is
  // exactly the case being measured; cancelling it would manufacture an un-ticked held write.
  const stop = useCallback(async () => {
    stopRequestedRef.current = true
    if (runTimerRef.current) clearTimeout(runTimerRef.current)
    if (wallClockTimerRef.current) clearTimeout(wallClockTimerRef.current)
    try { recRef.current?.stop() } catch { /* ignore */ }
    const permAfter = await micPermission()
    setEnv(e => ({ ...e, permAfter }))
    log(`mic permission after: ${permAfter}`)
  }, [log])

  const gaps = stats.gaps
  const gapSummary = gaps.length
    ? `${Math.min(...gaps)} / ${Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)} / ${Math.max(...gaps)} ms`
    : '— (no re-arm yet)'

  // The one line that decides question 1, stated as a verdict rather than left to derive from counters.
  const verdict = stats.finals === 0 ? '—'
    : stats.sessions <= 1 ? 'CONTINUOUS HOLDS — one session carried every utterance'
    : `RE-ARMING — ${stats.sessions} sessions for ${stats.finals} utterances`

  const drifts = hostMetrics.drifts
  const driftSummary = drifts.length
    ? `${Math.min(...drifts)} / ${Math.round(drifts.reduce((a, b) => a + b, 0) / drifts.length)} / ${Math.max(...drifts)} ms`
    : '— (no tick fired yet)'

  const dueLabel = dueAtMs == null
    ? '— (nothing pending)'
    : `+${dueAtMs - t0Ref.current}ms  (in ${Math.max(0, dueAtMs - Date.now())}ms)`

  // The count S0 owes: a save the user asked for where the tick never came. Supersessions are
  // deliberately NOT in this number — see reconcileHeld.
  const heldNeverTicked = hostMetrics.writesHeldLost + (heldOutstanding ? 1 : 0)

  const paths = hostMetrics.commitsByPath
  const suppressedList = Object.entries(hostMetrics.suppressedByReason)
  const box = { background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 12, marginBottom: 12 }
  const btn = (bg) => ({
    minHeight: 44, padding: '10px 18px', borderRadius: 8, border: 'none',
    background: bg, color: P.white, fontSize: '1rem', fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
  })

  return (
    <section style={{ marginTop: 24 }} data-testid="continuous-voice-probe">
      <h2 style={{ fontSize: '1rem', fontWeight: 700, color: P.dark, marginBottom: 4 }}>
        Continuous-mode probe (BD-068)
      </h2>
      <p style={{ fontSize: '0.82rem', color: P.light, lineHeight: 1.5, marginTop: 0 }}>
        Tap start, then say <strong>&ldquo;cucumber&rdquo;</strong>, pause, <strong>&ldquo;three count&rdquo;</strong>,
        pause, <strong>&ldquo;231 grams&rdquo;</strong>, pause, <strong>&ldquo;next&rdquo;</strong> — the flow from the
        braindump. Then stop and copy the log.
      </p>

      <div style={box}>
        <div style={{ fontSize: '0.8rem', color: P.mid, lineHeight: 1.7 }}>
          <div><strong>Verdict:</strong> {verdict}</div>
          <div><strong>Sessions / finals / interims:</strong> {stats.sessions} / {stats.finals} / {stats.interims}</div>
          <div><strong>Re-arm gap min/avg/max:</strong> {gapSummary}</div>
          <div><strong>Mic permission before / after:</strong> {env.permBefore} / {env.permAfter}</div>
          <div><strong>On-device:</strong> {env.onDevice}</div>
          <div data-testid="voice-run-budget">
            <strong>Run budget:</strong> {(longRun ? LONG_BUDGET : SHORT_BUDGET).label}
            {longRun ? ' — LONG RUN' : ''}
          </div>
          <div data-testid="voice-roundtrip-mode">
            <strong>Search round-trip:</strong> {roundTrip
              ? 'ON — any gap spanning +6000ms is confounded'
              : 'OFF — gaps are clean'}
          </div>
        </div>
      </div>

      {/* C3. The short budget hard-stops inside gate B6's own fixture. Opt-in per run, disabled while
          running, and it says how long the mic can stay live. */}
      <label
        style={{
          display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, marginBottom: 12,
          fontSize: '0.85rem', color: running ? P.light : P.dark, cursor: running ? 'not-allowed' : 'pointer',
        }}
      >
        <input
          type="checkbox"
          data-testid="voice-longrun-toggle"
          checked={longRun}
          disabled={running}
          onChange={(e) => setLongRun(e.target.checked)}
          style={{ width: 22, height: 22, flex: '0 0 auto' }}
        />
        <span>
          <strong>Long run</strong> — for the ≥20-utterance outdoor fixture (gate B6).
          Raises the caps to {LONG_BUDGET.label}; the mic can stay live for the whole of it.
        </span>
      </label>

      {/* C4. Q4 is answered, so this fires only when someone is deliberately re-asking it. Default OFF:
          a settle window cannot be measured through an event the instrument itself injected. */}
      <label
        style={{
          display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, marginBottom: 12,
          fontSize: '0.85rem', color: running ? P.light : P.dark, cursor: running ? 'not-allowed' : 'pointer',
        }}
      >
        <input
          type="checkbox"
          data-testid="voice-roundtrip-toggle"
          checked={roundTrip}
          disabled={running}
          onChange={(e) => setRoundTrip(e.target.checked)}
          style={{ width: 22, height: 22, flex: '0 0 auto' }}
        />
        <span>
          <strong>Simulate a search round-trip</strong> — one fetch at +6s. Leave OFF; it confounds
          the gap measurements.
        </span>
      </label>

      {/* S0 — the debounce layer's first execution outside a test file. */}
      <div style={box} data-testid="voice-debounce-panel">
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: P.dark, marginBottom: 6 }}>
          Commit layer (S0)
        </div>
        <div style={{ fontSize: '0.8rem', color: P.mid, lineHeight: 1.7 }}>
          <div data-testid="voice-commit-paths">
            <strong>Commits by path:</strong> tick {paths.tick ?? 0} · sessionEnd {paths.sessionEnd ?? 0} · final {paths.final ?? 0}
          </div>
          <div data-testid="voice-due-at"><strong>dueAt:</strong> {dueLabel}</div>
          <div data-testid="voice-tick-drift">
            <strong>Tick drift min/avg/max:</strong> {driftSummary} · scheduled {hostMetrics.ticksScheduled} · fired {hostMetrics.ticksFired}
          </div>
          <div data-testid="voice-held-writes">
            <strong>Held writes never ticked:</strong> {heldNeverTicked} (waiting {heldOutstanding ? 1 : 0} · vanished {hostMetrics.writesHeldLost}) · held {hostMetrics.writesHeld} · committed by tick {hostMetrics.writesHeldCommitted} · superseded {hostMetrics.writesHeldSuperseded} · suppressed {hostMetrics.writesHeldSuppressed}
          </div>
          <div data-testid="voice-debounce-stats">
            <strong>Layer:</strong> empty {debStats?.droppedEmpty ?? 0} · superseded {debStats?.superseded ?? 0} · regressed {debStats?.regressed ?? 0} · stale-dropped {debStats?.staleDropped ?? 0} · cooldown-suppressed {debStats?.suppressedCommands ?? 0} · committed {debStats?.committed ?? 0} · commit errors {debStats?.commitErrors ?? 0}
          </div>
          {suppressedList.length > 0 && (
            <div data-testid="voice-suppressed-reasons">
              <strong>Suppressed by reason:</strong> {suppressedList.map(([k, v]) => `${k} ${v}`).join(' · ')}
            </div>
          )}
        </div>
      </div>

      {/* THE ECHO. Committed rows persist; the pending utterance is a recessive line beneath them,
          never the existence condition for the strip. */}
      <div style={box} data-testid="voice-commit-ledger">
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: P.dark, marginBottom: 6 }}>
          Committed ({commits.length})
        </div>
        {commits.length === 0 ? (
          <div style={{ fontSize: '0.8rem', color: P.light }}>Nothing has settled yet.</div>
        ) : (
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: '0.8rem', color: P.dark, lineHeight: 1.7 }}>
            {commits.map((c, i) => (
              <li key={`${c.atMs}-${i}`} data-testid="voice-commit-row">
                {describe(c.result)} <span style={{ color: P.light }}>· {c.path} · +{c.atMs - t0Ref.current}ms</span>
              </li>
            ))}
          </ol>
        )}
        <div
          data-testid="voice-pending-echo"
          style={{ marginTop: 8, fontSize: '0.78rem', color: P.light, fontStyle: 'italic' }}
        >
          {pendingEcho ? `hearing: ${describe(pendingEcho)}` : 'hearing: —'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <button type="button" onClick={running ? stop : start} style={btn(running ? P.terra : P.green)}>
          {running ? 'Stop probe' : 'Start probe'}
        </button>
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText(lines.join('\n'))}
          disabled={lines.length === 0}
          style={{ ...btn(lines.length ? P.mid : P.light), cursor: lines.length ? 'pointer' : 'not-allowed' }}
        >
          Copy log
        </button>
      </div>

      <pre data-testid="voice-probe-log" style={{
        maxHeight: 320, overflow: 'auto', margin: 0, padding: 10,
        background: P.white, border: `1px solid ${P.border}`, borderRadius: 8,
        fontSize: '0.72rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: P.dark,
      }}>
        {lines.length ? lines.join('\n') : 'No run yet.'}
      </pre>
    </section>
  )
}
