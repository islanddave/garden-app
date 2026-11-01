// NumberPad.jsx — V4-QUICKHITRANGE-001 (BD-047) + V4-WEIGHKBDNEXT-001 (BD-046).
// On-screen digit builder for the harvest quantity and weight fields, so a two-digit value stops
// needing the Android soft keyboard.
//
// Deliberately NOT SelectChip. That primitive is the selection PILL grammar (aria-pressed, an active
// tone, one-of-N semantics) and these keys select nothing; they append. Reusing it would ship
// aria-pressed on a keypad, which is wrong for a screen reader.
//
// Geometry — SIX columns. On the harvest panel a sticky Save band floats over the form at
// `bottom: BOTTOM_NAV_HEIGHT_PX + 12`. A 5-column pad is three rows / 160px tall; measured in
// tests/harness at 390x500 (keyboard-open, quantity field focused) its third row sat beneath the band
// and elementFromPoint returned the BAND for both `.` and BACKSPACE, so the mandatory backspace was
// not tappable. Six columns is two rows / 104px. 6 x ~46.7px at a 320px group width still clears the
// 44px WCAG 2.5.5 floor, and six is the column count the outgoing chip row used at this width. The
// Next row (session only) spans all six as a third row.
//
// THE COLUMN COUNT ALONE IS NOT THE GUARD. The keyboard DOES come up in session (quantity is
// inputMode 'numeric', weight 'decimal'), so 390x500 IS reachable, and the WEIGHT pad's two-row
// geometry ends 15px inside the band (the band grows from 48px to 184px as the session ledger
// fills). Clearance is therefore resolved against the band as rendered, by lib/saveBandLayout.js,
// with a stated 20px minimum and a real-engine gate (scripts/layout-gate/save-band-clearance.mjs).
// Change the row count freely; the gate, not this paragraph, is what holds the line.
//
// jsdom cannot falsify ANY of the layout claims above (getBoundingClientRect returns zeros, and
// elementFromPoint is meaningless there; see tests/harness/README.md). A green suite proves the
// STATE MACHINE only; every layout claim here came from tests/harness/.
//
// ⌫ AND `.` FOLLOW THE HANDEDNESS SETTING (V4-HANDEDNESSCONTROLS-001, BD-054). ⌫ is the
// most-repeated corrective key on this surface (MANDATORY: under build semantics a mis-tap
// COMPOUNDS), so it belongs on whichever edge the user's thumb reaches. Right-handed, the default,
// is `7 8 9 0 . ⌫`. The DIGITS never reverse; only the trailing corrective pair moves to the leading
// cells, because a pad rendering `0 9 8 7` would be a worse defect. The grid is `repeat(6, 1fr)`, so
// this is a reorder, not a re-layout, and the primary keeps `gridColumn: '1 / -1'`: a full-width
// control has no handedness and must stay that way.
import React from 'react'
import { P } from '../lib/constants.js'
import { PAD_BACKSPACE, appendDigit, padKeyDisabled } from '../lib/numberPad.js'
import { orderByThumb } from '../lib/handedness.js'
import { useHandedness } from '../hooks/useHandedness.js'

const ROWS = [['1', '2', '3', '4', '5', '6'], ['7', '8', '9', '0']]

const keyBase = {
  minHeight: 48,
  minWidth: 44,
  borderRadius: 10,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '1rem',
  fontWeight: 600,
  border: `1px solid ${P.border}`,
  backgroundColor: P.white,
  color: P.dark,
  padding: 0,
}

function PadKey({ label, ariaLabel, testId, disabled, onClick, gridColumn, tone }) {
  return (
    <button
      type="button"
      // The pad must never submit the form it lives in: a stray submit would post a half-built number.
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      style={{
        ...keyBase,
        gridColumn,
        ...(tone === 'primary'
          ? { backgroundColor: P.green, borderColor: P.green, color: P.white }
          : null),
        // Disabled keys DIM rather than disappear: tap targets on this surface must never move, and a
        // vanishing '.' would shift every key after it (see comboboxInput.js).
        ...(disabled ? { opacity: 0.35, cursor: 'default' } : null),
      }}
    >
      {label}
    </button>
  )
}

export default function NumberPad({
  value,
  onChange,
  onPrimary,
  primaryLabel,
  idPrefix,
  ariaLabel,
  keyAriaPrefix,
  maxLen,
  // V4-PUTUPSESSION-001 — opt-in, default off. The put-up walk's bag count is an integer column, so
  // its pad dims `.` rather than offering a value the server rejects. Passed straight through to
  // lib/numberPad.js.
  integer = false,
}) {
  const opts = maxLen == null && !integer ? undefined : { ...(maxLen == null ? null : { maxLen }), integer }
  const press = (key) => onChange(appendDigit(value, key, opts))
  const dis = (key) => padKeyDisabled(value, key, opts)
  const hand = useHandedness()

  const digitKey = (d) => (
    <PadKey
      key={d}
      label={d}
      ariaLabel={`${keyAriaPrefix} ${d}`}
      testId={`${idPrefix}-${d}`}
      disabled={dis(d)}
      onClick={() => press(d)}
    />
  )

  // ⌫ is MANDATORY, not a nicety: under build semantics a mis-tap COMPOUNDS, so without a backspace
  // the builder would be worse than chips for errors. Being the key the thumb returns to most, it is
  // the `underThumb` argument at BOTH levels below: outermost within the corrective pair, and the
  // pair itself outermost within the row.
  const backKey = (
    <PadKey
      key="back"
      label={PAD_BACKSPACE}
      ariaLabel={`${keyAriaPrefix} backspace`}
      testId={`${idPrefix}-back`}
      disabled={dis(PAD_BACKSPACE)}
      onClick={() => press(PAD_BACKSPACE)}
    />
  )
  const dotKey = (
    <PadKey
      key="dot"
      label="."
      ariaLabel={`${keyAriaPrefix} decimal point`}
      testId={`${idPrefix}-dot`}
      disabled={dis('.')}
      onClick={() => press('.')}
    />
  )

  const [topRow, bottomDigits] = ROWS
  const corrective = orderByThumb(hand, backKey, dotKey)
  const bottomRow = orderByThumb(hand, corrective, bottomDigits.map(digitKey)).flat()

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 8 }}
    >
      {topRow.map(digitKey)}
      {bottomRow}
      {onPrimary && (
        // Advances quantity → weight → save, the same advance the keyboard's Enter performs.
        <PadKey
          label={primaryLabel}
          ariaLabel={primaryLabel}
          testId={`${idPrefix}-primary`}
          onClick={onPrimary}
          gridColumn="1 / -1"
          tone="primary"
        />
      )}
    </div>
  )
}
