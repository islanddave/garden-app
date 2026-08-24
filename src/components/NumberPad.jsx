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
// Geometry (design-weighin-session-20260824.md §5.5): five columns at 48px = 252px wide, inside the
// 304px the outgoing 6-chip row already occupied at 390px. Costs ~+50px of height and saves the
// ~301-344px the keyboard was taking — the pad pays for itself about six times over.
//
// ⚠️ jsdom cannot falsify the geometry above (getBoundingClientRect returns zeros —
// tests/harness/README.md:14-16). A green suite proves the STATE MACHINE only; the layout claim
// needs tests/harness/.
import React from 'react'
import { P } from '../lib/constants.js'
import { PAD_BACKSPACE, appendDigit, padKeyDisabled } from '../lib/numberPad.js'

const ROWS = [['1', '2', '3', '4', '5'], ['6', '7', '8', '9', '0']]

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
}) {
  const opts = maxLen == null ? undefined : { maxLen }
  const press = (key) => onChange(appendDigit(value, key, opts))
  const dis = (key) => padKeyDisabled(value, key, opts)

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 8 }}
    >
      {ROWS.flat().map((d) => (
        <PadKey
          key={d}
          label={d}
          ariaLabel={`${keyAriaPrefix} ${d}`}
          testId={`${idPrefix}-${d}`}
          disabled={dis(d)}
          onClick={() => press(d)}
        />
      ))}
      <PadKey
        label="."
        ariaLabel={`${keyAriaPrefix} decimal point`}
        testId={`${idPrefix}-dot`}
        disabled={dis('.')}
        onClick={() => press('.')}
      />
      {/* ⌫ is MANDATORY, not a nicety. Under replace semantics a mis-tap was corrected by tapping
          the right chip; under build semantics it COMPOUNDS. Without a backspace the builder would
          be strictly worse than the chips for errors — the one way this feature can go wrong. */}
      <PadKey
        label={PAD_BACKSPACE}
        ariaLabel={`${keyAriaPrefix} backspace`}
        testId={`${idPrefix}-back`}
        disabled={dis(PAD_BACKSPACE)}
        onClick={() => press(PAD_BACKSPACE)}
      />
      {onPrimary && (
        // The coupling that makes BD-046 non-optional: once the pad sets inputMode="none" the
        // keyboard stops appearing, and with it the Enter key — which was the ONLY shipped
        // mechanism for quantity → weight → save. This button performs the same advance.
        <PadKey
          label={primaryLabel}
          ariaLabel={primaryLabel}
          testId={`${idPrefix}-primary`}
          onClick={onPrimary}
          gridColumn="span 3"
          tone="primary"
        />
      )}
    </div>
  )
}
