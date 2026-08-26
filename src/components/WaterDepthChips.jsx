// src/components/WaterDepthChips.jsx
// V4-WATERMATH-001 F0 — the Light / Normal / Deep amount-class chip row.
//
// Composed from the FROZEN SelectChip primitive (components/forms/FROZEN.md: extend, don't
// mint a second chip). Deliberately NOT added to the forms barrel: the freeze test pins that
// export set exactly, and this is a domain widget (a watering vocabulary), not a shared
// primitive. Imported directly, the same way ScopeChecklist imports SelectChip.
//
// Layout: a 3-column grid, not flex-wrap. At 390px (Dave's Chrome/Android width) three
// `touch` chips demand 3*44 + 2*8 = 148px of min-content, so they sit on ONE line with room
// to spare; wrapping would double the block height on the fast path this exists to keep fast.
// `touch` gives the 48px height floor — these are tapped one-handed while holding a hose.
//
// Sits OUTSIDE <Field> deliberately: Field's frozen contract takes exactly one focusable
// control and clones ARIA onto it, so a chip group inside it would trip contractWarn.
import React from 'react'
import { P } from '../lib/constants.js'
import Icon from './Icon.jsx'
import SelectChip from './forms/SelectChip.jsx'
import { WATER_DEPTH_CHIPS } from '../lib/waterDepth.js'

// V4-ICON-001. The tier's drop row, exported because LogMany's compact per-row override chip draws
// the same thing outside this component — one place decides how many drops a class is worth, so the
// two surfaces cannot disagree about what "Deep" looks like.
//
// `filled` + color={false}, both deliberate. The base care.drop is an OUTLINE, and at the 12-14px
// these render at its counter closes to under a pixel — it reads as a fuzzy ring, not a drop
// (compared side by side at 11/12/13/14/16px). The filled variant is solid and stays crisp. Killing
// the colour pass makes it inherit the chip's ink instead of the authored blue, which is what keeps
// it legible on the ACTIVE chip, where SelectChip flips to a green fill with white text.
export function WaterDepthDrops({ count = 0, size = 14 }) {
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      {Array.from({ length: count }, (_, i) => (
        <Icon key={i} name="care.drop" variant="filled" color={false} size={size} decorative />
      ))}
    </span>
  )
}

// `small` is TYPOGRAPHY ONLY (tighter padding, smaller type for the per-row variant). It does NOT
// relax the touch target: `touch` stays on by default in every variant, because a 40px chip is
// under the WCAG 2.5.5 floor and these are tapped one-handed outdoors on Android. Keeping the two
// concerns separate is deliberate — SelectChip's own `small` couples them, and reusing that
// coupling here is how the compact variant would have quietly shipped an undersized target.
export default function WaterDepthChips({
  value,
  onChange,
  small = false,
  touch = true,
  idPrefix = 'water-depth',
  groupLabel = 'How much water',
  showAnchors = true,
}) {
  return (
    <div
      role="group"
      aria-label={groupLabel}
      data-testid={`${idPrefix}-group`}
      style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}
    >
      {WATER_DEPTH_CHIPS.map(chip => (
        <SelectChip
          key={chip.value}
          active={value === chip.value}
          small={small}
          touch={touch}
          onClick={() => onChange(chip.value)}
          // The accessible name carries the ANCHOR, not just the word: "Deep" alone is the
          // ambiguity the anchors exist to remove, and a screen-reader user gets no visual
          // caption to disambiguate it.
          aria-label={`${chip.label} — ${chip.anchor}`}
          data-testid={`${idPrefix}-${chip.value}`}
        >
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.25 }}>
            <WaterDepthDrops count={chip.dropCount} size={small ? 12 : 14} />
            <span>{chip.label}</span>
            {showAnchors && (
              // The anchor rides ON the chip (canon Part 3), not in a legend below it: a caption
              // the user has to look away to read is a caption they stop reading by week two.
              <span
                aria-hidden="true"
                style={{
                  fontSize: '0.66rem', fontWeight: 500, opacity: 0.85,
                  color: value === chip.value ? P.white : P.mid,
                }}
              >
                {chip.anchor}
              </span>
            )}
          </span>
        </SelectChip>
      ))}
    </div>
  )
}
