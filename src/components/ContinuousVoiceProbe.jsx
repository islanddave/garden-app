// src/components/ContinuousVoiceProbe.jsx
//
// V5-HARVESTVOICEFLOW-001 (BD-068) — the INSTRUMENT for the half of the investigation that cannot be
// answered anywhere but on Dave's own phone. Not a feature; not wired into any user-facing surface.
// It renders only inside the unlinked /admin/voice-debug route, the "device-truth surface"
// BUG-VOICEDUPE-002 established for exactly this — ask the device, do not reason about the device.
//
// WHY IT DOES NOT USE lib/transcribe.js, which is the app's own recogniser wrapper: transcribe.js
// deliberately ends a session on `onend` (endedFired guard, no restart) and layers two iOS watchdogs
// plus a duplicate-collapsing accumulator on top of the raw stream. All of that is behaviour we are
// deciding whether to CHANGE, so measuring through it would measure the wrapper. This talks to
// SpeechRecognition directly and reports what Chrome actually dispatches.
//
// THE FOUR QUESTIONS IT ANSWERS, from the ledger row:
//   1. Does `continuous = true` survive several utterances in ONE session on Chrome Android, or does
//      `onend` fire per-utterance? (Chromium 40324711: older Android providers did not support
//      continuous at all, and Chrome ends a session after a silence window regardless.) The counter
//      that settles it is sessions-vs-utterances: 1 session and 4 finals = continuous works;
//      4 sessions and 4 finals = it is re-arming behind the scenes.
//   2. HOW LONG the re-arm takes. This is the number that decides whether the whole flow is viable,
//      because the gap is dead air where speech is LOST — Dave saying "231 grams" into a 700ms gap
//      loses the utterance with no error and no signal, and a flow that silently eats every fourth
//      value is worse than the form it replaces.
//   3. Whether re-arming re-prompts for microphone permission. Read from the Permissions API before
//      and after rather than by watching for a dialog, so the answer does not depend on Dave
//      noticing one.
//   4. Whether an async round-trip mid-session kills recognition — the "pause while the input is
//      searched" step in Dave's flow. Probed with a real deferred call, not asserted. ANSWERED on
//      2026-08-27: it fired at 6008ms, resolved at 6121ms, and recognition carried straight on. The
//      simulation is therefore opt-in and OFF by default now — see C4. It stayed on one run too long
//      and confounded the only supersede gap that ever appeared to break the 500ms settle window.
//
// It ALSO runs every final transcript through the grammar (lib/voiceHarvestGrammar.js) so the
// classification is visible on the same screen as the raw text: that is how a "three count" that the
// device actually hears as "3 count" or "three counts" gets caught, rather than being assumed.
//
// ── S0 (build plan V101, 2026-08-27) ────────────────────────────────────────────────────────────
// THE DEBOUNCE LAYER IS NOW WIRED IN HERE, AND THIS IS THE ONLY PLACE IT RUNS. lib/voiceCommitDebounce
// .js was written, then edited three times in one day on analysis alone, and had never executed on a
// device — two of those edits, made in response to measurements, introduced fresh defects. The boss
// pass froze it to reasoning-only changes until a device run exists. S0 is how that freeze ends: it
// adds a HOST (a timer and callbacks) around the existing layer and changes not one line of it.
// Reverting is deleting one import.
//
// WHY THE PROBE AND NOT A REAL SURFACE: the debouncer cannot sit above transcribe.js — that wrapper's
// BUG-VOICEDUPE-003 fix pins `onResult` to never deliver a revised final (transcribe.rawEvents.test
// .js:154), and the supersede rule needs exactly that revision, so behind the wrapper it would commit
// the PREFIX ("231", not "231 G") — a silently wrong harvest weight with both suites green. The probe
// reads the RAW stream, which is the only stream the layer is correct above.
//
// THE THREE INSTRUMENTS S0 OWES, all rendered on screen and all in the copyable log:
//   * `dueAt()` — when the pending utterance would commit on its own. It was invisible, so a window
//     that never elapsed and a window that elapsed silently looked identical.
//   * TICK DRIFT — fired-at minus due-at. A settle window is only real if the host's timer actually
//     fires when it says. Android freezes timers on hidden pages; a 500 ms window that fires at
//     +40 000 ms is the staleness case `tick()` now discards, and this is what shows it happening.
//   * HELD WRITES THAT NEVER TICKED — `sessionEnd` deliberately refuses to flush a write command, so
//     every save depends on a tick landing. Replaying the device log produced 4 commits via
//     sessionEnd and ZERO via tick, which means the entire command axis of this design has never
//     been observed working. A held write that leaves the pending slot without committing is that
//     failure, counted.
// Commits are also split BY PATH (tick / sessionEnd / final) for the same reason: "it committed" is
// not the finding — WHICH path committed it is.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { P } from '../lib/constants.js'
import { classify } from '../lib/voiceHarvestGrammar.js'
import { createCommitDebouncer, WRITE_CLASS } from '../lib/voiceCommitDebounce.js'

// RUN BUDGETS (C3). Two hard stops, so a forgotten probe cannot hold the mic open forever: a re-arm
// count and a wall clock. The short pair is right for the 4-phrase fixture and WRONG for gate B6.
const SHORT_BUDGET = { restarts: 24, runMs: 4 * 60 * 1000, label: '24 re-arms / 4 min' }

// B6 asks for ≥20 utterances outdoors, in one session, with Jen's voice and an offline segment. The
// device re-arms roughly 5 sessions per 4 utterances, so 20 utterances is ~25 re-arms — meaning the
// short budget hard-stops INSIDE the fixture it exists to measure, and V101's own gate could not be
// executed by V101's own instrument. This is sized for that run plus mis-hears and retries.
//
// IT IS STILL BOUNDED, deliberately. "Long run" must not mean "no stop": twenty minutes of live mic
// is the cost of the measurement, not a licence, and it is opt-in per run because the person who
// forgets a 4-minute probe will also forget a 20-minute one.
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
  const [lines, setLines] = useState([])
  const [stats, setStats] = useState({ sessions: 0, finals: 0, interims: 0, gaps: [] })
  const [env, setEnv] = useState({ onDevice: '…', permBefore: '…', permAfter: '—' })

  // S0 host state. `commits` is the echo — the stand-in for the shipped harvest session ledger that
  // S3 will use instead. It is a LEDGER, not a pending indicator: the crucible measured a pending
  // echo rendering committed values for 3/1/276/2 ms (three below one 60 Hz frame, so they never
  // paint) while 66% of its screen time showed values already discarded. So what persists here is
  // what committed; what is pending is a recessive line beneath it.
  const [commits, setCommits] = useState([])
  const [pendingEcho, setPendingEcho] = useState(null)
  const [dueAtMs, setDueAtMs] = useState(null)
  const [debStats, setDebStats] = useState(null)
  const [hostMetrics, setHostMetrics] = useState(emptyHostMetrics)
  const [heldOutstanding, setHeldOutstanding] = useState(false)
  const [longRun, setLongRun] = useState(false)
  // C4. Q4 is answered, and an answered question does not earn an uncontrolled network event at a
  // fixed offset into every future run. What the fetch kept doing after it had served its purpose was
  // contaminating the measurement it sat inside: the single supersede gap that appeared to break the
  // 500ms settle window was 630ms with this round-trip inside it (fired 6008 / resolved 6121, between
  // finals at 5928 and 6558), against ≤353ms for every clean gap across both device runs. Off unless
  // someone is deliberately re-asking Q4.
  const [roundTrip, setRoundTrip] = useState(false)

  const recRef = useRef(null)
  const t0Ref = useRef(0)
  const endedAtRef = useRef(0)
  const stopRequestedRef = useRef(false)
  const restartsRef = useRef(0)
  const runTimerRef = useRef(null)
  const wallClockTimerRef = useRef(null)
  // CAPTURED AT START, never read live. A budget that can change under a run in progress makes the
  // run's own stop condition unknowable after the fact; the toggle is also disabled while running,
  // so the two can never disagree.
  const budgetRef = useRef(SHORT_BUDGET)
  // Captured at start for the same reason as the budget: a log has to describe the run that actually
  // happened, and a mode read live could disagree with what the log says fired.
  const roundTripRef = useRef(false)

  const debRef = useRef(null)
  const tickTimerRef = useRef(null)
  const metricsRef = useRef(emptyHostMetrics())
  // WHICH ENTRY POINT IS ON THE STACK. onCommit fires synchronously from inside final()/sessionEnd()
  // /tick(), so the path is knowable exactly — no inference, no heuristic.
  const commitPathRef = useRef(null)
  // The pending write we are currently waiting on a tick for, held BY REFERENCE. The layer builds a
  // fresh result object per final(), so object identity is a precise token for "still the same
  // pending utterance" without the layer having to expose an id.
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

  // Reconciles the held-write token against the layer's actual pending slot after every entry point.
  // A held write that is gone from the slot WITHOUT onCommit or onSuppressed having cleared it did
  // not commit — and the two ways that happens are NOT the same finding, so they are not one counter.
  //
  // SUPERSEDED is the design working. "next" pending, then the rest of "next to the fence" arrives
  // inside the window: the save is correctly replaced by a search and no write fires. That is the
  // single most valuable behaviour in the whole design, and an instrument that scored it as a failure
  // would report the feature succeeding as the feature breaking.
  //
  // LOST is the real defect: the slot emptied with nothing in its place and no commit, no
  // suppression. Nothing in this host does that, so it should read 0 for the entire device run — a
  // non-zero value means the layer moved on its own and the model here is wrong.
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

  // Release the mic on unmount no matter how the page is left — a probe that keeps recording after
  // Dave navigates away is a worse bug than anything it is measuring. The three timers go with it:
  // a tick firing into an unmounted host would commit against nothing and warn in React.
  useEffect(() => () => {
    stopRequestedRef.current = true
    if (runTimerRef.current) clearTimeout(runTimerRef.current)
    if (wallClockTimerRef.current) clearTimeout(wallClockTimerRef.current)
    if (tickTimerRef.current) clearTimeout(tickTimerRef.current)
    try { recRef.current?.abort() } catch { /* already gone */ }
    recRef.current = null
    debRef.current = null
  }, [])

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
      // GATE B1: resultIndex and results.length, which the first device fixture did not capture even
      // though voiceDebug.js:99-100 was already recording them on the OTHER capture path. Without the
      // pair, a re-delivery at the SAME index (the VOICEDUPE signature) is indistinguishable from a
      // new result at the next one — the exact distinction the whole duplicate analysis turns on.
      log(`result   resultIndex=${ev.resultIndex} len=${ev.results.length}`)
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i]
        const text = r[0]?.transcript ?? ''
        if (r.isFinal) {
          setStats(s => ({ ...s, finals: s.finals + 1 }))
          log(`  [${i}] FINAL   "${text.trim()}"  ->  ${describe(classify(text))}`)
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
      // THE RESTART, called with NO user gesture. Whether this succeeds is itself a finding: if
      // Chrome requires a fresh gesture per session, hands-free across a save is impossible and the
      // flow needs a different shape entirely. An error here is the answer, not a bug in the probe.
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

    if (tickTimerRef.current) { clearTimeout(tickTimerRef.current); tickTimerRef.current = null }
    metricsRef.current = emptyHostMetrics()
    heldWriteRef.current = null
    commitPathRef.current = null
    budgetRef.current = longRun ? LONG_BUDGET : SHORT_BUDGET
    roundTripRef.current = roundTrip
    log(`run budget: ${budgetRef.current.label}${longRun ? '  (LONG RUN — mic can stay live for 20 minutes)' : ''}`)
    // STATED EITHER WAY, deliberately. A log with no round-trip line would otherwise be ambiguous
    // between "the simulation was off" and "this log predates the toggle" — and a settle-window gap
    // measured under those two conditions does not mean the same thing.
    log(`search round-trip simulation: ${roundTrip ? 'ON — any gap spanning +6000ms is CONFOUNDED' : 'OFF — gaps are clean'}`)

    // A FRESH DEBOUNCER PER RUN, deliberately: `resetSession()` would clear the duplicate-suppression
    // memory of a layer that might still be holding a pending utterance from the previous run, which
    // is precisely the footgun its own docstring warns hosts about. A new instance has no history to
    // mis-clear.
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
    log('SAY: "cucumber" … "three count" … "231 grams" … "next"  (pause between each)')

    arm()

    // Question 4 — an async round-trip mid-session, at roughly the moment the real flow would be
    // searching for the spoken crop. A real deferred call, so if it DOES disturb recognition the log
    // shows an onend/onerror right after this line rather than us assuming it cannot. Answered once
    // already (see the header); this now fires only when someone opts in to asking it again.
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

  // NOTE: the tick timer is deliberately NOT cleared here. A write pending at the moment Dave taps
  // stop is exactly the case the run is measuring — letting the timer land records whether it ever
  // fires, whereas cancelling it would manufacture an un-ticked held write and score the instrument's
  // own cleanup as the finding.
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

  // The one line that decides question 1. Stated as a verdict rather than left for Dave to derive
  // from two counters, because the whole point of a device probe is to come back with an answer.
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

      {/* C3. The short budget hard-stops inside gate B6's own fixture, so the gate could not be
          executed by the instrument that is supposed to execute it. Opt-in per run, disabled while
          running, and it says out loud how long the mic can stay live — a 20-minute recorder is a
          thing you choose, not a default you inherit. */}
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

      {/* C4. Q4 is answered, so this fires only when someone is deliberately re-asking it. Default OFF
          is the whole point: the last run's one anomalous supersede gap had this fetch inside it, and
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
          never the existence condition for the strip. This is the probe's stand-in for the shipped
          harvest session ledger that S3 uses instead of building anything new. */}
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
