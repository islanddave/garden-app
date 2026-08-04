// authz-parents.js — body-supplied PARENT-id ownership loaders (BUG-PARENTOWN-001).
//
// THE PATTERN THIS CLOSES (5 known instances: BUG-TAGENTOWN-001, BUG-PHOTOLOCAUTHZ-001, events POST,
// photos POST, plants POST): a DB foreign key proves the referenced row EXISTS; it never proves the
// caller OWNS it. Any write path that takes a parent id straight from the request body must therefore
// prove household ownership BEFORE the insert, or an authenticated non-member can hang their row off
// another household's container/planting/event — which both writes a cross-household FK and, through
// any read surface that JOINs the parent, turns into a cross-household READ.
//
// WHY THIS FILE EXISTS ALONGSIDE household.js (read this before adding a third home).
// household.js is the canonical home for ownership loaders and already carries loadOwnedLocation /
// loadOwnedInventoryItem / loadOwnedSpace / loadOwnedPlanting / warnRejectedFk. These three belong
// there too. They are HERE only because household.js is held byte-identical across SIXTEEN Lambda
// dirs by lambda/household-copies-sync.test.js, so it cannot be extended from a change scoped to
// lambda/photos + lambda/plants without editing fourteen out-of-scope dirs. FOLLOW-UP (do this in the
// consolidating sweep that also fixes events POST): move these three into household.js, delete this
// file and its copies, and drop lambda/authz-parents-copies-sync.test.js.
//
// DEPLOY NOTE (same as household.js): each Lambda is zipped from its OWN directory
// (`cd lambda/<fn> && zip -r ../<fn>.zip .`), so a `../authz-parents.js` import is NOT packaged and
// the handler 502s at module load. An IDENTICAL copy therefore lives in each consuming Lambda dir and
// is imported as `./authz-parents.js`. This file is the canonical source; copies are held
// byte-identical by lambda/authz-parents-copies-sync.test.js.
//
// CONTRACT (identical to household.js's loaders — one pattern, not a dialect per site):
//   • return the row on success, null on ANY failure — absent id, out-of-household, soft-deleted.
//   • NO existence oracle: the caller answers a null with the SAME generic 400 it would give for a
//     malformed id, never "not found" vs "forbidden" — that distinction is itself a leak.
//   • pair every null with warnRejectedFk() from household.js so a misconfigured household is visible
//     in CloudWatch instead of silent.
//   • callers MUST also have rejected an empty JWT subject with a 401 before calling: householdScope('')
//     returns [''] and `'' = ANY(ARRAY[''])` is TRUE in Postgres, so an empty sub is a live ownership
//     value rather than a no-match.
//
// Owner columns were verified against live prod, not assumed:
//   plant_projects.created_by · event_log.created_by (+ its container's) · plants.created_by (+ its
//   container's). `container` and `garden_node` are VIEWS over `plant_projects` and `plants`; these
//   predicates address the BASE TABLES, which is also where the CHECK constraints live.

// A malformed id must answer the SAME generic null these loaders give a foreign id — not a 22P02
// that falls through the handler's catch to an opaque 500 (which is both a worse client contract and
// a weak side-channel: 500 = "syntactically invalid", 400 = "valid uuid, but not yours"). The
// household.js loaders do NOT carry this guard; a malformed location_id / inventory_item_id still
// 500s, which is pre-existing and should be fixed when these merge into household.js.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Verify a container/project id (plants.project_id, photos.project_id, event_log.project_id).
// Byte-for-byte the predicate already shipped as lambda/tags/index.js entityExists('project').
// Soft-deleted containers are rejected: attaching a NEW row to a deleted container is not a
// legitimate flow, and it matches photos/index.js:1045 + findings/index.js:83, which already do.
export async function loadOwnedProject(sql, projectId, householdIds) {
  if (!UUID_RE.test(String(projectId))) return null;
  const rows = await sql`
    SELECT id, name FROM public.plant_projects
    WHERE id = ${projectId}
      AND deleted_at IS NULL
      AND created_by = ANY(${householdIds})
  `;
  return rows.length ? rows[0] : null;
}

// Verify a planting id (photos.plant_id, plants.parent_plant_id, plants.succession_group_id).
// Byte-for-byte the predicate shipped as lambda/tags/index.js entityExists('plant') and as the
// canonical by-id ownership predicate in lambda/plants/index.js (BUG-PLANTLESSWRITE-001).
//
// THE `project_id IS NULL` CONJUNCT IS LOAD-BEARING, NOT DECORATION. Without it, the own-created_by
// arm reaches a planting the caller created INSIDE another household's container. Do not "simplify"
// it away — see the long comment on the PUT predicate in lambda/plants/index.js.
//
// DELIBERATE DIVERGENCE from household.js loadOwnedPlanting(), which is the same query MINUS that
// conjunct (`gn.created_by = ANY(h) OR pp.created_by = ANY(h)`) and is therefore strictly looser.
// This is the stricter, canonical form; the looser one is the outlier and should be reconciled to
// this in the consolidating sweep (lambda/preservation is its remaining consumer).
export async function loadOwnedPlantingRef(sql, plantId, householdIds) {
  if (!UUID_RE.test(String(plantId))) return null;
  const rows = await sql`
    SELECT gn.id, gn.name
    FROM public.plants gn
    LEFT JOIN public.plant_projects pp ON pp.id = gn.project_id
    WHERE gn.id = ${plantId}
      AND gn.deleted_at IS NULL
      AND ( pp.created_by = ANY(${householdIds})
            OR (gn.project_id IS NULL AND gn.created_by = ANY(${householdIds})) )
  `;
  return rows.length ? rows[0] : null;
}

// Verify an event id (photos.event_id). Same two-arm shape as loadOwnedPlantingRef: ownership runs
// through the container when there is one, and falls back to the event's own created_by when there
// is not. The own-created_by arm is exact rather than approximate here — the shipped RLS policy
// events_creator_delete already scopes deletes that way.
//
// THE FALLBACK ARM CARRIES ITS OWN PLANTING GUARD, and that is not belt-and-braces (adversarial
// review, finding 3). event_log has a SECOND parent, plant_id, which the two ownership arms above
// never inspect. Without the guard the chain is: attacker creates a project-less event anchored to
// the VICTIM's planting → the fallback arm passes on the attacker's own created_by → the attacker
// attaches a photo with that event_id and this loader waves it through. That would make the photos
// gate bypassable via a two-request detour, and it would depend on a predicate in a DIFFERENT Lambda
// to be safe. It is now self-contained.
//
// SCOPED TO THE FALLBACK ARM ONLY — measured, not assumed. Applying the same guard to the
// container-owned arm looks tidier and is WRONG: 39 live household events are anchored to a
// SOFT-DELETED planting (their planting was deleted after the event), and one live photo hangs off
// one of them, so a both-arms guard would reject 1 of the 735 event-attached photos and 39 events.
// A predicate that quietly narrows real access is worse than the bug. On the fallback arm the cost
// is 0 by construction: prod has zero live project-less events today (the validator relax in
// lambda/events creates the first ones).
//
// NO `pp.deleted_at IS NULL` conjunct, deliberately: lambda/events' own PUT/DELETE predicates do not
// carry one, and adding it here only would make an event attachable by its owning Lambda but not by
// photos. Measured cost of adding it against live prod was zero (735 = 735), so this is a
// consistency choice, not a data-driven one — revisit it for ALL event paths at once or not at all.
export async function loadOwnedEvent(sql, eventId, householdIds) {
  if (!UUID_RE.test(String(eventId))) return null;
  const rows = await sql`
    SELECT el.id
    FROM public.event_log el
    LEFT JOIN public.plant_projects pp ON pp.id = el.project_id
    WHERE el.id = ${eventId}
      AND el.deleted_at IS NULL
      AND ( pp.created_by = ANY(${householdIds})
            OR ( el.project_id IS NULL
                 AND el.created_by = ANY(${householdIds})
                 AND ( el.plant_id IS NULL
                       OR EXISTS ( SELECT 1 FROM public.plants gn2
                                   LEFT JOIN public.plant_projects pp2 ON pp2.id = gn2.project_id
                                   WHERE gn2.id = el.plant_id
                                     AND gn2.deleted_at IS NULL
                                     AND ( pp2.created_by = ANY(${householdIds})
                                           OR (gn2.project_id IS NULL AND gn2.created_by = ANY(${householdIds})) ) ) ) ) )
  `;
  return rows.length ? rows[0] : null;
}
