// V5-SEEDMULTIPARENT-001 (release 2a) — WHICH VARIETY IS THIS SEED LOT FILED UNDER, for
// lambda/inventory-items.
//
// A saved lot is created under a variety, and until now nothing could change it afterwards: the wide
// PUT assigns variety_id from whatever stale row its caller round-trips, which is how a re-file gets
// silently undone (and why that verb now keeps a parented lot's stored variety). This module is the
// one deliberate way to re-file a lot — a jar that gains a second variety moves to the mix of the
// two — and it is reached two ways that must not differ:
//   • PUT /api/inventory-items/:id/filing        — the filing alone (fileSeedLot below);
//   • PUT /api/inventory-items/:id/source-plants — `filing` beside a new parent set, in that write's
//     own transaction (seed-lot-parents.js places judgeFiling, fileLot and readFiling in its list).
// One body rule, one judge, ONE UPDATE: the set route does not carry a second copy of any of them.
//
// THE RULE, judged on the STORED variety under the lot's row lock:
//   stored = variety_id         -> nothing to do. 200, changed: false. A replay costs nothing.
//   stored = expect_variety_id  -> write (when the target is usable — below).
//   anything else               -> the lot was re-filed by someone else since the caller read it:
//                                  409 lot_changed with what it is filed under now. Nothing written.
// A write also needs the target to be a LIVE variety (variety_unusable) and, when the lot has
// parents whose varieties share one crop, to be of that crop (filing_crop_mismatch; NULL is one
// value of its own, and a lot with no parents — or parents of several crops, which only drift can
// produce — has no shared crop to differ from). It does NOT need the target to be the parents' mix:
// Undo files a lot back under what it was, and that has to be allowed.
//
// plant_varieties is a shared catalogue with no owner to gate against — the reason
// inventory-items::variety_id sits in the shared-vocabulary group of lambda/authz-write-fk.test.js.
// What is checked is what POST's source refs check: the row exists and is not soft-deleted.
//
// THE VERDICT IS HELD in the transaction-local setting app.seed_lot_go, exactly as seed-lot-rules.js
// describes: judgeFiling computes it once, fileLot reads it. Inside the set route it can only take
// 'go' away from the verdict already reached there, so a refused filing refuses the whole edit and
// a refused edit refuses the filing.
//
// DEPENDENCY-FREE, like its siblings: the driver is handed in. Do not add imports.

// Same regex as index.js; declared again because this module imports nothing.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Worded for the person. A client branches on `code`.
export const VARIETY_UNUSABLE = 'That variety is not available any more. Pick another one.';
export const FILING_CROP_MISMATCH = 'That variety is a different crop from the plants this seed came from.';

// { variety_id, expect_variety_id, name? } as a request sent it -> { varietyId, expectVarietyId, name }
// or { error }. The same function reads the body of PUT /:id/filing and the `filing` key of the set
// route, so the two cannot accept different shapes.
//
// Both ids are REQUIRED and must be uuids: a non-uuid reaching Postgres is 22P02, an opaque 500.
// `expect_variety_id` is what makes this a compare-and-set — without it a stale page re-files over
// someone else's re-file.
//
// `name` is optional. Absent (or null) leaves the lot's name alone; present, it must be a string
// with something in it, and it is stored trimmed, as POST stores it. A blank name is refused rather
// than read as "leave it": the caller said to change it.
//
// Read as `sent`, never as `body`, and by value, never by hasOwnProperty: this file is in the
// directory two static scans read (the presence-idiom scan in SavedSeeds.storedCount.test.jsx is
// index.js-only today; the body-FK scan in authz-write-fk.test.js is not).
export function normalizeFiling(sent) {
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)) {
    return { error: 'variety_id and expect_variety_id are required' };
  }
  if (typeof sent.variety_id !== 'string' || !UUID_RE.test(sent.variety_id)) {
    return { error: 'variety_id must be the id of the variety to file this seed under' };
  }
  if (typeof sent.expect_variety_id !== 'string' || !UUID_RE.test(sent.expect_variety_id)) {
    return { error: 'expect_variety_id must be the id of the variety this seed is filed under now' };
  }
  let name = null;
  if (sent.name != null) {
    if (typeof sent.name !== 'string' || !sent.name.trim()) {
      return { error: 'name must not be blank when it is sent' };
    }
    name = sent.name.trim();
  }
  return {
    varietyId: sent.variety_id.toLowerCase(),
    expectVarietyId: sent.expect_variety_id.toLowerCase(),
    name,
  };
}

// THE JUDGE — one row for the caller's live seed lot: { verdict, previous_variety_id, previous_name, go }.
//   'same'     stored = target. Nothing will be written; not a refusal.
//   'changed'  stored is neither the target nor what the caller expected.
//   'unusable' the target is not a live variety.
//   'crop'     the target's crop differs from the parents' shared crop.
//   'write'    file it.
// In that order: a replay is answered before anything is asked of the target, and a stale caller is
// told so before being told its target is wrong.
//
// It must run in a statement that STARTS after the lot is locked (a subquery in the locking statement
// reads the snapshot taken before the wait — seed-lot-parents.js, statement 2).
//
// WHOSE PARENTS. `ids` non-null = the set this same transaction is about to write (the set route):
// the crop is judged against the jar as it will be. null = the lot's live seed_parent rows as they
// stand (the filing route). Read through the household, like the rules' own planting reads.
//
// `alone` = nothing was judged before this in the transaction (the filing route). Otherwise 'go'
// survives only if it was already 'go'.
export function judgeFiling(sql, { lotId, householdIds, varietyId, expectVarietyId, ids = null, alone = false }) {
  const ofThisWrite = ids != null;
  return sql`
    SELECT v.verdict, v.previous_variety_id, v.previous_name,
           set_config('app.seed_lot_go',
             CASE WHEN v.verdict IN ('write', 'same')
                   AND (${alone}::boolean OR current_setting('app.seed_lot_go', true) = 'go')
                  THEN 'go' ELSE 'stop' END, true) AS go
      FROM (
        SELECT i.variety_id AS previous_variety_id,
               i.name AS previous_name,
               CASE
                 WHEN i.variety_id = ${varietyId}::uuid THEN 'same'
                 WHEN i.variety_id IS DISTINCT FROM ${expectVarietyId}::uuid THEN 'changed'
                 WHEN fv.id IS NULL THEN 'unusable'
                 WHEN (SELECT count(*) = 1 AND bool_or(d.crop IS DISTINCT FROM fv.crop_type_slug)
                         FROM (SELECT DISTINCT pv.crop_type_slug AS crop
                                 FROM public.garden_node p
                                 JOIN public.cultivar pv ON pv.id = p.cultivar_id
                                WHERE p.created_by = ANY(${householdIds})
                                  AND ((${ofThisWrite}::boolean AND p.id = ANY(${ids ?? []}::uuid[]))
                                       OR (NOT ${ofThisWrite}::boolean AND EXISTS (
                                             SELECT 1 FROM public.seed_lot_parent_planting l
                                              WHERE l.inventory_item_id = i.id
                                                AND l.plant_id = p.id
                                                AND l.role = 'seed_parent'
                                                AND l.deleted_at IS NULL)))) d)
                   THEN 'crop'
                 ELSE 'write'
               END AS verdict
          FROM public.inventory_items i
          LEFT JOIN public.cultivar fv
                 ON fv.id = ${varietyId}::uuid
                AND fv.deleted_at IS NULL
         WHERE i.id = ${lotId}
           AND i.created_by = ANY(${householdIds})
           AND i.deleted_at IS NULL
           AND i.category = 'seeds'
      ) v
  `;
}

// THE WRITE — the only statement in this Lambda that re-files a lot. Both routes place this one.
//
// It carries the lot predicate, like every write here, and reads the held verdict rather than
// re-deriving any of it. `IS DISTINCT FROM` is the 'same' case said in the statement's own terms: a
// lot already filed there is not touched (no updated_at bump for a write that changed nothing), and
// that is also what makes RETURNING the test of "changed".
//
// `name` NULL keeps the name: COALESCE, because the lot's name is NOT NULL and a caller that did not
// send one said nothing about it.
export function fileLot(sql, { lotId, householdIds, varietyId, name = null }) {
  return sql`
    UPDATE public.inventory_items i
       SET variety_id = ${varietyId}::uuid,
           name = COALESCE(${name}::text, i.name),
           updated_at = NOW()
     WHERE i.id = ${lotId}
       AND i.created_by = ANY(${householdIds})
       AND i.deleted_at IS NULL
       AND i.category = 'seeds'
       AND current_setting('app.seed_lot_go', true) = 'go'
       AND i.variety_id IS DISTINCT FROM ${varietyId}::uuid
    RETURNING i.id
  `;
}

// The lot's filing as the transaction left it, with the variety's name and rank for the reply.
export function readFiling(sql, { lotId, householdIds }) {
  return sql`
    SELECT i.id, i.variety_id, pv.display_name AS variety_name, pv.variety_rank, i.name
      FROM public.inventory_items i
      LEFT JOIN public.cultivar pv ON pv.id = i.variety_id
     WHERE i.id = ${lotId}
       AND i.created_by = ANY(${householdIds})
       AND i.deleted_at IS NULL
       AND i.category = 'seeds'
  `;
}

// The reply's filing object: what the lot is filed under now, whether this request changed it, and
// what it was before — which is what Undo sends back as its target.
export function filingOf(filedRows, judged, changed) {
  const now = filedRows?.[0] ?? {};
  return {
    variety_id: now.variety_id ?? null,
    variety_name: now.variety_name ?? null,
    variety_rank: now.variety_rank ?? null,
    name: now.name ?? null,
    changed,
    previous: { variety_id: judged?.previous_variety_id ?? null, name: judged?.previous_name ?? null },
  };
}

// What a judged filing that did NOT go through means, or null when the verdict was not a refusal.
// Shared by the two routes so they cannot read one verdict two ways.
export function filingRefusal(judged) {
  if (judged?.verdict === 'changed') return 'lot_changed';
  if (judged?.verdict === 'unusable') return 'variety_unusable';
  if (judged?.verdict === 'crop') return 'filing_crop_mismatch';
  return null;
}

// PUT /:id/filing — the filing alone, in ONE transaction of four statements:
//   0 lock   SELECT .. FOR UPDATE on the lot: the same lock, taken first, that the parents write and
//            the planting merge take first, so the three queue on a lot and cannot cross.
//   1 judge  judgeFiling, in a statement that starts after the lock.
//   2 file   fileLot.
//   3 read   readFiling.
// No planting is locked: the crop test is a write-time courtesy, judged once, and a parent's variety
// changing a moment later is the same drift as it changing a day later.
//
// Returns { outcome } and never a status code — index.js owns the HTTP:
//   'ok'                   -> { id, filing }
//   'not_found'            -> absent, foreign, deleted or not seeds. Nothing written.
//   'lot_changed'          -> { variety_id, name } as stored now. Nothing written.
//   'variety_unusable' | 'filing_crop_mismatch' -> nothing written.
//   'conflict'             -> 40P01, or a write the verdict allowed that changed nothing.
export async function fileSeedLot(sql, { lotId, householdIds, varietyId, expectVarietyId, name = null }) {
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
      judgeFiling(sql, { lotId, householdIds, varietyId, expectVarietyId, alone: true }),
      fileLot(sql, { lotId, householdIds, varietyId, name }),
      readFiling(sql, { lotId, householdIds }),
    ]);
  } catch (err) {
    // A deadlock victim's transaction rolled back whole. Logged for the reason the parents write
    // logs its own: a 409 that would have been a 500 is otherwise invisible.
    if (err?.code === '40P01') {
      console.warn(JSON.stringify({ tag: 'inv-filing-retry', item: lotId, code: err.code }));
      return { outcome: 'conflict' };
    }
    throw err;
  }

  const [, judgedRows, fileRows, filedRows] = results;
  const judged = judgedRows?.[0];
  if (!judged) return { outcome: 'not_found' };
  const refusal = filingRefusal(judged);
  if (refusal === 'lot_changed') {
    return { outcome: 'lot_changed', variety_id: judged.previous_variety_id ?? null, name: judged.previous_name ?? null };
  }
  if (refusal) return { outcome: refusal };
  const changed = (fileRows?.length ?? 0) > 0;
  // The verdict said write and nothing was written: unreachable under the lot lock except through a
  // writer that does not take it. Never a 200 for a write that did not happen.
  if (judged.verdict === 'write' && !changed) return { outcome: 'conflict' };
  return { outcome: 'ok', id: filedRows?.[0]?.id ?? lotId, filing: filingOf(filedRows, judged, changed) };
}
