// BUG-LOCDELSLUG-001 — resolving the `:id` path segment of /api/locations/:id to EXACTLY ONE row.
//
// THE DEFECT. The route matcher is /^\/api\/locations\/([^/]+)$/ and all three verbs resolve the
// captured segment as `(slug = $1 OR id::text = $1)`. That predicate is not single-valued, because
// `locations.slug` has NO global unique index. Measured against live Neon 2026-08-14 — two PARTIAL
// uniques and nothing else:
//   idx_locations_root_slug   UNIQUE (slug)             WHERE parent_id IS NULL
//   idx_locations_child_slug  UNIQUE (parent_id, slug)  WHERE parent_id IS NOT NULL
// So the same child slug under two different parents is not merely possible, it is EXPLICITLY
// LEGAL — 'bed-1' under Stable and 'bed-1' under House satisfy both indexes — as is a root slug
// that equals some child's slug. Neither index carries `deleted_at IS NULL`, so the soft-delete
// filter in the handler neither creates nor removes ambiguity; only the cross-parent case does.
//
// WHY IT MATTERS MOST ON DELETE. The DELETE arm is `UPDATE locations SET deleted_at = NOW() WHERE
// (slug = $1 OR id::text = $1) ... RETURNING id`, gated on `!rows.length`. Ambiguity therefore
// soft-deletes EVERY match and still answers 200 {ok:true} — the 404 gate cannot see the
// difference between one row and five. The PUT is not "differently safe": it carries the
// byte-identical predicate on an UPDATE that writes name/type_label/sort_order/description/
// is_active/featured_photo_id and returns rows[0], so it silently overwrites N locations with one
// body and reports the edit of whichever row Postgres happened to return first. The GET is the
// mild one — an arbitrary rows[0] read — but arbitrary in a DIFFERENT direction than the PUT's
// rows[0], which is the silent-divergence shape this file's own hero comment warns about.
//
// LATENT, NOT LIVE, and measured rather than assumed (prod, 2026-08-14): 21 live locations, 6 of
// them roots, ZERO duplicate slugs. No caller sends a slug either — src/pages/Locations.jsx:132
// passes loc.id. Reachable, though, and not only by collision-by-accident: POST accepts
// `body.slug` verbatim (index.js ~:390), so a client can create a colliding child slug directly.
//
// THE RULE. An id match is UNAMBIGUOUS by construction (id is the primary key), so it always wins
// — including over any slug that happens to equal it. Otherwise: one slug match resolves, several
// resolve to nothing and the caller gets a typed 409. 409 rather than "pick one" is the whole
// point; a genuinely ambiguous reference has no correct answer, and answering it arbitrarily is
// what makes the multi-row DELETE possible in the first place. 404 is reserved for "no such
// location you can see" and must not absorb the ambiguous case — they are different facts and the
// existence-leak argument for collapsing not-found/not-owned/already-deleted does not apply here
// (the caller already proved it can see at least two).
//
// Extracted to its own module with ZERO imports so it can be tested BEHAVIOURALLY. The handler
// itself cannot be imported in CI (per-dir node_modules do not exist there), which is why every
// sibling guard in this directory reads index.js as text; this rule is arithmetic on rows and
// deserves better than a source-text assertion.

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
  // Deliberately re-checked here rather than trusted from the caller's ORDER BY: the id arm is the
  // only tiebreak that is correct BY CONSTRUCTION, and an ORDER BY is a property of one call site
  // while this is the rule for all three verbs.
  const exact = list.find((r) => String(r?.id) === String(ref));
  return exact ? { row: exact } : { ambiguous: true };
}

// Pre-flight resolution for the MUTATING verbs. GET can apply resolveLocationRow to the rows it
// already fetched (no extra round trip); PUT and DELETE cannot, because by the time they can count
// rows they have already written them. `sql` is the neon tagged template, injected so this module
// stays import-free.
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
