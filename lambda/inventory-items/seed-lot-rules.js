// V5-SEEDMULTIPARENT-001 (release 2a) — THE PARENT RULES of a saved-seed lot, for lambda/inventory-items.
//
// Release 1 asked one thing of a lot's parent plantings: may this household use them. A jar gathered
// from several plants needs three more, and they are all about the plantings' VARIETIES:
//   • parent_without_variety — a planting being ADDED has no variety. Nothing can be said about what
//     the seed is, and the mix the jar is filed under cannot name it.
//   • mixed_crop_parents     — the set's varieties are not all one crop. NULL is one value of its own:
//     two varieties with no crop recorded agree with each other and with nothing else.
//   • blend_required         — the set spans two or more varieties, and the lot is not filed under
//     the household's mix of exactly those. Dave's decision: a mixed jar is ALWAYS filed under a
//     named mix.
//
// WHEN THEY APPLY, and it is narrower than "always": only to a set of TWO OR MORE plantings, and only
// to a request that ADDS at least one planting that is not already a live parent of the lot. A
// planting's variety can be cleared, and a merge can change it, long after the jar was saved, so a
// set that was legal can stop being so with no lot write at all. If the rules judged every request,
// such a jar could never be edited again — not even to take the offending plant out. So a request
// that only removes is never refused by them, and a planting that is already a parent is never the
// one refused for having no variety.
//
// TWO PLACES, ONE RULE. checkParentRules answers the ordinary bad request with a 400 and the detail
// a person needs (which plant, which varieties), before anything is locked. judgeParentRules asks
// the same question again INSIDE the write's transaction, under the lot lock and the planting share
// locks, because a planting's variety can change while the request waits for its lot — the same
// reason the ownership rule is asked twice (seed-lot-parents.js, T1 defect D-2).
//
// THE VERDICT IS HELD, NOT REPEATED. The driver's transaction is a fixed list of statements, so a
// refusal cannot be a read followed by a decision in JS. Release 1 put each guard in every write's
// own WHERE, which works only while the writes cannot change what the guard reads. These rules read
// "which plantings are already parents", which the write's own INSERT changes. So the verdict is
// computed ONCE, before the first write, and kept in a transaction-local setting, app.seed_lot_go,
// that every write statement reads. set_config(..., true) lasts exactly as long as the transaction
// (the app.actor_clerk_sub precedent in lambda/events). A judge can only take 'go' away, never give
// it back; the first statement of a chain (`alone`) is the one that may start it.
//
// A SOFT-DELETED VARIETY STILL COUNTS as the planting's variety, here as in the source_plants read:
// the cultivar join carries no deleted_at predicate. The variety the LOT is filed under is the one
// place liveness is required.
//
// DEPENDENCY-FREE, like its siblings: the driver is handed in. Do not add imports.

// Same regex as index.js; declared again because this module imports nothing.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Worded for the person holding the phone: no ids, no column names. A client branches on `code`.
export const PARENT_WITHOUT_VARIETY = 'One of those plants has no variety yet. Give it a variety first, then add it.';
export const MIXED_CROP_PARENTS = 'Seed in one lot has to come from one crop, and those plants are not all the same crop.';
export const BLEND_REQUIRED = 'Seed from more than one variety is filed under a mix of those varieties.';

// THE KEY of a mix (R2A-CONTRACT section 1): its LEAF variety ids, lower-case, in uuid order, joined
// by commas. A variety that is itself a mix contributes its own leaves — its blend_key split on the
// comma — so flattening reads no table. uuid order is byte order, which for lower-case hex text is
// plain string order; that is what makes this the same string Postgres builds with
// string_agg(u::text, ',' ORDER BY u).
export function blendKeyOf(cultivars) {
  const leaves = new Set();
  for (const c of cultivars) {
    if (c.blend_key) {
      for (const leaf of String(c.blend_key).split(',')) leaves.add(leaf.trim().toLowerCase());
    } else {
      leaves.add(String(c.id).toLowerCase());
    }
  }
  return [...leaves].sort().join(',');
}

// What the rules need to know about each planting in `ids`, one row per id, in ONE statement.
//
// Not folded into ownsEveryPlanting's read. That statement is the authorization gate, pinned word for
// word by lambda/authz-write-fk.test.js, and it is the whole of what a one-planting request costs.
// This read is issued only for a set of two or more, after that gate has passed.
//
// The planting is read through the household (p.created_by): a planting the household cannot see
// reports no variety here rather than someone else's. `member` and the lot's own variety come
// through the caller's live seed lot, so a foreign lot reports lot_found false and nothing else.
// lotId null (POST: the lot does not exist yet) finds no lot and so no members.
export function readParentFacts(sql, { ids, householdIds, lotId = null }) {
  return sql`
    SELECT q.plant_id AS id,
           p.cultivar_id,
           pv.crop_type_slug AS crop_slug,
           pv.blend_key,
           (k.plant_id IS NOT NULL) AS member,
           (i.id IS NOT NULL) AS lot_found,
           i.variety_id AS lot_variety_id
      FROM unnest(${ids}::uuid[]) AS q(plant_id)
      LEFT JOIN public.inventory_items i
             ON i.id = ${lotId}::uuid
            AND i.created_by = ANY(${householdIds})
            AND i.deleted_at IS NULL
            AND i.category = 'seeds'
      LEFT JOIN public.seed_lot_parent_planting k
             ON k.inventory_item_id = i.id
            AND k.plant_id = q.plant_id
            AND k.role = 'seed_parent'
            AND k.deleted_at IS NULL
      LEFT JOIN public.garden_node p
             ON p.id = q.plant_id
            AND p.created_by = ANY(${householdIds})
      LEFT JOIN public.cultivar pv ON pv.id = p.cultivar_id
  `;
}

// The rules, applied to those rows. Pure, so every cell of the table is a unit test.
//
// Returns { applies: false } when the rules have nothing to say (fewer than two plantings, or the
// request adds none), { refusal } with the 400 body for the first rule broken, or { blend } — null
// when one variety covers the whole set, else the varieties the lot's mix must be made of and its
// key — which the caller checks against the variety the lot is filed under.
//
// AN ID WITH NO ROW IS AN ADDED PLANTING WITH NO VARIETY. The statement returns one row per id, so
// this is only ever a read that did not answer — and that must refuse, not pass.
export function judgeParentFacts(ids, rows) {
  const byId = new Map((rows ?? []).map((r) => [String(r.id).toLowerCase(), r]));
  const facts = ids.map((id) => byId.get(id) ?? { id, cultivar_id: null, crop_slug: null, blend_key: null, member: false });
  const added = facts.filter((f) => f.member !== true);
  if (ids.length < 2 || !added.length) return { applies: false };

  const bare = added.find((f) => f.cultivar_id == null);
  if (bare) {
    return {
      applies: true,
      refusal: { error: PARENT_WITHOUT_VARIETY, code: 'parent_without_variety', plant_id: String(bare.id).toLowerCase() },
    };
  }

  // The crop and the mix are facts about the set's VARIETIES. A parent that is already a member and
  // has since lost its variety contributes none: it is not a crop of its own, and no mix can name it.
  const named = facts.filter((f) => f.cultivar_id != null);
  const crops = new Set(named.map((f) => f.crop_slug ?? null));
  if (crops.size > 1) {
    return { applies: true, refusal: { error: MIXED_CROP_PARENTS, code: 'mixed_crop_parents' } };
  }

  const cultivars = new Map(named.map((f) => [String(f.cultivar_id).toLowerCase(), f.blend_key ?? null]));
  if (cultivars.size < 2) return { applies: true, blend: null };
  const component_variety_ids = [...cultivars.keys()].sort();
  return {
    applies: true,
    blend: {
      component_variety_ids,
      key: blendKeyOf(component_variety_ids.map((id) => ({ id, blend_key: cultivars.get(id) }))),
    },
  };
}

// THE FAST PATH — null when the request may go on to its write, else the body of its 400.
//
// `varietyId` is the variety the lot will be filed under AFTER this request when the request itself
// says so (POST's variety_id; the set route's filing.variety_id). Without one, on the set route, it
// is the variety the lot is filed under now.
//
// A LOT-SCOPED REQUEST WHOSE LOT IS NOT THE CALLER'S LIVE SEED LOT IS NOT JUDGED AT ALL. "Already a
// parent" has no meaning against a lot the caller cannot see, and the write that follows answers it
// 404 — the same answer for absent, foreign, deleted and not seeds, with no rule in front of it to
// tell them apart.
//
// One read for the plantings, and one more for the filed variety only when the set really is mixed.
// Not the guarantee: judgeParentRules below is.
export async function checkParentRules(sql, { ids, householdIds, lotId = null, varietyId = null }) {
  if (ids.length < 2) return null;
  const rows = await readParentFacts(sql, { ids, householdIds, lotId });
  if (lotId != null && !(rows ?? []).some((r) => r.lot_found === true)) return null;
  const verdict = judgeParentFacts(ids, rows);
  if (!verdict.applies) return null;
  if (verdict.refusal) return verdict.refusal;
  if (!verdict.blend) return null;

  const filedUnder = varietyId ?? rows.find((r) => r.lot_variety_id != null)?.lot_variety_id ?? null;
  // A value that is not a uuid names no variety. It is never sent to Postgres (22P02 is an opaque 500).
  const filed = filedUnder != null && UUID_RE.test(String(filedUnder))
    ? await sql`
        SELECT fv.id
          FROM public.cultivar fv
         WHERE fv.id = ${filedUnder}::uuid
           AND fv.deleted_at IS NULL
           AND fv.created_by = ANY(${householdIds})
           AND fv.blend_key = ${verdict.blend.key}
      `
    : [];
  if (filed.length) return null;
  return { error: BLEND_REQUIRED, code: 'blend_required', component_variety_ids: verdict.blend.component_variety_ids };
}

// THE GUARANTEE — the same rules, judged inside the write's transaction, once.
//
// Placed AFTER the lot lock and the planting share locks and BEFORE the first write. Under those
// locks the lot's link rows, its filed variety and each named planting's variety hold still. (The
// variety rows themselves are not locked: a crop edited on one mid-transaction is read once, here,
// and the verdict stands for every statement after it — which is the point of holding it.)
//
// It answers one row, { rules_hold, go }, and sets app.seed_lot_go for the writes that follow:
// 'go' only when the rules hold AND everything judged before it said go (`alone` = nothing was
// judged before it: POST, where the lot was created by this same transaction). No row, and no
// setting, when the lot is not the caller's live seed lot — the writes carry that predicate too.
//
// FEWER THAN TWO PLANTINGS: the rules cannot apply, so the statement names no table at all. That is
// POST's one-parent create — what every shipped client sends — which must not come to depend on a
// column this release adds.
//
// `varietyId` as in checkParentRules; NULL reads the lot's own variety_id, which on POST is the one
// the lot INSERT just wrote.
//
// The mix's key is built here from the same leaves blendKeyOf reads: a variety with no blend_key is
// its own leaf, one with a key contributes that key's ids.
export function judgeParentRules(sql, { lotId, ids, householdIds, varietyId = null, alone = false }) {
  if (ids.length < 2) {
    return sql`
      SELECT TRUE AS rules_hold,
             set_config('app.seed_lot_go',
               CASE WHEN ${alone}::boolean OR current_setting('app.seed_lot_go', true) = 'go'
                    THEN 'go' ELSE 'stop' END, true) AS go
    `;
  }
  return sql`
    SELECT r.rules_hold,
           set_config('app.seed_lot_go',
             CASE WHEN r.rules_hold
                   AND (${alone}::boolean OR current_setting('app.seed_lot_go', true) = 'go')
                  THEN 'go' ELSE 'stop' END, true) AS go
      FROM (
        SELECT (cardinality(${ids}::uuid[]) < 2
                OR m.added = 0
                OR (m.added_bare = 0
                    AND m.crops <= 1
                    AND (m.cultivars < 2 OR m.filed_as_mix))) AS rules_hold
          FROM (
            SELECT (SELECT count(*)
                      FROM unnest(${ids}::uuid[]) AS q(plant_id)
                     WHERE NOT EXISTS (
                             SELECT 1 FROM public.seed_lot_parent_planting k
                              WHERE k.inventory_item_id = i.id
                                AND k.plant_id = q.plant_id
                                AND k.role = 'seed_parent'
                                AND k.deleted_at IS NULL)) AS added,
                   (SELECT count(*)
                      FROM unnest(${ids}::uuid[]) AS q(plant_id)
                      LEFT JOIN public.garden_node p
                             ON p.id = q.plant_id
                            AND p.created_by = ANY(${householdIds})
                     WHERE p.cultivar_id IS NULL
                       AND NOT EXISTS (
                             SELECT 1 FROM public.seed_lot_parent_planting k
                              WHERE k.inventory_item_id = i.id
                                AND k.plant_id = q.plant_id
                                AND k.role = 'seed_parent'
                                AND k.deleted_at IS NULL)) AS added_bare,
                   (SELECT count(*)
                      FROM (SELECT DISTINCT pv.crop_type_slug
                              FROM public.garden_node p
                              JOIN public.cultivar pv ON pv.id = p.cultivar_id
                             WHERE p.id = ANY(${ids}::uuid[])
                               AND p.created_by = ANY(${householdIds})) d) AS crops,
                   (SELECT count(DISTINCT p.cultivar_id)
                      FROM public.garden_node p
                     WHERE p.id = ANY(${ids}::uuid[])
                       AND p.created_by = ANY(${householdIds})) AS cultivars,
                   EXISTS (
                     SELECT 1 FROM public.cultivar fv
                      WHERE fv.id = COALESCE(${varietyId}::uuid, i.variety_id)
                        AND fv.deleted_at IS NULL
                        AND fv.created_by = ANY(${householdIds})
                        AND fv.blend_key = (
                              SELECT string_agg(f.leaf::text, ',' ORDER BY f.leaf)
                                FROM (SELECT DISTINCT u.leaf
                                        FROM public.garden_node p
                                        JOIN public.cultivar pv ON pv.id = p.cultivar_id
                                       CROSS JOIN LATERAL unnest(
                                               CASE WHEN pv.blend_key IS NULL THEN ARRAY[pv.id]
                                                    ELSE string_to_array(pv.blend_key, ',')::uuid[]
                                               END) AS u(leaf)
                                       WHERE p.id = ANY(${ids}::uuid[])
                                         AND p.created_by = ANY(${householdIds})) f)) AS filed_as_mix
              FROM public.inventory_items i
             WHERE i.id = ${lotId}
               AND i.created_by = ANY(${householdIds})
               AND i.deleted_at IS NULL
               AND i.category = 'seeds'
          ) m
      ) r
  `;
}
