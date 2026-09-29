import React from 'react'
import { P } from '../../../lib/constants.js'
import { T } from '../../forms/formStyles.js'
import PlantCareRow from './PlantCareRow.jsx'
import { exceptionReason, sortCohort, cohortLine, cohortCapNote, COHORT_CAP } from '../../../lib/todayV2/spots.js'

// SpotBody — an opened spot (V5-TODAYREDESIGN-001 S4; plan-v2 §4 "Opened spot body", D3 + D11, §11.0 E8,
// SF2). Water first: the few rows that differ from the rest, pinned and never capped ("DIFFERENT FROM THE
// REST · 8"), then the cohort as ONE line ("89 more like this · mostly daily · last watered 4 d ago") that
// discloses its rows on "Show them" — 20 at a time, sorted by record, crop, name, fixed while open — with the
// filled "Water the other N" under them. A spot the split does not fit (≤ 5 water rows, no shared record, a
// cohort under 3) lists every row. Then FEED and CHECK. Rows handled this visit stay in place as done lines.
// Rows are hairline-separated, no cards inside the card; `role="list"` (a 09-08 Tier-0 item).
export default function SpotBody({ spot, spotAll, exceptions, done, failed, pendingKeys, cohortOpen, cohortAll, onCohort, onShowAll, rowProps, waterOther }) {
  const inView = new Set(spot.rows.map((r) => r.key))
  const place = (r, testid, reason) => {
    const d = done[r.key]
    if (!inView.has(r.key) && !d) return null
    return <PlantCareRow key={r.key} row={r} testid={testid} reason={reason} done={d && !inView.has(r.key) ? d : null} failed={!!failed[r.key]} pending={pendingKeys.has(r.key)} {...rowProps} />
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

  return (
    <div data-testid="care-spot-panel" style={{ borderTop: '1px solid ' + P.border, padding: `0 0 ${T.space.xs}px` }}>
      {tasks.has('water') || water.length ? (
        split ? (
          <>
            {exRows.length > 0 && (
              <div data-testid="care-exceptions" data-spot={spot.name}>
                <div style={subLabel}>{'Different from the rest · ' + liveCount(exRows)}</div>
                <div role="list">{exRows.map((r) => place(r, 'care-exceptions-row', exceptionReason(r)))}</div>
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
                    <div role="list">{cohort.slice(0, shown).map((r) => place(r, 'care-cohort-row', null))}</div>
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
      {feed.some((r) => inView.has(r.key) || done[r.key]) && (
        <div style={{ borderTop: '1px solid ' + P.border }}>
          <div style={subLabel}>{'Feed · ' + liveCount(feed)}</div>
          <div role="list">{feed.map((r) => place(r, 'care-row', r.reason))}</div>
        </div>
      )}
      {check.some((r) => inView.has(r.key) || done[r.key]) && (
        <div style={{ borderTop: '1px solid ' + P.border }}>
          <div style={subLabel}>{'Check · ' + liveCount(check) + (oneCheck ? ' — ' + oneCheck : '')}</div>
          <div role="list">{check.map((r) => place(r, 'care-row', oneCheck ? null : r.reason))}</div>
        </div>
      )}
    </div>
  )
}

const subLabel = { fontSize: T.type.xs, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: P.mid, padding: '8px 10px 4px' }
const textLink = { minHeight: T.tapMinHeight, padding: '0 10px', background: 'none', border: 'none', color: P.green, fontWeight: 600, fontSize: T.type.sm, cursor: 'pointer', fontFamily: 'inherit' }
