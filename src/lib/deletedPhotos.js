// W-RESTORE — the API paths for the "Recently deleted" surface, in ONE place.
//
// WHY A MODULE FOR TWO STRINGS. Earlier the same day, a component and its test each declared the
// same private route literal, so the UI shipped pointing at an endpoint the server does not serve —
// with 33 tests green, because the test was asserting the component's own typo back at itself. A
// literal that appears twice is not a contract; it is two guesses that happen to agree.
//
// These constants are the single spelling. RecentlyDeleted.jsx imports them, and
// deletedPhotos.contract.test.js proves them against the TWO surfaces that actually decide whether a
// request lands: the real route matchers in lambda/photos/index.js, and the real resolveUrl prefix
// table in src/lib/api.js. Neither of those is written by the test, so agreement between them and
// this file cannot be self-fulfilling.
export const DELETED_PHOTOS_PATH = '/api/photos/deleted'

// POST — the server treats it as idempotent (restoring a live photo answers 200 already_restored),
// so a double-tap is safe by contract rather than by client-side guarding alone.
export function restorePhotoPath(photoId) {
  return `/api/photos/${photoId}/restore`
}
