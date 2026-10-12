// V4-CROPTYPERETIRE-001 — retire and restore a crop type, for the admin page at /admin/crop-types.
//
// Three routes hang off this module, all dispatched from ./index.js:
//   GET  /api/varieties/crop-types/admin   every type, retired ones included, with what still uses it
//   POST /api/varieties/crop-types/retire  { slug }          soft-delete (deleted_at = now())
//   POST /api/varieties/crop-types         { restore_slug }  the existing restore arm, entered by slug
//
// The SQL lives here rather than in index.js so that no statement in that file changes position.
//
// WHAT RETIRE MAY NOT DO. A retired type leaves GET /api/varieties/crop-types, and every picker with
// it, so a type that anything live still names must stay. The guard therefore covers EVERY table with
// a foreign key to crop_types(slug) — CROP_TYPE_DEPENDENTS below — and crop-type-admin.test.js derives
// that list from migrations/ and fails when a table appears there that is not listed here. The food
// classes (category non_plant_food: bread, cheese, ...) are refused by category: Put Up reads them and
// migrations/v4-putupfood-001/gates.yml requires each to stay live.
//
// NO event_log ROW. event_log_has_anchor requires a planting or a project and a crop type has
// neither, so each retire and restore is recorded as one structured log line instead (auditLine).

export const NON_PLANT_FOOD_CATEGORY = 'non_plant_food';

// The distinct code a non-admin gets when the name typed into an inline "new crop type" form matches
// a retired type. Both inline forms key their one plain line on it (src/lib/cropTypeRetired.js).
export const RETIRED_CODE = 'crop_type_retired';
export const RETIRED_MESSAGE = "That crop type was retired. Ask the garden's admin to bring it back.";
// ADMIN_CLERK_SUBS unset or empty: the gate refuses everyone, and the admin page says so in words.
export const NOT_CONFIGURED_CODE = 'admin_not_configured';

export const FOOD_CLASS_REFUSAL = "Food types like bread and cheese are part of Put Up and can't be retired.";
export const ALREADY_RETIRED = 'That crop type is already retired.';
export const NOT_RETIRED = "That crop type isn't retired.";
export const NOT_FOUND = "That crop type doesn't exist.";
export const RACE_REFUSAL = 'Something started using this crop type just now. Reload and try again.';

// Fail-CLOSED admin gate, copied from lambda/tags/validate.js. Unset/empty ADMIN_CLERK_SUBS -> nobody
// is admin -> 403 for all.
export function isAdmin(userId, env) {
  const subs = (env.ADMIN_CLERK_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return subs.length > 0 && subs.includes(userId);
}

function adminConfigured(env) {
  return (env.ADMIN_CLERK_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean).length > 0;
}

// The refusal body for an admin-only route, or null when the caller may proceed. The status is 403
// either way; `code` is present only when nobody could have passed.
export function adminRefusal(userId, env) {
  if (isAdmin(userId, env)) return null;
  return adminConfigured(env) ? { error: 'Admin only' } : { error: 'Admin only', code: NOT_CONFIGURED_CODE };
}

// Every table with a foreign key to crop_types(slug). `table` is the base table the constraint is on
// (plant_varieties is read through its view public.cultivar, as everywhere in this directory);
// `key` is the count's name in the listing; `one`/`many` are the words the refusal uses.
export const CROP_TYPE_DEPENDENTS = [
  { table: 'plant_varieties', key: 'varieties', one: 'variety', many: 'varieties' },
  { table: 'preservation_log', key: 'put_ups', one: 'put-up', many: 'put-ups' },
  { table: 'pantry_item', key: 'pantry_items', one: 'pantry item', many: 'pantry items' },
  { table: 'kitchen_batch_input', key: 'batches', one: 'batch', many: 'batches' },
  { table: 'preservation_source', key: 'put_up_sources', one: 'put-up source', many: 'put-up sources' },
];

// "Still used by 3 pantry items and 1 batch." — null when nothing live names the type.
export function usageSentence(counts) {
  const parts = CROP_TYPE_DEPENDENTS
    .map(d => ({ n: Number(counts?.[d.key] ?? 0), d }))
    .filter(p => p.n > 0)
    .map(p => `${p.n} ${p.n === 1 ? p.d.one : p.d.many}`);
  if (parts.length === 0) return null;
  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Still used by ${list}.`;
}

// One listing row from one usage row. `why_not` is the sentence the page prints under a type that
// cannot be retired; it is null for a retired type (the page offers Bring back there instead).
export function describeType(row) {
  const counts = Object.fromEntries(CROP_TYPE_DEPENDENTS.map(d => [d.key, Number(row[d.key] ?? 0)]));
  const retired = row.deleted_at != null;
  const why = retired ? null
    : row.category === NON_PLANT_FOOD_CATEGORY ? FOOD_CLASS_REFUSAL
    : usageSentence(counts);
  return {
    slug: row.slug,
    display_name: row.display_name,
    category: row.category ?? null,
    retired,
    retired_at: row.deleted_at ?? null,
    counts,
    can_retire: !retired && why == null,
    why_not: why,
  };
}

// The record of who retired or restored what. Exactly these four keys, on one line.
export function auditLine(evt, slug, by, at = new Date()) {
  return JSON.stringify({ evt, slug, by, at: at.toISOString() });
}

// Every type (slug null) or one type, with its live-row count per dependent table. No deleted_at
// filter on crop_types: the page lists retired types so they can be brought back. A batch counts
// once however many of its ingredients name the type.
async function loadUsage(sql, slug) {
  return sql`
    SELECT ct.slug, ct.display_name, ct.category, ct.sort_order, ct.deleted_at,
           (SELECT count(*)::int FROM public.cultivar cv
             WHERE cv.crop_type_slug = ct.slug AND cv.deleted_at IS NULL) AS varieties,
           (SELECT count(*)::int FROM public.preservation_log pl
             WHERE pl.crop_type_slug = ct.slug AND pl.deleted_at IS NULL) AS put_ups,
           (SELECT count(*)::int FROM public.pantry_item pit
             WHERE pit.crop_type_slug = ct.slug AND pit.deleted_at IS NULL) AS pantry_items,
           (SELECT count(DISTINCT kbi.batch_id)::int FROM public.kitchen_batch_input kbi
             WHERE kbi.crop_type_slug = ct.slug AND kbi.deleted_at IS NULL) AS batches,
           (SELECT count(*)::int FROM public.preservation_source ps
             WHERE ps.crop_type_slug = ct.slug AND ps.deleted_at IS NULL) AS put_up_sources
    FROM public.crop_types ct
    WHERE (${slug}::text IS NULL OR ct.slug = ${slug}::text)
    ORDER BY ct.sort_order ASC, ct.display_name ASC
  `;
}

// GET /api/varieties/crop-types/admin
export async function listForAdmin(sql, userId, env) {
  const refusal = adminRefusal(userId, env);
  if (refusal) return { status: 403, body: refusal };
  const rows = await loadUsage(sql, null);
  return { status: 200, body: { types: rows.map(describeType) } };
}

// POST /api/varieties/crop-types/retire  { slug }
export async function retireCropType(sql, body, userId, env) {
  const refusal = adminRefusal(userId, env);
  if (refusal) return { status: 403, body: refusal };
  const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
  if (!slug) return { status: 400, body: { error: 'slug is required' } };

  const [row] = await loadUsage(sql, slug);
  if (!row) return { status: 404, body: { error: NOT_FOUND } };
  const type = describeType(row);
  if (type.retired) return { status: 409, body: { error: ALREADY_RETIRED, code: 'already_retired', type } };
  if (!type.can_retire) {
    const code = row.category === NON_PLANT_FOOD_CATEGORY ? 'food_class' : 'in_use';
    return { status: 409, body: { error: type.why_not, code, type } };
  }

  // The guard is repeated inside the write, so a row that started naming the type between the read
  // above and this statement still stops the retire. updated_at is set by hand: crop_types has no
  // trigger that would.
  const [retired] = await sql`
    UPDATE public.crop_types ct
       SET deleted_at = now(), updated_at = now()
     WHERE ct.slug = ${slug}
       AND ct.deleted_at IS NULL
       AND (ct.category IS NULL OR ct.category <> ${NON_PLANT_FOOD_CATEGORY})
       AND NOT EXISTS (SELECT 1 FROM public.cultivar cv
                        WHERE cv.crop_type_slug = ct.slug AND cv.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.preservation_log pl
                        WHERE pl.crop_type_slug = ct.slug AND pl.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.pantry_item pit
                        WHERE pit.crop_type_slug = ct.slug AND pit.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.kitchen_batch_input kbi
                        WHERE kbi.crop_type_slug = ct.slug AND kbi.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.preservation_source ps
                        WHERE ps.crop_type_slug = ct.slug AND ps.deleted_at IS NULL)
    RETURNING ct.slug, ct.display_name, ct.category, ct.sort_order, ct.deleted_at
  `;
  if (!retired) return { status: 409, body: { error: RACE_REFUSAL, code: 'in_use' } };
  console.log(auditLine('crop_type_retired', retired.slug, userId));
  return { status: 200, body: { ...describeType(retired), retired: true } };
}

// The restore arm of POST /api/varieties/crop-types. Two ways in, one write:
//   inline — a signed-in user typed a name that resolves to a retired type (`inline: true`). An admin
//            gets the type back, as before; anyone else gets RETIRED_CODE, because a deliberate
//            retire must not be undone by typing the name.
//   door   — the admin page sent { restore_slug }. Admin only, refused like every admin route.
// The reply keeps the shape the inline forms already read: the type's columns plus restored: true.
export async function restoreCropType(sql, slug, userId, env, { inline = false } = {}) {
  if (!isAdmin(userId, env)) {
    return inline
      ? { status: 403, body: { error: RETIRED_MESSAGE, code: RETIRED_CODE } }
      : { status: 403, body: adminRefusal(userId, env) };
  }
  const key = typeof slug === 'string' ? slug.trim() : '';
  if (!key) return { status: 400, body: { error: 'restore_slug is required' } };
  const [restored] = await sql`
    UPDATE public.crop_types
       SET deleted_at = NULL, updated_at = now()
     WHERE slug = ${key} AND deleted_at IS NOT NULL
    RETURNING slug, display_name, default_lifecycle, category, sort_order
  `;
  if (!restored) {
    const [live] = await sql`SELECT ct.slug FROM public.crop_types ct WHERE ct.slug = ${key}`;
    return live
      ? { status: 409, body: { error: NOT_RETIRED, code: 'not_retired' } }
      : { status: 404, body: { error: NOT_FOUND } };
  }
  console.log(auditLine('crop_type_restored', restored.slug, userId));
  return { status: 200, body: { ...restored, restored: true } };
}
