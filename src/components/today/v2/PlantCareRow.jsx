import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../../../lib/constants.js'
import { NEED_LABEL, canMoistureCheck } from '../../../lib/careNeeded.js'
import { overdueWords } from '../../../lib/todayV2/spots.js'
import { TIER } from '../../../lib/photoModel.js'
import PhotoView from '../../photo/PhotoView.jsx'
import Icon from '../../Icon.jsx'
import { T } from '../../forms/formStyles.js'

// PlantCareRow — one plant inside an opened spot of the redesigned Needs care (V5-TODAYREDESIGN-001 S4; plan-v2 §4
// "Exception / plant row"), drawn in THE per-plant row anatomy (PlantRow, below) that Protect tonight's tender rows
// share — finish plan §3.6, Dave's D18 "Rounded buttons + picture" (2026-10-14). Body = link to the planting with
// its 40px picture box; then Skip (quiet text, 48 wide + 8 px dead) → Moist (outline, water_due only) → the soft-
// green main action at the thumb edge, which IS the log button: accessible name exactly "Log Water for X" (BD-036b).
// The name wraps (never an ellipsis); the meta line is the caller's (a group line above it may already say what
// every row shares — then the caller hands '' and the row is its name alone); an overdue row says so in its meta
// with a warning mark ("2d overdue"), the red and yellow cells are gone. A handled row becomes its done line in
// place, with Undo, for the visit (§2.5); a write that failed says "Not logged" with Retry on the row, never a toast
// (§6.6). Skip and Moist render only where the caller hands them a handler: a planting waiting for rain
// (RainHold.jsx) passes neither — it is not on today's list to skip, and "still moist" changes nothing about a hold.
const ROW_TAP_MIN = 48
const SR_ONLY = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }
const CHECK_NEEDS = new Set(['pest', 'overwintering'])

// The app's row picture box (My seeds / Garden: 40×40, radius 8, always drawn): the photo on the photo-tile fill, or
// the sprout on green when the planting has none — the two must not look alike, or a slow load reads as "none". A
// photo that can never load (PhotoImg's terminal: deleted, forbidden) is no photo, so it falls back to the sprout,
// as My seeds' thumb does.
export function PlantThumb({ photo }) {
  const key = photo ? (photo.id ?? photo.featured_photo_view_url ?? null) : null
  const [deadKey, setDeadKey] = useState(null)
  const shown = photo && !(key != null && deadKey === key)
  return (
    <span data-testid="plant-thumb" data-photo={shown ? 'yes' : 'none'} aria-hidden="true" style={shown ? thumbPhoto : thumbEmpty}>
      {shown
        ? <PhotoView photo={photo} tier={TIER.THUMB} alt="" style={thumbImg} onTerminal={() => setDeadKey(key)} />
        : <Icon name="lifecycle.sprout" size={24} decorative />}
    </span>
  )
}

// PlantRow — the ONE per-plant row anatomy (finish plan §3.6; design-visual-system §3 "Per-plant row"): Needs care's
// water / feed / check rows and Protect's tender rows. Up to three rounded buttons in one grammar, 8 px apart, at
// the thumb edge: quiet `skip` text (48 wide, then 8 px of dead space — SF1), an `outline` (Covered / Moist), the
// soft-green `main` action (Brought in / Water / Feed / Checked). No cell dividers, no fills. `failed` swaps the
// meta for "Not logged" and the buttons for one outline `retry`. `held` (review 4160.2 IMPORTANT-2: the page is
// holding its writes) leaves every control inert — aria-disabled, no handler; `pending` disables the posting ones.
// Each button is { text, label, onClick, testid?, icon? }; `meta` is the line under the name (a node), `urgent`
// puts the warning mark in front of it. `rowStyle` replaces the hairline row's box (Protect's row card).
export function PlantRow({ as: Tag = 'div', testid, rowKey, rowStyle, href, focusId, photo, name, owner, meta, urgent, srMeta, failed, held, pending, skip, outline, main, retry, controlsTestid }) {
  const fire = (b) => (held ? undefined : b.onClick)
  return (
    <Tag data-testid={testid} data-key={rowKey} role={Tag === 'li' ? undefined : 'listitem'} style={rowStyle || row}>
      <Link to={href} data-focus-id={focusId} style={bodyLink}>
        <PlantThumb photo={photo} />
        <span data-row-text="" style={{ flex: 1, minWidth: 0 }}>
          <span data-row-name="" style={nameStyle}>{name}{owner && <span style={ownerStyle}>{` (${owner})`}</span>}</span>
          {failed
            ? <span data-row-meta="" style={failStyle}>Not logged</span>
            : meta && (
              <span data-row-meta="" style={metaStyle}>
                {urgent && <Icon name="severity.med" size={14} decorative style={{ flexShrink: 0, marginRight: 4, verticalAlign: '-2px' }} />}
                {meta}
              </span>
            )}
          {!failed && !meta && srMeta && <span style={SR_ONLY}>{srMeta}</span>}
        </span>
      </Link>
      {failed ? (
        <div data-testid={controlsTestid} style={controls}>
          <button type="button" onClick={fire(retry)} disabled={pending} aria-disabled={held ? 'true' : undefined} aria-label={retry.label} style={outlineRowBtn}>{retry.text || 'Retry'}</button>
        </div>
      ) : (
        <>
          {skip && (
            <button type="button" onClick={fire(skip)} aria-disabled={held ? 'true' : undefined} aria-label={skip.label} style={skipBtn}>{skip.text || 'Skip'}</button>
          )}
          <div data-testid={controlsTestid} style={controls}>
            {outline && (
              <button type="button" data-testid={outline.testid} onClick={fire(outline)} disabled={pending} aria-disabled={held ? 'true' : undefined} aria-label={outline.label} style={outlineRowBtn}>
                {pending ? '…' : outline.text}
              </button>
            )}
            <button type="button" onClick={fire(main)} disabled={pending} aria-disabled={held ? 'true' : undefined} aria-label={main.label} style={mainBtn}>
              {pending ? '…' : <>{main.icon && <Icon name={main.icon} size={16} decorative style={{ flexShrink: 0 }} />}{main.text}</>}
            </button>
          </div>
        </>
      )}
    </Tag>
  )
}

const DONE_WORD = { watered: 'watered', moist: 'moist', fed: 'fed', checked: 'checked', skipped: 'skipped', 'not-today': 'not today' }

// writesHeld (review 4160.2 IMPORTANT-2): the page holds its writes — Skip, Moist, the main action and Retry are inert
// (aria-disabled, no handler) until it lets go; Undo stays live.
// `reason`: the meta line. Absent (null) = the row's own reason unless it only restates its tier (BD-036b
// reasonRedundant); '' = the name alone (a group line says the rest). `urgent`: absent = the row's own overdue
// state; false = the group line carries it.
export default function PlantCareRow({ row, testid = 'care-row', reason, urgent, pending, failed, done, onLog, onMoist, onSkip, onUndo, onRetry, undoBusy, writesHeld = false }) {
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
  const detailHref = row.plantingId ? '/plantings/' + row.plantingId : '/garden'
  const line = reason != null ? reason : (!row.reasonRedundant ? row.reason : null)
  // The overdue words lead the meta (once — a redundant reason IS those words), after the warning mark.
  const late = urgent === false ? null : overdueWords(row)
  const meta = late ? [late, line && line !== late ? line : null].filter(Boolean).join(' · ') : line
  // srMeta: a reason dropped as a restatement still reaches a screen reader; one a group line already said ('') does not.
  const check = CHECK_NEEDS.has(row.need)
  const main = check
    // A check's main action states what was done, as Protect's do ("Covered: X"); its name starts with its label (2.5.3).
    ? { text: 'Checked', label: 'Checked: ' + row.name, icon: 'event.' + row.eventType, onClick: () => onLog(row) }
    : { text: NEED_LABEL[row.need], label: 'Log ' + NEED_LABEL[row.need] + ' for ' + row.name, icon: 'event.' + row.eventType, onClick: () => onLog(row) }
  return (
    <PlantRow testid={testid} rowKey={row.key} href={detailHref} photo={row.photo} name={row.name}
      meta={meta || null} urgent={!!late} srMeta={reason == null ? row.reason : null} failed={failed} held={writesHeld} pending={pending}
      skip={onSkip ? { label: 'Skip ' + row.name + ' today', onClick: () => onSkip(row) } : null}
      outline={onMoist && canMoistureCheck(row) ? { text: 'Moist', label: 'Checked ' + row.name + ' — still moist', testid: 'care-moist', onClick: () => onMoist(row) } : null}
      main={main}
      retry={{ label: 'Retry: ' + row.name, onClick: () => onRetry(row) }} />
  )
}

// ── styles (tokens P / T; design-visual-system §3 "Per-plant row") ──────────────────────────────────────────────
// A hairline row inside a card (Protect's own rows restyle it into a row card): 48 tall, padding 4/6/4/10. The main
// action keeps the 48px tap height of the cell it replaced — gate:today-shape:v2's rain-wait-floors and
// rain-hold-view.mjs read "each row's Water ≥ 48" — but paints the mockup's 44px pill, level with the outline beside
// it: a 2px transparent rule above and below is part of the target and not of the fill (background-clip). The outline
// and Retry are the 44 floor (T.tapMinHeight). Button padding is 8 (not outlineBtn's 12) so three buttons leave the
// name its ≈106 px at 426 (finish plan §3.1).
const row = { display: 'flex', alignItems: 'stretch', borderTop: '1px solid ' + P.border, minHeight: ROW_TAP_MIN }
const bodyLink = { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: T.space.row, padding: '4px 8px 4px 10px', textDecoration: 'none', color: P.dark, minHeight: ROW_TAP_MIN }
const thumbBase = {
  position: 'relative', flex: '0 0 auto', width: 40, height: 40, borderRadius: T.radiusButton,
  border: '1px solid ' + P.border, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', color: P.green,
}
const thumbPhoto = { ...thumbBase, backgroundColor: P.photoPlaceholder }
const thumbEmpty = { ...thumbBase, backgroundColor: P.greenPale }
const thumbImg = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
const nameStyle = { display: 'block', fontSize: T.type.base, fontWeight: 600, color: P.dark, overflowWrap: 'anywhere' }
const ownerStyle = { fontWeight: 400, color: P.mid }
const metaStyle = { display: 'block', fontSize: T.type.xs, color: P.mid, marginTop: 1 }
const failStyle = { display: 'block', fontSize: T.type.xs, color: P.severityUrgent, fontWeight: 600, marginTop: 1 }
const controls = { display: 'flex', alignItems: 'center', gap: T.space.row, paddingRight: 6, flexShrink: 0 }
const skipBtn = {
  flexShrink: 0, width: 48, marginRight: T.space.row, padding: 0, border: 'none', background: 'none',
  color: P.mid, fontWeight: 600, fontSize: T.type.sm, cursor: 'pointer', fontFamily: 'inherit',
}
const doneRow = { display: 'flex', alignItems: 'center', gap: 8, minHeight: ROW_TAP_MIN, padding: '0 6px 0 10px', borderTop: '1px solid ' + P.border }
export const outlineBtn = {
  flexShrink: 0, minHeight: T.tapMinHeight, padding: '0 12px', background: P.white, border: '1px solid ' + P.border,
  borderRadius: T.radiusButton, color: P.mid, fontWeight: 600, fontSize: T.type.sm, cursor: 'pointer', fontFamily: 'inherit',
}
const outlineRowBtn = { ...outlineBtn, padding: '0 8px' }
const mainBtn = {
  flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
  minHeight: T.buttonMinHeight, padding: '0 8px', backgroundColor: P.greenPale, borderRadius: T.radiusButton,
  borderStyle: 'solid', borderColor: 'transparent', borderWidth: `${(T.buttonMinHeight - T.tapMinHeight) / 2}px 0`, backgroundClip: 'padding-box',
  color: P.green, fontWeight: 700, fontSize: T.type.sm, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}
