// Release F — GET /api/kitchen-batches/line-search?q= (06 §1.2 "Line linking", §4; contract-F §2.2).
// B′ release 3 widens the corpus to V4 §2.5a's whole name search: every planting (ended and archived
// ones included), what we have (put-ups AND pantry items), and crops and varieties.
//
// THE RESPONSE (additive — F's two keys keep their shape, so a stale bundle still reads them):
//   { plantings, put_ups,                 ← F's arms, unchanged keys (plantings gain status words)
//     pantry_items, crops, varieties,     ← B′'s arms
//     hits,                               ← every arm merged and RANKED once (rankHits below)
//     resolved_crop }                     ← the typed text's crop by V4 §2.5a's rule, or null
// RANKING, stated once (V4 §2.5a): exact whole-name matches, then names starting with the text, then
// names containing it; within each, live plantings, ended plantings, what we have (put-ups, pantry
// items), then crops and varieties; ties by most recent (then by name, then key, so it is total).
//
// Plantings carry their recent picks inline, so "Which pick?" needs no second round trip. Household
// only, on the same strict dialect every planting loader in this Lambda uses. Varieties are the
// household's own (created by a member) or ones a household planting grows; crops are the shared list.
//
// Matched as a LITERAL path before any `:id` capture (kitchenBatch.js parseKitchenRoute), so
// 'line-search' can never be read as a batch id.
//
// Put-ups exclude soft-deleted jars and (boss F2) jars that are used up — remaining_count = 0 or
// consumed_at set: a draw from one would be refused (409 jar_used_up), so it is not offered. Pantry
// items exclude removed and used-up items for the same reason.
// suggested_form follows 06 §2.6.6 — from the jar's METHOD first (dehydrate/powder → dried;
// roast_freeze → cooked; the other *_freeze methods → frozen), and only for other / purchased_preserved
// from the place (a freezer → frozen). It is a suggestion; the line's form is always editable.
import { MASS_G } from './kitchenBatch.js';
import { ET_TZ } from './useBy.js';

// Per arm. Wide enough that a household with many jars of one crop still sees every live one (a
// short cap silently hid the jar he meant — integration run 36631452977); the list is the search.
export const LINE_SEARCH_LIMIT = 50;
export const RECENT_PICKS = 5;
const MASS_UNITS = Object.keys(MASS_G);

export function suggestedForm(method, storageKind) {
  if (method === 'dehydrate' || method === 'powder') return 'dried';
  if (method === 'roast_freeze') return 'cooked';
  if (method === 'whole_freeze' || method === 'blanch_freeze') return 'frozen';
  if (method === 'other' || method === 'purchased_preserved') {
    return storageKind === 'deep_freezer' || storageKind === 'fridge_freezer' ? 'frozen' : null;
  }
  return null;
}

// LIKE metacharacters in what he typed are literal.
export const likePattern = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// A planting has ENDED when it is archived or its status says it is over. Everything else is live.
export const ENDED_STATUSES = ['ended', 'failed'];

// ── ranking (pure; executed by lineSearch.test.js) ───────────────────────────────────────────────
const TIER = { exact: 0, starts: 1, contains: 2 };
// V4 §2.5a's groups, in order.
const GROUP = { live: 0, ended: 1, stock: 2, catalog: 3 };

const lc = (v) => String(v ?? '').trim().toLowerCase();
// The best tier any of a hit's names reaches for the text, or null when none contains it.
export function matchTier(q, names) {
  const t = lc(q);
  if (!t) return null;
  let best = null;
  for (const n of names) {
    const name = lc(n);
    if (!name) continue;
    const tier = name === t ? 'exact' : name.startsWith(t) ? 'starts' : name.includes(t) ? 'contains' : null;
    if (tier && (best == null || TIER[tier] < TIER[best])) best = tier;
  }
  return best;
}

const ms = (v) => {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

// Every arm → one list of hits, each { kind, key, label, tier, group, recent_at, ...its own fields },
// ranked. A row that matches none of its names (the SQL is wider, e.g. a crop slug) is dropped.
export function rankHits(q, { plantings = [], put_ups = [], pantry_items = [], crops = [], varieties = [] } = {}) {
  const hits = [];
  const push = (kind, key, names, group, recent, row) => {
    const tier = matchTier(q, names);
    if (!tier) return;
    hits.push({ ...row, kind, key, tier, group, recent_at: recent ?? null });
  };
  for (const p of plantings) {
    push('planting', `planting:${p.plant_id}`, [p.label, p.variety_name], p.ended ? 'ended' : 'live', p.recent_at, p);
  }
  for (const j of put_ups) push('put_up', `jar:${j.preservation_log_id}`, [j.label, j.crop_name], 'stock', j.recent_at, j);
  for (const i of pantry_items) push('pantry_item', `pantry:${i.pantry_item_id}`, [i.label], 'stock', i.recent_at, i);
  for (const c of crops) push('crop', `crop:${c.crop_type_slug}`, [c.label], 'catalog', null, c);
  for (const v of varieties) push('variety', `variety:${v.variety_id}`, [v.label], 'catalog', null, v);
  return hits.sort((a, b) => (TIER[a.tier] - TIER[b.tier])
    || (GROUP[a.group] - GROUP[b.group])
    || ((ms(b.recent_at) ?? -Infinity) - (ms(a.recent_at) ?? -Infinity))
    || lc(a.label).localeCompare(lc(b.label))
    || a.key.localeCompare(b.key));
}

// V4 §2.5a "Resolved crop", for a TYPED name: an exact whole-name cultivar match to ONE crop, else
// none. (A planting hit resolves through its variety and a stock hit through its row's crop — both are
// already on those hits as crop_type_slug.)
export function resolvedCropOf(q, varieties = []) {
  const t = lc(q);
  const slugs = new Set(varieties.filter((v) => lc(v.label) === t && v.crop_type_slug).map((v) => v.crop_type_slug));
  return slugs.size === 1 ? [...slugs][0] : null;
}

export async function lineSearch(sql, query, householdIds) {
  const q = String(query?.q ?? '').trim();
  if (!q) return { status: 400, body: { error: 'type something to search for' } };
  const pat = likePattern(q);
  const [plantings, jars, pantryItems, crops, varieties] = await Promise.all([
    sql`
    SELECT gn.id AS plant_id, gn.display_name AS label, cv.crop_type_slug, gn.cultivar_id AS variety_id,
           cv.display_name AS variety_name, gn.status,
           (gn.archived_at IS NOT NULL OR COALESCE(gn.status = ANY(${ENDED_STATUSES}::text[]), false)) AS ended,
           COALESCE(gn.planted_out_at, gn.transplanted_at, gn.sown_at, gn.created_at) AS recent_at,
           COALESCE((
             SELECT json_agg(json_build_object('harvest_log_id', r.id, 'picked_on', r.picked_on,
                                               'qty', r.quantity, 'qty_unit', r.unit)
                             ORDER BY r.event_date DESC, r.id DESC)
             FROM (SELECT h.id, h.quantity, h.unit, e.event_date,
                          to_char(e.event_date AT TIME ZONE ${ET_TZ}::text, 'YYYY-MM-DD') AS picked_on
                     FROM harvest_log h
                     JOIN event_log e ON e.id = h.event_id AND e.deleted_at IS NULL
                    WHERE e.plant_id = gn.id
                      AND h.deleted_at IS NULL
                      AND h.created_by = ANY(${householdIds})
                    ORDER BY e.event_date DESC, h.id DESC
                    LIMIT ${RECENT_PICKS}) r
           ), '[]'::json) AS recent_picks
    FROM garden_node gn
    LEFT JOIN container pp ON pp.id = gn.container_id
    LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
    WHERE gn.deleted_at IS NULL
      AND ( pp.created_by = ANY(${householdIds})
            OR (gn.container_id IS NULL AND gn.created_by = ANY(${householdIds})) )
      AND (gn.display_name ILIKE ${pat} OR cv.display_name ILIKE ${pat})
    ORDER BY gn.display_name, gn.id
    LIMIT ${LINE_SEARCH_LIMIT}
  `,
    sql`
    SELECT p.id AS preservation_log_id, p.label, p.method, p.crop_type_slug, p.variety_id,
           p.quantity_value, p.quantity_unit, p.package_count, p.remaining_count, p.remaining_amount,
           CASE WHEN p.package_count = 1 AND p.quantity_unit = ANY(${MASS_UNITS}::text[])
                THEN 'weighed' ELSE 'counted' END AS stock_mode,
           s.kind AS storage_kind, ct.display_name AS crop_name, p.preserved_at AS recent_at
    FROM preservation_log p
    LEFT JOIN storage_location s ON s.id = p.storage_location_id
    LEFT JOIN crop_types ct ON ct.slug = p.crop_type_slug
    WHERE p.user_id = ANY(${householdIds})
      AND p.deleted_at IS NULL
      AND (p.remaining_count IS NULL OR p.remaining_count > 0)
      AND p.consumed_at IS NULL
      AND (p.label ILIKE ${pat} OR ct.display_name ILIKE ${pat} OR p.crop_type_slug ILIKE ${pat})
    ORDER BY p.preserved_at DESC, p.id DESC
    LIMIT ${LINE_SEARCH_LIMIT}
  `,
    sql`
    SELECT pit.id AS pantry_item_id, pit.name AS label, pit.crop_type_slug, pit.plant_id,
           s.label AS place_label, COALESCE(pit.acquired_at::timestamptz, pit.created_at) AS recent_at
    FROM pantry_item pit
    LEFT JOIN storage_location s ON s.id = pit.storage_location_id
    WHERE pit.user_id = ANY(${householdIds})
      AND pit.deleted_at IS NULL
      AND pit.used_up_at IS NULL
      AND pit.name ILIKE ${pat}
    ORDER BY pit.created_at DESC, pit.id DESC
    LIMIT ${LINE_SEARCH_LIMIT}
  `,
    sql`
    SELECT ct.slug AS crop_type_slug, ct.display_name AS label
    FROM crop_types ct
    WHERE ct.display_name ILIKE ${pat}
    ORDER BY ct.display_name, ct.slug
    LIMIT ${LINE_SEARCH_LIMIT}
  `,
    sql`
    SELECT cv.id AS variety_id, cv.display_name AS label, cv.crop_type_slug
    FROM cultivar cv
    WHERE cv.deleted_at IS NULL
      AND cv.display_name ILIKE ${pat}
      AND ( cv.created_by = ANY(${householdIds})
            OR EXISTS (SELECT 1 FROM garden_node gn
                        LEFT JOIN container pp ON pp.id = gn.container_id
                        WHERE gn.cultivar_id = cv.id AND gn.deleted_at IS NULL
                          AND ( pp.created_by = ANY(${householdIds})
                                OR (gn.container_id IS NULL AND gn.created_by = ANY(${householdIds})) )) )
    ORDER BY cv.display_name, cv.id
    LIMIT ${LINE_SEARCH_LIMIT}
  `,
  ]);
  const put_ups = jars.map(({ storage_kind: kind, ...j }) => ({ ...j, suggested_form: suggestedForm(j.method, kind) }));
  const arms = { plantings, put_ups, pantry_items: pantryItems, crops, varieties };
  return {
    status: 200,
    body: { ...arms, hits: rankHits(q, arms), resolved_crop: resolvedCropOf(q, varieties) },
  };
}
