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
// ONE query for every id, and the answer is a COUNT, not a presence. The single-id gates in index.js test
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
//
// THE SECOND ARM (contract amendment, Follow-up 1) — `lotId`, on the set route only. An id is also
// acceptable when it is ALREADY a live seed_parent of THIS lot. Without it a lot that keeps a parent
// whose planting was later soft-deleted could never be edited again: re-sending the unchanged id
// would fail the first arm, so the only edit the route would accept is one that drops that parent.
// It admits nothing new — a member was gated when it was added — and it is scoped through the lot
// the household owns, so a foreign lot's members prove nothing. POST passes no lotId: a lot that
// does not exist yet has no members.
//
// A SECOND STATEMENT, AND ONLY WHEN THE FIRST LEFT SOMETHING OVER. The common request — every
// planting owned and live — is still the one garden_node read it always was and never touches the
// link table before the transaction. Only ids the first arm did not admit are asked about again.
//
// THIS IS THE FAST PATH, NOT THE GUARANTEE. It runs before any lock is taken, so what it reads can
// be stale by the time the write runs: a request that then waits for its lot behind a planting
// merge would act on a pre-merge answer (T1 defect D-2). The same two-arm rule is therefore
// re-tested INSIDE the transaction, under the lot lock, by every write statement — see
// replaceSourcePlants. This check exists to answer the ordinary bad request with a 400 and a
// warnRejectedFk before anything is locked.
export async function ownsEveryPlanting(sql, ids, householdIds, lotId = null) {
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
  const rest = ids.filter((id) => !owned.includes(id));
  if (!rest.length) return true;
  // No lot (POST), or a lot id that is not one: nothing can be a member of it. A malformed id is
  // never sent to Postgres — the route answers it 404 after this gate.
  if (lotId == null || !UUID_RE.test(String(lotId))) return false;
  const kept = await sql`
    SELECT k.plant_id AS id
      FROM public.seed_lot_parent_planting k
      JOIN public.inventory_items i ON i.id = k.inventory_item_id
     WHERE i.id = ${lotId}
       AND i.created_by = ANY(${householdIds})
       AND i.deleted_at IS NULL
       AND i.category = 'seeds'
       AND k.plant_id = ANY(${rest}::uuid[])
       AND k.role = 'seed_parent'
       AND k.deleted_at IS NULL
  `;
  const members = kept.map((r) => String(r.id).toLowerCase());
  return rest.filter((id) => members.includes(id)).length === rest.length;
}

// Row locks on the plantings a parents write names — FOR SHARE, taken INSIDE the transaction, after
// the lot lock (set route) and before any statement decides anything about them.
//
// WHY THE WRITE NEEDS IT. Each write statement re-tests "may this lot use every one of these
// plantings" on its own snapshot. The lot lock keeps a lot's link rows still, but whether a planting
// is live is a fact about public.plants, which the lot lock does not cover. Unlocked, a planting
// soft-deleted between two statements of one batch would pass the test in the first and fail it in
// the next: links retired, their replacements never inserted, the cache left pointing at a retired
// row — a half-applied edit behind a 409. With the rows share-locked their state cannot change until
// this transaction ends, so all three writes reach the same verdict.
//
// It is also what lets a parents write and a planting merge queue instead of crossing: a merge that
// has already soft-deleted a planting (uncommitted) makes this statement WAIT, and the statements
// after it then read the merged state.
//
// FOR SHARE, not FOR KEY SHARE: a soft-delete is an UPDATE of a non-key column, which FOR KEY SHARE
// does not hold off. Through the garden_node view on purpose — a locking clause on a view locks the
// rows of the table under it, and the view is this directory's contracted planting relation.
// No household predicate: every row the request names is frozen, whichever arm it will be judged by.
// ORDER BY id so two writes naming the same plantings take them in one order.
export function lockPlantings(sql, ids) {
  return sql`
    SELECT p.id
      FROM public.garden_node p
     WHERE p.id = ANY(${ids}::uuid[])
     ORDER BY p.id
       FOR SHARE
  `;
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
// `legacy`, the source_kind conjunct and the every-planting-usable count are the set-replace guards,
// explained on replaceSourcePlants. The POST path passes legacy = false on a lot the same
// transaction just created — where the usable count's second arm ("already a member of this lot")
// cannot hold for anything, so on a create it is the ownership rule alone.
//
// ALL OR NONE. The usable count is over the WHOLE array, so one planting that is no longer the
// caller's to use inserts no link at all — never the other N-1. On the set route that is "nothing
// written"; on a create it leaves a lot with no links, which assertEveryParentLinked then refuses.
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
       AND (SELECT count(*)
              FROM unnest(${ids}::uuid[]) AS q(plant_id)
             WHERE EXISTS (
                     SELECT 1 FROM public.garden_node p
                      WHERE p.id = q.plant_id
                        AND p.created_by = ANY(${householdIds})
                        AND p.deleted_at IS NULL)
                OR EXISTS (
                     SELECT 1 FROM public.seed_lot_parent_planting k
                      WHERE k.inventory_item_id = i.id
                        AND k.plant_id = q.plant_id
                        AND k.role = 'seed_parent'
                        AND k.deleted_at IS NULL)) = cardinality(${ids}::uuid[])
       AND NOT EXISTS (
             SELECT 1 FROM public.seed_lot_parent_planting x
              WHERE x.inventory_item_id = i.id
                AND x.plant_id = u.plant_id
                AND x.role = 'seed_parent'
                AND x.deleted_at IS NULL)
  `;
}

// POST only — the create's last word before its read-back: every planting in `ids` has a live link
// on the new lot, or the WHOLE transaction fails.
//
// WHY A STATEMENT THAT RAISES. On the set route a refused write is "nothing changed, answer from the
// read-back". A create cannot do that: its lot INSERT has already run by the time the link INSERT
// declines (a planting soft-deleted, or merged away, in the instant since the pre-transaction gate
// passed), and the batch would commit a lot whose column names a parent and which has no link rows —
// the cache rule broken at birth. The driver's transaction is a fixed list, so JS cannot stop it
// part-way; the only way to undo the lot is for a later statement to fail. An error in any statement
// of the batch rolls back all of it (the lane's integration suite proves that for this very
// transaction with a 23503).
//
// The divisor is 1 when the live links number what was asked for and 0 otherwise: division_by_zero,
// SQLSTATE 22012, which nothing else in this transaction can raise and which the POST arm answers
// 409. Not a constant expression — the count is a subquery — so the planner cannot fold it and
// raise at plan time.
export function assertEveryParentLinked(sql, { lotId, ids, householdIds }) {
  return sql`
    SELECT 1 / (CASE WHEN (
             SELECT count(*)
               FROM public.seed_lot_parent_planting l
               JOIN public.inventory_items i ON i.id = l.inventory_item_id
              WHERE i.id = ${lotId}
                AND i.created_by = ANY(${householdIds})
                AND i.deleted_at IS NULL
                AND l.role = 'seed_parent'
                AND l.deleted_at IS NULL) = cardinality(${ids}::uuid[])
           THEN 1 ELSE 0 END) AS every_parent_linked
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
//   'plants_changed' -> a planting in `ids` stopped being usable between the route's gate and this
//                     write (soft-deleted, or merged into another). Nothing written.
//   'conflict'     -> 23505 or 40P01 from a concurrent writer; the transaction rolled back.
//
// THE SEVEN STATEMENTS, in order, and why each is where it is:
//   0 lock    SELECT .. FOR UPDATE on the lot. Two requests on one lot now run one after the other,
//             and a concurrent /source-kind write waits too. FIRST, before anything touches a link
//             row: the migration's reconcile and the planting merge take their lots first as well,
//             and a writer that took a link row before its lot deadlocked against them.
//   1 hold    lockPlantings — FOR SHARE on the plantings named, so whether each is live cannot
//             change under the statements below. After the lot, never before it.
//   2 facts   the lot's source_kind, its live-parent count and whether every planting is usable,
//             read by a statement that STARTS after both locks are held. Not folded into statement 0
//             on purpose: a subquery in the locking statement is evaluated on that statement's
//             snapshot, taken BEFORE it waited, so it would report things as they stood before the
//             other request committed.
//   3 retire  soft-delete the live rows not in `ids` (deleted_at and updated_at; no trigger does it).
//   4 add     insertSeedParentLinks — the ones the lot does not have.
//   5 cache   source_plant_id: kept if it is still a member, else the earliest live row
//             (created_at, then id), else NULL. RETURNING is how a completed write is recognised.
//   6 read    readSourcePlants, inside the transaction, so the answer is the set this write left.
//
// EVERY WRITE CARRIES THE LOT PREDICATE AND ALL THREE GUARDS IN ITS OWN WHERE. The driver's
// transaction is not interactive — no statement can see another's result and nothing in JS can stop
// the batch part-way — so a refusal cannot be an earlier read followed by a decision. Each of 3, 4
// and 5 re-tests the same conditions on its own snapshot, under the locks, and writes nothing when
// one fails; statement 2 only tells JS, afterwards, WHICH one it was.
//   • source_kind: a non-own_garden kind refuses a non-empty set (the mutual-exclusion rule the
//     /source-kind route and chk_inventory_seed_source_plant enforce from the other side). An EMPTY
//     set is always allowed — clearing is how a lot gets out of that state.
//   • legacy (PATCH /:id/source-plant): the write goes through only while the lot has at most one
//     live parent. The count is re-read by each statement, and stays <= 1 across 3 and 4 exactly
//     when it started <= 1, because a legacy set is one id or none.
//   • every planting usable (Follow-up 1, T1 defect D-2): each id in `ids` is EITHER a live planting
//     the household owns OR already a live seed_parent of this lot — ownsEveryPlanting's two arms,
//     counted over the whole array, so one failure refuses all of it. The route's gate asked the
//     same question BEFORE the lot lock, and a request that then waited for its lot behind a planting
//     merge would otherwise act on the answer from before the merge: re-saving {A, L} after L was
//     merged into W retired W's row and linked the soft-deleted L, on a 200. Asked again here, L is
//     neither live nor a member, and nothing is written.
//     The three writes cannot disagree about it: the first arm reads rows statement 1 holds, the
//     second reads link rows the lot lock holds, and of the writes themselves the retire touches
//     only rows NOT in `ids` and the add only makes more of `ids` members.
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
      lockPlantings(sql, ids),
      sql`
        SELECT i.id, i.source_kind,
               (SELECT count(*) FROM public.seed_lot_parent_planting n
                 WHERE n.inventory_item_id = i.id
                   AND n.role = 'seed_parent'
                   AND n.deleted_at IS NULL)::int AS live_parents,
               ((SELECT count(*)
                   FROM unnest(${ids}::uuid[]) AS q(plant_id)
                  WHERE EXISTS (
                          SELECT 1 FROM public.garden_node p
                           WHERE p.id = q.plant_id
                             AND p.created_by = ANY(${householdIds})
                             AND p.deleted_at IS NULL)
                     OR EXISTS (
                          SELECT 1 FROM public.seed_lot_parent_planting k
                           WHERE k.inventory_item_id = i.id
                             AND k.plant_id = q.plant_id
                             AND k.role = 'seed_parent'
                             AND k.deleted_at IS NULL)) = cardinality(${ids}::uuid[])) AS ids_usable
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
           AND (SELECT count(*)
                  FROM unnest(${ids}::uuid[]) AS q(plant_id)
                 WHERE EXISTS (
                         SELECT 1 FROM public.garden_node p
                          WHERE p.id = q.plant_id
                            AND p.created_by = ANY(${householdIds})
                            AND p.deleted_at IS NULL)
                    OR EXISTS (
                         SELECT 1 FROM public.seed_lot_parent_planting k
                          WHERE k.inventory_item_id = i.id
                            AND k.plant_id = q.plant_id
                            AND k.role = 'seed_parent'
                            AND k.deleted_at IS NULL)) = cardinality(${ids}::uuid[])
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
           AND (SELECT count(*)
                  FROM unnest(${ids}::uuid[]) AS q(plant_id)
                 WHERE EXISTS (
                         SELECT 1 FROM public.garden_node p
                          WHERE p.id = q.plant_id
                            AND p.created_by = ANY(${householdIds})
                            AND p.deleted_at IS NULL)
                    OR EXISTS (
                         SELECT 1 FROM public.seed_lot_parent_planting k
                          WHERE k.inventory_item_id = i.id
                            AND k.plant_id = q.plant_id
                            AND k.role = 'seed_parent'
                            AND k.deleted_at IS NULL)) = cardinality(${ids}::uuid[])
        RETURNING i.id, i.source_plant_id
      `,
      readSourcePlants(sql, householdIds, lotId),
    ]);
  } catch (err) {
    // Both mean a concurrent writer and a transaction that rolled back WHOLE — nothing of this write
    // exists, so "reload and try again" is true of either.
    //   23505  uq_slpp_item_plant_role_live. The lot lock rules out two of these requests colliding
    //          on one lot, so this is a writer that does not take it: a link moved onto the same lot.
    //   40P01  Postgres chose this transaction as a deadlock victim. Reproduced on real Postgres
    //          against a planting merge (T1 D-1). The lock order above is what prevents the pairs
    //          that are known; this is the answer for one that is not, instead of a 500.
    // Logged, because a 409 that used to be a 500 is otherwise invisible: a lock-order regression
    // would show up only as people being asked to retry.
    if (err?.code === '23505' || err?.code === '40P01') {
      console.warn(JSON.stringify({ tag: 'inv-source-plants-retry', item: lotId, code: err.code }));
      return { outcome: 'conflict' };
    }
    throw err;
  }

  const [, , factRows, , , cacheRows, parentRows] = results;
  const fact = factRows?.[0];
  if (!fact) return { outcome: 'not_found' };
  const source_plants = sourcePlantsOf(parentRows);

  // The lot exists and is the caller's, and statement 5 changed nothing: a guard refused inside the
  // write statements. Nothing was written, so `source_plants` is the set as it stood.
  if (!cacheRows?.length) {
    const shopKind = fact.source_kind != null && fact.source_kind !== 'own_garden';
    if (shopKind && ids.length) return { outcome: 'source_kind' };
    if (legacy && Number(fact.live_parents) >= 2) {
      return { outcome: 'multi_parent', source_plant_ids: source_plants.map((p) => p.id) };
    }
    // Strictly FALSE, as the driver parses a Postgres boolean: the route's gate passed these ids a
    // moment ago, so one of them changed while this request was on its way to the lot.
    if (fact.ids_usable === false) return { outcome: 'plants_changed' };
    // No guard explains it: the lot moved under a writer that does not take the lock.
    return { outcome: 'conflict' };
  }
  return { outcome: 'ok', id: cacheRows[0].id, source_plant_id: cacheRows[0].source_plant_id ?? null, source_plants };
}
