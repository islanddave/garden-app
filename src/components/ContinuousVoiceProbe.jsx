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
//      searched" step in Dave's flow. Probed with a real deferred call, not asserted.
//
// It ALSO runs every final transcript through the grammar (lib/voiceHarvestGrammar.js) so the
// classification is visible on the same screen as the raw text: that is how a "three count" that the
// device actually hears as "3 count" or "three counts" gets caught, rather than being assumed.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { P } from '../lib/constants.js'
import { classify } from '../lib/voiceHarvestGrammar.js'

const MAX_RESTARTS = 24          // hard stop so a forgotten probe cannot hold the mic open forever
const MAX_RUN_MS = 4 * 60 * 1000 // ...and a wall-clock stop for the same reason

function ctor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

// Chrome 139+ exposes on-device recognition (processLocally). Worth reporting because it removes the
// network round-trip that is the likeliest cause of a long re-arm gap — if it is available on Dave's
// device, question 2's answer may be very different from the cloud path's.
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

  const recRef = useRef(null)
  const t0Ref = useRef(0)
  const endedAtRef = useRef(0)
  const stopRequestedRef = useRef(false)
  const restartsRef = useRef(0)
  const runTimerRef = useRef(null)

  const log = useCallback((msg) => {
    const dt = t0Ref.current ? Date.now() - t0Ref.current : 0
    setLines(l => [...l, `+${String(dt).padStart(6, ' ')}ms  ${msg}`])
  }, [])

  useEffect(() => {
    probeOnDevice().then(onDevice => setEnv(e => ({ ...e, onDevice })))
  }, [])

  // Release the mic on unmount no matter how the page is left — a probe that keeps recording after
  // Dave navigates away is a worse bug than anything it is measuring.
  useEffect(() => () => {
    stopRequestedRef.current = true
    if (runTimerRef.current) clearTimeout(runTimerRef.current)
    try { recRef.current?.abort() } catch { /* already gone */ }
    recRef.current = null
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
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i]
        const text = r[0]?.transcript ?? ''
        if (r.isFinal) {
          const c = classify(text)
          const detail = c.kind === 'quantity' ? `quantity ${c.value} ${c.unit}`
            : c.kind === 'weight' ? `weight ${c.value} ${c.unit} (${Math.round(c.grams)}g)`
            : c.kind === 'command' ? `COMMAND ${c.command}`
            : c.kind === 'search' ? `search "${c.text}"`
            : `unparsed (${c.reason})`
          setStats(s => ({ ...s, finals: s.finals + 1 }))
          log(`FINAL   "${text.trim()}"  ->  ${detail}`)
        } else {
          setStats(s => ({ ...s, interims: s.interims + 1 }))
        }
      }
    }

    rec.onerror = (ev) => log(`onerror  ${ev?.error ?? 'unknown'}`)

    rec.onend = () => {
      endedAtRef.current = Date.now()
      log('onend')
      if (stopRequestedRef.current) { setRunning(false); log('— probe stopped —'); return }
      if (restartsRef.current >= MAX_RESTARTS) {
        setRunning(false); log(`— cap reached (${MAX_RESTARTS} re-arms) —`); return
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
  }, [log])

  const start = useCallback(async () => {
    setLines([]); setStats({ sessions: 0, finals: 0, interims: 0, gaps: [] })
    stopRequestedRef.current = false
    restartsRef.current = 0
    endedAtRef.current = 0
    t0Ref.current = Date.now()
    setRunning(true)

    const permBefore = await micPermission()
    setEnv(e => ({ ...e, permBefore, permAfter: '—' }))
    log(`mic permission before: ${permBefore}`)
    log('SAY: "cucumber" … "three count" … "231 grams" … "next"  (pause between each)')

    arm()

    // Question 4 — an async round-trip mid-session, at roughly the moment the real flow would be
    // searching for the spoken crop. A real deferred call, so if it DOES disturb recognition the log
    // shows an onend/onerror right after this line rather than us assuming it cannot.
    runTimerRef.current = setTimeout(() => {
      log('— simulating the search round-trip (keep talking) —')
      fetch('/manifest.webmanifest', { cache: 'no-store' })
        .then(() => log('round-trip resolved; recognition still armed?  see next event'))
        .catch(() => log('round-trip failed (offline?) — inconclusive for question 4'))
    }, 6000)

    // Wall-clock stop.
    setTimeout(() => {
      if (stopRequestedRef.current) return
      stopRequestedRef.current = true
      try { recRef.current?.stop() } catch { /* ignore */ }
    }, MAX_RUN_MS)
  }, [arm, log])

  const stop = useCallback(async () => {
    stopRequestedRef.current = true
    if (runTimerRef.current) clearTimeout(runTimerRef.current)
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

      <pre style={{
        maxHeight: 320, overflow: 'auto', margin: 0, padding: 10,
        background: P.white, border: `1px solid ${P.border}`, borderRadius: 8,
        fontSize: '0.72rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: P.dark,
      }}>
        {lines.length ? lines.join('\n') : 'No run yet.'}
      </pre>
    </section>
  )
}
