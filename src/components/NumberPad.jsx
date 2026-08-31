// NumberPad.jsx — V4-QUICKHITRANGE-001 (BD-047) + V4-WEIGHKBDNEXT-001 (BD-046).
// On-screen digit builder for the harvest quantity and weight fields, so a two-digit value stops
// needing the Android soft keyboard.
//
// Deliberately NOT SelectChip. That primitive is the selection PILL grammar — aria-pressed, an
// active tone, one-of-N semantics — and these keys select nothing; they append. Same reasoning
// SelectChip.jsx:8-10 gives for leaving EventTypePicker's button grid out of it ("compose, don't
// overload"). Reusing it here would have shipped aria-pressed on a keypad, which is wrong for a
// screen reader, not merely redundant.
//
// Geometry — SIX columns, deliberately NOT the five the design doc proposes (§5.5). That figure was
// drawn for a WIZARD STEP, where the pad owns the sheet and nothing overlays it. On the shipped
// harvest panel a sticky Save band floats over the form at `bottom: BOTTOM_NAV_HEIGHT_PX + 12`, and
// a 5-column pad is three rows / 160px tall. MEASURED in tests/harness at 390x500 — keyboard-open
// geometry with the quantity field focused — the third row sat at y370-418 beneath a band occupying
// y384-432, and elementFromPoint returned the BAND for both `.` and BACKSPACE: the backspace this
// component documents as mandatory was not tappable at all. Six columns is two rows / 104px, which
// ends above the band. In-session the two pads together go 320px -> 264px (the quantity pad keeps a
// third row for Next; the weight pad does not) — a reduction, not a halving.
//
// 6 x ~46.7px at a 320px group width still clears the 44px WCAG 2.5.5 floor — and six is the column
// count the outgoing chip row already used at this width, so the fit is proven on this exact
// surface. The Next row (session only) spans all six as a third row; that path never meets this
// constraint, because inputMode="none" means no keyboard and therefore no 390x500.
//
// ⚠️ THAT LAST SENTENCE IS NOW FALSE, and the column count alone was never the real guard.
// BUG-HARVNUMPADINPUT-001 (BD-063) retired `inputMode="none"` on both fields — quantity is
// 'numeric', weight is 'decimal' — so the keyboard DOES come up in session and 390x500 IS reachable.
// Re-measured there (BUG-WEIGHPADSAVEBAND-001): the WEIGHT pad's two-row geometry does NOT end above
// the band, it ends 15px inside it. Fitting the pad above the band by choosing a row count only ever
// held for the quantity pad, and only at one band height — the band grows from 48px to 184px as the
// session ledger fills. The clearance is therefore no longer inferred from this component's shape;
// it is resolved against the band as rendered, by lib/saveBandLayout.js, with a stated 20px minimum
// and a real-engine gate (scripts/layout-gate/save-band-clearance.mjs). Change the row count freely;
// the gate, not this paragraph, is what holds the line.
//
// ⚠️ jsdom cannot falsify ANY of the above (getBoundingClientRect returns zeros —
// tests/harness/README.md:14-16, and elementFromPoint is meaningless there). A green suite proves
// the STATE MACHINE only; every layout claim here came from tests/harness/.
//
// V4-HANDEDNESSCONTROLS-001 (BD-054) — ⌫ AND `.` FOLLOW THE HANDEDNESS SETTING. ⌫ is the
// most-repeated corrective key on this surface (the header above calls it MANDATORY: under build
// semantics a mis-tap COMPOUNDS), so it belongs on whichever edge the user's thumb actually
// reaches. Right-handed — the default — is byte-identical to what shipped: `7 8 9 0 . ⌫`. The
// DIGITS never reverse; only the trailing corrective pair moves to the leading cells, because a pad
// that renders `0 9 8 7` would be a different and much worse defect than the one being fixed.
// The grid is `repeat(6, 1fr)`, so this is a reorder, not a re-layout, and the primary keeps
// `gridColumn: '1 / -1'` — a full-width control has no handedness and must stay that way.
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
      // The pad must never submit the form it lives in — EventNew's Save is a separate type="button"
      // and a stray submit here would post a half-built number.
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
        // Disabled keys DIM rather than disappear: comboboxInput.js:138-144 requires that tap
        // targets on this surface never move, and a vanishing '.' would shift every key after it.
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
  // lib/numberPad.js; every existing caller omits it and is unchanged.
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

  // ⌫ is MANDATORY, not a nicety. Under replace semantics a mis-tap was corrected by tapping the
  // right chip; under build semantics it COMPOUNDS. Without a backspace the builder would be
  // strictly worse than the chips for errors — the one way this feature can go wrong. Being the
  // key the thumb returns to most, it is the `underThumb` argument at BOTH levels below: outermost
  // within the corrective pair, and the pair itself outermost within the row.
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
        // The coupling that makes BD-046 non-optional: once the pad sets inputMode="none" the
        // keyboard stops appearing, and with it the Enter key — which was the ONLY shipped
        // mechanism for quantity → weight → save. This button performs the same advance.
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
