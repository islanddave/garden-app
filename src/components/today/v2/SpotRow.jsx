import React, { useId } from 'react'
import { P } from '../../../lib/constants.js'
import { T } from '../../forms/formStyles.js'
import Icon from '../../Icon.jsx'
import { TASKS, TASK_LABEL } from '../../../lib/todayV2/spots.js'
import { outlineBtn } from './PlantCareRow.jsx'

// SpotRow — one spot of the redesigned Needs care, whole (V5-TODAYREDESIGN-001 S4; plan-v2 §4 "Spot row",
// §5, Dave's D3 / D6 / D10, §13 SF7). A row card: the disclosure is an <h4><button> (never nested: Not today
// and Water all are its siblings, 8 px of dead space before and between), line 1 "Pasture › Bag Area 97 ▸",
// line 2 the counts with zeros dropped (SF7) and the fast-drying note. Water all logs the whole spot's
// candidates (bed-wait held back on Outside, D7); "Water the other N" once a plant in it was handled.
// The panel (SpotBody) mounts only while open. After a spot's Water all or Not today empties it, the row
// shrinks to its done line in place — held for the visit, Undo on it (D10) — see SpotDoneLine.
// MF3 (S4g): a write that failed stays on the SPOT, open or closed — one line under the header, "3 not logged"
// with its Retry (the plant rows inside say it too, each with its own). The failed rows are out of Water all
// (the spot's candidates exclude them), so only Retry re-posts them; while it runs it reads "Retrying 1 of 3…".
export default function SpotRow({ spot, open, onToggle, children, busy, groupBusy, handled, onNotToday, onWater, partial, failedN = 0, onRetry }) {
  const panelId = useId()
  const total = spot.counts.water + spot.counts.feed + spot.counts.check
  const n = spot.candidates.size
  const line2 = TASKS.filter((t) => spot.counts[t] > 0).map((t) => `${TASK_LABEL[t]} ${spot.counts[t]}`)
  if (spot.dryFastest > 0) line2.push(`${spot.dryFastest} dry fastest`)
  if (spot.bedsWaiting > 0) line2.push(`${spot.bedsWaiting} bed${spot.bedsWaiting === 1 ? '' : 's'} wait for rain`)
  const disabled = !!groupBusy
  const verb = handled || failedN > 0 ? 'Water the other' : 'Water all'
  const running = busy && !busy.retry ? busy : null
  const label = running ? `Watering ${running.done} of ${running.total}…` : (n === 1 && verb === 'Water all' ? 'Water 1' : `${verb} ${n}`)
  const failing = failedN > 0 && !!onRetry
  return (
    <li data-testid="care-spot" data-spot={spot.name} data-count={total} style={card}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
        <h4 style={{ margin: 0, flex: 1, minWidth: 0, display: 'flex' }}>
          <button type="button" data-focus-id={'spotrow:' + spot.key} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle} style={hit}>
            <span style={{ display: 'block' }}>
              {spot.parentPath && <span style={{ fontSize: T.type.sm, fontWeight: 400, color: P.mid }}>{spot.parentPath + ' › '}</span>}
              <span style={{ fontSize: T.type.md, fontWeight: 600, color: P.dark }}>{spot.name}</span>
              <span style={{ fontSize: T.type.sm, fontWeight: 700, color: P.dark, fontVariantNumeric: 'tabular-nums' }}>{' ' + total}</span>
              <span aria-hidden="true" style={{ fontSize: T.type.xs, color: P.light }}>{open ? ' ▾' : ' ▸'}</span>
            </span>
            {partial ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: T.type.sm, color: P.mid }}>
                <Icon name="action.check" size={14} decorative style={{ color: P.green }} />{partial}
              </span>
            ) : line2.length > 0 && <span style={{ display: 'block', fontSize: T.type.sm, color: P.mid }}>{line2.join(' · ')}</span>}
          </button>
        </h4>
        <div style={zone}>
          <button type="button" onClick={disabled || busy ? undefined : onNotToday} aria-disabled={disabled || busy ? 'true' : undefined} aria-label={'Not today: ' + spot.name} style={outlineBtn}>Not today</button>
          {n > 0 ? (
            <button type="button" data-testid="care-spot-bulk" onClick={disabled || busy ? undefined : onWater} aria-disabled={disabled || busy ? 'true' : undefined}
              aria-label={running ? label : `${label} in ${spot.name}`} style={tinted}>{label}</button>
          ) : spot.bedsWaiting > 0 && spot.counts.water > 0 ? (
            <span style={waitText}>Beds wait for rain</span>
          ) : null}
        </div>
      </div>
      {failing && (
        <div data-testid="care-spot-failed" style={failLine}>
          <span style={{ flex: 1, minWidth: 0, fontSize: T.type.sm, fontWeight: 600, color: P.severityUrgent }}>{`${failedN} not logged`}</span>
          <button type="button" data-testid="care-spot-retry" data-focus-id={'retry:' + spot.key} onClick={disabled || busy ? undefined : onRetry}
            aria-disabled={disabled || busy ? 'true' : undefined}
            aria-label={busy && busy.retry ? `Retrying ${busy.done} of ${busy.total}…` : `Retry: ${failedN} not logged in ${spot.name}`} style={outlineBtn}>
            {busy && busy.retry ? `Retrying ${busy.done} of ${busy.total}…` : 'Retry'}
          </button>
        </div>
      )}
      {open && <div id={panelId}>{children}</div>}
    </li>
  )
}

// A spot emptied by its Water all, a group's, or Not today: one 48 px line, focus lands on its text.
export function SpotDoneLine({ spotKey, name, text, onUndo, undoBusy, undoLabel, note }) {
  return (
    <li data-testid="care-done-line" data-spot={name} style={{ ...card, display: 'flex', alignItems: 'center', gap: 8, minHeight: 48, padding: '0 6px 0 10px' }}>
      <Icon name="action.check" size={16} decorative style={{ color: P.green, flexShrink: 0 }} />
      <span tabIndex={-1} data-focus-id={'spot:' + spotKey} style={{ flex: 1, minWidth: 0, fontSize: T.type.sm, outline: 'none' }}>
        <span style={{ fontWeight: 600, color: P.dark }}>{name}</span>
        <span style={{ color: P.mid }}>{' · ' + text}{note ? ' · ' + note : ''}</span>
      </span>
      {onUndo && <button type="button" onClick={onUndo} disabled={undoBusy} aria-label={undoLabel} style={outlineBtn}>Undo</button>}
    </li>
  )
}

const card = { listStyle: 'none', background: P.white, border: '1px solid ' + P.border, borderRadius: T.radiusCard, overflow: 'clip' }
const hit = {
  flex: 1, minWidth: 0, minHeight: 48, padding: `6px ${T.space.sm}px`, display: 'flex', flexDirection: 'column', justifyContent: 'center',
  gap: 2, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: P.dark, overflowWrap: 'anywhere',
}
const zone = { display: 'flex', alignItems: 'center', gap: 8, paddingRight: 6, flexShrink: 0 }
export const tinted = {
  flexShrink: 0, minHeight: T.tapMinHeight, padding: '0 12px', background: P.greenPale, border: 'none', borderRadius: T.radiusButton,
  color: P.green, fontWeight: 700, fontSize: T.type.sm, cursor: 'pointer', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums',
}
const waitText = { fontSize: T.type.xs, color: P.mid, maxWidth: 88, textAlign: 'right' }
// One 48px line under the header, the done line's anatomy: the failure in words, then its Retry (§5.10 "Failed:
// 'Not logged' text" — the words carry it, not the colour).
const failLine = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 48, padding: '0 6px 0 10px', borderTop: '1px solid ' + P.border }
