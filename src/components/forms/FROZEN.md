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
| **FilterChipRow** | Multi-select FILTER chip row (OR across chips) with optional pinned chips + `More ▾` in-place tray and a one-tap Clear. Distinct from SelectChip, which is a single tappable option: this owns the ROW, its pin/tray policy, and the aria-pressed selected state. V4-CROPFILTER-001. Selection state is consumer-owned (a Set) and session-ephemeral by design. `TimeframeChips` in Harvests.jsx is the hand-rolled precursor it adopts conventions from; migrating it is a tracked follow-up, deliberately not the minting change. V4-CROPFILTERLAYOUT-001 (BD-011) extends the contract IN-PLACE, no new primitive: optional `trayMaxHeight` turns the EXPANDED tray into a bounded, overscroll-contained scrollport (collapsed row stays unbounded), and selecting a tray-only chip auto-collapses the tray (deselect and pinned taps never do). Chip ORDER is caller-owned — PlantingSelect band-orders via its exported `bandOrder` (V4-CROPLISTORDER-001/BD-010); the row's pinned-first re-sort is stable and passes the caller's order through. Callers without `pinned`/`trayMaxHeight` (HarvestExportSheet) render byte-identically. |
| **SegmentedControl** | 2+-way mutually-exclusive VIEW toggle (radiogroup). V4-THEME-001. |
| **Sheet** | Bottom-sheet fly-up (dialog, backdrop, focus-trap, safe-area). V4-THEME-001. |
| **TileGrid** | Responsive tile-grid layout (columns/auto-fit, empty state). V4-THEME-001. |
| **Button** | Action button (variants via prop). |
| **Badge** | Display-only label chip (tone-colored). Not a reward surface. |
| **EventTypePicker** | Composite: event-type taxonomy picker. |
| **PlantingSelect** | Composite: searchable single-planting combobox (V4-PLANTPICKER-001 — union of the six former hand-rolled pickers; multi-target scope stays in ScopeChecklist). |
| **SourcePicker** | Composite: searchable single-source combobox WITH an inline mint (V4-SOURCEREG-001, kind mint V5-SOURCEKIND-001). Joins two patterns that existed separately: PlantingSelect's combobox contract (aria-activedescendant, namespaced option ids, measured flip placement, `useDismissable`/`LAYER.SHEET`, the shared `useComboboxInput` cluster — all reused, none re-derived) and CropTypeField's inline-create-beside-a-Select. Create path is staged in-panel per VarietyPicker: `＋ Create "<query>"` footer row (a real `role="option"` that counts toward keyboard nav, shown only when a query has no exact `looseKey` match) → a mint form rendered INSTEAD of the listbox → a 409 steer renders a real `Use "<name>"` adopt button, never a dead error string. Serves BOTH `source_id` (originator) and `acquired_from_source_id` (venue) — one component, axis carried by `label`. Every button in the mint panel is `type="button"`: it renders inside the host `<form>`. |
| **ScopeChecklist** | Composite: multi-scope checkbox group. |
| **PlantForm** | Composite: unified add/edit planting form (E1 union). |
| **Spinner** | Loading indicator. |
| **ErrorBanner** | Inline error surface. |
| **Toast** | Transient ambient confirmation (ambient per Reward-UX V102). |
| **formStyles** | Shared token namespace (T) — not a component. |

## Faceted tag primitives — DESIGNSYS Pass A contract §3

Registered here 2026-08-26. Four of these five were **built and shipped** against the
ratified Pass A contract (`v4-wave1.5/designsys-passA-contract-V100-20260624.md` §3) without
ever being registered in this file — so a builder consulting the app repo's own
frozen-primitive register found no tag-primitive contract at all, and the only written one
lived in a different repository. That gap is what this section closes.

**They are NOT in the barrel** (`index.js`) and therefore not in the freeze guard test.
Consumers import them by path. This is a real inconsistency with the header rule above —
recorded rather than papered over. Promoting them into the barrel changes the module's
public surface and needs its own decision; it is deliberately not done here.

| Primitive | Role | State |
|---|---|---|
| **TagChip** | One faceted tag as a chip. Facet conveyed by icon + shape + text prefix, never hue alone. `aria-label="<facet>: <value>"`; the remove control is a real `<button>` with its own accessible name; `role="group"` (not `role="img"`, which would make the nested button presentational). Display primitive — distinct from the interactive SelectChip. | Shipped. **Signature diverges** — see below. |
| **FacetGroupHeader** | Section header for one group in the faceted Garden render: facet icon + value + count, collapsible-disclosure per the Garden accordion. | Shipped. Signature is a superset of the contract's `({facet, value, count})` — compatible. |
| **TagFilterBar** | Contract: the facet-scoped filter ROW (`{facets, active, onToggle}`), SelectChip grammar with `aria-pressed` per chip. | **Name is occupied by a different primitive** — see below. The contracted facet-toggle row is unbuilt. |
| **GroupByControl** | Group-by axis selector (type / group / lifecycle / location / none). Drives `buildTagGroupedList`. The `none` path MUST reproduce the Garden-render golden — see the regression oracle note below. | Shipped, matches the contract. |
| **SavedViewSelector** | `({views, active})` — persisted filter/group presets, cross-device per the Cross-Device State Principle (localStorage only as a tracked expedient). | **UNBUILT.** No `SavedView` identifier exists anywhere in `src/`. Reserved slot, listed so its absence is a recorded state rather than an oversight. |

### The two divergences, recorded as-is

Both are described, **not corrected**. Renaming or re-signaturing a shipped primitive is a
behaviour change with its own blast radius; documenting the drift is what makes it a
decision someone can take rather than a surprise someone discovers.

1. **`TagChip` takes a tag OBJECT.** Shipped as `({ tag, onRemove, onClick, active, style })`;
   the contract specifies `({ facet, value, removable, onRemove })`. `removable` is not a
   prop — it is derived internally as
   `typeof onRemove === 'function' && tag.source !== 'derived'`. That derivation **honours
   the contract's substantive rule** (derived tags are non-removable, system-managed), so
   the divergence is in the interface shape, not the behaviour.
2. **`TagFilterBar` shipped as an active-filter REMOVAL bar**, not the contract's
   facet-toggle row: `({ filters, onRemove, onClear, style })`, `role="region"
   aria-label="Active filters"`, rendering removable TagChips for the filters already
   applied. It is a different primitive wearing the contracted name. Consequence worth
   stating plainly: the facet-toggle row §3 actually specifies is still **unbuilt**, and its
   name is taken.

### GroupByControl's regression oracle

`projectTree.js`'s `buildDisplayList`/`buildGardenTree` (the `none`/by-project path) are
gated to parity hash `8a3d78f098e55ff2` by `npm run parity:garden-render`, wired in
`ci.yml`. Before 2026-08-26 that claim existed only as a source comment with nothing
executing it.

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
