// Garden's group-by: the options its control offers, and how a choice persists across visits and devices.
// BUG-GARDENGROUPBYRESET-001 moved both out of src/pages/Garden.jsx (not in coverage.include) so they are
// measured, and so lambda/critter/groupby.parity.test.js can enumerate the REAL option set against both
// allow-lists instead of a copy of it — a copy is how Type ('crop_type') went missing from both lists
// without any test noticing.
import { clearGroupByPending } from './projectTree.js'

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

// ── Keeping the choice ────────────────────────────────────────────────────────────────────────────────
//
// Dave, 2026-09-29: "It should ALWAYS remember my last grouping." Two copies carry a choice: the local one
// (projectTree.js loadGroupBy/saveGroupBy) paints Garden's first frame, and the server one
// (user_notification_prefs.garden_group_by) carries it to another device. Every Garden mount reads the
// server copy once, and before this fix it simply ADOPTED it — after the scroll restore, so the list
// regrouped and the spot went with it. Adopting was only safe while the server copy was never older than
// the local one, and it was older every time a save did not land.
//
// THE RULE: THE USER'S CHOICE WINS UNTIL ITS SAVE IS CONFIRMED. A pick is stored locally and marked pending
// (projectTree.js) BEFORE its PATCH goes out, and the marker comes off only when that PATCH answers ok.
// Dave works in the garden on a weak radio, where a save routinely never lands; with the marker on, a
// mount keeps the local choice and sends it again instead of reading the server's older value as news.

// api.js's service-worker offline-cache marker, read through the global Symbol registry — the
// dependency-free seam dataCache.js and NavPrefsContext.jsx use, so this module never imports api.js.
const FROM_CACHE = Symbol.for('garden-app.fromCache')
export const servedFromCache = (body) => !!body && typeof body === 'object' && body[FROM_CACHE] === true
// The prefs client's mark on a read that was on the wire when a grouping save was confirmed (QA MINOR 4;
// PREDATES_GROUP_BY_SAVE in notificationPrefsClient.js has the why). The same registry seam, so Garden's tests,
// which stub the prefs client, need no new export from it.
const PREDATES_SAVE = Symbol.for('garden-app.prefsPredatesGroupBySave')
export const predatesGroupBySave = (body) => !!body && typeof body === 'object' && body[PREDATES_SAVE] === true

// What one Garden mount does with the prefs body's garden_group_by, in precedence order:
//   { action: 'resend', value } — this person has a choice waiting: the local value stands and goes out again.
//                                 Never adopt here, whatever the server says: its copy is the older one. Across
//                                 devices that makes the LAST CONFIRMED save win, not the last pick (QA MINOR 9,
//                                 a recorded decision): a choice waiting here goes out over another device's.
//   { action: 'keep' }          — the body came from the service worker's cache (it can predate a choice this
//                                 device already confirmed, and it answers exactly when the radio is out) or
//                                 from a read that was on the wire when a save was confirmed (predatesSave: its
//                                 row can be the one from before that save), or the server value is unset,
//                                 EQUAL to the local one (no state write, so no regroup), or one Garden cannot
//                                 offer right now.
//   { action: 'adopt', value }  — nothing waiting here and a different value Garden can show: another
//                                 device's choice. This one does regroup, once; it is the cross-device sync.
// `offerable` is the control's current option values. A tag facet is offerable only once the tag map has
// landed, so a server tag-facet choice that arrives first is kept out — and, since that fresh read ends the
// visit's hydrate, DROPPED for the visit rather than deferred (QA MINOR 7, a recorded decision; tag groupings
// are BUG-GARDENTAGGROUPREPAINT-001's).
export function decideGroupByHydrate({ local, pending, server, fromCache = false, predatesSave = false, offerable = [] }) {
  if (typeof pending === 'string' && pending) return { action: 'resend', value: pending }
  if (fromCache || predatesSave) return { action: 'keep' }
  if (typeof server !== 'string' || !server || server === local) return { action: 'keep' }
  if (!offerable.includes(server)) return { action: 'keep' }
  return { action: 'adopt', value: server }
}

// Send `value` through `save` (a reported saver: resolves { ok } — saveGardenGroupBy) and clear this
// person's pending marker when, and only when, the server has confirmed THIS value.
//
// A SAVE THAT OVERLAPPED ANOTHER NEVER CONFIRMS. Two PATCHes in flight can be applied in either order (two
// Lambda instances, a retransmit on a weak radio), so an ok for the newer one does not prove the server
// ended on it — the older one may have landed after it. Neither clears the marker then; it stays, and the
// next mount re-sends the choice on its own. Module state because a save outlives the Garden that started
// it (the tab is left mid-save) and the next mount's re-send must see it.
const onTheWire = new Set()
export async function sendGroupByChoice({ save, user, value }) {
  const flight = { overlapped: onTheWire.size > 0 }
  for (const other of onTheWire) other.overlapped = true
  onTheWire.add(flight)
  let res = null
  try { res = await save(value) } catch { res = null } finally { onTheWire.delete(flight) }
  if (res?.ok === true && !flight.overlapped) clearGroupByPending(user, value)
  return res
}

// Test seam: the set is module state and vitest does not reset modules between cases in a file.
export function __resetGroupBySends() { onTheWire.clear() }
