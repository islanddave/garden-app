// V4-RESTORESURFACE-001 — the non-photo half of "Recently deleted", in ONE place.
//
// Sibling of deletedPhotos.js, and it exists for the same reason that file gives: a route literal
// that appears in both a component and its test is not a contract, it is two guesses that happen to
// agree. These descriptors are the single spelling, and deletedEntities.contract.test.js proves each
// `listPath` and `restorePath` against the real route matchers in the four Lambdas and the real
// prefix table in src/lib/api.js — surfaces the test does not write.
//
// ORDER IS LOAD-BEARING, not alphabetical. Containers come FIRST because restoring one is a
// precondition for restoring things inside it: every container-reaching read in lambda/plants
// requires the container to be live (the F4 gate), so a planting whose container is also deleted is
// invisible to the plantings list until the container comes back. On live prod at authoring time
// that was 11 of 33 soft-deleted plantings. A user who works down this page top-to-bottom hits the
// unblocking action before the blocked one; a user who works alphabetically does not.
//
// NO DELETE VERB, EVER. Same rule as the photos surface: the only action here is Restore. Nothing on
// this page removes anything, so there is no destructive control to keep away from the thumb path.
export const DELETED_ENTITY_KINDS = [
  {
    key: 'projects',
    label: 'Containers',
    // Named for what the user calls them, not for the table. `plant_projects` is a container in the
    // UI's vocabulary everywhere else.
    listPath: '/api/projects/deleted',
    responseKey: 'projects',
    restorePath: (id) => `/api/projects/${id}/restore`,
    // Restoring a container does NOT resurrect its plantings — the delete never cascaded to them —
    // so the count is shown to explain why this row is worth restoring first.
    subtitle: (row) => {
      const n = Number(row?.deleted_planting_count ?? 0)
      return n > 0 ? `${n} deleted planting${n === 1 ? '' : 's'} inside` : null
    },
    invalidatePrefixes: ['/api/projects', '/api/plants'],
    toast: 'Container restored',
  },
  {
    key: 'plants',
    label: 'Plantings',
    listPath: '/api/plants/deleted',
    responseKey: 'plants',
    restorePath: (id) => `/api/plants/${id}/restore`,
    subtitle: (row) => row?.project_name || null,
    invalidatePrefixes: ['/api/plants'],
    toast: 'Planting restored',
  },
  {
    key: 'locations',
    label: 'Locations',
    listPath: '/api/locations/deleted',
    responseKey: 'locations',
    restorePath: (id) => `/api/locations/${id}/restore`,
    subtitle: (row) => row?.type_label || null,
    invalidatePrefixes: ['/api/locations'],
    toast: 'Location restored',
  },
  {
    key: 'varieties',
    label: 'Cultivars',
    listPath: '/api/varieties/deleted',
    responseKey: 'varieties',
    restorePath: (id) => `/api/varieties/${id}/restore`,
    subtitle: (row) => row?.crop_type_slug || null,
    invalidatePrefixes: ['/api/varieties'],
    toast: 'Cultivar restored',
  },
]

// The list endpoints answer `{ <responseKey>: [...] }` rather than a bare array — matching the
// existing list routes in each Lambda rather than inventing a different shape for this one surface.
// A missing key yields [] rather than throwing: one entity type failing to load must not blank the
// other three, which is the same reasoning RecentlyDeleted uses to keep load and restore errors apart.
export function rowsFromResponse(kind, body) {
  const rows = body?.[kind.responseKey]
  return Array.isArray(rows) ? rows : []
}
