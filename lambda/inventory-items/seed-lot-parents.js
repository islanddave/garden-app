// V5-SEEDMULTIPARENT-001 (release 1) — a saved-seed lot's PARENT PLANTINGS, for lambda/inventory-items.
//
// A lot can record several plantings its seed was gathered from: one live role = 'seed_parent' row of
// public.seed_lot_parent_planting per planting. inventory_items.source_plant_id stays beside the table
// as a MEMBER CACHE — NULL exactly when the lot has no live seed_parent row, otherwise the plant_id of
// one of them. It is kept, not retired, because the two CHECKs anchored on it
// (chk_inventory_seed_source_plant, chk_inventory_source_plant_seeds_only) cannot be restated on a
// link table, and every reader not yet moved to the set still shows a true parent rather than none.
//
// Everything the routes share lives here so there is ONE of each: the id-array rule, the ownership
// gate, the read, and the set-replace write. index.js keeps the routing, the status codes and the two
// single-id gates that predate this (search sourcePlantMatch there).
//
// ROLE. The column has no default, so every INSERT here names 'seed_parent', and every read and count
// filters on it. 'pollen_parent' is in the table's CHECK for deliberate crosses later; nothing in
// release 1 writes or reads it, and a row carrying it must never count as a parent here.
//
// A LINK ROW FOLLOWS ITS LOT. Soft-deleting a lot does not soft-delete its link rows, so every
// statement below reaches them through a LIVE lot (i.deleted_at IS NULL), and scopes through the
// LOT's owner — never through the link row's own created_by, which only records who added it.
//
// DEPENDENCY-FREE ON PURPOSE, like source-kinds.js and delete-guard.js: the driver is handed in, so
// the blocking unit suite can import this file and execute it. Do not add imports.

// Same regex as index.js and household.js; declared again because this module imports nothing.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The Function URL is callable directly, so the array needs a bound. Twelve is far past any real jar
// (the founding case is two plantings) and keeps the ownership query and the unnest trivially small.
export const MAX_SOURCE_PLANTS = 12;

// What the legacy single-parent route answers on a lot that already has two or more. Worded for the
// person: the caller is by construction a client that cannot see the set (an old bundle), and it
// renders this string as is.
export const MULTI_PARENT_ERROR = 'This seed came from more than one plant. Reload the app to change which.';

// `source_plant_ids` from a request body -> { ids } (deduped, lower-cased, in body order) or { error }.
//
// REFUSED, never repaired: a non-array, or one element that is not a uuid, is a 400 for the whole
// body. Dropping the bad element would write a smaller set than the caller named and answer 200.
// A non-uuid must not reach Postgres either — 22P02 is unmapped and falls through as an opaque 500.
//
// Lower-cased before deduping because Postgres reads a uuid case-insensitively: 'AB..' and 'ab..' are
// one planting, and the ownership gate below compares what came back against what was asked for.
// The cap is applied AFTER deduping, so the same id sent thirteen times is a set of one.
export function normalizeSourcePlantIds(value) {
  if (!Array.isArray(value)) return { error: 'source_plant_ids must be an array of planting ids' };
  const ids = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
      return { error: 'source_plant_ids must contain only planting ids' };
    }
    const id = raw.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
    if (ids.length > MAX_SOURCE_PLANTS) {
      return { error: `source_plant_ids can name at most ${MAX_SOURCE_PLANTS} plantings` };
    }
  }
  return { ids };
}

// AUTHZ (BUG-AUTHZFKENUM-001 class) — may this household use EVERY one of these plantings?
//
// ONE query, and the answer is a COUNT, not a presence. The single-id gates in index.js test
// `!owned.length`; generalised to `= ANY(ids)` that test passes when ONE of N ids is owned, and the
// other N-1 — another household's plantings — are then written as link rows and read back by name on
// every surface that lists a lot's parents. So: the number of asked-for ids that came back owned must
// equal the number asked for. `ids` is the output of normalizeSourcePlantIds (deduped, lower-cased),
// which is what makes that count mean "all of them".
//
// The predicate is the single-id gates' own, unchanged: the garden_node VIEW (the base table would
// add nothing and the view is this directory's contracted planting relation), the OWN-created_by arm
// only, no archived filter (a finished, archived plant is the likeliest seed parent there is), and
// soft-deleted plantings refused.
//
// An empty set owns nothing and asks nothing: clearing needs no planting, and costs no round trip.
export async function ownsEveryPlanting(sql, ids, householdIds) {
  if (!ids.length) return true;
  if (!ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) return false;
  const rows = await sql`
    SELECT p.id
      FROM public.garden_node p
     WHERE p.id = ANY(${ids}::uuid[])
       AND p.created_by = ANY(${householdIds})
       AND p.deleted_at IS NULL
  `;
  const owned = rows.map((r) => String(r.id).toLowerCase());
  return ids.filter((id) => owned.includes(id)).length === ids.length;
}

// THE READ — one row per live lot that has at least one live seed_parent link, carrying
// source_plants: [{ id, name, variety_id, variety_name, breeding_system, archived, deleted }].
//
// ONE AGGREGATE PER LOT, in a LATERAL, never a join against the lot list: a join would return a lot
// once per parent and every count on the page that reads this list would be wrong by that factor.
// Lots with no parent return no row at all (the aggregate over nothing is NULL and is filtered), so
// the caller reads "absent" as [] and the list read stays as small as the number of saved lots.
//
// ONE ELEMENT PER LIVE LINK ROW, whatever state the planting is in. The planting is LEFT JOINed and
// carries NO archived or deleted predicate: an archived parent is still the parent
// (BUG-SAVEDSEEDPROVENANCEARCHIVE-001), and a soft-deleted one is reported with deleted: true rather
// than silently dropped from the record. `id` is the link row's own plant_id for the same reason.
//
// garden_node has NO name and NO variety_id column — they are display_name and cultivar_id, aliased
// here. Naming p.name is BUG-SEEDDETAIL500-001 verbatim. The cultivar alias is pv, as everywhere else
// in this directory; garden-node-columns.test.js and cultivar-columns.test.js sweep this statement.
//
// lotId null = every lot of the household (the list); a uuid = that one lot (detail, read-backs).
// Not awaited here: the caller awaits it, settles it, or places it in a sql.transaction([...]).
export function readSourcePlants(sql, householdIds, lotId = null) {
  return sql`
    SELECT i.id AS inventory_item_id, sp.source_plants
      FROM public.inventory_items i
     CROSS JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object(
                     'id', l.plant_id,
                     'name', p.display_name,
                     'variety_id', p.cultivar_id,
                     'variety_name', pv.display_name,
                     'breeding_system', pv.breeding_system,
                     'archived', (p.archived_at IS NOT NULL),
                     'deleted', (p.deleted_at IS NOT NULL)
                   ) ORDER BY p.display_name, l.plant_id) AS source_plants
              FROM public.seed_lot_parent_planting l
              LEFT JOIN public.garden_node p ON p.id = l.plant_id
              LEFT JOIN public.cultivar pv ON pv.id = p.cultivar_id
             WHERE l.inventory_item_id = i.id
               AND l.role = 'seed_parent'
               AND l.deleted_at IS NULL
          ) sp
     WHERE i.created_by = ANY(${householdIds})
       AND i.deleted_at IS NULL
       AND (${lotId}::uuid IS NULL OR i.id = ${lotId}::uuid)
       AND sp.source_plants IS NOT NULL
  `;
}

// The one lot's array out of a single-lot read: [] when the lot has no parents (no row came back).
export function sourcePlantsOf(rows) {
  const found = rows?.[0]?.source_plants;
  return Array.isArray(found) ? found : [];
}

// The list read's rows as lotId -> array, for merging into the list by id.
export function sourcePlantsByLot(rows) {
  return new Map((rows ?? [])
    .filter((r) => Array.isArray(r.source_plants))
    .map((r) => [String(r.inventory_item_id), r.source_plants]));
}

// SETTLED, NOT ALL-OR-NOTHING (the sown_from precedent in index.js; BUG-SEEDDETAIL500-001 class).
// On a GET, and on the wide PUT's echo, the parents are a detail of the response and not the reason
// for it: a failed parents read answers null — "unknown", which is not [] — and says so in CloudWatch
// by tag and error class, instead of 500ing the packet page or the whole seed list. Never rejects, so
// it can sit beside the main read in a Promise.all. `scope` names what was being read ({ item } or
// { list }), for the log line.
export async function settleSourcePlants(read, scope) {
  try {
    return await read;
  } catch (err) {
    console.error(JSON.stringify({
      tag: 'inv-source-plants-failed', ...scope,
      error: err?.name ?? err?.constructor?.name ?? typeof err, code: err?.code ?? null,
      message: err?.message ?? String(err),
    }));
    return null;
  }
}

// Link rows for the plantings in `ids` that the lot does not already have live.
//
// The lot predicate is IN the statement (the house rule for every write here — see /seed-stage's
// CTE): on a foreign, missing, deleted or non-seeds lot the SELECT yields nothing and nothing is
// written. `created_by` is the CALLER, the person who added the planting, not the lot's owner.
//
// NOT EXISTS rather than ON CONFLICT DO NOTHING: both skip a planting that is already a live parent,
// but a row that appears between this statement's snapshot and its insert (a planting merge
// repointing onto the same lot) must surface as 23505 for the route to answer 409, not be swallowed.
//
// `legacy` and the source_kind conjunct are the set-replace guards, explained on replaceSourcePlants.
// The POST path passes legacy = false on a lot the same transaction just created.
export function insertSeedParentLinks(sql, { lotId, ids, householdIds, userId, legacy = false }) {
  return sql`
    INSERT INTO public.seed_lot_parent_planting (inventory_item_id, plant_id, role, created_by)
    SELECT i.id, u.plant_id, 'seed_parent', ${userId}::text
      FROM public.inventory_items i
     CROSS JOIN unnest(${ids}::uuid[]) AS u(plant_id)
     WHERE i.id = ${lotId}
       AND i.created_by = ANY(${householdIds})
       AND i.deleted_at IS NULL
       AND i.category = 'seeds'
       AND (i.source_kind IS NULL OR i.source_kind = 'own_garden' OR cardinality(${ids}::uuid[]) = 0)
       AND (NOT ${legacy}::boolean OR (
              SELECT count(*) FROM public.seed_lot_parent_planting n
               WHERE n.inventory_item_id = i.id
                 AND n.role = 'seed_parent'
                 AND n.deleted_at IS NULL) <= 1)
       AND NOT EXISTS (
             SELECT 1 FROM public.seed_lot_parent_planting x
              WHERE x.inventory_item_id = i.id
                AND x.plant_id = u.plant_id
                AND x.role = 'seed_parent'
                AND x.deleted_at IS NULL)
  `;
}

// THE WRITE — make the lot's live seed_parent set exactly `ids`, and keep the member cache true, in
// ONE sql.transaction([...]) (the lambda/plants/merge.js idiom: the HTTP driver auto-commits a bare
// statement, so anything not in the array is a separate transaction).
//
// Returns { outcome } and never a status code — index.js owns the HTTP:
//   'ok'           -> { id, source_plant_id, source_plants }
//   'not_found'    -> the lot is absent, foreign, deleted or not seeds. Nothing written.
//   'multi_parent' -> legacy only: the lot has two or more parents. Nothing written. { source_plant_ids }
//   'source_kind'  -> the lot says it came from a shop / gift / farm stand, and `ids` is not empty.
//   'conflict'     -> 23505 from a concurrent writer; the transaction rolled back.
//
// THE SIX STATEMENTS, in order, and why each is where it is:
//   0 lock    SELECT .. FOR UPDATE on the lot. Two requests on one lot now run one after the other,
//             and a concurrent /source-kind write waits too.
//   1 facts   the lot's source_kind and its live-parent count, read by a statement that STARTS after
//             the lock is held. Not folded into statement 0 on purpose: a subquery in the locking
//             statement is evaluated on that statement's snapshot, taken BEFORE it waited, so it
//             would report the count as it stood before the other request committed.
//   2 retire  soft-delete the live rows not in `ids` (deleted_at and updated_at; no trigger does it).
//   3 add     insertSeedParentLinks — the ones the lot does not have.
//   4 cache   source_plant_id: kept if it is still a member, else the earliest live row
//             (created_at, then id), else NULL. RETURNING is how a completed write is recognised.
//   5 read    readSourcePlants, inside the transaction, so the answer is the set this write left.
//
// EVERY WRITE CARRIES THE LOT PREDICATE AND BOTH GUARDS IN ITS OWN WHERE. The driver's transaction
// is not interactive — no statement can see another's result and nothing in JS can stop the batch
// part-way — so a refusal cannot be an earlier read followed by a decision. Each of 2, 3 and 4
// re-tests the same conditions on its own snapshot, under the lock, and writes nothing when one
// fails; statement 1 only tells JS, afterwards, WHICH one it was.
//   • source_kind: a non-own_garden kind refuses a non-empty set (the mutual-exclusion rule the
//     /source-kind route and chk_inventory_seed_source_plant enforce from the other side). An EMPTY
//     set is always allowed — clearing is how a lot gets out of that state.
//   • legacy (PATCH /:id/source-plant): the write goes through only while the lot has at most one
//     live parent. The count is re-read by each statement, and stays <= 1 across 2 and 3 exactly
//     when it started <= 1, because a legacy set is one id or none.
export async function replaceSourcePlants(sql, { lotId, ids, householdIds, userId, legacy = false }) {
  let results;
  try {
    results = await sql.transaction([
      sql`
        SELECT i.id
          FROM public.inventory_items i
         WHERE i.id = ${lotId}
           AND i.created_by = ANY(${householdIds})
           AND i.deleted_at IS NULL
           AND i.category = 'seeds'
           FOR UPDATE
      `,
      sql`
        SELECT i.id, i.source_kind,
               (SELECT count(*) FROM public.seed_lot_parent_planting n
                 WHERE n.inventory_item_id = i.id
                   AND n.role = 'seed_parent'
                   AND n.deleted_at IS NULL)::int AS live_parents
          FROM public.inventory_items i
         WHERE i.id = ${lotId}
           AND i.created_by = ANY(${householdIds})
           AND i.deleted_at IS NULL
           AND i.category = 'seeds'
      `,
      sql`
        UPDATE public.seed_lot_parent_planting l
           SET deleted_at = now(),
               updated_at = now()
          FROM public.inventory_items i
         WHERE i.id = ${lotId}
           AND i.created_by = ANY(${householdIds})
           AND i.deleted_at IS NULL
           AND i.category = 'seeds'
           AND (i.source_kind IS NULL OR i.source_kind = 'own_garden' OR cardinality(${ids}::uuid[]) = 0)
           AND (NOT ${legacy}::boolean OR (
                  SELECT count(*) FROM public.seed_lot_parent_planting n
                   WHERE n.inventory_item_id = i.id
                     AND n.role = 'seed_parent'
                     AND n.deleted_at IS NULL) <= 1)
           AND l.inventory_item_id = i.id
           AND l.role = 'seed_parent'
           AND l.deleted_at IS NULL
           AND NOT (l.plant_id = ANY(${ids}::uuid[]))
      `,
      insertSeedParentLinks(sql, { lotId, ids, householdIds, userId, legacy }),
      sql`
        UPDATE public.inventory_items i
           SET source_plant_id = CASE
                 WHEN EXISTS (
                        SELECT 1 FROM public.seed_lot_parent_planting m
                         WHERE m.inventory_item_id = i.id
                           AND m.plant_id = i.source_plant_id
                           AND m.role = 'seed_parent'
                           AND m.deleted_at IS NULL)
                   THEN i.source_plant_id
                 ELSE (SELECT e.plant_id FROM public.seed_lot_parent_planting e
                        WHERE e.inventory_item_id = i.id
                          AND e.role = 'seed_parent'
                          AND e.deleted_at IS NULL
                        ORDER BY e.created_at, e.id
                        LIMIT 1)
               END,
               updated_at = NOW()
         WHERE i.id = ${lotId}
           AND i.created_by = ANY(${householdIds})
           AND i.deleted_at IS NULL
           AND i.category = 'seeds'
           AND (i.source_kind IS NULL OR i.source_kind = 'own_garden' OR cardinality(${ids}::uuid[]) = 0)
           AND (NOT ${legacy}::boolean OR (
                  SELECT count(*) FROM public.seed_lot_parent_planting n
                   WHERE n.inventory_item_id = i.id
                     AND n.role = 'seed_parent'
                     AND n.deleted_at IS NULL) <= 1)
        RETURNING i.id, i.source_plant_id
      `,
      readSourcePlants(sql, householdIds, lotId),
    ]);
  } catch (err) {
    // uq_slpp_item_plant_role_live. The lock rules out two of these requests colliding on one lot, so
    // this is a writer that does not take it — a planting merge repointing a link onto the same lot.
    // The whole transaction rolled back; the caller reloads and tries again.
    if (err?.code === '23505') return { outcome: 'conflict' };
    throw err;
  }

  const [, factRows, , , cacheRows, parentRows] = results;
  const fact = factRows?.[0];
  if (!fact) return { outcome: 'not_found' };
  const source_plants = sourcePlantsOf(parentRows);

  // The lot exists and is the caller's, and statement 4 changed nothing: a guard refused inside the
  // write statements. Nothing was written, so `source_plants` is the set as it stood.
  if (!cacheRows?.length) {
    const shopKind = fact.source_kind != null && fact.source_kind !== 'own_garden';
    if (shopKind && ids.length) return { outcome: 'source_kind' };
    if (legacy && Number(fact.live_parents) >= 2) {
      return { outcome: 'multi_parent', source_plant_ids: source_plants.map((p) => p.id) };
    }
    // Neither guard explains it: the lot moved under a writer that does not take the lock.
    return { outcome: 'conflict' };
  }
  return { outcome: 'ok', id: cacheRows[0].id, source_plant_id: cacheRows[0].source_plant_id ?? null, source_plants };
}
