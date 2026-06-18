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
| **Section** | Titled grouping inside a page/card. |
| **PageShell** | Page-level frame (safe-area + max-width + heading slot). |
| **Field** | Label + control + error wrapper (the form-row unit). |
| **Input** | Text/number/date input. |
| **Textarea** | Multiline text input. |
| **Select** | Native single-select. |
| **EnumSelect** | Select bound to a registry value set (dropdownRegistry). |
| **StatusSelect** | Status-vocabulary select (lifecycle stages). |
| **SelectChip** | Tappable chip option (chip-style single/multi pick). |
| **Button** | Action button (variants via prop). |
| **Badge** | Display-only label chip (tone-colored). Not a reward surface. |
| **EventTypePicker** | Composite: event-type taxonomy picker. |
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
