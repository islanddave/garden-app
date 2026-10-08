// V5-SEEDLOTADDITION-001 (release 3) — "put it in a seed lot I already started", for lambda/inventory-items.
//
// A later picking goes INTO a lot that already exists: one row of public.seed_lot_addition per picking,
// hung on the lot's link row for the plant it was picked from (parent_link_id — the table has no key to
// the lot or to the planting of its own), and the lot's own count, weight and plant count raised by
// what that picking adds. The picking row is the record; the lot's columns are the running total.
//
// Four things live here so index.js keeps only the routing and the status codes:
//   normalizeAddition    the body of POST /:id/seed-additions -> a checked request, or a 400 sentence;
//   addSeedToLot         the write, ONE sql.transaction([...]), insert-only;
//   readOpenLots         the read behind GET /seed-lots-open?plant_id=;
//   readExpectedMeasure  the three compare-and-set keys of PUT /:id/seed-measure.
//
// THE WRITE BORROWS, IT DOES NOT COPY. The lot lock, the planting share lock, the parent rules, the
// re-file and the link INSERT are the set route's own statements, imported unchanged from the three
// siblings; replaceSourcePlants itself is not touched and not called. Two statements are new: the
// judge (every fact and ONE verdict, held in app.seed_lot_go exactly as the set route holds its own)
// and applyAddition (the lot's totals and the picking row, in one statement).
//
// IMPORTS ARE THE SIBLINGS ONLY, each dependency-free for the reason seed-lot-parents.js gives: the
// driver is handed in, so the blocking unit suite can import this file and execute it.
import {
  MAX_SOURCE_PLANTS, normalizeSourcePlantIds, lockPlantings, insertSeedParentLinks, readSourcePlants,
  sourcePlantsOf, sourcePlantsByLot,
} from './seed-lot-parents.js';
import { judgeParentRules } from './seed-lot-rules.js';
import { normalizeFiling, judgeFiling, fileLot, readFiling, filingOf, filingRefusal } from './seed-lot-filing.js';
import { resolveStageEnteredAt } from './seed-stage-date.js';

// Same regex as index.js; declared again rather than shared (the siblings' rule).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// One picking is a handful to a few thousand seeds; a million is a typing slip. The weight's cap is
// the same kind of bound (100 kg of seed from one picking), and both keep the lot's own columns far
// from their types' edges for anything a person would enter.
export const MAX_ADD_SEED_COUNT = 1000000;
export const MAX_ADD_SEED_WEIGHT_G = 100000;
// The /seed-stage route's bound, for the same reason it gives: a phone east of Eastern sends a day
// Eastern has not reached, and that day's noon is ahead of the server by up to ~30 h.
const FUTURE_PICKED_ON_TOLERANCE_MS = 48 * 60 * 60 * 1000;

// Worded for the person. A client branches on `code` and prints its own sentence.
export const LOT_USED_UP = 'This seed lot is used up or no longer active. Nothing was added.';
export const ADDITION_KEY_CONFLICT = 'That addition is already recorded against another seed lot.';
export const OWN_SOURCE_LOT = 'This plant was grown from this seed lot.';
export const AMOUNT_TOO_LARGE = 'That would make the seed count too large.';
export const VARIETY_MISMATCH_NO_PARENTS =
  'This seed lot has no plant on record and is filed under a different variety.';
// The set route's own sentence for a thirteenth planting (normalizeSourcePlantIds), so the two routes
// say the same thing about the same limit.
export const TOO_MANY_PARENTS = `source_plant_ids can name at most ${MAX_SOURCE_PLANTS} plantings`;

// The body of POST /:id/seed-additions -> the request the write takes, or { error }.
//
// EVERY KEY IS READ BY VALUE (`!= null`), never by presence: none of them has a "clear" to tell from
// "absent", and index.js is scraped for the presence idiom (src/__tests__/SavedSeeds.storedCount.test.jsx).
// A top-level `name`, `type` or `category` is never read: with one of those an older Lambda would
// take this body for a create.
//
// REFUSED, never repaired — a count sent as "3", a fraction, a count with no basis. The weight is the
// one value that is normalised, and it is normalised BEFORE it is judged: the column is numeric(10,3),
// which rounds on the way in, so 0.0004 would pass a `> 0` test here and arrive as 0.000.
//
// `now` is a parameter so the 48-hour rule can be tested at its edge.
export function normalizeAddition(sent, now = new Date()) {
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)) return { error: 'addition_key is required' };

  if (typeof sent.addition_key !== 'string' || !UUID_RE.test(sent.addition_key)) {
    return { error: 'addition_key must be a uuid the client made for this addition' };
  }
  if (typeof sent.plant_id !== 'string' || !UUID_RE.test(sent.plant_id)) {
    return { error: 'plant_id must be the id of the planting this seed was picked from' };
  }
  if (sent.expected_source_plant_ids == null) {
    return { error: 'expected_source_plant_ids is required (send [] for a lot with no plant on record)' };
  }
  const expected = normalizeSourcePlantIds(sent.expected_source_plant_ids, 'expected_source_plant_ids');
  if (expected.error) return { error: expected.error };

  if (typeof sent.picked_on !== 'string' || !DAY_RE.test(sent.picked_on)) {
    return { error: 'picked_on must be a date, YYYY-MM-DD' };
  }
  const picked = resolveStageEnteredAt(sent.picked_on, now);
  if (picked.invalid) return { error: 'picked_on must be a date, YYYY-MM-DD' };
  if (Date.parse(picked.at) > now.getTime() + FUTURE_PICKED_ON_TOLERANCE_MS) {
    return { error: 'picked_on cannot be in the future' };
  }

  let addCount = null;
  let addEstimated = null;
  if (sent.add_seed_count != null) {
    if (!Number.isInteger(sent.add_seed_count) || sent.add_seed_count < 1 || sent.add_seed_count > MAX_ADD_SEED_COUNT) {
      return { error: `add_seed_count must be a whole number of seeds from 1 to ${MAX_ADD_SEED_COUNT}` };
    }
    if (typeof sent.add_estimated !== 'boolean') {
      return { error: 'add_estimated must say whether add_seed_count was counted (false) or estimated (true)' };
    }
    addCount = sent.add_seed_count;
    addEstimated = sent.add_estimated;
  } else if (sent.add_estimated != null) {
    return { error: 'add_estimated is only allowed with add_seed_count' };
  }

  let addWeight = null;
  if (sent.add_seed_weight_g != null) {
    if (typeof sent.add_seed_weight_g !== 'number' || !Number.isFinite(sent.add_seed_weight_g)) {
      return { error: 'add_seed_weight_g must be a number of grams' };
    }
    const rounded = Math.round(sent.add_seed_weight_g * 1000) / 1000;
    if (!(rounded > 0) || rounded > MAX_ADD_SEED_WEIGHT_G) {
      return { error: `add_seed_weight_g must be more than 0 and at most ${MAX_ADD_SEED_WEIGHT_G} grams` };
    }
    addWeight = rounded;
  }

  const filing = sent.filing != null ? normalizeFiling(sent.filing) : null;
  if (filing?.error) return { error: filing.error };

  const plantId = sent.plant_id.toLowerCase();
  return {
    additionKey: sent.addition_key.toLowerCase(),
    plantId,
    expected: expected.ids,
    // The set the parent rules and the re-file's crop test are asked about: the lot as the caller
    // last read it, with this plant in it.
    ruleIds: expected.ids.includes(plantId) ? expected.ids : [...expected.ids, plantId],
    pickedOn: sent.picked_on,
    addCount,
    addEstimated,
    addWeight,
    filing,
  };
}

// The three compare-and-set keys of PUT /:id/seed-measure -> { any, has*, values } or { error }.
//
// Read by `in`, here, and NOT by hasOwnProperty in index.js: presence is the contract (null means
// "I loaded no value", absent means "do not compare"), and a presence read written the other way in
// that file would make each key one the Saved seeds list row must strip before its wide PUT.
// A numeric STRING is refused for the weight, as the route refuses one for seed_weight_g itself.
export function readExpectedMeasure(body) {
  const sent = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const hasCount = 'expected_seed_count' in sent;
  const hasBasis = 'expected_seed_count_estimated' in sent;
  const hasWeight = 'expected_seed_weight_g' in sent;
  if (hasCount && sent.expected_seed_count !== null && !Number.isInteger(sent.expected_seed_count)) {
    return { error: 'expected_seed_count must be a whole number of seeds, or null' };
  }
  if (hasBasis && sent.expected_seed_count_estimated !== null && typeof sent.expected_seed_count_estimated !== 'boolean') {
    return { error: 'expected_seed_count_estimated must be true, false or null' };
  }
  if (hasWeight && sent.expected_seed_weight_g !== null
      && (typeof sent.expected_seed_weight_g !== 'number' || !Number.isFinite(sent.expected_seed_weight_g))) {
    return { error: 'expected_seed_weight_g must be a number of grams, or null' };
  }
  return {
    any: hasCount || hasBasis || hasWeight,
    hasCount,
    count: hasCount ? sent.expected_seed_count : null,
    hasBasis,
    basis: hasBasis ? sent.expected_seed_count_estimated : null,
    hasWeight,
    weight: hasWeight ? sent.expected_seed_weight_g : null,
  };
}

// THE FAST PATH'S FIRST QUESTION — has this addition been recorded already, on any lot?
//
// It names the picking table and nothing else, on purpose: a replay must reach the transaction (and
// its 200) even when the plant has since been deleted or the lot's rules have since changed, so the
// route asks this BEFORE the ownership gate and the parent rules and skips both when a row comes
// back. It decides nothing else; which lot the key is on is judged under the lot lock.
export function readAdditionKey(sql, additionKey) {
  return sql`
    SELECT a.id
      FROM public.seed_lot_addition a
     WHERE a.addition_key = ${additionKey}::uuid
  `;
}

// THE JUDGE — every fact about the lot, the plant and the key, and ONE verdict, for a statement that
// STARTS after the lot lock and the planting share lock are held (seed-lot-parents.js, statement 2,
// says why it cannot be folded into the locking statement).
//
// One row for the caller's live seed lot; no row (and no setting) for a lot that is absent, foreign,
// deleted or not seeds. First match wins, and only 'go' lets a write through:
//   replay             this addition_key is already on a link row of THIS lot. Nothing is written
//                      and the answer is a 200: the first result stands, whatever has changed since.
//   key_conflict       the key is on a link row of another lot.
//   used_up            quantity_on_hand <= 0, or status is not 'active'.
//   lot_changed        the lot's live seed_parent set is not `expected`, as a set.
//   source_kind        the lot says it came from a shop, a gift or a farm stand.
//   plants_changed     the plant is not a live planting of the household (the route's gate passed
//                      it a moment ago).
//   own_source_lot     the plant was grown from this very lot.
//   no_parent_variety  the lot has no plant on record and is filed under another variety.
//   too_many_parents   the plant would be the lot's thirteenth.
//   amount_too_large   the lot's count or weight would leave its column's range.
//   go
//
// THE KEY'S LINK ROW IS FOUND WHETHER OR NOT IT IS LIVE (alias kl, and the one binding of the link
// table here with no role or live-row filter): the plant may have been taken off the lot, or merged
// into a plant already on it, since the first request. That must still read as a replay.
//
// plant_was_added, for a replay: the link row and the picking row carry the same created_at exactly
// when one transaction wrote both (both default to now(), the transaction's start).
//
// Two settings, both transaction-local: app.seed_lot_go, which every write reads and the judges
// after this one may only take away; and app.seed_lot_plant_new — "not a live seed_parent of this
// lot at this statement" — which applyAddition reads after the link INSERT has made it one.
export function judgeAddition(sql, { lotId, plantId, householdIds, additionKey, expected, addCount, addWeight }) {
  return sql`
    SELECT f.id, f.name, f.variety_id, f.source_kind, f.source_plant_id, f.seed_count, f.seed_count_estimated,
           f.seed_weight_g, f.seed_parent_plant_count, f.quantity_on_hand, f.updated_at,
           f.plant_member, f.verdict, f.addition_id, f.count_applied, f.weight_applied, f.plant_was_added,
           set_config('app.seed_lot_go', CASE WHEN f.verdict = 'go' THEN 'go' ELSE 'stop' END, true) AS go,
           set_config('app.seed_lot_plant_new', CASE WHEN f.plant_member THEN 'false' ELSE 'true' END, true) AS plant_new
      FROM (
        SELECT g.*,
               CASE
                 WHEN g.key_found AND g.key_on_lot THEN 'replay'
                 WHEN g.key_found THEN 'key_conflict'
                 WHEN g.quantity_on_hand <= 0 OR g.status <> 'active' THEN 'used_up'
                 WHEN NOT g.set_as_expected THEN 'lot_changed'
                 WHEN g.source_kind IS NOT NULL AND g.source_kind <> 'own_garden' THEN 'source_kind'
                 WHEN NOT g.plant_live THEN 'plants_changed'
                 WHEN g.own_source_lot THEN 'own_source_lot'
                 WHEN g.live_parents = 0 AND g.plant_cultivar_id IS DISTINCT FROM g.variety_id THEN 'no_parent_variety'
                 WHEN NOT g.plant_member AND g.live_parents >= ${MAX_SOURCE_PLANTS}::int THEN 'too_many_parents'
                 WHEN COALESCE(g.seed_count::bigint + ${addCount}::int > 2147483647, FALSE)
                   OR COALESCE(g.seed_weight_g + ${addWeight}::numeric >= 10000000, FALSE) THEN 'amount_too_large'
                 ELSE 'go'
               END AS verdict
          FROM (
            SELECT i.id, i.name, i.variety_id, i.source_kind, i.source_plant_id, i.seed_count, i.seed_count_estimated,
                   i.seed_weight_g, i.seed_parent_plant_count, i.quantity_on_hand, i.status, i.updated_at,
                   a.id AS addition_id, a.count_applied, a.weight_applied,
                   (kl.created_at = a.created_at) AS plant_was_added,
                   (a.id IS NOT NULL) AS key_found,
                   COALESCE(kl.inventory_item_id = i.id, FALSE) AS key_on_lot,
                   (SELECT count(*) FROM public.seed_lot_parent_planting n
                     WHERE n.inventory_item_id = i.id
                       AND n.role = 'seed_parent'
                       AND n.deleted_at IS NULL)::int AS live_parents,
                   EXISTS (SELECT 1 FROM public.seed_lot_parent_planting m
                            WHERE m.inventory_item_id = i.id
                              AND m.plant_id = ${plantId}::uuid
                              AND m.role = 'seed_parent'
                              AND m.deleted_at IS NULL) AS plant_member,
                   ((SELECT count(*) FROM public.seed_lot_parent_planting e
                      WHERE e.inventory_item_id = i.id
                        AND e.role = 'seed_parent'
                        AND e.deleted_at IS NULL) = cardinality(${expected}::uuid[])
                    AND (SELECT count(*) FROM public.seed_lot_parent_planting e
                          WHERE e.inventory_item_id = i.id
                            AND e.role = 'seed_parent'
                            AND e.deleted_at IS NULL
                            AND e.plant_id = ANY(${expected}::uuid[])) = cardinality(${expected}::uuid[])) AS set_as_expected,
                   (p.id IS NOT NULL AND p.deleted_at IS NULL) AS plant_live,
                   p.cultivar_id AS plant_cultivar_id,
                   COALESCE(p.source_inventory_item_id = i.id, FALSE) AS own_source_lot
              FROM public.inventory_items i
              LEFT JOIN public.garden_node p
                     ON p.id = ${plantId}::uuid
                    AND p.created_by = ANY(${householdIds})
              LEFT JOIN public.seed_lot_addition a ON a.addition_key = ${additionKey}::uuid
              LEFT JOIN public.seed_lot_parent_planting kl ON kl.id = a.parent_link_id
             WHERE i.id = ${lotId}
               AND i.created_by = ANY(${householdIds})
               AND i.deleted_at IS NULL
               AND i.category = 'seeds'
          ) g
      ) f
  `;
}

// THE ONE STATEMENT — the lot's totals and the picking row, together or not at all.
//
//   pre  the lot BEFORE this statement and its link row for the plant, and only under 'go'. No link
//        row, no row here: the picking has nothing to hang on.
//   upd  the lot. The member cache by the set route's own rule (kept while it is a live member, else
//        the earliest live row); the count, its basis and the weight per the table below; the plant
//        count; updated_at. RETURNING is the lot as this request left it, re-file included (fileLot
//        runs before this statement).
//   ins  the picking, from `upd` — so a lot that was not updated gets no picking row.
//
// COUNT AND BASIS — lot before x today -> lot after; the picking always records what was typed:
//   uncounted  + anything      -> stays uncounted (count_applied false)
//   n          + blank         -> n, and the basis becomes ESTIMATED: some of it was not counted
//   n          + a             -> n + a; estimated if either was (count_applied true)
// Weight has no basis: w0 + w when both are known, otherwise the lot's weight is left as it was.
// Count and weight are independent. The plant count goes up by one only for a plant NEW to the lot
// that stands for exactly one plant (garden_node.quantity = 1), and never past 9999.
//
// ALL OR NOTHING IS THE DATABASE'S. The last column divides by zero (22012) when the verdict is still
// 'go' and exactly one picking row was not written: the transaction rolls back whole — the link
// INSERT and the re-file with it. The divisor reads the CTE, so the planner cannot fold it.
// Refused (the setting is not 'go'): `pre` is empty, nothing is written, one row of NULLs comes back.
//
// A SECOND WRITER of seed_parent_plant_count, beside PUT /:id/seed-measure.
// Never written: created_at, year_harvested, seed_stage, seed_process, quantity_on_hand, status.
export function applyAddition(sql, {
  lotId, plantId, householdIds, userId, additionKey, pickedOn, addCount, addEstimated, addWeight,
}) {
  return sql`
    WITH pre AS (
      SELECT i.id, i.seed_count AS c0, i.seed_weight_g AS w0, i.seed_parent_plant_count AS n0, l.id AS link_id,
             (SELECT p.quantity = 1
                FROM public.garden_node p
               WHERE p.id = ${plantId}::uuid
                 AND p.created_by = ANY(${householdIds})) AS one_plant
        FROM public.inventory_items i
        JOIN public.seed_lot_parent_planting l
          ON l.inventory_item_id = i.id
         AND l.plant_id = ${plantId}::uuid
         AND l.role = 'seed_parent'
         AND l.deleted_at IS NULL
       WHERE i.id = ${lotId}
         AND i.created_by = ANY(${householdIds})
         AND i.deleted_at IS NULL
         AND i.category = 'seeds'
         AND current_setting('app.seed_lot_go', true) = 'go'
    ), upd AS (
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
             seed_count = CASE
               WHEN pre.c0 IS NOT NULL AND ${addCount}::int IS NOT NULL THEN pre.c0 + ${addCount}::int
               ELSE pre.c0
             END,
             seed_count_estimated = CASE
               WHEN pre.c0 IS NULL THEN i.seed_count_estimated
               WHEN ${addCount}::int IS NULL THEN TRUE
               ELSE (i.seed_count_estimated OR ${addEstimated}::boolean)
             END,
             seed_weight_g = CASE
               WHEN pre.w0 IS NOT NULL AND ${addWeight}::numeric IS NOT NULL THEN pre.w0 + ${addWeight}::numeric
               ELSE pre.w0
             END,
             seed_parent_plant_count = CASE
               WHEN pre.n0 IS NOT NULL
                AND pre.n0 < 9999
                AND pre.one_plant IS TRUE
                AND current_setting('app.seed_lot_plant_new', true) = 'true'
                 THEN pre.n0 + 1
               ELSE pre.n0
             END,
             updated_at = NOW()
        FROM pre
       WHERE i.id = pre.id
      RETURNING i.id, i.name, i.variety_id, i.source_plant_id, i.seed_count, i.seed_count_estimated,
                i.seed_weight_g, i.seed_parent_plant_count, i.quantity_on_hand, i.updated_at
    ), ins AS (
      INSERT INTO public.seed_lot_addition (addition_key, parent_link_id, picked_on, seed_count, seed_count_estimated, seed_weight_g, count_applied, weight_applied, created_by)
      SELECT ${additionKey}::uuid, pre.link_id, ${pickedOn}::date, ${addCount}::int,
             CASE WHEN ${addCount}::int IS NULL THEN NULL ELSE ${addEstimated}::boolean END,
             ${addWeight}::numeric,
             (pre.c0 IS NOT NULL AND ${addCount}::int IS NOT NULL),
             (pre.w0 IS NOT NULL AND ${addWeight}::numeric IS NOT NULL),
             ${userId}::text
        FROM upd
        JOIN pre ON pre.id = upd.id
      RETURNING id, count_applied, weight_applied
    )
    SELECT u.id, u.name, u.variety_id, u.source_plant_id, u.seed_count, u.seed_count_estimated,
           u.seed_weight_g, u.seed_parent_plant_count, u.quantity_on_hand, u.updated_at,
           s.id AS addition_id, s.count_applied, s.weight_applied,
           1 / (CASE WHEN current_setting('app.seed_lot_go', true) IS DISTINCT FROM 'go'
                       OR (SELECT count(*) FROM ins) = 1
                     THEN 1 ELSE 0 END) AS all_or_nothing
      FROM (VALUES (1)) AS one(x)
      LEFT JOIN upd u ON TRUE
      LEFT JOIN ins s ON TRUE
  `;
}

// The lot's measure and filing keys as a reply carries them, off whichever row holds them: the
// judge's (a replay, a 409) or applyAddition's (a write).
const lotFieldsOf = (row) => ({
  id: row.id,
  name: row.name ?? null,
  variety_id: row.variety_id ?? null,
  source_plant_id: row.source_plant_id ?? null,
  seed_count: row.seed_count ?? null,
  seed_count_estimated: row.seed_count_estimated ?? null,
  seed_weight_g: row.seed_weight_g ?? null,
  seed_parent_plant_count: row.seed_parent_plant_count ?? null,
  quantity_on_hand: row.quantity_on_hand ?? null,
  updated_at: row.updated_at ?? null,
});

// THE WRITE — one more picking into a lot, in ONE sql.transaction([...]). Insert-only: no statement
// in it retires a row.
//
// Returns { outcome } and never a status code — index.js owns the HTTP:
//   'ok'            -> { lot, source_plants, addition: { id, replayed, plant_was_added, count_applied,
//                      weight_applied } } and, when a `filing` was sent AND this request wrote, { filing }.
//                      A replay is 'ok' too: replayed true, the lot as it stands now, no filing.
//   'not_found'     -> the lot is absent, foreign, deleted or not seeds.
//   'lot_changed'   -> the lot's parent set is not the one the caller read ({ source_plant_id,
//                      source_plants, variety_id, name and the measure keys } as stored), or its
//                      filing is not ({ variety_id, name }).
//   'key_conflict' | 'used_up' | 'source_kind' | 'plants_changed' | 'own_source_lot' |
//   'no_parent_variety' | 'too_many_parents' | 'amount_too_large' -> the judge's verdict.
//   'rules_changed' | 'variety_unusable' | 'filing_crop_mismatch' -> a judge after it took 'go' away.
//   'conflict'      -> the transaction rolled back whole: a unique violation (23505), a deadlock
//                      victim (40P01), or the all-or-nothing division (22012).
// Nothing is written in any outcome but a first-time 'ok'.
//
// THE STATEMENTS, in order (eight when nothing optional is asked):
//   0 lock    the lot, FOR UPDATE — the set route's own first statement, first for its reason.
//   1 hold    lockPlantings on the one plant.
//   2 judge   judgeAddition.
//   + rules   judgeParentRules over the caller's set with the plant in it, when that is two or more.
//   + judge   judgeFiling, when a `filing` was sent, against the same set.
//   3 add     insertSeedParentLinks for the one plant: nothing when it is already a live parent.
//   + file    fileLot, when a `filing` was sent.
//   4 apply   applyAddition.
//   5 read    readSourcePlants, inside the transaction.
//   + filed   readFiling, when a `filing` was sent.
// When the judge says 'replay', what the rules and the filing judge returned is not read: a re-filing
// body sent twice carries a stale expect_variety_id by construction, and is still a 200.
export async function addSeedToLot(sql, {
  lotId, householdIds, userId, additionKey, plantId, expected, ruleIds, pickedOn,
  addCount = null, addEstimated = null, addWeight = null, filing = null,
}) {
  const setWithPlant = ruleIds ?? (expected.includes(plantId) ? expected : [...expected, plantId]);
  const judgesRules = setWithPlant.length >= 2;
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
      lockPlantings(sql, [plantId]),
      judgeAddition(sql, { lotId, plantId, householdIds, additionKey, expected, addCount, addWeight }),
      ...(judgesRules
        ? [judgeParentRules(sql, { lotId, ids: setWithPlant, householdIds, varietyId: filing?.varietyId ?? null })]
        : []),
      ...(filing
        ? [judgeFiling(sql, {
          lotId, householdIds, varietyId: filing.varietyId, expectVarietyId: filing.expectVarietyId, ids: setWithPlant,
        })]
        : []),
      insertSeedParentLinks(sql, { lotId, ids: [plantId], householdIds, userId }),
      ...(filing
        ? [fileLot(sql, { lotId, householdIds, varietyId: filing.varietyId, name: filing.name })]
        : []),
      applyAddition(sql, {
        lotId, plantId, householdIds, userId, additionKey, pickedOn, addCount, addEstimated, addWeight,
      }),
      readSourcePlants(sql, householdIds, lotId),
      ...(filing ? [readFiling(sql, { lotId, householdIds })] : []),
    ]);
  } catch (err) {
    // Each of the three means the transaction rolled back WHOLE, so "reload and try again" is true:
    //   23505  a concurrent writer that does not take the lot lock (a link moved onto this lot by a
    //          planting merge), or the same addition_key landing on two lots at one moment;
    //   40P01  a deadlock victim;
    //   22012  applyAddition's own division: the verdict said go and no picking row was written.
    // Logged, for the reason the set route logs its own.
    if (err?.code === '23505' || err?.code === '40P01' || err?.code === '22012') {
      console.warn(JSON.stringify({ tag: 'inv-seed-addition-retry', item: lotId, code: err.code }));
      return { outcome: 'conflict' };
    }
    throw err;
  }

  // Found by position from the two optional counts, as replaceSourcePlants finds its own.
  const nRules = judgesRules ? 1 : 0;
  const nFiling = filing ? 1 : 0;
  const applyAt = 3 + nRules + nFiling + 1 + nFiling;
  const fact = results[2]?.[0];
  const ruleRows = judgesRules ? results[3] : null;
  const judged = filing ? (results[3 + nRules]?.[0] ?? null) : null;
  const fileRows = filing ? results[applyAt - 1] : null;
  const applied = results[applyAt]?.[0] ?? null;
  const parentRows = results[applyAt + 1];
  const filedRows = filing ? results[applyAt + 2] : null;

  if (!fact) return { outcome: 'not_found' };
  const source_plants = sourcePlantsOf(parentRows);

  if (fact.verdict === 'replay') {
    return {
      outcome: 'ok',
      lot: lotFieldsOf(fact),
      source_plants,
      addition: {
        id: fact.addition_id,
        replayed: true,
        plant_was_added: fact.plant_was_added === true,
        count_applied: fact.count_applied === true,
        weight_applied: fact.weight_applied === true,
      },
    };
  }
  if (fact.verdict === 'lot_changed') {
    const { id: _id, updated_at: _updatedAt, ...asStored } = lotFieldsOf(fact);
    return { outcome: 'lot_changed', ...asStored, source_plants };
  }
  if (fact.verdict !== 'go') return { outcome: fact.verdict };

  // The judge said go. A judge after it may have taken that away, and then nothing was written.
  if (ruleRows?.[0]?.rules_hold === false) return { outcome: 'rules_changed' };
  const refusal = filingRefusal(judged);
  if (refusal === 'lot_changed') {
    return { outcome: 'lot_changed', variety_id: judged.previous_variety_id ?? null, name: judged.previous_name ?? null };
  }
  if (refusal) return { outcome: refusal };
  // Go, no refusal, and no write: unreachable (the division raises first) except through a writer
  // that does not take the lot lock. Never a 200 for a picking that was not recorded.
  if (!applied?.id || !applied.addition_id) return { outcome: 'conflict' };

  const out = {
    outcome: 'ok',
    lot: lotFieldsOf(applied),
    source_plants,
    addition: {
      id: applied.addition_id,
      replayed: false,
      plant_was_added: fact.plant_member === false,
      count_applied: applied.count_applied === true,
      weight_applied: applied.weight_applied === true,
    },
  };
  if (filing) out.filing = filingOf(filedRows, judged, (fileRows?.length ?? 0) > 0);
  return out;
}

// THE READ — GET /seed-lots-open?plant_id=: the lots this planting's seed could go into.
//
// ONE STATEMENT, and its shape answers three questions at once: NO ROW means the planting is not a
// live planting of the household (the route's 400); ONE ROW with a null lot id means it is, and no
// lot is open to it; otherwise one row per lot, in the order the list shows them.
//
//   pl  the planting: its variety, that variety's crop, and the lot it was grown from.
//   lv  the variety the LOT is filed under (name, rank, crop).
//   se  when the lot entered its current stage — the list read's own LATERAL, same key.
//   k   the lot's live seed_parent links, aggregated: how many, how many of their plantings have a
//       variety, how many distinct crops those varieties are (NULL counted as a crop of its own, as
//       the parent rules count it), whether this planting is one of them, and whether one of them
//       has this planting's variety.
//
// WHAT IS OFFERED: a live, active seed lot with something in it, that says it is home-saved (or says
// nothing and looks it), is not fermenting, and is either still drying or was made this year in
// New York — and never the lot this planting was grown from. Then the crop: a lot with no plant on
// record only for its own variety; a lot whose plants have no variety by the lot's own crop;
// otherwise by the plants' one shared crop.
//
// BOTH YEAR TERMS OPEN A PARENTHESIS STRAIGHT AFTER `FROM`. scripts/dev-main-schema-audit.py reads
// the word after a FROM as a relation, and `EXTRACT(YEAR FROM now() ...)` makes `now` one.
//
// is_member    this planting is a live seed_parent of the lot.
// same_variety adding this planting would not change what the lot is filed under: the lot's variety
//              is the planting's, or a live parent's planting has it.
export function readOpenLots(sql, { plantId, householdIds }) {
  return sql`
    SELECT pl.id AS plant_id, pl.crop_slug AS plant_crop_slug, o.*
      FROM (
        SELECT p.id, p.cultivar_id, p.source_inventory_item_id, pv.crop_type_slug AS crop_slug
          FROM public.garden_node p
          LEFT JOIN public.cultivar pv ON pv.id = p.cultivar_id
         WHERE p.id = ${plantId}::uuid
           AND p.created_by = ANY(${householdIds})
           AND p.deleted_at IS NULL
      ) pl
      LEFT JOIN LATERAL (
        SELECT i.id, i.name, i.variety_id, lv.variety_name, lv.variety_rank, lv.crop_slug,
               i.seed_stage, i.seed_process, se.entered_at AS stage_entered_at, i.created_at, i.updated_at,
               i.seed_count, i.seed_count_estimated, i.seed_weight_g, i.seed_parent_plant_count,
               i.quantity_on_hand, i.status, i.source_plant_id,
               k.is_member,
               (i.variety_id = pl.cultivar_id OR k.shares_variety) AS same_variety
          FROM public.inventory_items i
          LEFT JOIN LATERAL (
                 SELECT pv.display_name AS variety_name, pv.variety_rank, pv.crop_type_slug AS crop_slug
                   FROM public.cultivar pv
                  WHERE pv.id = i.variety_id
               ) lv ON TRUE
          LEFT JOIN LATERAL (
                 SELECT sl.entered_at
                   FROM public.seed_lot_stage_log sl
                  WHERE i.seed_stage IS NOT NULL
                    AND sl.inventory_item_id = i.id
                    AND sl.stage = i.seed_stage
                  ORDER BY sl.created_at DESC, sl.entered_at DESC, sl.id DESC
                  LIMIT 1
               ) se ON TRUE
         CROSS JOIN LATERAL (
                 SELECT count(*)::int AS parents,
                        count(p.cultivar_id)::int AS named,
                        (count(DISTINCT COALESCE(pv.crop_type_slug, '')) FILTER (WHERE p.cultivar_id IS NOT NULL))::int AS crops,
                        min(pv.crop_type_slug) FILTER (WHERE p.cultivar_id IS NOT NULL) AS crop,
                        COALESCE(bool_or(l.plant_id = pl.id), FALSE) AS is_member,
                        COALESCE(bool_or(p.cultivar_id = pl.cultivar_id), FALSE) AS shares_variety
                   FROM public.seed_lot_parent_planting l
                   LEFT JOIN public.garden_node p
                          ON p.id = l.plant_id
                         AND p.created_by = ANY(${householdIds})
                   LEFT JOIN public.cultivar pv ON pv.id = p.cultivar_id
                  WHERE l.inventory_item_id = i.id
                    AND l.role = 'seed_parent'
                    AND l.deleted_at IS NULL
               ) k
         WHERE i.created_by = ANY(${householdIds})
           AND i.deleted_at IS NULL
           AND i.category = 'seeds'
           AND i.status = 'active'
           AND i.quantity_on_hand > 0
           AND (i.source_kind IS NULL OR i.source_kind = 'own_garden')
           AND (i.source_plant_id IS NOT NULL OR i.seed_stage IS NOT NULL OR i.source_kind = 'own_garden')
           AND i.seed_stage IS DISTINCT FROM 'fermenting'
           AND (i.seed_stage = 'drying'
                OR EXTRACT(YEAR FROM (i.created_at AT TIME ZONE 'America/New_York'))
                 = EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/New_York')))
           AND i.id IS DISTINCT FROM pl.source_inventory_item_id
           AND pl.crop_slug IS NOT NULL
           AND CASE WHEN k.parents = 0 THEN i.variety_id = pl.cultivar_id
                    WHEN k.named = 0 THEN lv.crop_slug = pl.crop_slug
                    ELSE k.crops = 1 AND k.crop = pl.crop_slug
               END
      ) o ON TRUE
     ORDER BY o.is_member DESC NULLS LAST, o.same_variety DESC NULLS LAST, o.created_at DESC, o.id DESC
  `;
}

// The row keys of one open lot, in the order the reply carries them.
const OPEN_LOT_KEYS = [
  'id', 'name', 'variety_id', 'variety_name', 'variety_rank', 'crop_slug', 'seed_stage', 'seed_process',
  'stage_entered_at', 'created_at', 'updated_at', 'seed_count', 'seed_count_estimated', 'seed_weight_g',
  'seed_parent_plant_count', 'quantity_on_hand', 'status', 'source_plant_id', 'is_member', 'same_variety',
];

// readOpenLots' rows and the household's parents read -> the 200 body, or null when the planting is
// not one the household can use. source_plants is readSourcePlants' own element, `[]` for a lot with
// no plant on record.
export function openLotsOf(rows, parentRows) {
  if (!rows?.length) return null;
  const parents = sourcePlantsByLot(parentRows);
  return {
    plant_id: rows[0].plant_id,
    crop_slug: rows[0].plant_crop_slug ?? null,
    open_lots: rows.filter((r) => r.id != null).map((r) => ({
      ...Object.fromEntries(OPEN_LOT_KEYS.map((key) => [key, r[key] ?? null])),
      is_member: r.is_member === true,
      same_variety: r.same_variety === true,
      source_plants: parents.get(String(r.id)) ?? [],
    })),
  };
}
