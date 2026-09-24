// src/components/LogManyVoice.jsx
// V5-VOICECARE-001 — spoken bulk care on Log many: "water all bag area", "fed all pasture in ground
// except zephyr, crimson sweet, king richard". Dave's placement decision (2026-09-24): a mic ON LOG
// MANY, because a spoken area already means what Log many's zone scope means (every live plant in it).
//
// THE ENGINE IS NOT HERE. voiceCareGrammar.js says what was said, voiceCareResolve.js decides which
// plantings it means (R0–R7 of _roadmapexec_20260916/lane-G-voicecare-hostres.md) and voiceCareBatch.js
// moves it across the wire. This file is the HOST: it listens, shows the read-back, waits for the
// go-ahead and hands a logged batch to the page. Every rule below is about that hand-off.
//
// ── THREE THINGS THIS HOST NEVER DOES ──────────────────────────────────────────────────────────
//   1. It never writes without an explicit go-ahead: the word "next" (the harvest save word, Dave's
//      Q-B) or a tap on the confirm button. Silence, any other words, a timeout, an edit to the list
//      and every error all end with NOTHING written.
//   2. It never writes the area minus the skips. The write names the planting ids that were read
//      back (writeCarePlan: scope `ids`), so a planting added or ended in between is a 409 rather
//      than a silently different batch.
//   3. It never touches the page's own form. The frame covers the form; the form keeps its type,
//      date, note, water amount and hand-made picks, and its draft stash and guards keep running.
//
// ── WHY lib/transcribe.js AND NOT VoiceHarvest's RECOGNISER ────────────────────────────────────
// startLiveTranscription is the shared single-session wrapper: VOICEDUPE slot + echo guards, the mic
// arbiter hold, the start and no-speech watchdogs, the voice-debug capture, and an onEnd that hands
// back the whole utterance rebuilt from REVISED slots — the "the utterance boundary is the
// delimiter" contract voiceCareGrammar was designed on. VoiceHarvest's recogniser and the frozen
// debouncer serve a minutes-long continuous run with data commits at session boundaries; one command
// per tap has none of that. The wrapper never re-arms, and Chrome Android can end a session in
// ~1.7 s having heard nothing (2026-09-13 trace), so the WINDOW below re-arms empty sessions until a
// deadline. A session WITH words is decided once, at its end, never on its first final: Chrome
// revises finals inside a session ("bitter" -> "bitter melon", BUG-VOICEDUPE-003), and a "next" that
// is revised to "next to the fence" must cancel, not confirm.
//
// ── NOTHING SPEAKS ─────────────────────────────────────────────────────────────────────────────
// The read-back is SHOWN, never spoken: nothing in the app speaks, and a spoken read-back would be
// heard by the open mic — which, under Q-B, is "anything else" and cancels. The page's own
// ScopeChecklist is the visual twin: the area's plants with the skipped ones unticked, fed the SAME
// dry-run answer the plan was built from so the list cannot drift from the sentence above it.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { P } from '../lib/constants.js'
import { T } from './forms/formStyles.js'
import { ScopeChecklist } from './forms'
import Icon from './Icon.jsx'
import { startLiveTranscription, isTranscriptionSupported } from '../lib/transcribe.js'
import { isMicHeld } from '../lib/micArbiter.js'
import { classifyCareCommand } from '../lib/voiceCareGrammar.js'
import { careConfirmDecision, CARE_CONFIRM_PROMPT } from '../lib/voiceCareResolve.js'
import { prepareCarePlan, writeCarePlan } from '../lib/voiceCareBatch.js'
import { fetchAliases, indexAliases } from '../lib/voiceAliases.js'
import { splitCropAliases } from '../lib/comboboxInput.js'
import { EVENT_TYPE_META } from '../lib/eventTypes.js'
import { useDismissable } from '../context/DismissRegistry.jsx'
import { LAYER } from '../lib/dismissLayers.js'
import { setReloadBlocked } from '../lib/reloadGate.js'

// Listening windows. NONE OF THESE IS MEASURED — the confirm window in particular is design-note
// open question 3 (laneD2-voicecare-core.md §9.3) and needs a device number, not this guess. What
// each one bounds: COMMAND — how long a tap waits for the first words; CONFIRM — how long the
// read-back waits for "next" before silence counts as a cancel; SETTLE — how long after the last
// words the host ends a session Chrome is keeping open (desktop does; Android usually ends it first).
export const COMMAND_WINDOW_MS = 10000
export const CONFIRM_WINDOW_MS = 20000
export const COMMAND_SETTLE_MS = 2000
export const CONFIRM_SETTLE_MS = 1200
export const REARM_DELAY_MS = 150
// An AUTOMATIC start that finds the mic held waits this many re-arm delays for it to clear, then gives
// up with 'taken'. It never TAKES the mic — the check and the acquire run in one synchronous call, so
// nothing can slip between them. The wait exists for one case: OUR OWN session, cancelled a moment
// ago (a confirm TAP cancels the live "next" session before writing), whose hold Chrome releases only
// when it delivers `end`, asynchronously after abort(). A retry reopened in that instant would
// otherwise read our own hold as someone else's and tell him another microphone took over.
export const HELD_RECHECKS = 2
// A window that keeps being handed empty sessions this many times is not "quiet", it is broken.
const MAX_REARMS = 12
const MIC_LABEL = 'log-many-voice'

// The household list the names resolve against (U). This file is a censused consumer of the picker
// projection — lambda/plants/grid-view.test.js lists it with the fields it reads.
const PICKER_PATH = '/api/plants?view=picker'

const NOTHING = 'Nothing was logged.'
const MIC_TEXT = {
  nothing: 'I didn’t hear anything.',
  denied: 'The microphone is blocked for this app — allow it in Chrome’s site settings.',
  unavailable: 'This browser can’t listen.',
  'silent-failure': 'The microphone didn’t start.',
  failed: 'The microphone didn’t start.',
  aborted: 'Listening stopped — the screen may have gone off.',
  taken: 'Another microphone on this screen took over.',
}
const NO_RETRY = new Set(['denied', 'unavailable'])
// A cancel whose words start like the second half of a command: Chrome ended the session at a pause
// ("fed all pasture in ground" | "except zephyr…"), the first half was read back with no skips, and
// the rest arrived in the confirm window. The confirm step is what made that safe; this line is
// what makes it understandable.
const CONTINUATION = /^(except|excluding|but not|apart from|other than)\b/i

// U + A in one load, started on the first tap (in parallel with listening) and awaited only when a
// command actually names plants to skip. Crop aliases are attached to the ROW the way VoiceHarvest
// attaches them, because careTerms() reads `crop_aliases` off the planting.
async function loadVocabulary(apiFetch) {
  const [plants, cropTypes, aliasRows] = await Promise.all([
    Promise.resolve()
      .then(() => apiFetch(PICKER_PATH))
      .then((r) => {
        const rows = Array.isArray(r?.plants) ? r.plants : Array.isArray(r) ? r : null
        if (!rows) throw new Error('The plant list came back unreadable')
        return { ok: true, rows: rows.filter((p) => p && !p.archived_at) }
      })
      .catch(() => ({ ok: false, rows: [] })),
    Promise.resolve()
      .then(() => apiFetch('/api/varieties/crop-types'))
      .then((d) => (Array.isArray(d) ? d : []))
      .catch(() => []),
    // Fails soft to [] by contract (voiceAliases.js): forgetting his taught names degrades matching,
    // it never blocks it.
    fetchAliases(apiFetch),
  ])
  const bySlug = new Map(cropTypes.map((c) => [c.slug, c]))
  const plantings = plants.rows.map((p) => {
    const aliases = splitCropAliases(bySlug.get(p?.variety_ref?.crop_type_slug)?.search_aliases)
    return aliases.length ? { ...p, crop_aliases: aliases } : p
  })
  return { ok: plants.ok, plantings, aliasIndex: indexAliases(aliasRows) }
}

function listJoin(items) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// What the voice write will NOT carry from the form beneath it, said only when the form holds it.
function formNoticeText(formState, eventType) {
  if (!formState) return null
  const parts = []
  if (formState.backDated) parts.push('back-date')
  if (formState.hasNote) parts.push('note')
  if (formState.depthChosen && eventType === 'watering') parts.push('water amount')
  if (formState.picksMade) parts.push('picks')
  if (!parts.length) return null
  return `Voice logs only what it read back, for today. The ${listJoin(parts)} on the form ${parts.length === 1 ? 'is' : 'are'} kept but not used.`
}

const sameIdSet = (a, b) => {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}
const sameDecisions = (a = {}, b = {}) => {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => b[k] === a[k])
}

/**
 * Props
 *   apiFetch        the `fetch` from useApiFetch() (injected, so tests stub the far side of the wire)
 *   careLocations   L — careLocations(GET /api/locations): name + full_path per location
 *   projects, locations   what the page hands its own ScopeChecklist (zone chips)
 *   runDryRun       the page's dry-run function; the fallback if the voice list is ever re-scoped
 *   formState       { backDated, hasNote, depthChosen, picksMade } — the form content voice will NOT use
 *   onLogged(res, plan)   a batch was written; the page shows its own result card with Undo
 */
export default function LogManyVoice({
  apiFetch, careLocations, projects = [], locations = [], runDryRun, formState, onLogged,
}) {
  const [supported] = useState(() => isTranscriptionSupported())
  // phase: idle | listening | checking | readback | writing | refused | cancelled | failed | mic
  const [view, setView] = useState({ phase: 'idle' })
  const [hearing, setHearing] = useState('')
  const viewRef = useRef(view)
  viewRef.current = view

  // `windowRef` is the ONE live listening window, or null. Every recogniser callback checks that it
  // still belongs to the current window before acting, so a late event from a window we already
  // closed (Chrome dispatches `aborted` and `end` after our own cancel) can never move the flow.
  const windowRef = useRef(null)
  // Bumped whenever a flow ends or restarts; an async step that resumes into a newer generation
  // drops its result instead of applying it to a frame the user has since closed.
  const runRef = useRef(0)
  const vocabRef = useRef(null)
  const writingRef = useRef(false)
  const aliveRef = useRef(true)
  const onLoggedRef = useRef(onLogged)
  onLoggedRef.current = onLogged
  const seedRef = useRef(null)

  const closeWindow = useCallback(() => {
    const w = windowRef.current
    windowRef.current = null
    if (!w) return
    for (const t of Object.values(w.timers)) clearTimeout(t)
    try { w.handle?.cancel() } catch { /* already ended */ }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false; runRef.current += 1; closeWindow() }
  }, [closeWindow])

  // ── the listening window ──────────────────────────────────────────────────────────────────────
  // Exactly one of onWords / onSilence / onMicError fires, once. An EMPTY session is re-armed until
  // the deadline — never over another surface's mic: the arbiter's rule is that the newest USER start
  // wins, and a background re-arm taking it back would steal a mic he just tapped. `tapStart` marks
  // the one start that IS a user start — the tap that opened the command window (see arm()).
  const openWindow = useCallback(({ deadline, settleMs, onWords, onSilence, onMicError, tapStart = false }) => {
    closeWindow()
    const w = {
      deadline, settleMs, tapStart, handle: null, words: false, lastError: null,
      rearms: 0, starts: 0, heldChecks: 0, timers: {},
    }
    windowRef.current = w
    const finish = (fire) => {
      if (windowRef.current !== w) return
      windowRef.current = null
      for (const t of Object.values(w.timers)) clearTimeout(t)
      fire()
    }
    const arm = () => {
      if (windowRef.current !== w) return
      // REVIEW MINOR-1 (review-logmany-voice.md). Only the TAP that opened a window may take the mic
      // from another surface — that is the arbiter's newest-user-start rule, and the tap is this
      // surface's user start. Every other start is AUTOMATIC: a re-arm after Chrome ends an empty
      // session, the "next" window opening by itself under the read-back, a relisten, a retry. None
      // of those may evict a mic the user tapped since. The only check used to sit in onEnd, 150 ms
      // BEFORE the re-arm, so a mic taken inside that gap was taken straight back (reproduced by the
      // seat with this component's own harness). It is made HERE, in the same synchronous call as the
      // acquire inside startLiveTranscription, so nothing can slip between the check and the acquire.
      if (!(w.tapStart && w.starts === 0) && isMicHeld()) {
        if (w.heldChecks++ < HELD_RECHECKS) { w.timers.rearm = setTimeout(arm, REARM_DELAY_MS); return }
        finish(() => onMicError('taken'))
        return
      }
      w.starts += 1
      w.heldChecks = 0
      w.words = false
      w.lastError = null
      w.handle = startLiveTranscription({
        debugLabel: MIC_LABEL,
        onResult: ({ transcript }) => {
          if (windowRef.current !== w) return
          const t = String(transcript || '').trim()
          if (!t) return
          w.words = true
          setHearing(t)
          clearTimeout(w.timers.settle)
          w.timers.settle = setTimeout(() => {
            if (windowRef.current === w) { try { w.handle?.stop() } catch { /* ended */ } }
          }, w.settleMs)
        },
        onError: (code) => {
          if (windowRef.current !== w) return
          // These two are followed by `end`, which decides with whatever was heard.
          if (code === 'no-speech' || code === 'aborted') { w.lastError = code; return }
          // The rest may arrive with no `end` at all (a start that threw, a start that never
          // began), so they finish here.
          finish(() => { try { w.handle?.cancel() } catch { /* ended */ } onMicError(code) })
        },
        onEnd: ({ finalTranscript }) => {
          if (windowRef.current !== w) return
          clearTimeout(w.timers.settle)
          const text = String(finalTranscript || '').trim()
          if (text) { finish(() => onWords(text)); return }
          if (w.lastError === 'aborted') { finish(() => onMicError('aborted')); return }
          if (Date.now() >= w.deadline) { finish(onSilence); return }
          // Our own hold was released in `onend` before this callback runs, so a hold now is someone
          // else's — say so at once. arm() re-checks, for a mic taken in the gap before the re-arm.
          if (isMicHeld()) { finish(() => onMicError('taken')); return }
          if (++w.rearms > MAX_REARMS) { finish(() => onMicError('failed')); return }
          w.timers.rearm = setTimeout(arm, REARM_DELAY_MS)
        },
      })
    }
    // At the deadline, words already in flight are allowed to finish and decide; an empty window is
    // silence.
    w.timers.deadline = setTimeout(() => {
      if (windowRef.current !== w) return
      if (w.words) { try { w.handle?.stop() } catch { /* ended */ } return }
      finish(() => { try { w.handle?.cancel() } catch { /* ended */ } onSilence() })
    }, Math.max(0, deadline - Date.now()))
    arm()
  }, [closeWindow])

  const ensureVocab = useCallback(() => {
    const cur = vocabRef.current
    if (cur && !cur.failed) return cur.promise
    const entry = { failed: false, promise: null }
    entry.promise = loadVocabulary(apiFetch).then((v) => { if (!v.ok) entry.failed = true; return v })
    vocabRef.current = entry
    return entry.promise
  }, [apiFetch])

  // ── cancel / confirm ──────────────────────────────────────────────────────────────────────────
  const cancelPlan = useCallback((reason, said = null) => {
    closeWindow()
    setView((v) => (v.phase !== 'readback' ? v : {
      phase: 'cancelled', heard: v.heard, reason, said, readBack: v.plan.readBackText,
    }))
  }, [closeWindow])

  const commitRef = useRef(null)

  const openConfirm = useCallback((plan, extra = {}) => {
    const deadline = Date.now() + CONFIRM_WINDOW_MS
    setHearing('')
    setView((v) => ({ ...v, ...extra, phase: 'readback', plan, deadline, micNote: null }))
    const listen = () => openWindow({
      deadline,
      settleMs: CONFIRM_SETTLE_MS,
      onWords: (text) => {
        const decision = careConfirmDecision(text)
        if (decision === 'confirm') { commitRef.current?.(plan); return }
        // Only punctuation reached us — not an utterance. Keep the same deadline.
        if (decision === 'ignore') { if (Date.now() < deadline) listen(); else cancelPlan('timeout'); return }
        cancelPlan('words', text)
      },
      onSilence: () => cancelPlan('timeout'),
      // The mic is gone but the plan is not: the tap still confirms until the deadline, which the
      // countdown effect below enforces once no window is running.
      onMicError: (code) => setView((v) => (v.phase === 'readback' ? { ...v, micNote: code } : v)),
    })
    listen()
  }, [openWindow, cancelPlan])

  const commit = useCallback(async (plan) => {
    if (writingRef.current) return
    writingRef.current = true
    // The recogniser is stopped BEFORE the write — nothing it hears from here on can matter.
    closeWindow()
    const run = runRef.current
    setView((v) => ({ ...v, phase: 'writing' }))
    let res
    try {
      res = await writeCarePlan(apiFetch, plan)
    } catch (e) {
      res = { ok: false, retryable: false, spoken: `${NOTHING} ${e?.message ?? ''}`.trim() }
    } finally {
      writingRef.current = false
    }
    if (!aliveRef.current || run !== runRef.current) return
    if (res.ok) {
      runRef.current += 1
      setView({ phase: 'idle' })
      onLoggedRef.current?.(res, plan)
      return
    }
    // Outcome unknown (timeout / 5xx): the SAME plan and key again, so a repeat cannot log twice.
    if (res.retryable) { openConfirm(plan, { retryNote: res.spoken }); return }
    setView((v) => ({ phase: 'failed', heard: v.heard, message: res.spoken, readBack: plan.readBackText }))
  }, [apiFetch, closeWindow, openConfirm])
  commitRef.current = commit

  // ── the command ───────────────────────────────────────────────────────────────────────────────
  const processCommand = useCallback(async (text) => {
    const run = runRef.current
    const stale = () => !aliveRef.current || run !== runRef.current
    setView({ phase: 'checking', heard: text })
    try {
      const care = classifyCareCommand(text)
      if (care == null) {
        setView({ phase: 'refused', heard: text, message: `That doesn’t start with water, feed, mulch or weed — say it like “water all bag area”. ${NOTHING}` })
        return
      }
      let vocab = { ok: true, plantings: [], aliasIndex: null }
      if (care.kind === 'care' && (care.exclusions?.length ?? 0) > 0) {
        vocab = await ensureVocab()
        if (stale()) return
        // Without the list every name would read as "couldn't find", which blames the words.
        if (!vocab.ok) {
          setView({ phase: 'refused', heard: text, message: `I couldn’t load your plant list to check the names. ${NOTHING}` })
          return
        }
      }
      // The dry run prepareCarePlan makes is captured, so the checklist shows THAT answer.
      let dryRun = null
      const capture = (url, opts) => Promise.resolve(apiFetch(url, opts)).then((res) => {
        try {
          const body = JSON.parse(opts?.body ?? 'null')
          if (body?.dry_run) dryRun = { body, res }
        } catch { /* not a JSON body */ }
        return res
      })
      const plan = await prepareCarePlan(capture, {
        care, plantings: vocab.plantings, locations: careLocations, aliasIndex: vocab.aliasIndex,
      })
      if (stale()) return
      if (plan?.kind !== 'care_plan' || !dryRun) {
        setView({ phase: 'refused', heard: text, message: plan?.spokenReason ?? `I couldn’t use that. ${NOTHING}` })
        return
      }
      openConfirm(plan, { heard: text, dryRun, retryNote: null })
    } catch (e) {
      if (stale()) return
      setView({ phase: 'refused', heard: text, message: `Something went wrong reading that. ${NOTHING}` })
    }
  }, [apiFetch, careLocations, ensureVocab, openConfirm])

  // MUST stay synchronous from the tap to startLiveTranscription — the user-activation rule
  // transcribe.js documents. No await before openWindow().
  const startCommand = useCallback(() => {
    runRef.current += 1
    closeWindow()
    ensureVocab()
    setHearing('')
    setView({ phase: 'listening' })
    openWindow({
      deadline: Date.now() + COMMAND_WINDOW_MS,
      settleMs: COMMAND_SETTLE_MS,
      onWords: processCommand,
      onSilence: () => setView({ phase: 'mic', code: 'nothing' }),
      onMicError: (code) => setView({ phase: 'mic', code }),
      // The tap IS the user start: its first session takes the mic even from another surface,
      // exactly as every other mic in the app does (micArbiter.js). Its re-arms do not.
      tapStart: true,
    })
  }, [closeWindow, ensureVocab, openWindow, processCommand])

  // "Stop" = I'm done talking: end the session and use what was heard.
  const stopListening = useCallback(() => {
    const w = windowRef.current
    if (!w) return
    if (w.words) { try { w.handle?.stop() } catch { /* ended */ } return }
    w.deadline = 0
    try { w.handle?.stop() } catch { /* ended */ }
  }, [])

  const closeFrame = useCallback(() => {
    if (writingRef.current) return
    runRef.current += 1
    closeWindow()
    setView({ phase: 'idle' })
  }, [closeWindow])

  const onConfirmTap = useCallback(() => {
    const v = viewRef.current
    if (v.phase !== 'readback') return
    // By the wall clock, not the timer: a throttled timer must never leave a stale plan confirmable.
    if (Date.now() >= v.deadline) { cancelPlan('timeout'); return }
    commit(v.plan)
  }, [cancelPlan, commit])

  // The deadline for a read-back whose mic has already stopped: no window is left to time it out,
  // and "silence cancels" has to stay true without one. (The visible countdown ticks in its own
  // child so the checklist beneath is not re-rendered twice a second.)
  const phase = view.phase
  useEffect(() => {
    if (phase !== 'readback') return undefined
    const id = setInterval(() => {
      const v = viewRef.current
      if (v.phase === 'readback' && Date.now() >= v.deadline && !windowRef.current) cancelPlan('timeout')
    }, 500)
    return () => clearInterval(id)
  }, [phase, cancelPlan])

  const frameOpen = phase !== 'idle'
  useDismissable({ open: frameOpen, onDismiss: closeFrame, busy: phase === 'writing', layer: LAYER.DIALOG })
  // A write in flight is the one moment a deploy reload would lose something: the batch may land
  // while the page that would show it (and its Undo) is gone.
  const reloadKey = `log-many-voice:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadKey, phase === 'writing')
    return () => setReloadBlocked(reloadKey, false)
  }, [reloadKey, phase])

  // ── the checklist twin ────────────────────────────────────────────────────────────────────────
  const plan = view.plan ?? null
  const dryRun = view.dryRun ?? null
  const seed = useMemo(() => {
    if (!plan || !dryRun) return null
    const skipped = new Set(plan.exclusions.flatMap((e) => e.plantingIds))
    const decisions = {}
    for (const p of dryRun.res?.plantings ?? []) {
      if (skipped.has(String(p.id).toLowerCase())) decisions[p.id] = false
    }
    // baseline TRUE whatever the stored "start with nothing selected" preference says: a spoken
    // area means every live plant in it (Q-A). touched TRUE so the checklist never re-seeds it.
    return { decisions, baseline: true, touched: true, mode: 'bulk' }
  }, [plan, dryRun])
  seedRef.current = seed
  const voiceScope = useMemo(() => (plan ? { type: 'space', location_id: plan.location.id } : null), [plan])
  const voiceDryRun = useCallback((args) => {
    const d = dryRun
    if (d && args?.scope?.type === 'space' && args.scope.location_id === d.body.scope?.location_id
        && args.eventType === d.body.event_type && !args.eventDate) {
      return Promise.resolve(d.res)
    }
    return runDryRun(args)
  }, [dryRun, runDryRun])
  // ANY edit to the list cancels: the read-back is a promise about an exact set, and a list that
  // no longer matches it must not be confirmable by "next". Edits = a decision or the baseline or
  // the mode moving off the seed; the id comparison also catches a list that re-previewed.
  const onVoiceSelection = useCallback((sel) => {
    const v = viewRef.current
    const s = seedRef.current
    if (v.phase !== 'readback' || !s) return
    const st = sel?.selectionState
    const edited = !!st && (st.baseline !== s.baseline || st.mode !== s.mode || !sameDecisions(st.decisions, s.decisions))
    const included = sel?.includedIds ?? []
    const drifted = included.length > 0
      && !sameIdSet(new Set(included.map((id) => String(id).toLowerCase())), new Set(v.plan.keepIds))
    if (edited || drifted) cancelPlan('edited')
  }, [cancelPlan])
  const onVoiceScope = useCallback(() => cancelPlan('edited'), [cancelPlan])

  if (!supported) return null

  const verbLabel = plan ? (EVENT_TYPE_META[plan.eventType]?.label ?? plan.eventType).toLowerCase() : ''
  const notice = plan ? formNoticeText(formState, plan.eventType) : null

  return (
    <>
      <div data-testid="lmv-card" style={card}>
        <button type="button" data-testid="lmv-start" onClick={startCommand} style={startBtn}>
          <span aria-hidden="true" style={{ display: 'inline-flex' }}><Icon name="media.mic" size={22} decorative style={{ color: P.white }} /></span>
          Log by voice
        </button>
        <p style={hint}>Say “water all bag area” or “fed all pasture in ground except zephyr”, then “next”.</p>
      </div>

      {frameOpen && (
        <div data-testid="lmv-frame" role="group" aria-label="Log by voice"
          style={{
            position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: P.cream,
            display: 'grid', gridTemplateRows: 'auto 1fr auto', gridTemplateColumns: 'minmax(0, 1fr)',
            overflow: 'hidden', overscrollBehavior: 'contain',
          }}
        >
          {/* ── TRACK 1 — what is happening, and (in a read-back) the sentence itself ── */}
          <div style={{ padding: '10px 16px 12px', borderBottom: `1px solid ${P.border}`, backgroundColor: P.white, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <button type="button" data-testid="lmv-close" onClick={closeFrame} disabled={phase === 'writing'} style={ghostBtn}>Close</button>
              <span style={{ flex: 1, minWidth: 0, fontWeight: 700, color: P.dark, fontSize: '0.95rem' }}>Log by voice</span>
            </div>
            <Headline view={view} hearing={hearing} />
            {view.heard && phase !== 'listening' && (
              <p data-testid="lmv-heard" style={{ margin: '6px 0 0', color: P.light, fontSize: '0.8rem', overflowWrap: 'anywhere' }}>
                Heard: “{view.heard}”
              </p>
            )}
            {(phase === 'readback' || phase === 'writing') && notice && (
              <p data-testid="lmv-notice" style={{ margin: '6px 0 0', color: P.mid, fontSize: '0.8rem', lineHeight: 1.4 }}>{notice}</p>
            )}
          </div>

          {/* ── TRACK 2 — the only scroller: the checklist twin, or the detail of an outcome ── */}
          <div style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '12px 16px' }}>
            {phase === 'listening' && (
              <p style={{ margin: 0, color: P.mid, fontSize: '0.88rem', lineHeight: 1.5 }}>
                Say the verb, the area, and anything to skip — “water all bag area”, or “fed all pasture in
                ground except zephyr, crimson sweet, king richard”.
              </p>
            )}
            {(phase === 'readback' || phase === 'writing') && plan && seed && (
              <ScopeChecklist
                key={plan.idempotencyKey}
                scope={voiceScope}
                onScopeChange={onVoiceScope}
                projects={projects}
                locations={locations}
                eventType={plan.eventType}
                eventDate=""
                verbLabel={verbLabel}
                runDryRun={voiceDryRun}
                onSelectionChange={onVoiceSelection}
                initialSelection={seed}
              />
            )}
            {phase === 'cancelled' && view.readBack && (
              <p data-testid="lmv-was" style={{ margin: 0, color: P.light, fontSize: '0.82rem', lineHeight: 1.45 }}>
                It was: {view.readBack}
              </p>
            )}
            {phase === 'failed' && view.readBack && (
              <p style={{ margin: 0, color: P.light, fontSize: '0.82rem', lineHeight: 1.45 }}>It was: {view.readBack}</p>
            )}
          </div>

          {/* ── TRACK 3 — thumb zone: every action lives here ── */}
          <div style={{ padding: '10px 16px calc(12px + env(safe-area-inset-bottom))', borderTop: `1px solid ${P.border}`, backgroundColor: P.white, minWidth: 0 }}>
            {phase === 'listening' && (
              <div style={row}>
                <button type="button" data-testid="lmv-cancel" onClick={closeFrame} style={ghostBtn}>Cancel</button>
                <button type="button" data-testid="lmv-stop" onClick={stopListening} style={{ ...primaryBtn, flex: 1 }}>Stop listening</button>
              </div>
            )}
            {phase === 'checking' && (
              <div style={row}>
                <button type="button" data-testid="lmv-cancel" onClick={closeFrame} style={{ ...ghostBtn, flex: 1 }}>Cancel</button>
              </div>
            )}
            {(phase === 'readback' || phase === 'writing') && plan && (
              <>
                <p data-testid="lmv-prompt" aria-live="polite" style={{ margin: '0 0 8px', color: P.mid, fontSize: '0.82rem', lineHeight: 1.4 }}>
                  {phase === 'writing' ? 'Logging…'
                    : view.micNote ? `${MIC_TEXT[view.micNote] ?? MIC_TEXT.failed} Tap to log it, or Cancel.`
                    : <>{CARE_CONFIRM_PROMPT} <Countdown deadline={view.deadline} /></>}
                </p>
                <div style={row}>
                  <button type="button" data-testid="lmv-cancel" onClick={() => cancelPlan('tapped')} disabled={phase === 'writing'} style={ghostBtn}>Cancel</button>
                  <button type="button" data-testid="lmv-confirm" onClick={onConfirmTap} disabled={phase === 'writing'}
                    style={{ ...primaryBtn, flex: 1, opacity: phase === 'writing' ? 0.5 : 1 }}>
                    {phase === 'writing' ? 'Logging…' : `Log ${verbLabel} on ${plan.keepIds.length}`}
                  </button>
                </div>
              </>
            )}
            {(phase === 'refused' || phase === 'cancelled' || phase === 'failed' || phase === 'mic') && (
              <div style={row}>
                <button type="button" data-testid="lmv-done" onClick={closeFrame} style={ghostBtn}>Close</button>
                {!(phase === 'mic' && NO_RETRY.has(view.code)) && (
                  <button type="button" data-testid="lmv-retry" onClick={startCommand} style={{ ...primaryBtn, flex: 1 }}>
                    <span aria-hidden="true" style={{ display: 'inline-flex' }}><Icon name="media.mic" size={20} decorative style={{ color: P.white }} /></span>
                    Try again
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function Countdown({ deadline }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [deadline])
  const left = Math.max(0, Math.ceil((deadline - now) / 1000))
  return <span data-testid="lmv-countdown" style={{ color: P.light }}>· {left} s</span>
}

// The engine's sentences are written to be SPOKEN, so a failure ends "Nothing was logged." (or
// starts "Nothing was logged — …"). On screen that phrase is already the bold title above the
// message, so it is taken off the message rather than said twice.
function screenMessage(s) {
  const t = String(s ?? '').replace(/\s*Nothing was logged\.\s*$/, '').replace(/^Nothing was logged\s*—\s*/, '')
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''
}

// The top-of-frame sentence for each phase. A refusal and a cancel both SAY "Nothing was logged" —
// a hands-free user who half-reads a failure must never mistake it for a success.
function Headline({ view, hearing }) {
  const { phase } = view
  if (phase === 'listening') {
    return (
      <div data-testid="lmv-status" aria-live="polite">
        <p style={{ margin: 0, color: P.green, fontWeight: 700, fontSize: '1.1rem' }}>Listening…</p>
        {hearing && <p data-testid="lmv-hearing" style={{ margin: '4px 0 0', color: P.dark, fontSize: '0.95rem', overflowWrap: 'anywhere' }}>“{hearing}”</p>}
      </div>
    )
  }
  if (phase === 'checking') {
    return <p data-testid="lmv-status" aria-live="polite" style={{ margin: 0, color: P.mid, fontWeight: 700, fontSize: '1rem' }}>Checking…</p>
  }
  if (phase === 'readback' || phase === 'writing') {
    return (
      <div data-testid="lmv-status" aria-live="polite">
        {view.retryNote && (
          <p data-testid="lmv-retry-note" role="alert" style={{ margin: '0 0 6px', color: P.terra, fontWeight: 600, fontSize: '0.85rem' }}>{view.retryNote}</p>
        )}
        <p data-testid="lmv-readback" style={{ margin: 0, color: P.dark, fontWeight: 700, fontSize: '1.05rem', lineHeight: 1.4, overflowWrap: 'anywhere' }}>
          {view.plan.readBackText}
        </p>
      </div>
    )
  }
  let message = ''
  let title = 'Nothing was logged'
  if (phase === 'refused' || phase === 'failed') message = screenMessage(view.message)
  if (phase === 'mic') message = MIC_TEXT[view.code] ?? MIC_TEXT.failed
  if (phase === 'cancelled') {
    title = 'Cancelled — nothing was logged'
    if (view.reason === 'words') {
      message = CONTINUATION.test(String(view.said ?? '').trim())
        ? `Heard “${view.said}” — the command was split at a pause. Say it again in one go.`
        : `Heard “${view.said}” — only “next” logs it.`
    } else if (view.reason === 'timeout') {
      message = `No “next” within ${Math.round(CONFIRM_WINDOW_MS / 1000)} seconds.`
    } else if (view.reason === 'edited') {
      message = 'The list was changed, so it no longer matches what was read back.'
    }
  }
  return (
    <div data-testid="lmv-status" role="alert">
      <p style={{ margin: 0, color: P.terra, fontWeight: 700, fontSize: '1rem' }}>{title}</p>
      {message && <p data-testid="lmv-message" style={{ margin: '4px 0 0', color: P.dark, fontSize: '0.9rem', lineHeight: 1.4, overflowWrap: 'anywhere' }}>{message}</p>}
    </div>
  )
}

const card = {
  backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 16,
}
const startBtn = {
  width: '100%', minHeight: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
  backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 10,
  fontSize: '1.05rem', fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
}
const hint = { margin: '8px 2px 0', fontSize: '0.78rem', color: P.light, lineHeight: 1.45 }
const row = { display: 'flex', gap: 10, alignItems: 'center' }
const primaryBtn = {
  minHeight: T.buttonMinHeight, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  backgroundColor: P.green, color: P.white, border: 'none', borderRadius: 8, padding: '0 16px',
  fontSize: '0.95rem', fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
}
const ghostBtn = {
  minHeight: T.buttonMinHeight, padding: '0 16px', borderRadius: 8, border: `1px solid ${P.greenLight}`,
  backgroundColor: P.white, color: P.green, fontSize: '0.9rem', fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
}
