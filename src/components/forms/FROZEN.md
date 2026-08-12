# Frozen primitive set — V3-PRIMITIVES-001

This is the **canonical, frozen** set of shared UI/form primitives for garden-app.
All form surfaces and display chrome compose from these. **Do not add new ad-hoc
primitives** — extend one of these (new prop / tone / size) or, if a genuinely new
primitive is needed, add it here AND update the freeze guard test in the same change
(`src/__tests__/formsPrimitivesFreeze.test.js`). The guard fails CI on any drift
(a primitive removed, renamed, or an unlisted one exported), so the freeze is enforced,
not aspirational.

Barrel: `src/components/forms/index.js`. Token layer: `formStyles.js` (`T`) + palette `P`.

## Canonical primitives

| Primitive | Role |
|---|---|
| **Card** | Bounded content container (the surface block). |
| **AsyncRegion** | Async-state content region: error → loading → empty → children. NOT a titled section — compose a local titled `<section>` for headings. The error branch is an inline `ErrorBanner` by default; pass `onRetry` (+ optional `errorTitle` / `retryLabel`) to get the recoverable-error CARD instead — glyph + title + message + `Button variant="secondary"`. Pages must not hand-roll that card. |
| **PageShell** | Page-level frame (safe-area + max-width + heading slot). |
| **Field** | Label + control + error wrapper (the form-row unit). |
| **Input** | Text/number/date input. |
| **Textarea** | Multiline text input. |
| **Select** | Native single-select. |
| **EnumSelect** | Select bound to a registry value set (dropdownRegistry). |
| **StatusSelect** | Status-vocabulary select (lifecycle stages). |
| **SelectChip** | Tappable chip option (chip-style single/multi pick). |
| **FilterChipRow** | Multi-select FILTER chip row (OR across chips) with optional pinned chips + `More ▾` in-place tray and a one-tap Clear. Distinct from SelectChip, which is a single tappable option: this owns the ROW, its pin/tray policy, and the aria-pressed selected state. V4-CROPFILTER-001. Selection state is consumer-owned (a Set) and session-ephemeral by design. `TimeframeChips` in Harvests.jsx is the hand-rolled precursor it adopts conventions from; migrating it is a tracked follow-up, deliberately not the minting change. |
| **SegmentedControl** | 2+-way mutually-exclusive VIEW toggle (radiogroup). V4-THEME-001. |
| **Sheet** | Bottom-sheet fly-up (dialog, backdrop, focus-trap, safe-area). V4-THEME-001. |
| **TileGrid** | Responsive tile-grid layout (columns/auto-fit, empty state). V4-THEME-001. |
| **Button** | Action button (variants via prop). |
| **Badge** | Display-only label chip (tone-colored). Not a reward surface. |
| **EventTypePicker** | Composite: event-type taxonomy picker. |
| **PlantingSelect** | Composite: searchable single-planting combobox (V4-PLANTPICKER-001 — union of the six former hand-rolled pickers; multi-target scope stays in ScopeChecklist). |
| **ScopeChecklist** | Composite: multi-scope checkbox group. |
| **PlantForm** | Composite: unified add/edit planting form (E1 union). |
| **Spinner** | Loading indicator. |
| **ErrorBanner** | Inline error surface. |
| **Toast** | Transient ambient confirmation (ambient per Reward-UX V102). |
| **formStyles** | Shared token namespace (T) — not a component. |

## Intentionally deferred slot

- **MediaTile** — a canonical image/photo thumbnail tile (tap-to-zoom, lazy, fallback).
  Deferred from Phase F (bardeen). Its API should be settled together with
  V3-PHOTOMULTI-001 (multi-photo galleries) and V4-IMG-001 (thumbnail/derivative
  pipeline) so it's designed against real galleries, not speculatively. Until then,
  media tiles remain local to PhotoLibrary/Collection. When built, add it to the barrel
  and the freeze guard in the same change.

## Status-badge note (broad adoption = Phase F / Bundle 3)

Badge is frozen here, but the project-status pill is still rendered several ways across
surfaces (PlantStatusBadge is canonical; ProjectList/Dashboard/Garden carry inline pills).
Unifying them is **broad-adoption** work tracked under V3-FORMSYS-001 Phase F — it needs
per-surface visual-parity checks and is deliberately NOT part of the freeze.
