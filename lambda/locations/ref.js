// Resolving the `:id` path segment of /api/locations/:id to EXACTLY ONE row (BUG-LOCDELSLUG-001).
//
// THE DEFECT. All three verbs resolve the captured segment as `(slug = $1 OR id::text = $1)`, which is not
// single-valued because `locations.slug` has NO global unique index, only two PARTIAL uniques:
//   idx_locations_root_slug   UNIQUE (slug)             WHERE parent_id IS NULL
//   idx_locations_child_slug  UNIQUE (parent_id, slug)  WHERE parent_id IS NOT NULL
// So the same child slug under two different parents is EXPLICITLY LEGAL, as is a root slug equal to some
// child's slug. Neither index carries `deleted_at IS NULL`, so the soft-delete filter neither creates nor
// removes the ambiguity.
//
// WHY IT MATTERS MOST ON DELETE. The DELETE arm is gated on `!rows.length`, so ambiguity soft-deletes
// EVERY match and still answers 200 {ok:true}. The PUT carries the same predicate on an UPDATE, so it
// silently overwrites N locations with one body. The GET returns an arbitrary rows[0].
//
// LATENT, NOT LIVE: no caller sends a slug (src/pages/Locations.jsx passes loc.id), but POST accepts
// `body.slug` verbatim, so a client can create a colliding child slug directly.
//
// THE RULE. An id match is UNAMBIGUOUS (primary key), so it always wins, even over a slug that equals it.
// Otherwise one slug match resolves, and several resolve to nothing and the caller gets a typed 409. 404 is
// reserved for "no such location you can see" and must not absorb the ambiguous case: the existence-leak
// argument for collapsing not-found/not-owned/already-deleted does not apply (the caller already proved it
// can see at least two).
//
// ZERO imports so it can be tested BEHAVIOURALLY: the handler cannot be imported in CI (per-dir
// node_modules do not exist there), so sibling guards read index.js as text; this rule is arithmetic on rows.

export const AMBIGUOUS_REF_STATUS = 409;
export const AMBIGUOUS_REF_BODY = {
  error: 'Ambiguous location reference',
  code: 'location_ref_ambiguous',
};

// rows: whatever the slug-or-uuid SELECT returned; each row must carry `id`.
// Returns { row } (row may be null for not-found) or { ambiguous: true }.
export function resolveLocationRow(rows, ref) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length <= 1) return { row: list[0] ?? null };
  // Re-checked here rather than trusted from the caller's ORDER BY: the id arm is the only tiebreak that is
  // correct BY CONSTRUCTION, and an ORDER BY belongs to one call site while this is the rule for all three verbs.
  const exact = list.find((r) => String(r?.id) === String(ref));
  return exact ? { row: exact } : { ambiguous: true };
}

// Pre-flight resolution for the MUTATING verbs. GET applies resolveLocationRow to the rows it already
// fetched; PUT and DELETE cannot, because by the time they can count rows they have already written them.
// `sql` is injected so this module stays import-free.
export async function loadLocationRef(sql, ref, householdIds) {
  const rows = await sql`
    SELECT id::text AS id
      FROM locations
     WHERE (slug = ${ref} OR id::text = ${ref})
       AND deleted_at IS NULL
       AND created_by = ANY(${householdIds})
  `;
  return resolveLocationRow(rows, ref);
}
