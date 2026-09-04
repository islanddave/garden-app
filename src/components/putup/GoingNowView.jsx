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
// live at the top of ./goingNow.js: no readiness affordance, no countdown, no urgency tone, no
// warning colour on a missing start, and nothing at all about pH, acidification or shelf stability.
import React, { useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApiFetch } from '../../lib/api.js'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { ErrorBanner } from '../forms'
import {
  partitionGoing, describeAge, describeStage, describeExpectedWindow, startPromptState,
  submersionPrompt, START_CHIPS, startChipPatch, pickedDatePatch, startPatchViolatesPairing,
} from './goingNow.js'

// "Sep 3". Month + day only: the year is noise on a surface whose entire subject is the recent past,
// and the one card that shows a year is a card about something that has been going for a year.
function shortDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function todayYMD() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ── the missing-datum CTA ────────────────────────────────────────────────────────────────────────
// The shipped "Set parent plant →" pattern (SavedSeeds.jsx:955-958): same type size, same ink as any
// other line on the card, in the card's ACTION slot rather than as a validation error or an empty
// field. Never a badge and never a warning colour — an unknown start is a permanent, acceptable
// terminal state, and a card that scolds for it teaches the user to stop reading the card.
//
// Expands IN PLACE rather than opening a Sheet, matching StorageField's "＋ New location" on this
// same page. An inline reveal is not a dismissable layer, so it needs no DismissRegistry
// coordination — which is exactly why it is the cheaper shape here.
function SetStartDate({ batch, fetch, onChanged }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [picked, setPicked] = useState('')

  const save = useCallback(async (patch) => {
    // The client-side restatement of chk_kitchen_batch_start_pairing. A patch that could never
    // commit is caught here rather than surfacing as an opaque 400 from a route the user cannot see.
    if (!patch || startPatchViolatesPairing(patch)) { setErr("That start doesn't make sense — pick another."); return }
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}`, { method: 'PUT', body: JSON.stringify(patch) })
      setOpen(false)
      onChanged?.()
    } catch {
      setErr("Couldn't save that — try again.")
    } finally { setBusy(false) }
  }, [batch.id, fetch, onChanged])

  if (!open) {
    return (
      <button type="button" data-testid="going-set-start" onClick={() => setOpen(true)}
        style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
          background: 'none', border: 'none', padding: '2px 8px 2px 0', cursor: 'pointer',
          fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
        Set a start date →
      </button>
    )
  }

  return (
    <div data-testid="going-start-chips" style={{ marginTop: 6 }}>
      {err && <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 6 }}>{err}</div>}
      {/* Ruling 5: NEVER ask for a precision grade. `exact` vs `day` are not humanly distinguishable
          and rating your own memory is a second decision stacked on the one already avoided. The
          grade is derived from WHICH CHIP was tapped; uncertainty is expressed by choosing a wider
          chip, which is a natural act. "Longer / not sure" is a first-class answer, not a decline. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {START_CHIPS.map(chip => (
          <button key={chip.value} type="button" disabled={busy}
            data-testid={`going-start-chip-${chip.value}`}
            onClick={() => save(startChipPatch(chip.value, Date.now()))}
            style={{ minHeight: T.tapMinHeight, padding: '6px 12px', cursor: busy ? 'default' : 'pointer',
              background: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusButton,
              fontFamily: 'inherit', fontSize: T.type.sm, color: P.dark }}>
            {chip.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm, marginTop: 8 }}>
        <input type="date" aria-label="Pick a start date" value={picked} max={todayYMD()}
          onChange={e => setPicked(e.target.value)}
          style={{ minHeight: T.tapMinHeight, padding: '6px 10px', fontFamily: 'inherit',
            fontSize: T.type.sm, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, background: P.white }} />
        <button type="button" disabled={busy || !picked} data-testid="going-start-pick-save"
          onClick={() => save(pickedDatePatch(picked))}
          style={{ minHeight: T.tapMinHeight, padding: '6px 12px', cursor: busy || !picked ? 'default' : 'pointer',
            background: 'none', border: 'none', fontFamily: 'inherit', fontSize: '0.78rem',
            fontWeight: 700, color: picked ? P.green : P.light }}>
          Use this date
        </button>
        <button type="button" onClick={() => { setOpen(false); setErr(null) }}
          style={{ minHeight: T.tapMinHeight, padding: '6px 4px', cursor: 'pointer', background: 'none',
            border: 'none', fontFamily: 'inherit', fontSize: '0.78rem', color: P.light }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── one batch ────────────────────────────────────────────────────────────────────────────────────
// Leads with WHAT IS KNOWN, never with the gap. The meta line is one joined string on purpose: it is
// the thing a test can assert as a full literal with both bounds and every separator, which is the
// standard this repo adopted after shipping an assertion that passes on a value ten days wrong.
function BatchCard({ batch, nowMs, fetch, onChanged, paused }) {
  const age = describeAge(batch, nowMs)
  const stage = describeStage(batch, nowMs)
  const window = describeExpectedWindow(batch)
  const prompt = startPromptState(batch) === 'prompt'
  const submersion = submersionPrompt(batch, nowMs)

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
      {/* The submersion prompt. A QUESTION, in the card's ordinary ink, with no verdict beside it
          and no list of failure signs under it — a checklist of what going wrong looks like invites
          the reader to conclude that its absence means success, which is the specific inference
          behind the documented olive botulism outbreak. Deliberately not a badge and not a warning
          colour: it asks you to go and look, it does not claim anything is wrong. */}
      {submersion && (
        <div data-testid="going-batch-submersion" style={{ marginTop: 4, color: P.mid, fontSize: '0.82rem' }}>
          {submersion}
        </div>
      )}
      {Number(batch.input_count) > 0 && (
        <div data-testid="going-batch-inputs" style={{ marginTop: 3, color: P.light, fontSize: '0.78rem' }}>
          {Number(batch.input_count) === 1 ? '1 pick in' : `${Number(batch.input_count)} picks in`}
        </div>
      )}
      {prompt && <SetStartDate batch={batch} fetch={fetch} onChanged={onChanged} />}
    </div>
  )
}

// `now` is an injectable prop, not a hidden Date.now() call. ONE instant for the whole render, so
// two cards can never disagree about what time it is mid-paint — and a test can pin an age to a
// fixed literal instead of to the wall clock. The wall-clock version of this passed under
// America/New_York and failed under UTC by four hours, which is precisely the class the blocking TZ
// re-run exists to catch and which millisecond-offset fixtures are structurally unable to expose.
export default function GoingNowView({ batches, loading, error, onReload, now }) {
  const navigate = useNavigate()
  const { fetch } = useApiFetch()
  const nowMs = now ?? Date.now()
  const { active, paused } = useMemo(() => partitionGoing(batches), [batches])
  const empty = !loading && !error && active.length === 0 && paused.length === 0

  return (
    <div data-testid="going-now-view">
      {loading && <div style={{ padding: 24, textAlign: 'center', color: P.light }}>Loading&hellip;</div>}
      {error && <ErrorBanner>Couldn&rsquo;t load what&rsquo;s going right now — try again.</ErrorBanner>}

      {empty && (
        <div data-testid="going-empty" style={{ padding: '28px 18px', textAlign: 'center', color: P.mid,
          background: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusBadge }}>
          <div style={{ fontWeight: 700, color: P.dark, marginBottom: 6 }}>Nothing going right now.</div>
          <div style={{ fontSize: '0.85rem', color: P.light }}>
            A ferment, a dehydrator run, a pot of syrup — start one and it&rsquo;ll wait for you here.
          </div>
        </div>
      )}

      {active.map(b => (
        <BatchCard key={b.id} batch={b} nowMs={nowMs} fetch={fetch} onChanged={onReload} />
      ))}

      {paused.length > 0 && (
        <>
          <h2 data-testid="going-paused-heading"
            style={{ margin: `${T.space.md}px 0 ${T.space.sm}px`, fontSize: '0.82rem', fontWeight: 700,
              color: P.light, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Paused
          </h2>
          {paused.map(b => (
            <BatchCard key={b.id} batch={b} nowMs={nowMs} fetch={fetch} onChanged={onReload} paused />
          ))}
        </>
      )}

      {/* Start a batch. Deliberately at the BOTTOM, deliberately not a floating button, deliberately
          not in the header row and deliberately not in the ＋ sheet — that sheet has a hard 4-cap
          where "any FIFTH action requires DISPLACEMENT, not expansion", and none of its four is
          displaceable for a feature with zero users. The sibling surface already ruled the placement
          (SavedSeeds.jsx:1012-1014): starting is the once-per-lot action while checking is the
          repeated one, and the page's job on a normal visit is to answer "what needs checking"
          rather than to invite data entry.

          Destination is /capture rather than a form here: the start happens in the kitchen with the
          app closed, and the one trigger that fires reliably in that moment is the camera. The
          capture flow owns the "Something in the kitchen" card (a sibling lane's file); this button
          is the in-app door to the same place. */}
      <button type="button" data-testid="start-a-batch" onClick={() => navigate('/capture')}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          width: '100%', minHeight: T.buttonMinHeight, marginTop: T.space.md,
          background: 'none', color: P.green, border: `1px solid ${P.greenLight}`,
          borderRadius: T.radiusCard, fontSize: T.type.md, fontWeight: 700,
          fontFamily: 'inherit', cursor: 'pointer' }}>
        <span aria-hidden="true">🍲</span><span>Start a batch</span>
      </button>
    </div>
  )
}
