// src/lib/photoFilters.js — V5-PHOTOFILTERPARITY-001 (BD0901-01). The Photos page's filter/sort
// DECISIONS, held here rather than inside PhotoLibrary.jsx for the reason scrollRestore.js records:
// `src/pages/**` is not in vitest's coverage.include, so a predicate that lives in the page is
// unmeasured by construction. The page keeps the wiring; this file keeps the answers.
//
// WHAT A PHOTO'S CROP ACTUALLY IS, stated up front because it is the one thing here that can be
// misread. GET /api/photos returns no crop, no variety and no plant NAME — only `plant_id`
// (lambda/photos/index.js, the five list templates all select the same column set). So a crop is
// resolved by JOINING that id against the planting picker projection, and it therefore means
// "the crop of the planting this photo is filed under" — NOT "what is in the frame". A photo shot
// while logging a tomato pick is filed under that tomato whether it shows fruit, a trellis or the
// dog. The chips are honest about the filing, and nothing here infers subject matter from metadata.
//
// PHOTOS WITH NO PLANTING HAVE NO CROP, and that is a real exclusion rather than a gap to paper
// over: a photo attached only to an event, a zone, a project or an inventory item carries no
// plant_id, so no crop chip can ever match it. `cropOfPhoto` returns null for those and
// `filterByCrop` drops them while a chip is on — which is what "show me the tomato photos" means.
// The active-filter breadcrumb on the page is what keeps that from being a silent disappearance.

// Sort vocabulary. The server hands the list back created_at DESC (every template ends
// `ORDER BY p.created_at DESC`), so 'newest' reproduces the shipped order — but it is re-derived
// here rather than assumed, because the client now re-orders and a sort that merely trusted the
// wire would silently disagree with itself the moment anything reordered the array upstream.
import { photoDate } from './photoModel.js'

export const PHOTO_SORT_NEWEST = 'newest'
export const PHOTO_SORT_OLDEST = 'oldest'
export const DEFAULT_PHOTO_SORT = PHOTO_SORT_NEWEST
export const PHOTO_SORT_MODES = [
  { value: PHOTO_SORT_NEWEST, label: 'Newest' },
  { value: PHOTO_SORT_OLDEST, label: 'Oldest' },
]

// The mode chips, as data. Exported so the page's row and the breadcrumb's label lookup read the
// same table — a second copy of these four strings is how a chip and its pill start disagreeing.
export const PHOTO_FILTER_MODES = [
  { value: 'all', label: 'All' },
  { value: 'today', label: 'Today' },
  { value: 'standalone', label: 'No event' },
  { value: 'untagged', label: 'Untagged' },
]

export function cropOfPhoto(photo, cropByPlantId) {
  const id = photo?.plant_id
  if (!id || !cropByPlantId) return null
  return cropByPlantId.get(String(id)) ?? null
}

// plant_id -> crop_type_slug, over rows from the planting-chooser projection (PhotoLibrary's
// PICKER_PATH — the literal URL is deliberately NOT repeated here, so lambda/plants/grid-view.test.js's
// consumer census keeps counting CALL SITES rather than files that merely mention the param; this
// module issues no request). Keyed as STRINGS on both sides so a uuid that arrives as a different
// object identity still resolves.
export function cropIndex(plants) {
  const m = new Map()
  for (const p of plants ?? []) {
    const slug = p?.variety_ref?.crop_type_slug
    if (p?.id && slug) m.set(String(p.id), slug)
  }
  return m
}

// Multi-select OR across chips, exactly as FilterChipRow's contract states. Empty selection is a
// pass-through and returns the SAME array reference, so an unfiltered page does no work and no
// downstream memo churns.
export function filterByCrop(photos, cropSel, cropByPlantId) {
  if (!cropSel || cropSel.size === 0) return photos ?? []
  return (photos ?? []).filter(p => {
    const slug = cropOfPhoto(p, cropByPlantId)
    return slug != null && cropSel.has(slug)
  })
}

// Non-mutating. Sorts on photoDate() — capture time where the camera recorded one, upload time
// otherwise — so "newest" means the newest PHOTOGRAPH, not the newest upload. V4-PHOTOTAKENAT-002;
// the rule and the measurements behind it live on photoDate() in photoModel.js, in one place so
// this helper and PhotosWall's month sectioning cannot drift apart.
//
// LEXICAL COMPARE STILL HOLDS, and now spans two columns rather than one. Both taken_at and
// created_at are timestamptz that reach the client as ISO-8601 with a Z — the driver renders them
// identically because they are the same PG type on the same round trip — so a string compare IS the
// chronological one and mixing the two is safe. That is a property of the wire format, not a
// coincidence: if either column ever arrives in a different shape, this must become Date.parse.
//
// `id` breaks ties so the order is total and a test can pin it. A row with no date at all sorts
// LAST in both directions rather than drifting to the head of 'oldest' — an unknown timestamp must
// not outrank a measured one at the top of a list someone is scanning.
export function sortPhotos(photos, order) {
  const list = [...(photos ?? [])]
  const dir = order === PHOTO_SORT_OLDEST ? 1 : -1
  return list.sort((a, b) => {
    const A = photoDate(a), B = photoDate(b)
    if (!A && !B) return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
    if (!A) return 1
    if (!B) return -1
    return dir * String(A).localeCompare(String(B)) || String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  })
}

// The breadcrumb's pills, in the order the controls themselves read down the page: mode, crop,
// zone, project. Shaped for TagFilterBar/TagChip — `{ facet, slug, label }`, keyed `facet:slug`.
//
// FACETS ARE THE FOUR THAT CARRY A HUE (tokens.js FACET_TOKENS: type/group/location/freeform), so a
// mixed row is distinguishable by more than reading order, and TagChip's `aria-label` grammar
// (`${facet}: ${label}`) still says which axis each pill is on. `kind` is this file's own handle for
// the removal callback — TagFilterBar passes the whole tag object back to onRemove, so the page
// switches on it rather than re-parsing a composite id.
export function activeFilterPills({
  mode = 'all',
  cropSel,
  cropLabelBySlug,
  locationId = '',
  locationLabel = '',
  projectId = '',
  projectLabel = '',
} = {}) {
  const pills = []
  if (mode && mode !== 'all') {
    const label = PHOTO_FILTER_MODES.find(m => m.value === mode)?.label ?? mode
    pills.push({ facet: 'freeform', slug: mode, label, kind: 'mode' })
  }
  for (const slug of cropSel ?? []) {
    pills.push({ facet: 'type', slug, label: cropLabelBySlug?.get(slug) || prettySlug(slug), kind: 'crop' })
  }
  if (locationId) {
    // The id is the fallback label rather than a blank pill: a zone whose row has gone missing must
    // still be REMOVABLE, and a pill with no text is a control nobody can aim at.
    pills.push({ facet: 'location', slug: String(locationId), label: locationLabel || String(locationId), kind: 'zone' })
  }
  if (projectId) {
    pills.push({ facet: 'group', slug: String(projectId), label: projectLabel || String(projectId), kind: 'project' })
  }
  return pills
}

// Slug -> Title Case, the last-resort label when useCropTypes has no row for a slug the photos DO
// carry. The controlled vocabulary is the naming authority (SavedSeeds' facet header records why a
// second one is a hazard); this only covers its documented degrade-to-empty path.
export function prettySlug(slug) {
  return String(slug ?? '')
    .split(/[-_]/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}
