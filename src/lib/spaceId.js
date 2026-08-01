// src/lib/spaceId.js — V4-SPACEPHOTO-001 Lane C. The SINGLE seam that answers "which space?".
//
// Discovery is SERVER-side. `GET /api/photos/space-hero` with NO id resolves the caller's own
// household space (spaces.created_by = ANY(household), deterministic oldest when there is more
// than one) and returns its id as `space_id`. That one round trip bootstraps every other space
// surface: `?space_id=` for the gallery, `/space-featured/:id` for the PUT.
//
// It replaced a VITE_SPACE_ID build variable, now deleted. That variable was unset in every
// environment, so with it the feature was unreachable even with SPACE_PHOTOS_ENABLED on; there
// was no shipped surface a client could obtain a space id from (no /api/spaces, the plants list
// SELECT omits workspace_id, the daily-plan read model drops it).
//
// A route param still WINS over discovery: /space/:spaceId is a real route and the by-id hero form
// still 404s an unknown or foreign space server-side, so a second space needs a link, not a code
// change.

// Anything that is not a usable id becomes null — the guard that makes `/space-hero/undefined`
// unconstructible. useParams() yields undefined for an unmatched param; an empty or blank string
// is a malformed URL, not an id.
function usableId(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

// The ONLY place a space-hero URL is built. No param -> the id-free discovery form.
export function spaceHeroPath(routeParam) {
  const id = usableId(routeParam)
  return id ? `/api/photos/space-hero/${encodeURIComponent(id)}` : '/api/photos/space-hero'
}

// Route param first, then whatever the hero response resolved. Null means "no space to act on" —
// the zero-space empty state, NOT an error: the id-free form answers 200 with a null-valued body
// when the household owns no space at all.
export function resolveSpaceId(routeParam, hero) {
  return usableId(routeParam) ?? usableId(hero?.space_id)
}

// Whether the hero the server returned is a PERSISTED designation rather than its newest-photo
// fallback. `featured_photo_id` is the EFFECTIVE hero (so id and url can never disagree), which
// makes an id match alone ambiguous; `featured_is_explicit` is what disambiguates it. False covers
// every non-persisted case: spaces.featured_photo_id NULL, or pointing at a soft-deleted or
// out-of-household photo, or the space having no photos at all.
//
// Load-bearing: this is the set-featured no-op guard. Treating a bare id match as "already
// featured" is the silently-reverting bug — the fallback hero's own "set as feature photo" tap
// no-ops, nothing is written, and the hero changes the moment a newer photo is uploaded.
export function isPinnedFeatured(hero, photoId) {
  return !!photoId && photoId === hero?.featured_photo_id && hero?.featured_is_explicit === true
}
