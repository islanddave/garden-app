import React from 'react'
import { P } from '../../../lib/constants.js'
import { T } from '../../forms/formStyles.js'
import Icon from '../../Icon.jsx'
import PlantCareRow from './PlantCareRow.jsx'
import { tinted } from './SpotRow.jsx'
import { exceptionGroup, sortCohort, cohortLine, cohortCapNote, productGroups, COHORT_CAP } from '../../../lib/todayV2/spots.js'

// SpotBody — an opened spot (V5-TODAYREDESIGN-001 S4; plan-v2 §4 "Opened spot body", D3 + D11, §11.0 E8,
// SF2). Water first: the few rows that differ from the rest, pinned and never capped ("DIFFERENT FROM THE
// REST · 8"), then the cohort as ONE line ("89 more like this · mostly daily · last watered 4 d ago") that
// discloses its rows on "Show them" — 20 at a time, sorted by record, crop, name, fixed while open — with the
// filled "Water the other N" under them. A spot the split does not fit (≤ 5 water rows, no shared record, a
// cohort under 3) lists every row. Then FEED and CHECK. Rows handled this visit stay in place as done lines.
// Rows are hairline-separated, no cards inside the card; `role="list"` (a 09-08 Tier-0 item).
// Finish plan §3.6 (L5): what every row of a group shares is printed ONCE, in the group line, and the rows say only
// what is their own — the differing rows under "Tray cells · 8 / dry fastest · every 2 days · last watered 4 d ago"
// (exceptionGroup), the cohort's rows under its line, the check rows under "Check · 7 — <label>"; and feeding is one
// line per product — "Espoma Tomato-Tone 3-4-6 (granular) · 43 / top-dress + water in · Show them" with its own
// [Feed all 43] (D12 carried into the spot) — whose plant rows open on Show them.
export default function SpotBody({ spot, spotAll, exceptions, done, failed, pendingKeys, cohortOpen, cohortAll, onCohort, onShowAll, rowProps, waterOther, busy = null, held = false, feedOpen = [], onFeedToggle, onFeedAll }) {
  const inView = new Set(spot.rows.map((r) => r.key))
  const place = (r, testid, reason, urgent) => {
    const d = done[r.key]
    if (!inView.has(r.key) && !d) return null
    return <PlantCareRow key={r.key} row={r} testid={testid} reason={reason} urgent={urgent} done={d && !inView.has(r.key) ? d : null} failed={!!failed[r.key]} pending={pendingKeys.has(r.key)} {...rowProps} />
  }
  const tasks = new Set(spot.rows.map((r) => r.task))
  const water = spotAll.filter((r) => r.task === 'water' && (inView.has(r.key) || done[r.key]))
  const split = Array.isArray(exceptions)
  const exSet = new Set(split ? exceptions : [])
  const exRows = split ? exceptions.map((k) => water.find((r) => r.key === k)).filter(Boolean) : []
  const cohort = split ? sortCohort(water.filter((r) => !exSet.has(r.key))) : []
  const cohortLive = cohort.filter((r) => inView.has(r.key))
  const shown = cohortAll ? cohort.length : Math.min(COHORT_CAP, cohort.length)
  const feed = spotAll.filter((r) => r.task === 'feed')
  const check = spotAll.filter((r) => r.task === 'check')
  const checkLabels = [...new Set(check.filter((r) => inView.has(r.key)).map((r) => r.checkLabel).filter(Boolean))]
  const oneCheck = checkLabels.length === 1 ? checkLabels[0] : null
  const liveCount = (rs) => rs.filter((r) => inView.has(r.key)).length
  // The group line is read off every differing row the visit has held, handled or not, so a row's done line never
  // moves a shared part back onto the rows still due; the label counts the ones still due (count-invariant).
  const ex = exRows.length ? exceptionGroup(exRows, liveCount(exRows)) : null
  // A product's line counts the rows still due; its membership (live or handled this visit) holds for the visit.
  const products = productGroups(feed.filter((r) => inView.has(r.key) || done[r.key]))

  return (
    <div data-testid="care-spot-panel" style={{ borderTop: '1px solid ' + P.border, padding: `0 0 ${T.space.xs}px` }}>
      {tasks.has('water') || water.length ? (
        split ? (
          <>
            {exRows.length > 0 && (
              <div data-testid="care-exceptions" data-spot={spot.name}>
                {/* The label stays this block's first child and ends in its count: the gate reads it there. */}
                <div style={subLabel}>{ex.label}</div>
                {ex.line && (
                  <div data-testid="care-exceptions-line" style={groupLine}>
                    {ex.urgent && <Icon name="severity.med" size={14} decorative style={{ flexShrink: 0, marginRight: 4, verticalAlign: '-2px' }} />}
                    {ex.line}
                  </div>
                )}
                <div role="list">{exRows.map((r) => { const o = ex.own.get(r.key); return place(r, 'care-exceptions-row', o.meta || '', o.urgent ? undefined : false) })}</div>
              </div>
            )}
            {cohort.length > 0 && (
              <div data-testid="care-cohort" data-spot={spot.name} style={{ borderTop: '1px solid ' + P.border }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm, minHeight: 48, padding: '0 6px 0 10px' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: T.type.sm, color: P.mid }}>{cohortLine(cohortLive.length ? cohortLive : cohort, exRows.length > 0)}</span>
                  <button type="button" aria-expanded={cohortOpen} onClick={onCohort} style={textLink}>{cohortOpen ? 'Hide them' : 'Show them'}</button>
                </div>
                {cohortOpen && (
                  <>
                    {/* The cohort line carries their cadence and record: a row is its name, and its overdue mark if it has one. */}
                    <div role="list">{cohort.slice(0, shown).map((r) => place(r, 'care-cohort-row', ''))}</div>
                    {shown < cohort.length && (
                      <>
                        <button type="button" data-testid="care-show-more" onClick={onShowAll} style={{ ...textLink, display: 'block', width: '100%', borderTop: '1px solid ' + P.border }}>
                          {'Show ' + (cohort.length - shown) + ' more'}
                        </button>
                        <div data-testid="care-cap-note" style={{ fontSize: T.type.xs, color: P.mid, padding: '0 10px 4px' }}>{cohortCapNote(cohort, shown)}</div>
                      </>
                    )}
                    {waterOther}
                  </>
                )}
              </div>
            )}
          </>
        ) : (
          <div data-testid="care-water-rows" data-spot={spot.name}>
            <div style={subLabel}>{'Water · ' + liveCount(water)}</div>
            <div role="list">{water.map((r) => place(r, 'care-row', null))}</div>
          </div>
        )
      ) : null}
      {products.length > 0 && (
        <div style={{ borderTop: '1px solid ' + P.border }}>
          {/* One product says its count on its own line; several are headed by the task's. */}
          {products.length > 1 && <div style={subLabel}>{'Feed · ' + liveCount(feed)}</div>}
          {products.map((pg, i) => {
            const live = pg.rows.filter((r) => inView.has(r.key))
            // A row whose write failed is re-posted only by its Retry (MF3), never folded into a Feed all.
            const keys = live.filter((r) => !failed[r.key]).map((r) => r.key)
            const k = spot.key + '|' + pg.key
            const open = feedOpen.includes(k)
            const b = busy && busy.tag === 'feed:' + pg.key ? busy : null
            const n = keys.length
            const label = n === 1 ? 'Feed 1' : `Feed all ${n}`
            return (
              <div key={pg.key} data-testid="care-spot-product" data-product={pg.product} style={i > 0 || products.length > 1 ? { borderTop: '1px solid ' + P.border } : undefined}>
                <div style={{ display: 'flex', alignItems: 'stretch', gap: T.space.row }}>
                  <button type="button" aria-expanded={open} onClick={() => onFeedToggle(k)} style={productHit}>
                    <span style={{ display: 'block', fontSize: T.type.base, fontWeight: 600, color: P.dark }}>
                      <Icon name="event.fertilizing" size={14} decorative style={{ marginRight: 4, verticalAlign: '-2px', color: P.green }} />
                      {pg.product + (live.length ? ' · ' + live.length : '')}
                    </span>
                    <span style={{ display: 'block', fontSize: T.type.xs, color: P.mid }}>
                      {pg.method ? pg.method + ' · ' : ''}<span style={{ color: P.green, fontWeight: 600 }}>{open ? 'Hide them' : 'Show them'}</span>
                    </span>
                  </button>
                  {n > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', paddingRight: 6, flexShrink: 0 }}>
                      <button type="button" data-testid="care-spot-feed-all" onClick={busy || held ? undefined : () => onFeedAll(pg, keys)} aria-disabled={busy || held ? 'true' : undefined}
                        aria-label={b ? `Feeding ${b.done} of ${b.total}…` : `${label} with ${pg.product} in ${spot.name}`} style={tinted}>
                        {b ? `Feeding ${b.done} of ${b.total}…` : label}
                      </button>
                    </div>
                  )}
                </div>
                {open && <div role="list">{pg.rows.map((r) => place(r, 'care-row', ''))}</div>}
              </div>
            )
          })}
        </div>
      )}
      {check.some((r) => inView.has(r.key) || done[r.key]) && (
        <div style={{ borderTop: '1px solid ' + P.border }}>
          <div style={subLabel}>{'Check · ' + liveCount(check) + (oneCheck ? ' — ' + oneCheck : '')}</div>
          <div role="list">{check.map((r) => place(r, 'care-row', oneCheck ? '' : r.reason))}</div>
        </div>
      )}
    </div>
  )
}

const subLabel = { fontSize: T.type.xs, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: P.mid, padding: '8px 10px 4px' }
// The shared meta, printed once under its group's label: the row meta's own type (design-visual-system §3).
const groupLine = { fontSize: T.type.xs, color: P.mid, padding: '0 10px 6px', marginTop: -2 }
const textLink = { minHeight: T.tapMinHeight, padding: '0 10px', background: 'none', border: 'none', color: P.green, fontWeight: 600, fontSize: T.type.sm, cursor: 'pointer', fontFamily: 'inherit' }
const productHit = { flex: 1, minWidth: 0, minHeight: 48, padding: `6px ${T.space.sm}px`, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', overflowWrap: 'anywhere' }
