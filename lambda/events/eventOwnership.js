// BUG-NULLPROJEVENT-001 — who owns an event, when the event may have no project.
//
// THE DEFECT. GET, PUT and DELETE on /api/events/:id all resolved ownership with
// `JOIN public.container pp ON pp.id = el.project_id`. event_log.project_id is NULLABLE, and
// event_log_has_anchor admits plant-anchored rows, so an event with plant_id but no project_id
// matches zero rows in every one of those three reads: 404 on view, 404 on edit, 404 on delete, with
// no in-app recovery. clearFields.js named this "THE INNER-JOIN TRAP" and asserted "0 of 12,580 live
// events have a NULL project_id". Live prod on 2026-08-12 carries TWO (an Aug 11 watering and an
// Aug 12 status_change, both plant-anchored, both created after that comment was written), and the
// count is growing. A guarantee that holds only until it doesn't is not a guarantee.
//
// THE RULE, stated once, here, because four SQL statements have to agree on it:
//   * project-anchored (project_id IS NOT NULL) — owner is the CONTAINER's created_by. The container
//     must exist and not be soft-deleted. This is exactly the pre-existing behavior, unchanged.
//   * project-less (project_id IS NULL) — owner is the PLANTING's created_by. The planting must exist
//     and not be soft-deleted. garden_node.created_by is the household anchor lambda/critter already
//     uses for plant ownership, and it is NOT NULL on all 276 live plantings; container_id is not
//     usable as the fallback because 3 of those 276 have a NULL container_id — including both plants
//     the two orphan events are attached to.
//   * anything else — not owned.
// The plant arm applies ONLY when project_id IS NULL, so no project-anchored event changes hands.
// This widens REACHABILITY, not authority: the newly-reachable set is exactly the rows that were
// previously reachable by nobody at all.
//
// TWO INDEPENDENT GATES, ON PURPOSE. The SQL in index.js enforces this rule in its WHERE clause AND
// each route re-checks with assertEventOwned() on the row it read back. Either alone would be a
// single point of failure in a different direction: a widened SQL predicate cannot leak, because JS
// re-checks; a bug in this file cannot leak either, because it can only turn an allowed row into a
// 404. It is the JS half that is unit-executable — SQL semantics cannot be executed without a
// Postgres, so the SQL half is proven by running it read-only against live prod (see the commit).

// Which user id owns this event row? Null when ownership cannot be established.
// Expects the columns the by-id reads select: project_id, project_owner_id, plant_owner_id.
export function eventOwnerId(row) {
  if (!row) return null
  // Deliberately keyed on project_id, NOT on "did the container join produce a row". A project-
  // anchored event whose container is missing or soft-deleted must stay UNOWNED — it must never
  // fall through to the plant arm and become editable by the plant's owner.
  if (row.project_id != null) return row.project_owner_id ?? null
  return row.plant_owner_id ?? null
}

export function isEventOwned(row, householdIds) {
  const owner = eventOwnerId(row)
  if (owner == null) return false
  if (!Array.isArray(householdIds) || householdIds.length === 0) return false
  // V4-AUTHZRESIDUE-001: householdScope('') returns [''] and '' = ANY(ARRAY['']) is TRUE in
  // Postgres, so an empty subject would be a live ownership value rather than a no-match. Mirrored
  // here so the JS gate cannot be the looser of the two.
  if (owner === '') return false
  return householdIds.includes(owner)
}
