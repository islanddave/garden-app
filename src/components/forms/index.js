// src/components/forms/index.js
// Lane D / Phase A barrel — canonical shared form primitives.
// FROZEN SET (V3-PRIMITIVES-001): see ./FROZEN.md. The export surface below is pinned by
// src/__tests__/formsPrimitivesFreeze.test.js — adding/removing a primitive must update both.
export { default as Field } from './Field.jsx'
export { default as Input } from './Input.jsx'
export { default as Select } from './Select.jsx'
export { default as Textarea } from './Textarea.jsx'
export { default as Button } from './Button.jsx'
export { default as Badge } from './Badge.jsx'
export { default as EnumSelect } from './EnumSelect.jsx'
export { default as StatusSelect } from './StatusSelect.jsx'
export { default as PlantForm } from './PlantForm.jsx'
export { default as SelectChip } from './SelectChip.jsx'
export { default as SegmentedControl } from './SegmentedControl.jsx'
export { default as Sheet } from './Sheet.jsx'
export { default as TileGrid } from './TileGrid.jsx'
export { default as EventTypePicker } from './EventTypePicker.jsx'
export { default as PlantingSelect } from './PlantingSelect.jsx'
// V4-SOURCEREG-001: SourcePicker joins the frozen set (FROZEN.md + formsPrimitivesFreeze updated in
// this change) — the ONE provenance chooser, serving both source_id and acquired_from_source_id.
// `sourceSubLabel` is deliberately NOT re-exported: it is a row formatter, not a primitive, and the
// barrel's export surface is frozen to primitives.
export { default as SourcePicker } from './SourcePicker.jsx'
// V4-CROPFILTER-001: FilterChipRow joins the frozen set (FROZEN.md + formsPrimitivesFreeze updated
// in this change) — it is the ONE multi-select filter chip row, consumed by the picker now and the
// harvest export sheet next. CROP_CHIPS_AUTO is deliberately NOT re-exported here: it is a prop
// VALUE, not a primitive, and the barrel's export surface is frozen to primitives.
export { default as FilterChipRow } from './FilterChipRow.jsx'
export { default as ScopeChecklist } from './ScopeChecklist.jsx'
export { default as Card } from './Card.jsx'
export { default as AsyncRegion } from './AsyncRegion.jsx'
export { default as PageShell } from './PageShell.jsx'
export { default as Spinner } from './Spinner.jsx'
export { default as ErrorBanner } from './ErrorBanner.jsx'
export { default as Toast } from './Toast.jsx'
export * as formStyles from './formStyles.js'
