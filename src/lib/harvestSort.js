// Harvest Totals ordering — client-side, pure, and the SINGLE source of display order.
//
// WHY THIS EXISTS. v4.32.0 replaced the alphabetical crop/variety order with a weight-descending
// one, because alphabetical actively misled on the comparison question (Moskvich Heirloom 8,233 g
// sorted BELOW Cherry Falls 763 g — a currant tomato reading as the top producer). That fix was
// right about the defect and wrong about the remedy: it swapped one fixed order for another fixed
// order. Dave, verbatim: "having it weighted first and only is not all that useful when I'm trying
// to find specific items - alphanumeric is better sort for that and the default I want."
//
// Ranking and retrieval are two different jobs. Weight answers "what produced?"; name answers
// "where is my chard?". A list has to do both, so the order becomes a control and NAME is the
// default — you cannot scan for a known item in a ranked list, but you can always rank on demand.
//
// WHY CLIENT-SIDE. The page already holds every field this needs (grams via the V4-HARVGRAIN-001
// weight merge, pick counts via units[].count). Sorting here is instant, needs no refetch, and —
// the deciding reason — needs no Lambda deploy, so it ships as a pure frontend change. The server's
// own weight-desc order in applyWeights() is left untouched and simply becomes the base ordering
// this re-sorts; it is still the deterministic tie-break every weightless row falls back to.
//
// WHY IT MUST BE SHARED. The Totals EXPORT owns a SEPARATE fetch (HarvestExportSheet), so it does
// not inherit the page's array. If only the page sorted, a copied export would silently disagree
// with the screen it was copied from — breaking the "the export reconciles with the page"
// invariant that harvestExport.js is built around. Both call this function with the same args.

import { isMassUnit } from './harvestSummary.js'

export const HARVEST_SORT_MODES = [
  { value: 'name', label: 'Name' },
  { value: 'weight', label: 'Weight' },
  { value: 'count', label: 'Picks' },
]

export const DEFAULT_SORT_MODE = 'name'

// Each mode has its OWN natural direction, and switching mode snaps to it. Picking "Weight" and
// getting the lightest crop first would read as a bug, and making the user flip direction after
// every mode change is two taps to express one intent. The toggle then inverts from there.
const NATURAL_DIR = { name: 'asc', weight: 'desc', count: 'desc' }
export function naturalDirFor(mode) { return NATURAL_DIR[mode] ?? 'asc' }

export const DEFAULT_SORT_DIR = NATURAL_DIR[DEFAULT_SORT_MODE]

// Picks, not quantity. units[].count is the number of harvest EVENTS in that unit; total is the
// summed amount. Summing `total` across units would add cups to heads to counts and produce a
// number that means nothing, so the count axis is deliberately event-denominated — unit-free and
// comparable across every crop. unquantified rows are real picks with no amount recorded and are
// included for the same reason: they happened.
export function pickCount(node) {
  const units = Array.isArray(node?.units) ? node.units : []
  const inUnits = units.reduce((n, u) => n + (Number(u?.count) || 0), 0)
  return inUnits + (Number(node?.unquantified) || 0)
}

function gramsOf(node) {
  const g = node?.weight?.grams
  return g == null ? null : Number(g)
}

function nameOf(node) {
  return String(node?.crop_name ?? node?.variety_name ?? '')
}

// Locale-aware and NUMERIC — `numeric: true` is what makes this alphanumeric rather than merely
// alphabetic, so "Bed 2" precedes "Bed 10" instead of following it. Dave asked for alphanumeric.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function byName(a, b) { return collator.compare(nameOf(a), nameOf(b)) }

// Weightless rows sort LAST in BOTH directions, never first. A crop with no recorded weight is
// unknown, not zero — leading a weight-ascending list with rows that have no weight would answer a
// question nobody asked and bury the real lightest crop. Same argument as the ratchet's "no weight
// yet" state being null rather than 0.
function byWeight(a, b, dir) {
  const ga = gramsOf(a), gb = gramsOf(b)
  if (ga == null && gb == null) return byName(a, b)
  if (ga == null) return 1
  if (gb == null) return -1
  const d = dir === 'asc' ? ga - gb : gb - ga
  return d !== 0 ? d : byName(a, b)
}

function byCount(a, b, dir) {
  const ca = pickCount(a), cb = pickCount(b)
  const d = dir === 'asc' ? ca - cb : cb - ca
  return d !== 0 ? d : byName(a, b)
}

export function harvestComparator(mode = DEFAULT_SORT_MODE, dir = DEFAULT_SORT_DIR) {
  if (mode === 'weight') return (a, b) => byWeight(a, b, dir)
  if (mode === 'count') return (a, b) => byCount(a, b, dir)
  return dir === 'desc' ? (a, b) => byName(b, a) : byName
}

/**
 * Return `aggregates` with crops[] and each crop's varieties[] ordered by (mode, dir).
 *
 * Non-mutating: the caller's array is server-owned and is also read by the sparkline and first-pick
 * lookups, so this copies rather than sorting in place. Every other field passes through by
 * reference — this changes ORDER only, never content.
 *
 * The two copies are NOT equally load-bearing, which matters to anyone tempted to tidy them:
 * `[...aggregates.crops]` is belt-and-braces, because the `.map()` that follows already returns a
 * fresh array for `.sort()` to work on. `[...c.varieties]` is the one that counts — without it,
 * `.sort()` reorders the caller's own varieties array in place. Mutation-checked both ways.
 *
 * `other[]` is deliberately NOT sorted: it is the unattributed bucket, grouped by project rather
 * than by crop, carries no weight field at all, and is rendered as a footnote below the crops. A
 * weight sort over rows with no weight is meaningless, and reordering a 2-row footnote to match a
 * control that visually sits above the crop list would imply a relationship that isn't there.
 */
export function sortAggregates(aggregates, mode = DEFAULT_SORT_MODE, dir = DEFAULT_SORT_DIR) {
  if (!aggregates || !Array.isArray(aggregates.crops)) return aggregates
  const cmp = harvestComparator(mode, dir)
  return {
    ...aggregates,
    crops: [...aggregates.crops]
      .map((c) => (Array.isArray(c.varieties) ? { ...c, varieties: [...c.varieties].sort(cmp) } : c))
      .sort(cmp),
  }
}

// ── V4-HARVPLANTSORT-001 — column sorting INSIDE one expanded crop ─────────────────────────────────
//
// Dave, 2026-08-21: "the sort I really want is WITHIN each expanded crop block... I wanna be able to
// sort all other columns within an expanded crop block", defaulting to plant name. Deliberately
// separate from the page-level control above, which orders CROP CARDS and their varieties.
//
// It is a separate comparator rather than a fourth mode on harvestComparator() because ONE column
// means something different here, and quietly reusing the other meaning is how a sort ends up
// disagreeing with the numbers beside it:
//
//   page control "Picks"  -> pickCount(), the number of harvest EVENTS (units[].count)
//   this table's "Count"  -> the QUANTITY picked (units[].total), which is what countCell renders
//
// Sorting the visible "Count" column by event count would order 65 above 128 whenever the lighter
// planting had been visited more often — a ranking that contradicts the column it claims to sort.
// So countedQuantity() below mirrors countCell()'s own rule, mass units and all.

// Mass units are EXCLUDED here for the same reason countCell() dashes them: a pounds-logged planting
// has no meaningful "how many did I pick", and its weight already speaks one column over. Rows that
// filter to nothing sort as null (last in both directions), never as zero.
//
// isMassUnit is IMPORTED, not re-declared. The first draft of this duplicated the set locally to
// "avoid depending on the render layer" — and got it wrong on 11 of 15 entries, because the
// canonical set is exactly four keys (g/kg/lb/oz) and the copy invented gram/grams/pounds/ounces
// that isMassUnit has never recognised. The sort would then have kept a 'grams' row in the Count
// ranking while countCell dashed the very same row. There is no cycle to avoid here — harvestSummary
// imports nothing — so the duplication bought nothing and cost correctness.
function countedQuantity(node) {
  const units = Array.isArray(node?.units) ? node.units : null
  if (!units) return null
  const countable = units.filter((u) => !isMassUnit(String(u?.unit_key ?? '').trim().toLowerCase()))
  if (!countable.length) return null
  return countable.reduce((n, u) => n + (Number(u?.total) || 0), 0)
}

// The columns the planting table offers, in render order. Label doubles as the header text so the
// header and the sort key cannot drift apart.
export const PLANTING_SORT_COLUMNS = [
  { key: 'name', label: 'Planting' },
  { key: 'count', label: 'Count' },
  { key: 'weight', label: 'Total weight' },
  { key: 'first_pick', label: 'First pick' },
]

// Same principle as NATURAL_DIR above: picking a column gives you the direction that column is
// actually useful in. Name reads A-Z; the two magnitude columns lead with the biggest; first pick
// leads with the EARLIEST, because the question that column answers is "what came in first" — and
// because ascending by date is the order the table already shipped in, so the default render does
// not move under anyone who was used to it.
export const PLANTING_NATURAL_DIR = { name: 'asc', count: 'desc', weight: 'desc', first_pick: 'asc' }
export const PLANTING_DEFAULT_SORT = { key: 'name', dir: 'asc' }

export function plantingNaturalDir(key) { return PLANTING_NATURAL_DIR[key] ?? 'asc' }

function plantingName(row) { return String(row?.planting_name ?? '') }

// Null-last in BOTH directions, exactly like byWeight: a planting with no derivable count is
// unknown, not zero, and leading an ascending list with unknowns answers a question nobody asked.
function nullsLast(a, b, dir, valueOf, tie) {
  const va = valueOf(a), vb = valueOf(b)
  if (va == null && vb == null) return tie(a, b)
  if (va == null) return 1
  if (vb == null) return -1
  if (va === vb) return tie(a, b)
  if (typeof va === 'string') return dir === 'asc' ? collator.compare(va, vb) : collator.compare(vb, va)
  return dir === 'asc' ? va - vb : vb - va
}

/**
 * Comparator for ONE expanded crop's first_pick rows. Ties always fall back to the planting name so
 * the order is total and stable — two plantings with the same weight must not swap between renders.
 */
export function plantingComparator(key = PLANTING_DEFAULT_SORT.key, dir = PLANTING_DEFAULT_SORT.dir) {
  const byPlantingName = (a, b) => collator.compare(plantingName(a), plantingName(b))
  if (key === 'count') return (a, b) => nullsLast(a, b, dir, countedQuantity, byPlantingName)
  if (key === 'weight') return (a, b) => nullsLast(a, b, dir, (r) => (r?.weight?.grams == null ? null : Number(r.weight.grams)), byPlantingName)
  if (key === 'first_pick') return (a, b) => nullsLast(a, b, dir, (r) => r?.first_pick_date ?? null, byPlantingName)
  return dir === 'desc' ? (a, b) => byPlantingName(b, a) : byPlantingName
}

/** Non-mutating: `first_pick` is server-owned and read by other lookups on the same page. */
export function sortPlantings(rows, key, dir) {
  return Array.isArray(rows) ? [...rows].sort(plantingComparator(key, dir)) : []
}
