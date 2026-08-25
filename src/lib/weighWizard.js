// weighWizard.js — V4-WEIGHWIZARDFLOW-001 (BD-055) Slice 1. The step machine, as pure functions.
//
// Dave's flow, verbatim from the row: enter a weigh session -> IMMEDIATELY the planting chooser (no
// landing screen) -> pick -> IMMEDIATELY how many, with a BACK to re-choose -> count -> IMMEDIATELY
// weight -> weight -> IMMEDIATELY add-more or save.
//
// No React here on purpose. The wizard's LAYOUT is the thing jsdom cannot falsify
// (tests/harness/README.md:14-16 — getBoundingClientRect returns zeros); its ORDERING, its back
// edges and its dirty predicate are ordinary data, and keeping them out of the component is what
// lets a green vitest run mean something about the flow.
//
// SLICE 1 ships STEP_PLANTING only. The later steps are named here, and `advance` knows the order,
// because the order is the design decision — but EventNew only ever mounts step 1 while
// WEIGH_WIZARD_ENABLED gates the rest. See design-weighwizard-V100-20260825.md §8.

export const STEP_PLANTING = 'planting'
export const STEP_QUANTITY = 'quantity'
export const STEP_WEIGHT = 'weight'
export const STEP_MORE = 'more'

// Order is the flow. `back` is this list read right-to-left, which is why there is one array and
// not a pair of transition tables that could disagree.
export const STEP_ORDER = [STEP_PLANTING, STEP_QUANTITY, STEP_WEIGHT, STEP_MORE]

// Slice 1's horizon. Advancing past it hands control back to the existing form rather than
// rendering a step that does not exist yet — an explicit, testable edge instead of a blank sheet.
export const LAST_BUILT_STEP = STEP_PLANTING

export function stepIndex(step) {
  return STEP_ORDER.indexOf(step)
}

// Returns the next step, or null when there is none built. null means "close the wizard and let the
// form take it from here" — the whole of Slice 1's hand-off contract.
export function advance(step, { lastBuilt = LAST_BUILT_STEP } = {}) {
  const i = stepIndex(step)
  if (i < 0) return null
  if (i >= stepIndex(lastBuilt)) return null
  return STEP_ORDER[i + 1]
}

// Back is NAVIGATION, never erasure (design §5). This returns where to go; nothing here clears a
// value, and no caller may add that — one mis-tap of the back chevron costing the entry would make
// the wizard slower than the form it replaces.
export function back(step) {
  const i = stepIndex(step)
  if (i <= 0) return null
  return STEP_ORDER[i - 1]
}

export function canGoBack(step) {
  return back(step) !== null
}

// DIRTY = the in-flight entry only. Rows already saved this session are server-side and are never at
// risk, which is what the confirm body says; a confirm that overstates the loss trains the user to
// dismiss it. `weight` counts even though it is optional — the user typed it, so losing it is a loss.
//
// Trimmed rather than truthy-tested: '' and '  ' are both "nothing entered", and an Input that has
// been focused and cleared leaves the empty string, not undefined.
export function isDirty(entry) {
  if (!entry) return false
  const filled = (v) => typeof v === 'string' ? v.trim() !== '' : v != null && v !== ''
  return filled(entry.plant_id) || filled(entry.quantity) || filled(entry.weight)
}

// The header line for a step. Kept here, not in JSX, so the "every step names its planting" rule is
// testable: a number must never be ambiguous about what it belongs to (the original crucible's
// top usability failure mode — grams landing in the next row's quantity).
export function stepTitle(step, plantingName) {
  const base = {
    [STEP_PLANTING]: 'Weigh-in',
    [STEP_QUANTITY]: 'How many',
    [STEP_WEIGHT]: 'Weight',
    [STEP_MORE]: 'Add details',
  }[step]
  if (!base) return null
  if (step === STEP_PLANTING || !plantingName) return base
  return `${base}  ·  ${plantingName}`
}
