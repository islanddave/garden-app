// src/components/seed/SeedStageHistory.jsx
// V4-SEEDHISTORY-001 — the read-back for a seed lot's processing chain.
//
// GET /api/inventory-items/:id/seed-stage shipped with the write path and had ZERO consumers: the
// log has been written since v4-seedsaveflow-001 and never once read anywhere in the app. That is
// the whole of what this component changes, and it is the reinforcement loop the surface has never
// had — a ferment/dry/store commitment runs for two weeks and the app has so far shown the user
// nothing back for it.
//
// EMPTY AND FAILED ARE DIFFERENT ANSWERS, rendered differently on purpose. A bare empty list after
// a rejected request reads as "this lot has no history" — a factual claim the client cannot make —
// and it is the same silent-failure shape BUG-PLANTFETCHSILENT-001 catalogued one card up on this
// page, where an unfillable picker looked like a legitimately empty garden. AsyncRegion owns that
// precedence (error → loading → empty → children), so it is composed here rather than re-rolled.
//
// NOT A PRIMITIVE. It lives under components/seed/ and not components/forms/, so it does not touch
// the FROZEN export surface (src/__tests__/formsPrimitivesFreeze.test.js pins that array with a
// hard equality in both directions). House tokens are used anyway — being outside the
// designsys/no-raw-design-tokens glob is not a licence to go off-palette.
import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../../lib/api.js'
import { P } from '../../lib/constants.js'
import { formatDate } from '../../lib/format.js'
import AsyncRegion from '../forms/AsyncRegion.jsx'
import { seedStageLabel } from './seedStages.js'

export default function SeedStageHistory({
  itemId,
  // The lot's CURRENT stage, as inventory_items.seed_stage holds it. Passed in rather than derived
  // from row 0 — see the currentIdx note below, the two are allowed to disagree.
  currentStage = null,
  // V4-SEEDLINK-001's inventory_items.source_plant_id, and the name IF the host happens to know it.
  // The host does not always: PlantingSelect resolves the row only through onChange(id, planting),
  // so a parent chosen this session has a name and one merely loaded with the item does not. That
  // is deliberate — the alternative is a second request for one string on every seed packet, which
  // is the payload regression V4-PICKERPAYLOAD-001 spent a release undoing. The link works either
  // way; only the label degrades.
  sourcePlantId = '',
  sourcePlantName = null,
}) {
  const { fetch } = useApiFetch()
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  // Bumped by the retry affordance. A nonce rather than re-calling the loader directly so the
  // effect stays the single place that touches loading/error/rows and cannot drift from itself.
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt(n => n + 1), [])

  useEffect(() => {
    let mounted = true
    setLoading(true)
    setError(null)
    fetch(`/api/inventory-items/${itemId}/seed-stage`)
      .then(data => {
        if (!mounted) return
        // Array.isArray, not `data ?? []`: the route answers with a JSON array, and anything else
        // is a shape this component cannot read. Coercing rather than throwing keeps a surprising
        // response from taking down the rest of the page — it renders as "nothing recorded", which
        // is the same thing an empty array means.
        setRows(Array.isArray(data) ? data : [])
        setLoading(false)
      })
      .catch(err => {
        if (!mounted) return
        setError(err?.message ?? 'Could not load this lot’s history.')
        setLoading(false)
      })
    return () => { mounted = false }
  }, [itemId, fetch, attempt])

  const hasParent = Boolean(sourcePlantId)
  // Empty means "nothing to say at all". A lot with a parent but no stages still has a chain worth
  // one line, so it is NOT empty — AsyncRegion's empty branch short-circuits children, and routing
  // that case through it would hide the provenance the page just recorded.
  const isEmpty = rows.length === 0 && !hasParent

  // The newest logged entry carrying the lot's current stage. Found rather than assumed to be row
  // 0, because inventory_items.seed_stage can still be written WITHOUT appending a log row: only the
  // /seed-stage CTE logs, while the wide PUT and the create INSERT both assign the column and append
  // nothing. (The client's one non-logging stage writer — the <select> that used to sit on
  // /inventory/:id — was removed by V5-SEEDSTAGEONEPLACE-001, but the two server-side writers remain
  // and every live staged lot predates the change.) A backdated correction from /seeds/saved is the
  // other producer: it logs, but its entry can be OLDER than an existing row for a different stage.
  // "Newest entry" and "where the lot is now" are therefore genuinely allowed to differ, and when
  // they do the user is told so below rather than left to notice.
  const currentIdx = currentStage ? rows.findIndex(r => r.stage === currentStage) : -1

  // BUG-SEEDSTAGEHEADSHIP-001 — MEMBERSHIP IS THE WRONG PREDICATE, and the difference is the whole
  // point of this notice. `currentIdx === -1` asks "is the current stage ANYWHERE in the history".
  // The invariant this panel exists to report is "is the current stage the HEAD of the history" —
  // and the two disagree on precisely the case a repair creates most often, because correcting a
  // stage BACKWARDS lands it on one that is already logged, with a later entry still above it.
  //
  // Worked: log (newest first) [stored, drying, fermenting], lot corrected back to `drying`.
  // currentIdx is 1, membership says "no divergence", nothing renders — and the reader sees the
  // CURRENT badge painted on a middle row with a NEWER `stored` entry sitting above it, unexplained.
  // That is the exact confusion the notice was written to prevent, and it was silent on it.
  //
  // The shipped test could not tell the two predicates apart: its fixture is a SINGLE row, where
  // `=== -1` and `!== 0` always agree. Adding a three-row fixture is what makes this a detector
  // rather than a decoration.
  const stageNotLogged = Boolean(currentStage) && currentIdx === -1 && rows.length > 0
  const stageBehindLog = currentIdx > 0
  const stageOffLog = stageNotLogged || stageBehindLog

  return (
    <AsyncRegion
      data-testid="seed-stage-history"
      loading={loading}
      error={error}
      onRetry={retry}
      errorTitle="Couldn’t load this lot’s history"
      empty={isEmpty}
      emptyLabel="No processing stages recorded yet."
      loadingLabel="Loading this lot’s history…"
    >
      {rows.length > 0 && (
        <ol data-testid="seed-stage-entries" style={listChrome}>
          {rows.map((r, i) => (
            <li key={r.id} data-testid="seed-stage-entry" data-stage={r.stage} style={entryChrome}>
              <div style={entryHead}>
                <span style={stageInk}>{seedStageLabel(r.stage)}</span>
                {/* A TEXT affix, not a colour or a dot: the label channel is the only one that
                    survives a screen reader and a colour-blind read. */}
                {i === currentIdx && (
                  <span data-testid="seed-stage-entry-current" style={currentInk}>current</span>
                )}
                {/* formatDate slices the leading YYYY-MM-DD without constructing a Date (L-107).
                    Correct here because every entry this app writes is pinned to NOON — SavedSeeds
                    sends `${when}T12:00:00`, deliberately, so the calendar day reads the same from
                    either side of UTC. A row defaulted to now() by a hand-crafted POST is the one
                    case that can read a day forward late in the evening. */}
                <span style={dateInk}>{formatDate(r.entered_at) || 'undated'}</span>
              </div>
              {r.note && <p style={noteInk}>{r.note}</p>}
            </li>
          ))}
        </ol>
      )}

      {/* Two different facts, so two different sentences. "No entry for it" tells the reader the
          history simply does not cover where the lot is. "A later entry above" tells them the
          history goes FURTHER than the lot does — the pointer was moved back — which is the case
          that otherwise renders as a current badge stranded mid-list under a newer row. */}
      {stageOffLog && (
        <p data-testid="seed-stage-off-log" style={noteInk}>
          {stageBehindLog
            ? `Set back to ${seedStageLabel(currentStage)} here — there’s a later entry above it.`
            : `Set to ${seedStageLabel(currentStage)} here — there’s no processing entry for it.`}
        </p>
      )}

      {/* The oldest fact in the chain, so it sits at the BOTTOM of a newest-first list. */}
      {hasParent && (
        <p data-testid="seed-history-origin" style={originChrome}>
          Saved from{' '}
          <Link to={`/plantings/${sourcePlantId}`} style={originLink}>
            {sourcePlantName || 'the parent planting'}
          </Link>
        </p>
      )}

      {rows.length === 0 && hasParent && (
        <p data-testid="seed-stage-none-yet" style={noteInk}>
          No processing stages recorded yet.
        </p>
      )}
    </AsyncRegion>
  )
}

const listChrome  = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }
const entryChrome = { borderLeft: `2px solid ${P.greenLight}`, paddingLeft: 10 }
const entryHead   = { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }
const stageInk    = { fontWeight: 700, color: P.green, fontSize: '0.9rem' }
const currentInk  = { color: P.gold, fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }
const dateInk     = { marginLeft: 'auto', color: P.light, fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums' }
const noteInk     = { margin: '4px 0 0', color: P.mid, fontSize: '0.82rem', lineHeight: 1.5 }
const originChrome = { margin: '12px 0 0', color: P.light, fontSize: '0.82rem', lineHeight: 1.5 }
const originLink  = { color: P.green }
