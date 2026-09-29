// src/components/putup/GoingNowView.jsx
// V5-INFLIGHTBATCH-001 — "Going now": the third segment on /put-up, listing open kitchen_batch rows
// from GET /api/kitchen-batches?state=going.
//
// WHY A SEGMENT AND NOT A TAB OR A BAND. PutUp.jsx:44-46 records the house pattern for "a thing you
// are in the middle of" verbatim — a MODE FLAG on an existing page, never a new destination — and
// BottomNav.jsx:41-48 records that six slots was already a stretch with nothing displaceable. A
// standing "3 batches going" band on Today is separately forbidden by precedent: four signalling
// surfaces have already been retired for noise (CRITTERS_QUIET, TODAY_BAND_HIDDEN, HarvestReadyBand,
// PreserveOffer), and StorageDeadlineAlert's rule is that Today may carry only threshold-CROSSED
// rows. The browsable list of everything going lives here. Two questions, two surfaces.
//
// WHAT THIS SURFACE DOES NOT DO, and each absence is a ruling rather than an omission — the reasons
// live at the top of ./goingNow.js: no readiness affordance, no countdown, no urgency tone, and no
// warning colour on a missing start.
//
// ⚠ THE ORIGINAL FORM OF THAT LIST ENDED "and nothing at all about pH, acidification or shelf
// stability." V5-PHRECORD-001 reversed the first of those three and only the first. This card now
// asks whether you have measured, records what you measured, and links to how — and it still says
// NOTHING about acidification, shelf stability, or whether any reading is good. A recorded value is
// rendered exactly as it was typed, beside the date it was taken, in the card's ordinary ink. It is
// never scored, never coloured, never compared to anything, never counted, and never gates anything.
// The reasoning, and the reversal's audit trail, are at the top of ./goingNow.js and ./PhReadingField.jsx.
import React, { useState, useMemo, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApiFetch } from '../../lib/api.js'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { ErrorBanner } from '../forms'
import {
  partitionGoing, describeAge, describeStage, describeExpectedWindow,
  FERMENT_STALL_NOTE, describeLastPhReading,
  OPEN_BATCH_CTA, CLOSED_DOOR_CTA, KIND_QUESTION, CHECK_ON_IT_CTA, cardQuestion,
} from './goingNow.js'
import CheckOnItSheet from './CheckOnItSheet.jsx'
import PutItUpSheet from './PutItUpSheet.jsx'
import PutUpStub from './PutUpStub.jsx'
import CheckInSaved from './CheckInSaved.jsx'
import { PUT_IT_UP_CTA } from './putItUp.js'
import KindChips, { kindBody } from '../kitchen/KindChips.jsx'

// A question on the card is ONE TARGET that opens Check on it (V4 §2.3: "the ruled pH prompt's link
// opens Check on it", the IA seat's F14 — the question is the door, not a second control beside it).
// It keeps the question's own ordinary ink; only the arrow wears the link colour.
const questionLink = {
  display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: T.tapMinHeight, padding: '2px 0',
  background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
  fontSize: '0.82rem', color: P.mid,
}

// "Sep 3". Month + day only: the year is noise on a surface whose entire subject is the recent past,
// and the one card that shows a year is a card about something that has been going for a year.
function shortDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ── "What kind of batch? →" ──────────────────────────────────────────────────────────────────────
// Put-Up 1a (V4 §2.3). The same inline-expand shape as the start-date editor (now on the batch's
// own surface, BatchDetailView.jsx) and for the same reason: an inline reveal is not a dismissable
// layer. One tap on a chip IS the answer — it PUTs {kind} through
// the shipped merge PUT (an absent key is left alone, so nothing else on the row moves) and the
// question is never asked again. "Other" is the one two-step answer in 1a, because the live CHECK
// still needs its short name; kindBody refuses to build that body without one.
//
// The question hides itself the moment the write lands, rather than waiting for the list re-read to
// carry the new kind back: a question that re-appears for the length of a round trip after it was
// answered reads as "that didn't take", which invites a second tap.
function KindQuestion({ batch, fetch, onChanged }) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState(null)
  const [otherText, setOtherText] = useState('')
  const [answered, setAnswered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // Synchronous exclusion, the BatchInputsField idiom: `busy` only disables the chips after React
  // commits, so two taps inside one frame would both read it false and both PUT.
  const writingRef = useRef(false)

  // Resolves true when the kind landed. A refused or failed write leaves the question open with the
  // chips un-pressed, so the next tap is a retry rather than a toggle-off.
  const save = useCallback(async (kind, text) => {
    const body = kindBody(kind, text)
    if (!body || !Object.keys(body).length) { setErr('Give it a short name first.'); return false }
    if (writingRef.current) return false
    writingRef.current = true
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}`, { method: 'PUT', body: JSON.stringify(body) })
      setAnswered(true)
      onChanged?.()
      return true
    } catch {
      setErr("Couldn't save that — try again.")
      return false
    } finally {
      writingRef.current = false
      setBusy(false)
    }
  }, [batch.id, fetch, onChanged])

  const choose = useCallback((kind) => {
    setErr(null)
    if (kind === 'other' || kind == null) { setPicked(kind); return }
    setPicked(kind)
    save(kind).then(ok => { if (!ok) setPicked(null) })
  }, [save])

  if (answered) return null

  if (!open) {
    return (
      <button type="button" data-testid="going-kind-question" onClick={() => setOpen(true)}
        style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
          background: 'none', border: 'none', padding: '2px 8px 2px 0', cursor: 'pointer',
          fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
        {KIND_QUESTION} →
      </button>
    )
  }

  return (
    <div data-testid="going-kind-editor" style={{ marginTop: 6 }}>
      {err && <div role="alert" data-alarm-ink-exempt="error" data-testid="going-kind-error"
        style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 6 }}>{err}</div>}
      <KindChips idPrefix="going-kind" value={picked} onChange={choose} disabled={busy}
        otherText={otherText} onOtherTextChange={setOtherText} ariaLabel={KIND_QUESTION} />
      <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm, marginTop: 6 }}>
        {picked === 'other' && (
          <button type="button" data-testid="going-kind-save" disabled={busy}
            onClick={() => save('other', otherText)}
            style={{ minHeight: T.tapMinHeight, padding: '6px 12px', cursor: busy ? 'default' : 'pointer',
              background: 'none', border: 'none', fontFamily: 'inherit', fontSize: '0.78rem',
              fontWeight: 700, color: P.green }}>
            Save
          </button>
        )}
        <button type="button" data-testid="going-kind-cancel" disabled={busy}
          onClick={() => { setOpen(false); setPicked(null); setOtherText(''); setErr(null) }}
          style={{ minHeight: T.tapMinHeight, padding: '6px 4px', cursor: 'pointer', background: 'none',
            border: 'none', fontFamily: 'inherit', fontSize: '0.78rem', color: P.light }}>
          Not now
        </button>
      </div>
    </div>
  )
}

// ── one batch ────────────────────────────────────────────────────────────────────────────────────
// Leads with WHAT IS KNOWN, never with the gap. The meta line is one joined string on purpose: it is
// the thing a test can assert as a full literal with both bounds and every separator, which is the
// standard this repo adopted after shipping an assertion that passes on a value ten days wrong.
function BatchCard({ batch, nowMs, fetch, onChanged, onOpen, onCheck, onPutUp, stub, savedStageId, paused }) {
  const age = describeAge(batch, nowMs)
  const stage = describeStage(batch, nowMs)
  const window = describeExpectedWindow(batch)
  // ONE inline question per card, chosen in goingNow.js — see cardQuestion. The card paints the
  // shape it is handed and decides nothing, so no edit here can render two questions at once.
  const question = cardQuestion(batch, nowMs)
  const lastPh = describeLastPhReading(batch)
  // Both halves or neither: a reading whose date will not render is not a dated line, so it does not
  // render at all rather than becoming a bare "current pH".
  const lastPhLine = lastPh && shortDate(lastPh.at) ? `pH ${lastPh.text} recorded ${shortDate(lastPh.at)}` : null

  const ageText = age == null
    ? null
    : age.kind === 'elapsed'
      // The precision grade rides as a QUALIFIER on the elapsed line ("about"), not as a separate
      // confession. A card whose most prominent line is a disclaimer teaches the user the record is
      // broken.
      ? (age.approx ? `about ${age.text}` : age.text)
      : (shortDate(age.at) ? `first recorded ${shortDate(age.at)}` : null)

  const meta = [ageText, stage?.label, stage?.since, window].filter(Boolean).join(' · ')

  return (
    <div data-testid="going-batch" data-batch-id={batch.id}
      style={{ marginBottom: T.space.sm, padding: '12px 14px', backgroundColor: P.white,
        // Paused reads as a DIFFERENT ANSWER, not a worse one: a dashed, muted edge rather than a
        // warning tone. A frozen candy parent resumes N times over months and is fine the whole way.
        border: paused ? `1px dashed ${P.border}` : `1px solid ${P.border}`,
        borderRadius: T.radiusBadge, opacity: paused ? 0.85 : 1 }}>
      <div data-testid="going-batch-title"
        style={{ fontWeight: 700, color: P.dark, fontSize: T.type.md }}>{batch.label}</div>
      {meta && (
        <div data-testid="going-batch-meta" style={{ marginTop: 3, color: P.mid, fontSize: '0.82rem' }}>{meta}</div>
      )}
      {paused && (
        <div data-testid="going-batch-paused" style={{ marginTop: 3, color: P.light, fontSize: '0.78rem' }}>
          {shortDate(batch.suspended_at) ? `Paused since ${shortDate(batch.suspended_at)}` : 'Paused'}
        </div>
      )}
      {/* THE ONE INLINE QUESTION (V4 §2.3), in one slot, chosen by cardQuestion. */}
      {/* The kind question, on a NULL kind only and never again once answered. It is the one door to
          the three ferment questions below: all are gated on kind = 'ferment', so a batch nobody has
          classified can never be asked about its brine or its pH. */}
      {question?.kind === 'kind' && <KindQuestion batch={batch} fetch={fetch} onChanged={onChanged} />}
      {/* The submersion prompt. A QUESTION, in the card's ordinary ink, with no verdict beside it
          and no list of failure signs under it — a checklist of what going wrong looks like invites
          the reader to conclude that its absence means success, which is the specific inference
          behind the documented olive botulism outbreak. Deliberately not a badge and not a warning
          colour: it asks you to go and look, it does not claim anything is wrong. */}
      {question?.kind === 'submersion' && (
        <button type="button" data-testid="going-question-link" onClick={() => onCheck?.(batch.id)} style={questionLink}>
          <span data-testid="going-batch-submersion" style={{ color: P.mid, fontSize: '0.82rem' }}>{question.text}</span>
          <span aria-hidden="true" style={{ color: P.green }}>→</span>
        </button>
      )}
      {/* The measure prompt. Another QUESTION, same ink, same absence of a verdict — it asks whether
          you measured and says nothing about what the number was or ought to be. UMN Extension's
          published "check the pH every 1 to 2 days" is the only cadence in the evidence base with a
          sourced number behind it, and this is that cadence and nothing more. */}
      {question?.kind === 'cadence' && (
        <button type="button" data-testid="going-question-link" onClick={() => onCheck?.(batch.id)} style={questionLink}>
          <span data-testid="going-batch-ph-prompt" style={{ color: P.mid, fontSize: '0.82rem' }}>{question.text}</span>
          <span aria-hidden="true" style={{ color: P.green }}>→</span>
        </button>
      )}
      {/* The one-week stall prompt (FOODSAFETY-RULING-V101 §4). It replaces the cadence line above
          rather than stacking under it — the choice is made in goingNow.js, not here. Ordinary ink,
          no badge, no warning colour and no urgency tone: the app is repeating a published deadline
          and asking you to go and measure, which is the only thing it is entitled to do. The
          attribution beneath it is not decoration — the deadline is borrowed from guidance written
          for businesses, and §4 requires the card to say whose it is. */}
      {question?.kind === 'stall' && (
        <div data-testid="going-batch-stall" style={{ marginTop: 4, color: P.mid, fontSize: '0.82rem' }}>
          <button type="button" data-testid="going-question-link" onClick={() => onCheck?.(batch.id)} style={questionLink}>
            <span>{question.text}</span>
            <span aria-hidden="true" style={{ color: P.green }}>→</span>
          </button>
          <div data-testid="going-batch-stall-note"
            style={{ marginTop: 3, color: P.light, fontSize: '0.78rem', lineHeight: 1.45 }}>
            {FERMENT_STALL_NOTE}
          </div>
        </div>
      )}
      {/* The newest reading, VERBATIM, with the date it was taken. Never a count, never a streak,
          never a tick, never a colour — a batch that never acidified produces an unbroken run of
          "checked" entries, so an aggregate over these would turn absent failure signs into apparent
          success. One dated line; the rest of the history is the stage log. */}
      {lastPhLine && (
        <div data-testid="going-batch-ph-last" style={{ marginTop: 3, color: P.mid, fontSize: '0.82rem' }}>
          {lastPhLine}
        </div>
      )}
      {Number(batch.input_count) > 0 && (
        <div data-testid="going-batch-inputs" style={{ marginTop: 3, color: P.light, fontSize: '0.78rem' }}>
          {Number(batch.input_count) === 1 ? '1 pick in' : `${Number(batch.input_count)} picks in`}
        </div>
      )}
      {savedStageId && <CheckInSaved key={savedStageId} batchId={batch.id} stageId={savedStageId} onUndone={onChanged} />}
      {stub && <PutUpStub stub={stub} onOpen={onOpen} onUndone={onChanged} />}
      {/* THE ACTION SLOT (V4 §2.3): at most three quiet actions — Check on it · Open (release 1b adds
          Put it up between them and moves nothing). Pause and "Set a start date" moved to the batch's
          own surface in Put-Up 1a, both being desk decisions about the batch rather than check-ins,
          and the inline pH recorder moved INTO Check on it — the pH button moves into Check on it. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: T.space.md }}>
        <button type="button" data-testid="going-check" onClick={() => onCheck?.(batch.id)}
          style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
            background: 'none', border: 'none', padding: '2px 8px 2px 0', cursor: 'pointer',
            fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
          {CHECK_ON_IT_CTA} →
        </button>
        {/* Put-Up release 1b: Put it up sits between Check on it and Open, and moves nothing else. */}
        <button type="button" data-testid="going-put-up" onClick={() => onPutUp?.(batch.id)}
          style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
            background: 'none', border: 'none', padding: '2px 8px 2px 0', cursor: 'pointer',
            fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
          {PUT_IT_UP_CTA} →
        </button>
        {/* THE ONE EXPLICIT DOOR to the batch's own surface, and the card itself deliberately stays
            INERT. The card holds interactive descendants with zero propagation guards, so a whole-card
            tap handler would make every one of them do two things, and wrapping the card in a <button>
            is invalid nesting. On a 390px screen with wet hands a stray tap on the chrome beside a chip
            would navigate away mid-edit. Worse, useNavigate is a no-op spy in every test that renders
            this file, so no test could have caught that regression. So: one labelled affordance in the
            card's action slot, a SIBLING of the inline expanders rather than their ancestor — the
            shipped "Set parent plant →" pattern, same ink, same type size, same tap floor. */}
        <button type="button" data-testid="going-open-batch" onClick={() => onOpen?.(batch.id)}
          style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
            background: 'none', border: 'none', padding: '2px 8px 2px 0', cursor: 'pointer',
            fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
          {OPEN_BATCH_CTA}
        </button>
      </div>
    </div>
  )
}

// `now` is an injectable prop, not a hidden Date.now() call. ONE instant for the whole render, so
// two cards can never disagree about what time it is mid-paint — and a test can pin an age to a
// fixed literal instead of to the wall clock. The wall-clock version of this passed under
// America/New_York and failed under UTC by four hours, which is precisely the class the blocking TZ
// re-run exists to catch and which millisecond-offset fixtures are structurally unable to expose.
// `onStartBatch` (Put-Up 1a, the seam with the page lane): the page mounts the shared StartBatchSheet
// and hands this view the callback that opens it. Absent — a host that has not wired the seam — the
// door keeps its shipped behaviour and goes to /capture, whose "Something in the kitchen" card opens
// the same sheet, so a missed wiring degrades to one extra step rather than a dead button.
export default function GoingNowView({ batches, loading, error, onReload, now, onStartBatch }) {
  const navigate = useNavigate()
  const { fetch } = useApiFetch()
  const nowMs = now ?? Date.now()
  const { active, paused } = useMemo(() => partitionGoing(batches), [batches])
  const empty = !loading && !error && active.length === 0 && paused.length === 0

  // The two doors, collapsed ONCE here for the same reason nowMs is: every card writes the mode
  // through the same callback, so no card can disagree with its sibling about what "open" means.
  //
  // A SEARCH PARAM ON THIS SAME ROUTE, never a child route — /put-up is overlayable and the overlay
  // tree has no catch-all, so a child route renders a blank screen on a dead tap when PutUp was
  // opened as a flyover. A param leaves the route match alone: the page never unmounts, the segment
  // survives, and Back pops the param. The other keys are preserved rather than replaced so ?session=
  // and anything a future door adds ride through untouched.
  const [searchParams, setSearchParams] = useSearchParams()
  const openBatch = useCallback((id) => {
    const next = new URLSearchParams(searchParams)
    next.delete('state'); next.set('batch', id)
    setSearchParams(next)
  }, [searchParams, setSearchParams])
  const openClosed = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.delete('batch'); next.set('state', 'closed')
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  // CHECK ON IT — one sheet for the whole view, holding the id of the batch being checked. The row
  // itself is read from the CURRENT list on every render, so a re-read that lands while the sheet is
  // open updates what it shows, and a batch that left the list closes it.
  const [checkingId, setCheckingId] = useState(null)
  const checking = useMemo(
    () => (checkingId ? [...active, ...paused].find(b => b.id === checkingId) ?? null : null),
    [checkingId, active, paused],
  )
  const closeCheck = useCallback(() => setCheckingId(null), [])
  // The write landed: close, then re-read the list — the honest recovery, never a local mutation
  // (the card's clocks and "last touched" come back from the view the server computes).
  // "Saved · Undo" in place (V4 §2.3, from 1b): the saved row's id, per batch, until the next visit.
  const [saved, setSaved] = useState({})
  const checkSaved = useCallback((body, answer) => {
    const batchId = checkingId
    const stageId = answer?.stage?.id ?? null
    if (batchId && stageId) setSaved(m => ({ ...m, [batchId]: stageId }))
    setCheckingId(null); onReload?.()
  }, [checkingId, onReload])

  // PUT IT UP (release 1b) — one sheet for the view, like Check on it. A landed sitting leaves a STUB in
  // the card's slot (V4 §2.4 "Completion"): inside the card when the batch is still going, in the card's
  // old place when "Put it up and finish" closed it. Held in this view's state, so it lasts until the
  // next visit and no longer — there is no timer.
  const [puttingId, setPuttingId] = useState(null)
  const putting = useMemo(
    () => (puttingId ? [...active, ...paused].find(b => b.id === puttingId) ?? null : null),
    [puttingId, active, paused],
  )
  const [stubs, setStubs] = useState([])
  const closePutUp = useCallback(() => setPuttingId(null), [])
  const putUpDone = useCallback(({ finish, stub, answer, batchId }) => {
    const index = active.findIndex(b => b.id === batchId)
    const stageId = answer?.stage?.id ?? null
    setStubs(ss => [...ss.filter(x => x.batchId !== batchId),
      { batchId, stageId, text: stub, index: index < 0 ? 0 : index, focus: !!finish }])
    setPuttingId(null)
    onReload?.()
  }, [active, onReload])
  const stubFor = (id) => stubs.find(x => x.batchId === id) ?? null
  // Stubs whose card has left the list (the batch finished) render in the card's old place.
  const listed = new Set([...active, ...paused].map(b => b.id))
  const orphanStubs = stubs.filter(x => !listed.has(x.batchId)).sort((a, b) => a.index - b.index)
  const activeItems = active.map(b => ({ kind: 'card', batch: b }))
  for (const st of orphanStubs) activeItems.splice(Math.min(st.index, activeItems.length), 0, { kind: 'stub', stub: st })

  // THE DOOR TO THE CLOSED LIST, rendered inside the empty block when the list is empty and after the
  // list when it is not. Exactly one instance either way.
  //
  // Placement is the whole finding: the state in which a user hunts a six-week-old batch is the state
  // that currently hides the door — a doorway behind a segment whose own empty state reads "Nothing
  // going right now." has INVERTED scent, and the bare-open promote does not even select this segment
  // when the going list is empty. (It used to sit "above Start a batch" only because that button was
  // pinned as the literal last child; Start a batch moved to the top in Put-Up 1a, so this is now
  // simply the end of the list.)
  //
  // Labelled with its object, not as the bare adjective "Closed" — that predicts nothing about its
  // destination. NOT "Finished batches", which the seat proposed: `finished` is a live, re-enterable
  // stage_kind on this very card (a tended row legitimately follows a finished one), so a list of
  // CLOSED batches under that word would exclude batches the user would read as finished.
  const closedDoor = (
    <button type="button" data-testid="going-closed-door" onClick={openClosed}
      style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
        background: 'none', border: 'none', padding: '2px 8px 2px 0', marginTop: T.space.sm,
        cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
      {CLOSED_DOOR_CTA}
    </button>
  )

  // START A BATCH — Put-Up 1a (V4 §2.2, the adhd seat's "the door moves" finding): a QUIET TEXT
  // button at the TOP of Going now. At the bottom, with the several ferments Dave keeps going, the
  // door fell below the fold and moved as the list grew — a start cue the cook has to hunt for at the
  // one moment of starting. Still quiet (not a filled CTA, not floating, not in the header row, not in
  // the ＋ sheet with its hard 4-cap): the page's job on a normal visit is still "what needs checking".
  // It opens the shared Start sheet through the page (onStartBatch) — the same sheet Snap opens.
  const startBatch = useCallback(() => {
    if (onStartBatch) onStartBatch()
    else navigate('/capture')
  }, [navigate, onStartBatch])

  return (
    <div data-testid="going-now-view">
      <button type="button" data-testid="start-a-batch" onClick={startBatch}
        style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
          background: 'none', border: 'none', padding: '2px 8px 2px 0', marginBottom: T.space.sm,
          cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: T.type.sm, fontWeight: 700 }}>
        Start a batch →
      </button>
      {loading && <div style={{ padding: 24, textAlign: 'center', color: P.light }}>Loading&hellip;</div>}
      {error && <ErrorBanner>Couldn&rsquo;t load what&rsquo;s going right now — try again.</ErrorBanner>}

      {empty && (
        <div data-testid="going-empty" style={{ padding: '28px 18px', textAlign: 'center', color: P.mid,
          background: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusBadge }}>
          <div style={{ fontWeight: 700, color: P.dark, marginBottom: 6 }}>Nothing going right now.</div>
          <div style={{ fontSize: '0.85rem', color: P.light }}>
            A ferment, a dehydrator run, a pot of syrup — start one and it&rsquo;ll wait for you here.
          </div>
          {closedDoor}
        </div>
      )}

      {activeItems.map(item => (item.kind === 'stub'
        ? <PutUpStub key={`stub-${item.stub.batchId}`} stub={item.stub} onOpen={openBatch} onUndone={onReload} />
        : <BatchCard key={item.batch.id} batch={item.batch} nowMs={nowMs} fetch={fetch} onChanged={onReload} onOpen={openBatch}
            onCheck={setCheckingId} onPutUp={setPuttingId} stub={stubFor(item.batch.id)} savedStageId={saved[item.batch.id] ?? null} />
      ))}

      {paused.length > 0 && (
        <>
          <h2 data-testid="going-paused-heading"
            style={{ margin: `${T.space.md}px 0 ${T.space.sm}px`, fontSize: '0.82rem', fontWeight: 700,
              color: P.light, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Paused
          </h2>
          {paused.map(b => (
            <BatchCard key={b.id} batch={b} nowMs={nowMs} fetch={fetch} onChanged={onReload} onOpen={openBatch}
              onCheck={setCheckingId} onPutUp={setPuttingId} stub={stubFor(b.id)} savedStageId={saved[b.id] ?? null} paused />
          ))}
        </>
      )}

      {/* Renders NOTHING while closed, so it never displaces a sibling in the document. */}
      <CheckOnItSheet open={!!checking} batch={checking} now={now} onClose={closeCheck} onSaved={checkSaved} />
      <PutItUpSheet open={!!putting} batch={putting} now={now} onClose={closePutUp} onDone={putUpDone} onChanged={onReload} />

      {!empty && closedDoor}
    </div>
  )
}
