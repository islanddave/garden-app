// authz-parents.js — body-supplied PARENT-id ownership loaders (BUG-PARENTOWN-001).
//
// A DB foreign key proves the referenced row EXISTS; it never proves the caller OWNS it. Any write path
// that takes a parent id straight from the request body must prove household ownership BEFORE the insert,
// or an authenticated non-member can hang their row off another household's container/planting/event,
// which writes a cross-household FK and, through any read surface that JOINs the parent, becomes a
// cross-household READ.
//
// WHY THIS FILE EXISTS ALONGSIDE household.js (read this before adding a third home).
// household.js is the canonical home for ownership loaders; these belong there too. They are HERE only
// because household.js is held byte-identical across many Lambda dirs by lambda/household-copies-sync.test.js,
// so it could not be extended from a change scoped to lambda/photos + lambda/plants. FOLLOW-UP (in the
// consolidating sweep that also fixes events POST): move these into household.js, delete this file and its
// copies, and drop lambda/authz-parents-copies-sync.test.js.
//
// DEPLOY NOTE (same as household.js): a Lambda zip holds only its own dir, so a `../authz-parents.js`
// import 502s at module load. An IDENTICAL copy lives in each consuming Lambda dir, imported as
// `./authz-parents.js`, held byte-identical by lambda/authz-parents-copies-sync.test.js.
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
// Owner columns:
//   plant_projects.created_by · event_log.created_by (+ its container's) · plants.created_by (+ its
//   container's). `container` and `garden_node` are VIEWS over `plant_projects` and `plants`; these
//   predicates address the BASE TABLES, which is also where the CHECK constraints live.

// A malformed id must answer the SAME generic null these loaders give a foreign id, not a 22P02 that
// falls through the handler's catch to an opaque 500 (a weak side channel: 500 = "syntactically invalid",
// 400 = "valid uuid, but not yours"). Identical to the constant in household.js.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Verify a container/project id (plants.project_id, photos.project_id, event_log.project_id).
// Byte-for-byte the predicate shipped as lambda/tags/index.js entityExists('project').
// Soft-deleted containers are rejected: attaching a NEW row to a deleted container is not a
// legitimate flow, and photos and findings reject them too.
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

// Pick the container a NEW planting belongs in when the caller supplied none. Derives server-side, as
// deriveEventProjectId does for events: a client cannot be relied on to send the project (CaptureFlow
// posts `project_id: null` on every create).
//
// MATCHED ON CROP TYPE, NOT "the household's first container", and that distinction is the whole
// design. The container's NAME IS THE PUBLISHED CROP (gam-site's crop_label_sql reads plant_projects.name
// onto a public page), so an arbitrary container publishes a tomato to the world as a pepper. A wrong
// container is worse than none.
//
// DELIBERATELY FIND-ONLY; it never creates a container. A planting with no crop-type container to match
// stays NULL, a supported state with its own authorization arm (the `project_id IS NULL` conjunct below).
// Minting a container from a write path would publish a name chosen by a guess.
//
// THE `other = 0` GUARD IS WHAT MAKES THE MATCH SAFE. A candidate must hold plantings of the target
// crop and NOTHING ELSE. A mixed container (a bed, a grouping) can hold tomatoes without being "the
// tomato container", so matching on presence alone would file into it.
//
// Returns null on ANY uncertainty — unknown cultivar, cultivar with no crop type, no pure container.
// Null is the status quo, so the failure mode is "behaves as it did before".
//
// No ownership gate is needed on its output: the predicate is household-scoped
// (`pp.created_by = ANY(householdIds)`), so it can only return a container the caller already owns.
export async function resolveContainerForCultivar(sql, cultivarId, householdIds) {
  if (!UUID_RE.test(String(cultivarId))) return null;
  const rows = await sql`
    WITH target AS (
      SELECT crop_type_slug AS slug FROM public.plant_varieties WHERE id = ${cultivarId}
    ),
    candidate AS (
      SELECT pp.id,
             count(*) FILTER (WHERE pv.crop_type_slug = (SELECT slug FROM target)) AS same,
             count(*) FILTER (WHERE pv.crop_type_slug IS DISTINCT FROM (SELECT slug FROM target)) AS other
      FROM public.plant_projects pp
      JOIN public.plants pl ON pl.project_id = pp.id AND pl.deleted_at IS NULL
      JOIN public.plant_varieties pv ON pv.id = pl.variety_id
      WHERE pp.deleted_at IS NULL
        AND pp.archived_at IS NULL
        AND pp.created_by = ANY(${householdIds})
      GROUP BY pp.id
    )
    SELECT id FROM candidate
    WHERE same > 0 AND other = 0
    ORDER BY same DESC, id
    LIMIT 1
  `;
  return rows.length ? rows[0].id : null;
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
// conjunct and is therefore strictly looser. This is the canonical form; the looser one should be
// reconciled to it in the consolidating sweep (lambda/preservation is its remaining consumer).
// `project_id` is returned (BUG-EVENTPROJPLANTPAIR-001) because the planting owns the project on every
// row that has one: event_log's writers derive their project_id from it rather than from the request
// body, without a second round trip. Callers that only need the ownership verdict ignore it.
export async function loadOwnedPlantingRef(sql, plantId, householdIds) {
  if (!UUID_RE.test(String(plantId))) return null;
  const rows = await sql`
    SELECT gn.id, gn.name, gn.project_id
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
// THE FALLBACK ARM CARRIES ITS OWN PLANTING GUARD, and that is not belt-and-braces. event_log has a
// SECOND parent, plant_id, which the two ownership arms never inspect. Without the guard an attacker
// creates a project-less event anchored to the VICTIM's planting, the fallback arm passes on the
// attacker's own created_by, and the attacker attaches a photo with that event_id: the photos gate
// would be bypassable in two requests and would depend on a predicate in a DIFFERENT Lambda.
//
// SCOPED TO THE FALLBACK ARM ONLY. Applying the same guard to the container-owned arm looks tidier and
// is WRONG: events anchored to a SOFT-DELETED planting (deleted after the event) are legitimate, and a
// both-arms guard would reject them and their photos. A predicate that quietly narrows real access is
// worse than the bug.
//
// NO `pp.deleted_at IS NULL` conjunct, deliberately: lambda/events' own PUT/DELETE predicates do not
// carry one, and adding it here only would make an event attachable by its owning Lambda but not by
// photos. Revisit it for ALL event paths at once or not at all.
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
