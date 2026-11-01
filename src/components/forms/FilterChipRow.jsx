// THE shared multi-select filter chip row. Its aria-pressed + P-token conventions follow the
// hand-rolled TimeframeChips in Harvests.jsx, which has not been migrated onto it. Keep the prop
// surface stable: the export sheet consumes it.
//
// Selection semantics: MULTI-SELECT OR. `selected` is a Set owned by the consumer; every chip tap
// calls onToggle(value) and the consumer flips membership. Presentation rules:
//   - selected state is NON-COLOR-ONLY (border weight 1px→2px + font weight 600→700) + aria-pressed
//   - ≥48px touch targets
//   - `More ▾` is IN-PLACE DOWNWARD expansion of the row, never a nested sheet (no third modal
//     layer, no scroll re-anchor)
// Combobox-host contract: the root swallows mousedown (preventDefault) so a chip tap inside an
// open combobox panel never blurs the input; the 150ms blur-close would eat the first tap
// otherwise (same convention as PlantingSelect.jsx onMouseDown). Harmless on plain pages: click
// still fires and keyboard focus is unaffected.
import React, { useMemo, useState } from 'react'
import { P } from '../../lib/constants.js'

const EMPTY_SET = new Set()

export default function FilterChipRow({
  // [{ value, label, leading? }] in display order (pinned values are re-grouped first below).
  // `leading` is an OPTIONAL node drawn before the label (My seeds' supplier chips carry a colour
  // swatch that doubles as the legend for the card stripes); FilterChipRow.leading.test.jsx pins
  // both arms.
  options = [],
  // Set of selected values — consumer-owned state (session-ephemeral by design: never persisted).
  selected,
  onToggle,
  // Optional: values always visible; the rest collapse behind `More ▾`. Omitted → flat row, no More.
  pinned,
  // Optional: renders a one-tap "Clear" affordance while the selection is non-empty.
  onClear,
  // Optional: fired when the More tray expands/collapses — a combobox host re-measures its
  // panel geometry (the row's height enters the flip/room computation).
  onLayoutChange,
  // Optional: while EXPANDED, cap the row at this height and make it its own scrollport. Collapsed
  // stays unbounded (1-2 lines by construction, pinned ∪ selected); capping it would clip the only
  // always-visible chips.
  trayMaxHeight,
  'aria-label': ariaLabel = 'Filters',
  'data-testid': dataTestId,
}) {
  const [expanded, setExpanded] = useState(false)
  const sel = selected ?? EMPTY_SET
  const pinnedSet = useMemo(() => new Set(pinned ?? []), [pinned])
  // Tray exists only when pinning actually hides something.
  const hasTray = pinned != null && options.some(o => !pinnedSet.has(o.value))
  // Collapsed view = pinned ∪ SELECTED. A non-pinned chip selected from the tray stays visible
  // after collapse: hiding an ACTIVE filter is the invisible-filter trap.
  // Sort STABILITY here is LOAD-BEARING. `options` arrive pre-ordered by the caller
  // (PlantingSelect's bandOrder: pins → recents band → alphabetical tail). This pinned-first
  // comparator only partitions; within each partition the caller's order must pass through
  // untouched, which Array.prototype.sort's guaranteed stability (ES2019+) provides. A non-stable
  // sort, or a full comparator over labels, would silently scramble the recents band.
  const shown = useMemo(() => {
    const pinnedFirst = [...options].sort((a, b) =>
      (pinnedSet.has(b.value) ? 1 : 0) - (pinnedSet.has(a.value) ? 1 : 0))
    if (!hasTray || expanded) return pinnedFirst
    return pinnedFirst.filter(o => pinnedSet.has(o.value) || sel.has(o.value))
  }, [options, pinnedSet, hasTray, expanded, sel])

  if (options.length === 0) return null

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={dataTestId}
      // Combobox-host contract — see header. Root-level so every child (chips, More, Clear)
      // inherits the no-blur behavior without per-button wiring.
      onMouseDown={e => e.preventDefault()}
      style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
        // The EXPANDED tray is a bounded scrollport, never an unbounded wrap (a ~26-line row
        // starved the host's listbox). overscrollBehavior 'contain' is MANDATORY, same reason as
        // PlantingSelect's listboxStyle: an end-of-tray flick must not chain the scroll to the
        // Sheet and drag the anchored input away mid-choice.
        ...(expanded && trayMaxHeight != null
          ? { maxHeight: trayMaxHeight, overflowY: 'auto', overscrollBehavior: 'contain' }
          : null),
      }}
    >
      {shown.map(o => {
        const active = sel.has(o.value)
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => {
              onToggle?.(o.value)
              // Collapse-on-select: SELECTING a tray-only chip while expanded collapses the tray
              // (the list below is the next thing the user needs to see). DESELECT keeps the tray
              // open (the user is still browsing chips), and pinned chips never collapse it.
              // `shown` already includes selected values when collapsed, so the just-tapped chip
              // stays visible. Cost: picking a second different crop needs a re-expand. `active`
              // is the PRE-toggle state, so !active ⇔ this tap is a select.
              if (expanded && !active && !pinnedSet.has(o.value)) {
                setExpanded(false)
                onLayoutChange?.()
              }
            }}
            aria-pressed={active}
            style={{
              padding: '6px 14px', minHeight: 48, borderRadius: 20,
              fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'inherit',
              // Non-color-only selected state: weight + border-width move together with color.
              fontWeight: active ? 700 : 600,
              border: active ? `2px solid ${P.green}` : `1px solid ${P.border}`,
              backgroundColor: active ? P.greenPale : P.white,
              color: active ? P.green : P.mid,
            }}
          >
            {o.leading != null
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{o.leading}{o.label}</span>
              : o.label}
          </button>
        )
      })}
      {hasTray && (
        <button
          type="button"
          onClick={() => { setExpanded(x => !x); onLayoutChange?.() }}
          aria-expanded={expanded}
          style={{
            padding: '6px 12px', minHeight: 48, borderRadius: 20,
            fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            border: `1px dashed ${P.border}`, backgroundColor: P.white, color: P.mid,
          }}
        >
          {expanded ? 'Less ▴' : 'More ▾'}
        </button>
      )}
      {onClear && sel.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          style={{
            padding: '6px 10px', minHeight: 48, border: 'none', background: 'none',
            color: P.terra, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
            textDecoration: 'underline', fontFamily: 'inherit',
          }}
        >
          Clear
        </button>
      )}
    </div>
  )
}
