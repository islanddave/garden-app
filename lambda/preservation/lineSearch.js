// Release F — GET /api/kitchen-batches/line-search?q= (06 §1.2 "Line linking", §4; contract-F §2.2).
//
// The narrow search behind "What went in": plantings (each with its recent picks inline, so "Which
// pick?" needs no second round trip) and put-ups (jars to draw from). Nothing else — the crop/variety
// corpus is B′'s. Household only, on the same strict dialect every planting loader in this Lambda uses.
//
// Matched as a LITERAL path before any `:id` capture (kitchenBatch.js parseKitchenRoute), so
// 'line-search' can never be read as a batch id.
//
// Put-ups exclude soft-deleted jars and (boss F2) jars that are used up — remaining_count = 0 or
// consumed_at set: a draw from one would be refused (409 jar_used_up), so it is not offered.
// suggested_form follows 06 §2.6.6 — from the jar's METHOD first (dehydrate/powder → dried;
// roast_freeze → cooked; the other *_freeze methods → frozen), and only for other / purchased_preserved
// from the place (a freezer → frozen). It is a suggestion; the line's form is always editable.
import { MASS_G } from './kitchenBatch.js';
import { ET_TZ } from './useBy.js';

export const LINE_SEARCH_LIMIT = 12;
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

export async function lineSearch(sql, query, householdIds) {
  const q = String(query?.q ?? '').trim();
  if (!q) return { status: 400, body: { error: 'type something to search for' } };
  const pat = likePattern(q);
  const plantings = await sql`
    SELECT gn.id AS plant_id, gn.display_name AS label, cv.crop_type_slug, gn.cultivar_id AS variety_id,
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
  `;
  const jars = await sql`
    SELECT p.id AS preservation_log_id, p.label, p.method, p.crop_type_slug, p.variety_id,
           p.quantity_value, p.quantity_unit, p.package_count, p.remaining_count, p.remaining_amount,
           CASE WHEN p.package_count = 1 AND p.quantity_unit = ANY(${MASS_UNITS}::text[])
                THEN 'weighed' ELSE 'counted' END AS stock_mode,
           s.kind AS storage_kind
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
  `;
  return {
    status: 200,
    body: {
      plantings,
      put_ups: jars.map(({ storage_kind: kind, ...j }) => ({ ...j, suggested_form: suggestedForm(j.method, kind) })),
    },
  };
}
