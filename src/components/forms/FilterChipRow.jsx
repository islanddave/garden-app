// src/components/forms/FilterChipRow.jsx
// V4-CROPFILTER-001 — THE shared multi-select filter chip row (design
// harvest-logging-ux-design-V100-20260812 §1b "Shared primitive"). Minted HERE, FIRST, because
// this release would otherwise scatter two new hand-rolled chip rows (S2 picker crop chips, S5
// export crop multi-select) beside the existing hand-rolled TimeframeChips (Harvests.jsx — the
// house exemplar whose aria-pressed + P-token conventions this adopts). Migrating TimeframeChips
// itself is deliberately NOT this release (regression surface) — consolidation is a ledger
// follow-up. S5 (export sheet) consumes this cross-lane; keep the prop surface stable.
//
// Selection semantics: MULTI-SELECT OR — `selected` is a Set owned by the consumer; every chip
// tap calls onToggle(value) and the consumer flips membership. Presentation rules bound by the
// design's §5.8 build-spec addendum:
//   - selected state is NON-COLOR-ONLY (border weight 1px→2px + font weight 600→700) + aria-pressed
//   - ≥48px touch targets (the adjacent surface's house standard)
//   - `More ▾` is IN-PLACE DOWNWARD expansion of the row — never a nested sheet (no third modal
//     layer, no scroll re-anchor)
// Combobox-host contract: the root swallows mousedown (preventDefault) so a chip tap inside an
// open combobox panel never blurs the input — the 150ms blur-close would eat the first tap
// otherwise (PlantingSelect.jsx onMouseDown convention). Harmless on plain pages: click still
// fires and keyboard focus is unaffected.
import React, { useMemo, useState } from 'react'
import { P } from '../../lib/constants.js'

const EMPTY_SET = new Set()

export default function FilterChipRow({
  // [{ value, label }] in display order (pinned values are re-grouped first below).
  options = [],
  // Set of selected values — consumer-owned state (session-ephemeral by design: never persisted).
  selected,
  onToggle,
  // Optional: values always visible; the rest collapse behind `More ▾`. Omitted → flat row, no More.
  pinned,
  // Optional: renders a one-tap "Clear" affordance while the selection is non-empty.
  onClear,
  // Optional: fired when the More tray expands/collapses — a combobox host re-measures its
  // panel geometry (the row's height enters the flip/room computation, §1b).
  onLayoutChange,
  // V4-CROPFILTERLAYOUT-001 (BD-011) — optional: while EXPANDED, cap the row at this height and
  // make it its own scrollport. Collapsed stays unbounded — it is 1-2 lines by construction
  // (pinned ∪ selected), and capping it would clip the only always-visible chips. Absent (the
  // HarvestExportSheet contract, and any no-pin caller) ⇒ byte-identical render.
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
  // after collapse — hiding an ACTIVE filter is the invisible-filter trap the §1b "loud
  // active-filter signal" rule exists to prevent.
  // V4-CROPLISTORDER-001 (BD-010) NOTE — sort STABILITY here is LOAD-BEARING. `options` arrive
  // pre-ordered by the caller (PlantingSelect's bandOrder: pins → recents band → alphabetical
  // tail). This pinned-first comparator only partitions; within each partition the caller's
  // order must pass through untouched, which is exactly what Array.prototype.sort's guaranteed
  // stability (ES2019+) provides. Replacing it with a non-stable sort — or "simplifying" to a
  // full comparator over labels — would silently scramble the recents band.
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
        // BD-011: the EXPANDED tray is a bounded scrollport, never an unbounded wrap (the
        // ~26-line row that starved the host's listbox). overscrollBehavior 'contain' is
        // MANDATORY — same reason as PlantingSelect's listboxStyle: an end-of-tray flick must
        // not chain the scroll to the Sheet and drag the anchored input away mid-choice.
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
              // BD-011 rider — collapse-on-select: SELECTING a tray-only chip while expanded
              // collapses the tray (the list below is the next thing the user needs to see).
              // DESELECT keeps the tray open (the user is still browsing chips), and pinned
              // chips never collapse it. `shown` already includes selected values when
              // collapsed, so the just-tapped chip stays visible after the collapse. Cost:
              // picking a second different crop needs a re-expand — flagged for Dave's smoke
              // pass (consult §4). `active` is the PRE-toggle state, so !active ⇔ this tap
              // is a select.
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
            {o.label}
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
