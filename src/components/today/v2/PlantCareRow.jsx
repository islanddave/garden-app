import React from 'react'
import { Link } from 'react-router-dom'
import { P } from '../../../lib/constants.js'
import { SEVERITY_STYLES } from '../../../lib/waterDue.js'
import { NEED_LABEL, canMoistureCheck } from '../../../lib/careNeeded.js'
import { TIER } from '../../../lib/photoModel.js'
import PhotoView from '../../photo/PhotoView.jsx'
import Icon from '../../Icon.jsx'
import { T } from '../../forms/formStyles.js'

// PlantCareRow — one plant inside an opened spot of the redesigned Needs care (V5-TODAYREDESIGN-001 S4;
// plan-v2 §4 "Exception / plant row"). V1's Row anatomy (CareNeeded.jsx Row / CareChipButton /
// MoistureButton) COPIED, not refactored, so the row Dave phone-checked stays the same row (§4 control
// style 6): body = link to the planting (THUMB photo), Skip (48 wide + 8 px dead gap) → Moist (water_due
// only) → the care chip, which IS the log button, accessible name exactly "Log Water for X" (BD-036b).
// Differences, each from the plan: the name wraps (never an ellipsis); the reason line is the caller's
// (an exception says why it differs); a handled row becomes its done line in place, with Undo, for the
// visit (§2.5); a write that failed says "Not logged" with Retry on the row, never a toast (§6.6).
const ROW_TAP_MIN = 48
const SKIP_W = 48
const SKIP_GAP = 8
const SR_ONLY = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }

function CareChipButton({ row, pending, onLog }) {
  const s = SEVERITY_STYLES[row.tier] || SEVERITY_STYLES.gold
  return (
    <button
      type="button" onClick={() => onLog(row)} disabled={pending}
      aria-label={'Log ' + NEED_LABEL[row.need] + ' for ' + row.name}
      style={{
        flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        minWidth: 78, minHeight: ROW_TAP_MIN, border: 'none', borderLeft: '1px solid ' + P.border,
        background: pending ? P.greenPale : s.bg, color: pending ? P.green : s.text,
        fontWeight: 700, fontSize: '0.8rem', cursor: pending ? 'default' : 'pointer',
      }}
    >
      {pending ? '…' : <><Icon name={'event.' + row.eventType} size={15} decorative style={{ color: s.text }} />{NEED_LABEL[row.need]}</>}
    </button>
  )
}

function MoistureButton({ row, pending, onMoist }) {
  return (
    <button
      type="button" onClick={() => onMoist(row)} disabled={pending} data-testid="care-moist"
      aria-label={'Checked ' + row.name + ' — still moist'}
      style={{
        flexShrink: 0, width: 48, minHeight: ROW_TAP_MIN, border: 'none',
        borderLeft: '1px solid ' + P.border, background: pending ? P.greenPale : 'none',
        color: P.green, fontWeight: 600, fontSize: '0.7rem',
        cursor: pending ? 'default' : 'pointer',
      }}
    >
      {pending ? '…' : 'Moist'}
    </button>
  )
}

const DONE_WORD = { watered: 'watered', moist: 'moist', fed: 'fed', checked: 'checked', skipped: 'skipped', 'not-today': 'not today' }

export default function PlantCareRow({ row, testid = 'care-row', reason, pending, failed, done, onLog, onMoist, onSkip, onUndo, onRetry, undoBusy }) {
  if (done) {
    return (
      <div data-testid="care-row-done" data-key={row.key} role="listitem" style={doneRow}>
        <Icon name="action.check" size={16} decorative style={{ color: P.green, flexShrink: 0 }} />
        <span tabIndex={-1} data-focus-id={'row:' + row.key} style={{ flex: 1, minWidth: 0, fontSize: T.type.sm, outline: 'none' }}>
          <span style={{ fontWeight: 600, color: P.dark }}>{row.name}</span>
          <span style={{ color: P.mid }}>{' · ' + (DONE_WORD[done.kind] || done.kind)}{done.note ? ' · ' + done.note : ''}</span>
        </span>
        {onUndo && (
          <button type="button" onClick={() => onUndo(row)} disabled={undoBusy} aria-label={'Undo: ' + row.name + ' ' + (DONE_WORD[done.kind] || done.kind)} style={outlineBtn}>Undo</button>
        )}
      </div>
    )
  }
  const detailHref = (row.projectId && row.plantingId) ? '/projects/' + row.projectId + '/plantings/' + row.plantingId : '/garden'
  const line = reason != null ? reason : (!row.reasonRedundant ? row.reason : null)
  return (
    <div data-testid={testid} data-key={row.key} role="listitem" style={{ display: 'flex', alignItems: 'stretch', borderTop: '1px solid ' + P.border, minHeight: ROW_TAP_MIN }}>
      <Link to={detailHref} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', textDecoration: 'none', color: P.dark, minHeight: ROW_TAP_MIN }}>
        {row.photo && (
          <PhotoView photo={row.photo} tier={TIER.THUMB} alt="" style={{ width: 30, height: 30, borderRadius: 6, objectFit: 'cover', flexShrink: 0, border: '1px solid ' + P.border }} />
        )}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: T.type.base, fontWeight: 600, color: P.dark, overflowWrap: 'anywhere' }}>{row.name}</span>
          {failed
            ? <span style={{ display: 'block', fontSize: T.type.xs, color: P.severityUrgent, fontWeight: 600 }}>Not logged</span>
            : line && <span style={{ display: 'block', fontSize: T.type.xs, color: P.mid, marginTop: 1 }}>{line}</span>}
          {!line && row.reason && <span style={SR_ONLY}>{row.reason}</span>}
        </span>
      </Link>
      {failed ? (
        <button type="button" onClick={() => onRetry(row)} disabled={pending} aria-label={'Retry: ' + row.name} style={{ ...outlineBtn, margin: '2px 4px', minHeight: 44 }}>Retry</button>
      ) : (
        <>
          <button type="button" onClick={() => onSkip(row)} aria-label={'Skip ' + row.name + ' today'}
            style={{ flexShrink: 0, width: SKIP_W, marginRight: SKIP_GAP, minHeight: ROW_TAP_MIN, border: 'none', borderLeft: '1px solid ' + P.border, background: 'none', color: P.mid, cursor: 'pointer', fontSize: '0.7rem' }}>
            Skip
          </button>
          {canMoistureCheck(row) && <MoistureButton row={row} pending={pending} onMoist={onMoist} />}
          <CareChipButton row={row} pending={pending} onLog={onLog} />
        </>
      )}
    </div>
  )
}

const doneRow = { display: 'flex', alignItems: 'center', gap: 8, minHeight: ROW_TAP_MIN, padding: '0 6px 0 10px', borderTop: '1px solid ' + P.border }
export const outlineBtn = {
  flexShrink: 0, minHeight: T.tapMinHeight, padding: '0 12px', background: P.white, border: '1px solid ' + P.border,
  borderRadius: T.radiusButton, color: P.mid, fontWeight: 600, fontSize: T.type.sm, cursor: 'pointer', fontFamily: 'inherit',
}
