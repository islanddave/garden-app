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
// ── WHAT THIS PAD COST THE USER, stated once so nobody re-derives it as a free win ─────────────
// Android's own numeric IME at 390 wide is FOUR columns — roughly 97px keys. This pad replaced that
// keyboard with keys less than half as wide. That was the trade BD-046/BD-047 made to buy back the
// keyboard's ~344px, and it is a real motor cost, not a conformance detail. Every sizing decision
// below is about giving back what can be given back on the axis that is still free.
//
// ── GEOMETRY, MEASURED — real Chrome, self-proving 390x500 iframe, 2026-08-25 ───────────────────
// (Method: scripts/layout-gate/save-band-clearance.mjs's instrument — a 390x500 IFRAME inside a
// 900x900 window, because macOS Chrome floors an OS window at ~500px and CROPS rather than
// reflowing, which yields a plausible-looking mobile screenshot of a desktop-width layout.)
//
//   The pad group is 320px wide (x35-355). NOT the 358px of the sticky Save band — the form column
//   is inset a further ~19px. Six 1fr columns with an 8px gap therefore give 46.7px keys, not the
//   ~53px that arithmetic off the band's width produces. 46.7 is the real number.
//
//   Both pads are TWO rows. ROWS below is 10 digits + '.' + ⌫ = 12 cells in a 6-column grid, and
//   as of BD-063 NEITHER call site in EventNew.jsx passes onPrimary/primaryLabel, so the
//   `gridColumn: '1 / -1'` primary row never renders on the shipped surface at all.
//     per pad: 56 + 8 gap + 56 = 120px grid + 8px marginBottom = 128px of occupied flow
//     both pads in-session: 256px   (was 48px keys -> 104 + 8 = 112px each, 224px together)
//
// ── WHY SIX COLUMNS, AND WHY THAT IS NOT A FREE PARAMETER ──────────────────────────────────────
// 12 keys in 2 rows requires exactly 6 columns; 2 rows is the only height that fits TWO pads on
// this surface. Widening is not an available trade:
//     4 cols -> 3 rows -> 3x56 + 2x8 = 184px/pad -> 368px for two pads
//     5 cols -> 15 cells, still 3 rows -> same 184px, with three dead cells
// Either blows the fixed frame's 352px middle-track budget. The design doc's §5.5 five-column
// figure was drawn for a WIZARD STEP where the pad owns the sheet and nothing overlays it; on the
// shipped harvest panel a sticky Save band floats over the form, and the measured consequence of a
// third row was that `.` and ⌫ sat UNDER the band with elementFromPoint returning the band for
// both — the backspace this component documents as mandatory was not tappable at all.
//
// CONDITIONAL, for whoever reads this next: the moment a change puts ONE pad on screen at a time
// (V4-WEIGHWIZARDFLOW-001 / BD-055 Slice C is exactly that), 4 columns x ~74 x 56px becomes correct
// immediately and should be taken — it is the Android-IME shape, and the height budget is there as
// soon as the second pad is not competing for it. Nothing below hardcodes 6 outside this file.
//
// ── WHY '.' STAYS ──────────────────────────────────────────────────────────────────────────────
// Dropping '.' would free a cell for a double-width ⌫, which is tempting because Dave weighs in
// grams (his own placeholder is "337"). It is still wrong: WEIGHT_UNITS carries fractional units,
// so the key is load-bearing for real input, and PadKey's rule below correctly forbids a VANISHING
// key because it shifts every key after it. '.' stays present-and-dimmed when it cannot fire.
//
// ⚠️ jsdom cannot falsify ANY layout claim above (getBoundingClientRect returns zeros —
// tests/harness/README.md:14-16, and elementFromPoint is meaningless there). A green suite proves
// the STATE MACHINE, the INLINE STYLES, and the DOM ORDER only; every pixel above came from the
// real-Chrome instrument named at the top of this block.
import React from 'react'
import { P } from '../lib/constants.js'
import { PAD_BACKSPACE, appendDigit, padKeyDisabled } from '../lib/numberPad.js'

const ROWS = [['1', '2', '3', '4', '5', '6'], ['7', '8', '9', '0']]

// Which control the user's thumb reaches, by CONSEQUENCE rather than by hand: callers name the one
// they want under the thumb and the one they want out of its way, and get back DOM order, leading
// first. Anything that is not a known hand lays out the way the app has always laid out.
//
// ⚠️ THIS IS A STAND-IN, NOT A SECOND MECHANISM. V4-HANDEDNESSCONTROLS-001 (BD-054) owns the real
// one — `orderByThumb` in src/lib/handedness.js, same name, same signature, same semantics, plus
// the useHandedness() hook that sources the value. That module is not on this branch yet, so this
// component takes the hand as a PROP defaulted to 'right' and keeps the ordering local. When BD-054
// lands, delete this function and import the shared one: the call sites below do not change.
function orderByThumb(hand, underThumb, farSide) {
  return hand === 'left' ? [underThumb, farSide] : [farSide, underThumb]
}

const keyBase = {
  // 56, not the 48 that shipped. 46.7x48 already clears WCAG SC 2.5.8 (24px, AA) and SC 2.5.5
  // (44px, AAA), so this is not a conformance fix — it is a motor one, and it buys the target back
  // on the only axis that is free. Width is pinned by the 320px group over 6 columns and cannot
  // grow without a row (see the column reasoning in the header); height is not, so 17% more target
  // is available for +8px per ROW. It also meets the house 56px floor on the height axis, which
  // 46.7x48 missed on both.
  //
  // ⛔ PRECONDITION — 56 REQUIRES THE FIXED FRAME. IT MUST NOT REACH PROD AHEAD OF IT. ⛔
  // The cost is +8px per ROW, and each pad is TWO rows: +16px per pad, +32px for the two
  // in-session pads (224px -> 256px of occupied flow). On the fixed frame's 352px middle track
  // that fits. On TODAY'S unframed panel — where a sticky Save band floats over normal flow — it
  // does not, and the failure mode is the one this component exists to prevent. MEASURED, real
  // Chrome, self-proving 390x500, weigh-in session, weight field focused (2026-08-25):
  //     48px keys: weight pad y295-399, bottom row centres y375 vs band top y384.
  //                All 12 keys return THEMSELVES from elementFromPoint.        (box clearance -15px)
  //     56px keys: weight pad y311-431, bottom row centres y403 vs band top y384.
  //                ALL SIX bottom-row keys — 7 8 9 0 . AND ⌫ — return the BAND. (box clearance -47px)
  // That is the mandatory backspace made untappable, which is verbatim the defect the six-column
  // decision in the header was taken to avoid. Note the -15px baseline: the surface is ALREADY over
  // budget before this change (BUG-WEIGHPADSAVEBAND-001, whose gate floor is +20px), so there is no
  // trimming inside this file that rescues it — gap and marginBottom together are worth 8px against
  // a ~67px deficit. The fix is the frame, not this number. If the frame is dropped, this goes back
  // to 48 and the motor win has to come from somewhere else.
  minHeight: 56,
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
  // 'right' | 'left' — which hand works the phone. See the corrective-pair note below. Defaulting
  // to 'right' makes this a provable no-op for every caller that does not pass it, including both
  // EventNew call sites today and every pinned oracle that renders a pad.
  hand = 'right',
}) {
  const opts = maxLen == null ? undefined : { maxLen }
  const press = (key) => onChange(appendDigit(value, key, opts))
  const dis = (key) => padKeyDisabled(value, key, opts)

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
  // strictly worse than the chips for errors — the one way this feature can go wrong. Being the key
  // a one-handed operator returns to most, it is the `underThumb` argument at BOTH levels below:
  // outermost within the corrective pair, and the pair itself outermost within the row. It shipped
  // in column 6, which is the reachable corner for a right thumb ONLY — and Dave works the weigh-in
  // LEFT-handed, because his right hand is moving fruit onto the scale.
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

  // ── THE STANDING "TAP TARGETS NEVER MOVE" RULE IS NOT BEING BROKEN HERE ───────────────────────
  // PadKey above cites comboboxInput.js:138-144, and that rule is about mid-INTERACTION movement:
  // a target that shifts under a thumb already in flight. Read it in full and this reorder is
  // outside it on both counts:
  //   · The CELL COUNT and the GEOMETRY are identical in both modes — 12 keys, `repeat(6, 1fr)`,
  //     56px rows, 8px gaps, same group box. Only WHICH GLYPH OCCUPIES WHICH CELL differs. Nothing
  //     appears, disappears, resizes, or reflows; the grid is byte-identical.
  //   · It changes ONLY when the handedness preference changes, which is a deliberate trip to
  //     Settings — never mid-session, never on a value change, never on a re-render. A pad that is
  //     on screen while the user is typing into it cannot reorder, and NumberPad.keyLayout's
  //     "mid-session re-render never reorders" case pins exactly that.
  // The rule forbids a moving target during an interaction. This moves the layout between sessions,
  // which is the same class of thing as the user changing the setting at all.
  //
  // ── AND THE DIGITS NEVER MIRROR ──────────────────────────────────────────────────────────────
  // 1-2-3-4-5-6 / 7-8-9-0 stays in reading order in BOTH modes. Only the trailing corrective pair
  // moves to the leading cells. Mirror the frame, never the numerals: a pad rendering `0 9 8 7`
  // would guarantee mis-entry on a surface whose whole purpose is entering a number correctly —
  // a far worse defect than the reach problem being fixed. Pinned in both modes by test.
  //
  // DOM order is deliberately the ONLY mechanism. `flexDirection: row-reverse` and CSS `order`
  // would each do this visually while leaving DOM order — and so tab order, screen-reader order,
  // and everything jsdom can observe — pointing the old way. Two mechanisms for one behaviour is
  // also how a mutation test goes green whichever one you break, so there is exactly one here.
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
        // The coupling that made BD-046 seat this: once the pad sets inputMode="none" the keyboard
        // stops appearing, and with it the Enter key — which was the ONLY shipped mechanism for
        // quantity → weight → save. BD-063 removed both call sites' props (the pads write their own
        // fields directly, so advancing was never required), leaving this path unrendered on the
        // shipped surface but available to a wizard step that does want it.
        //
        // A full-width control has NO handedness and must stay that way: `gridColumn: '1 / -1'`
        // spans the row, so there is no edge for it to sit on. Pinned so a future "flip everything"
        // pass cannot invent one.
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
