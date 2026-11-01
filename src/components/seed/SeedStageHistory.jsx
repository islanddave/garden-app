// src/components/seed/SeedStageHistory.jsx
// The read-back for a seed lot's processing chain: GET /api/inventory-items/:id/seed-stage. It is the reinforcement
// loop for a ferment/dry/store commitment that runs for two weeks, showing the user back what they did.
//
// EMPTY AND FAILED ARE DIFFERENT ANSWERS, rendered differently on purpose. A bare empty list after a rejected request
// reads as "this lot has no history", a factual claim the client cannot make. AsyncRegion owns that precedence (error
// → loading → empty → children), so it is composed here rather than re-rolled.
//
// NOT A PRIMITIVE. It lives under components/seed/ and not components/forms/, so it does not touch the FROZEN export
// surface (src/__tests__/formsPrimitivesFreeze.test.js pins that array with a hard equality in both directions). House
// tokens are used anyway: being outside the designsys/no-raw-design-tokens glob is not a licence to go off-palette.
import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../../lib/api.js'
import { P } from '../../lib/constants.js'
import { formatDate } from '../../lib/format.js'
import { etDay } from '../../lib/harvestSummary.js'
import AsyncRegion from '../forms/AsyncRegion.jsx'
import { seedStageLabel } from './seedStages.js'

export default function SeedStageHistory({
  itemId,
  // The lot's CURRENT stage, as inventory_items.seed_stage holds it. Passed in rather than derived
  // from row 0 — see the currentIdx note below, the two are allowed to disagree.
  currentStage = null,
  // inventory_items.source_plant_id, and the name IF the host happens to know it. The host does not always:
  // PlantingSelect resolves the row only through onChange(id, planting), so a parent chosen this session has a name and
  // one merely loaded with the item does not. That is deliberate: the alternative is a second request for one string on
  // every seed packet. The link works either way; only the label degrades.
  sourcePlantId = '',
  sourcePlantName = null,
  // How many plantings the jar came off, when the host has the parent set. Two or more: the chain says the number and
  // names none of them (the host's "Saved from" card, directly above, lists and links every one). Null, 0 or 1: the
  // single-parent line.
  sourcePlantCount = null,
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
        // Array.isArray, not `data ?? []`: the route answers with a JSON array, and anything else is a shape this
        // component cannot read. Coercing rather than throwing keeps a surprising response from taking down the rest of
        // the page; it renders as an empty array does ("nothing recorded" for a lot with no stage, and the "no entry for
        // that stage" notice for a lot that has one, stageNotLogged below).
        setRows(Array.isArray(data) ? data : [])
        setLoading(false)
      })
      .catch(err => {
        if (!mounted) return
        // `||`: api.js can throw Error(''), and '' here rendered a failed load as "nothing recorded".
        setError(err?.message || 'Could not load this lot’s history.')
        setLoading(false)
      })
    return () => { mounted = false }
  }, [itemId, fetch, attempt])

  const hasParent = Boolean(sourcePlantId)

  // The newest logged entry carrying the lot's current stage. Found rather than assumed to be row 0, because a lot's
  // stage and its history could be written separately: the wide PUT and the create INSERT once assigned
  // inventory_items.seed_stage and appended nothing. POST /:id/seed-stage is the only writer now and it logs in the same
  // statement, so no NEW lot can get into that state, but a lot staged before can still be in it and nothing here
  // repairs one. "Newest entry" and "where the lot is now" are therefore still allowed to differ on such a row, and
  // when they do the user is told so below.
  //
  // NEWEST ENTRY WINS. The route orders rows by when each entry was MADE, not by the date it carries, so a backdated
  // correction from /seeds/saved lands at row 0: it is the lot's current word, not a divergence, and row order here is
  // the same key the list uses for the card's elapsed time. Do not re-sort by entered_at in this component: the
  // CURRENT badge would then stop marking the row the card counts from.
  const currentIdx = currentStage ? rows.findIndex(r => r.stage === currentStage) : -1

  // MEMBERSHIP IS THE WRONG PREDICATE for the off-log notice. `currentIdx === -1` asks "is the current stage ANYWHERE
  // in the history"; the invariant this panel reports is "is the current stage the HEAD of the history". The two
  // disagree whenever the pointer was moved BACKWARDS without a log row, onto a stage that is already logged with a
  // newer entry still above it. (A correction made on /seeds/saved logs a new entry, which heads the list.)
  //
  // Worked: log (newest entry first) [stored, drying, fermenting], lot set back to `drying`. currentIdx is 1,
  // membership says "no divergence", nothing renders, and the reader sees the CURRENT badge on a middle row with a
  // NEWER `stored` entry above it, unexplained. A test needs a three-row fixture to tell the two predicates apart: with
  // a SINGLE row, `=== -1` and `!== 0` always agree.
  //
  // NOT LOGGED INCLUDES AN EMPTY HISTORY (no `&& rows.length > 0`): a lot that has a stage and no entries at all must
  // not fall through to "No processing stages recorded yet.", the sentence for a lot nobody ever staged. That lot has
  // no date to count from (the list's stage_entered_at is NULL for it), and saying nothing would leave the missing "N
  // days" on its card unexplained.
  const stageNotLogged = Boolean(currentStage) && currentIdx === -1
  const stageBehindLog = currentIdx > 0
  const stageOffLog = stageNotLogged || stageBehindLog

  // Empty means "nothing to say at all". A lot with a parent but no stages still has a chain worth one line, and a lot
  // with a stage but no entries has the notice, so neither is empty: AsyncRegion's empty branch short-circuits children,
  // and routing either case through it would hide the line. Error and loading still win over both (AsyncRegion's
  // precedence), so a history that FAILED to load never reads as "no entry".
  const isEmpty = rows.length === 0 && !hasParent && !stageNotLogged

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
                {/* The EASTERN calendar day of the instant, then formatDate's string slice. Slicing entered_at itself */}
                {/* reads the UTC day, and two kinds of row are real instants: the intake SaveSeedSheet writes with now(), */}
                {/* and any stage dated today, which the route stamps with the moment it was entered. From 20:00 EDT */}
                {/* (19:00 EST) both would read tomorrow. A backdated entry sits at noon Eastern and reads the same. */}
                <span style={dateInk}>{formatDate(etDay(r.entered_at)) || 'undated'}</span>
              </div>
              {r.note && <p style={noteInk}>{r.note}</p>}
            </li>
          ))}
        </ol>
      )}

      {/* Two different facts, so two different sentences. "No entry for that stage" tells the reader the history simply */}
      {/* does not cover where the lot is, with other entries above it or with none at all. "A newer entry above" tells */}
      {/* them the history goes FURTHER than the lot does (the pointer was moved back), which otherwise renders as a */}
      {/* current badge stranded mid-list under a newer row. "Newer", not "later": rows are in entry order, so the row */}
      {/* above can carry an EARLIER date. The first sentence states only what this component can see: the stage the */}
      {/* lot carries and the absence of an entry for it. It does not say how the lot got there or when. */}
      {stageOffLog && (
        <p data-testid="seed-stage-off-log" style={noteInk}>
          {stageBehindLog
            ? `Set back to ${seedStageLabel(currentStage)} here — there’s a newer entry above it.`
            : `This lot is marked ${seedStageLabel(currentStage)}, but its history has no entry for that stage.`}
        </p>
      )}

      {/* The oldest fact in the chain, so it sits at the BOTTOM of a newest-first list. */}
      {hasParent && (
        <p data-testid="seed-history-origin" style={originChrome}>
          {sourcePlantCount >= 2 ? `Saved from ${sourcePlantCount} plantings` : (
            <>
              Saved from{' '}
              <Link to={`/plantings/${sourcePlantId}`} style={originLink}>
                {sourcePlantName || 'the parent planting'}
              </Link>
            </>
          )}
        </p>
      )}

      {/* Not beside the notice above: "none recorded yet" under "marked Stored" would be the same
          contradiction the notice exists to remove. */}
      {rows.length === 0 && hasParent && !stageNotLogged && (
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
