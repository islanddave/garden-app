// Garden's group-by: the options its control offers. BUG-GARDENGROUPBYRESET-001 moved this out of
// src/pages/Garden.jsx (not in coverage.include) so it is measured, and so lambda/critter/groupby.parity.test.js
// can enumerate the REAL option set against both allow-lists instead of a copy of it — a copy is how Type
// ('crop_type') went missing from both lists without any test noticing.

// The tag facets, in the order the control lists them.
export const GARDEN_TAG_FACETS = ['type', 'lifecycle', 'heat', 'determinacy', 'day_length', 'allium_type', 'basil_use', 'bean_type', 'bean_habit', 'bean_use', 'location', 'group', 'freeform']
const TAG_FACET_LABELS = { type: 'Type', lifecycle: 'Lifespan', heat: 'Heat', determinacy: 'Determinacy', day_length: 'Day Length', allium_type: 'Allium', basil_use: 'Basil', bean_type: 'Bean Type', bean_habit: 'Bean Habit', bean_use: 'Bean Use', location: 'Location', group: 'Group', freeform: 'Tags' }

// The options, in order, for a whole-garden tag map (useEntityTagsBulk's `entities`).
//
// V4-PROJHIDE-001: when projects are hidden, the "Projects" (none) grouping is gone and CROP TYPE
// leads — a real crop_type_slug grouping (tomato/pepper/...) from the cultivar join, since the
// entity-tags 'type' facet is unpopulated in prod. The tag 'type' facet is skipped so it can't
// shadow the crop-type option. Flag OFF keeps the exact prior options (Projects + tag facets).
//
// V4-FACETSLUG-001 ordering (BD0806-21: "type, project, location, lifecycle"). The option SET is
// unchanged in both flag states — only the ORDER moves, so nothing about grouping behavior or the
// stale-value fallback shifts. Three notes on the literal spec:
//   * "project" is DEAD. PROJECTS_HIDDEN went true 2026-08-10 (the day the row was filed), so the
//     'none'/Projects option is unreachable under the flag. It is NOT resurrected; with the flag
//     OFF it keeps its historical lead position and the rest of the head follows it.
//   * "lifecycle" means the option LABELLED "Lifecycle", which is the `status` facet. The
//     lifecycle TAG facet is labelled "Lifespan". That inversion is live and deliberate; it sorts
//     down with the other tag facets rather than claiming the head slot the row asked for.
//   * 'status' and 'location' are STRUCTURAL (every planting has both) so they are offered
//     unconditionally — they do not depend on tagMap having anything in it. Promoting them into
//     the head is what makes the head stable regardless of which tag facets happen to be present.
export function buildGardenFacetOptions(tagMap, projectsHidden) {
  const present = new Set()
  for (const id in (tagMap || {})) {
    const e = tagMap[id]
    for (const t of [...(e.direct || []), ...(e.projected || [])]) present.add(t.facet)
  }
  const opts = []
  if (projectsHidden) {
    opts.push({ value: 'crop_type', label: 'Type' }) // crop_type (cultivar join) replaces the tag 'type' facet
  } else {
    opts.push({ value: 'none', label: 'Projects' })
    if (present.has('type')) opts.push({ value: 'type', label: TAG_FACET_LABELS.type })
  }
  opts.push({ value: 'location', label: TAG_FACET_LABELS.location })
  opts.push({ value: 'status', label: 'Lifecycle' })
  for (const fct of GARDEN_TAG_FACETS) {
    if (fct === 'type') continue // already placed in the head (or replaced by crop_type)
    // V4-GARDENLOCFILTER-001: 'location' is STRUCTURAL (garden_node.location_id) and is placed in
    // the head above. Skipped here so a stray location-facet tag can't add a duplicate option.
    if (fct === 'location') continue
    if (present.has(fct)) opts.push({ value: fct, label: TAG_FACET_LABELS[fct] || fct })
  }
  return opts
}
