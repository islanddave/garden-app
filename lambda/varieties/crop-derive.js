// crop-derive.js — V4-TAGSUB-001 derive engine (SHARED, byte-identical copy in lambda/tags + lambda/varieties).
// Each Lambda is zipped from its own dir so a ../ import is NOT packaged (same constraint as household.js).
// Kept in sync by lambda/crop-derive-copies-sync.test.js. Canonical edits land in BOTH copies.
//
// Derives read-only `type:<crop_type_slug>` and `lifecycle:<x>` tags FROM the cultivar's structured
// crop attribute and materializes them as system-owned (owner_id='system', source='derived',
// visibility='shared') tag rows + entity_tag links on entity_type='cultivar'. Plantings project these
// at render time via garden_node.variety_id -> cultivar (NOT materialized per-planting).
//
// V4-CLASSIFY-001 adds five more DERIVED facets (same system-owned class as type/lifecycle — NOT
// hand-assignable, so they are intentionally NOT in lambda/tags/validate.js VALID_USER_FACETS):
//   heat (peppers, by scoville_max ceiling), determinacy (tomatoes), day_length (onions),
//   allium_type (bulbing|bunching), basil_use (culinary|thai|tulsi). The DB tag_facet_check must
//   already list these facets (migrations/v4-classify/0a-additive-ddl.sql).
//
// Crucible V101 deltas baked in: revive-or-insert against the soft-delete partial-unique (no dup
// accumulation, no 42P10), type-branch guarded against drifted slugs, lifecycle whitelisted, desired-vs-
// actual reconciliation soft-deletes stale derived links only (never user links). applyDerive takes a
// passed-in neon `sql` connection and runs IN-PROCESS (no HTTP, no admin gate) so the varieties Lambda
// can call it post-commit, fail-open.

export const VALID_LIFECYCLE = ['annual', 'perennial', 'biennial', 'tender_perennial'];

export function humanizeLifecycle(lc) {
  return String(lc).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── V4-CLASSIFY-001 derivation helpers (pure) ───────────────────────────────────────────────────
// Heat: classify a pepper by the CEILING of its Scoville range (the hottest pod it can throw). A
// cultivar belongs to the band its scoville_max lands in; min/width ignored — e.g. Santa Fe Grande
// (max ~8k) = Medium, not Hot. Bands chosen so cut points fall in gaps in the real collection.
export const HEAT_BANDS = [
  { max: 0,        slug: 'sweet',    label: 'Sweet' },
  { max: 999,      slug: 'mild',     label: 'Mild' },
  { max: 9999,     slug: 'medium',   label: 'Medium' },
  { max: 49999,    slug: 'hot',      label: 'Hot' },
  { max: 249999,   slug: 'very_hot', label: 'Very Hot' },
  { max: Infinity, slug: 'superhot', label: 'Superhot' },
];
export function heatBand(scovilleMax) {
  if (scovilleMax == null) return null;
  const n = Number(scovilleMax);
  if (!Number.isFinite(n) || n < 0) return null;
  for (const b of HEAT_BANDS) if (n <= b.max) return b;
  return null;
}

// Determinacy from free-text growth_habit prose. Substring-safe ('indeterminate' contains
// 'determinate'; 'semi-determinate' contains 'determinate') AND primary-term-aware: the LEFTMOST of
// {semi_determinate, indeterminate, determinate} wins, so "indeterminate vine (semi-determinate per
// some sources)" -> indeterminate, not semi. 'dwarf' is a REFINEMENT of determinate only (a
// "determinate dwarf bush" -> dwarf; dwarf never overrides an indeterminate/semi primary).
export const DETERMINACY_LABELS = { determinate: 'Determinate', semi_determinate: 'Semi-Determinate', indeterminate: 'Indeterminate', dwarf: 'Dwarf' };
export function parseDeterminacy(prose) {
  if (!prose) return null;
  const s = String(prose).toLowerCase();
  const semi = s.search(/semi[-_ ]?determinate/);
  const indet = s.indexOf('indeterminate');
  const blanked = s.replace(/semi[-_ ]?determinate/g, m => ' '.repeat(m.length)).replace(/indeterminate/g, m => ' '.repeat(m.length));
  const det = blanked.indexOf('determinate');
  const cands = [];
  if (semi >= 0) cands.push([semi, 'semi_determinate']);
  if (indet >= 0) cands.push([indet, 'indeterminate']);
  if (det >= 0) cands.push([det, 'determinate']);
  if (!cands.length) return null;
  cands.sort((a, b) => a[0] - b[0]);
  let primary = cands[0][1];
  if (primary === 'determinate' && s.indexOf('dwarf') >= 0) primary = 'dwarf';
  return primary;
}

// Onion day-length response, parsed from growth_habit prose (sourced text, never fabricated). Returns
// null when the prose doesn't state it.
export const DAY_LENGTH_LABELS = { long_day: 'Long-Day', short_day: 'Short-Day', day_neutral: 'Day-Neutral', intermediate: 'Intermediate' };
export function parseDayLength(prose) {
  if (!prose) return null;
  const s = String(prose).toLowerCase();
  if (/short[-_ ]?day/.test(s)) return 'short_day';
  if (/long[-_ ]?day/.test(s)) return 'long_day';
  if (/day[-_ ]?neutral/.test(s)) return 'day_neutral';
  if (/intermediate[-_ ]?day/.test(s)) return 'intermediate';
  return null;
}

// Allium bulbing vs bunching, from crop_type + (for onions) growth_habit prose. Leek and any onion
// whose prose doesn't state its habit get no allium_type (null — never guessed).
export const ALLIUM_LABELS = { bulbing: 'Bulbing', bunching: 'Bunching' };
export function alliumType(cropSlug, prose) {
  if (cropSlug === 'garlic' || cropSlug === 'shallot') return 'bulbing';
  if (cropSlug === 'chives') return 'bunching';
  if (cropSlug === 'onion') {
    const s = String(prose || '').toLowerCase();
    if (/non[-_ ]?bulbing|bunching|scallion/.test(s)) return 'bunching';
    if (/bulb forms|single bulb|forms a bulb/.test(s)) return 'bulbing';
  }
  return null;
}

// Basil culinary role, from species (Ocimum). Defaults to culinary sweet basil (O. basilicum).
export const BASIL_LABELS = { culinary: 'Culinary', thai: 'Thai', tulsi: 'Tulsi' };
export function basilUse(cropSlug, species) {
  if (cropSlug !== 'basil') return null;
  const sp = String(species || '').toLowerCase();
  if (!sp) return null;                        // no species -> can't classify (evidence-based, no default)
  if (sp.includes('tenuiflorum') || sp.includes('sanctum')) return 'tulsi';
  if (sp.includes('thyrsiflora')) return 'thai';
  return 'culinary';
}

// Pure: cultivar {crop_type_slug, lifecycle, scoville_max, growth_habit, species, determinacy,
// day_length_response} + cropTypesBySlug {slug:{display_name, default_lifecycle}} -> array of desired
// derived tags [{facet, slug, label}]. Never throws on a drifted/absent crop_type_slug (skip-and-log at
// the caller). Off-vocabulary lifecycle values are dropped (whitelist).
export function computeDerivedTags(cultivar, cropTypesBySlug) {
  const out = [];
  if (!cultivar) return out;
  const cropSlug = cultivar.crop_type_slug || null;
  const ct = cropSlug ? cropTypesBySlug[cropSlug] : null;
  if (cropSlug && ct) {
    out.push({ facet: 'type', slug: cropSlug, label: ct.display_name || cropSlug });
  }
  const lifecycle = cultivar.lifecycle ?? (ct ? ct.default_lifecycle : null);
  if (lifecycle && VALID_LIFECYCLE.includes(lifecycle)) {
    out.push({ facet: 'lifecycle', slug: lifecycle, label: humanizeLifecycle(lifecycle) });
  }
  // ── Classification facets (V4-CLASSIFY-001) ──
  if (cropSlug === 'pepper') {
    const b = heatBand(cultivar.scoville_max);
    if (b) out.push({ facet: 'heat', slug: b.slug, label: b.label });
  }
  if (cropSlug === 'tomato') {
    // Prefer the promoted column; fall back to parsing prose so a bulk-inserted tomato with prose but
    // an unset determinacy column is still faceted (closes the L-239 unfaceted-intake class).
    const d = cultivar.determinacy || parseDeterminacy(cultivar.growth_habit);
    if (d && DETERMINACY_LABELS[d]) out.push({ facet: 'determinacy', slug: d, label: DETERMINACY_LABELS[d] });
  }
  if (cropSlug === 'onion') {
    const dl = cultivar.day_length_response || parseDayLength(cultivar.growth_habit);
    if (dl && DAY_LENGTH_LABELS[dl]) out.push({ facet: 'day_length', slug: dl, label: DAY_LENGTH_LABELS[dl] });
  }
  const at = alliumType(cropSlug, cultivar.growth_habit);
  if (at) out.push({ facet: 'allium_type', slug: at, label: ALLIUM_LABELS[at] });
  const bu = basilUse(cropSlug, cultivar.species);
  if (bu) out.push({ facet: 'basil_use', slug: bu, label: BASIL_LABELS[bu] });
  return out;
}

// get-or-revive-or-insert a system derived tag; returns its id. One atomic CTE statement, safe against
// the partial-unique uq_tag_facet_slug_owner WHERE deleted_at IS NULL (revives a soft-deleted row rather
// than inserting a duplicate live+dead pair).
async function upsertDerivedTag(sql, facet, slug, label) {
  const rows = await sql`
    WITH live AS (
      UPDATE public.tag SET label = ${label}, updated_at = now()
      WHERE facet = ${facet} AND slug = ${slug} AND owner_id = 'system' AND deleted_at IS NULL
      RETURNING id
    ), revived AS (
      UPDATE public.tag SET deleted_at = NULL, label = ${label}, updated_at = now()
      WHERE id = (
        SELECT id FROM public.tag
        WHERE facet = ${facet} AND slug = ${slug} AND owner_id = 'system' AND deleted_at IS NOT NULL
        ORDER BY created_at LIMIT 1
      ) AND NOT EXISTS (SELECT 1 FROM live)
      RETURNING id
    ), inserted AS (
      INSERT INTO public.tag (facet, label, slug, source, owner_id, visibility, created_by)
      SELECT ${facet}, ${label}, ${slug}, 'derived', 'system', 'shared', 'system'
      WHERE NOT EXISTS (SELECT 1 FROM live) AND NOT EXISTS (SELECT 1 FROM revived)
      RETURNING id
    )
    SELECT id FROM live UNION ALL SELECT id FROM revived UNION ALL SELECT id FROM inserted
  `;
  return rows[0].id;
}

// get-or-revive-or-insert a cultivar->tag derived link; returns its id. Same partial-unique safety on
// uq_entity_tag (tag_id, entity_type, entity_id) WHERE deleted_at IS NULL.
async function upsertCultivarLink(sql, tagId, cultivarId) {
  const rows = await sql`
    WITH live AS (
      SELECT id FROM public.entity_tag
      WHERE tag_id = ${tagId} AND entity_type = 'cultivar' AND entity_id = ${cultivarId} AND deleted_at IS NULL
    ), revived AS (
      UPDATE public.entity_tag SET deleted_at = NULL
      WHERE id = (
        SELECT id FROM public.entity_tag
        WHERE tag_id = ${tagId} AND entity_type = 'cultivar' AND entity_id = ${cultivarId} AND deleted_at IS NOT NULL
        ORDER BY created_at LIMIT 1
      ) AND NOT EXISTS (SELECT 1 FROM live)
      RETURNING id
    ), inserted AS (
      INSERT INTO public.entity_tag (tag_id, entity_type, entity_id, created_by)
      SELECT ${tagId}, 'cultivar', ${cultivarId}, 'system'
      WHERE NOT EXISTS (SELECT 1 FROM live) AND NOT EXISTS (SELECT 1 FROM revived)
      RETURNING id
    )
    SELECT id FROM live UNION ALL SELECT id FROM revived UNION ALL SELECT id FROM inserted
  `;
  return rows[0].id;
}

// Reconcile ONE cultivar's derived links to its desired set. Returns {tags_upserted, links_added, links_removed}.
// links_removed = derived links (tag.source='derived' only — never user links) no longer in the desired set.
export async function deriveForCultivar(sql, cultivar, cropTypesBySlug) {
  const desired = computeDerivedTags(cultivar, cropTypesBySlug);
  const desiredTagIds = [];
  for (const d of desired) {
    const tagId = await upsertDerivedTag(sql, d.facet, d.slug, d.label);
    await upsertCultivarLink(sql, tagId, cultivar.id);
    desiredTagIds.push(tagId);
  }
  // Soft-delete stale DERIVED links for this cultivar not in the desired set. Never touches user links.
  const removed = await sql`
    UPDATE public.entity_tag et SET deleted_at = now()
    FROM public.tag t
    WHERE et.tag_id = t.id AND t.source = 'derived'
      AND et.entity_type = 'cultivar' AND et.entity_id = ${cultivar.id} AND et.deleted_at IS NULL
      AND NOT (et.tag_id = ANY(${desiredTagIds}::uuid[]))
    RETURNING et.id
  `;
  return { tags_upserted: desired.length, links_added: desiredTagIds.length, links_removed: removed.length };
}

// Entry point. cultivarId set -> one cultivar (the inline post-commit path from the varieties Lambda).
// null -> ALL non-deleted cultivars (admin bulk backfill / drift-heal), best-effort per-cultivar so one
// bad row never aborts the batch. Returns aggregate counts + failures[].
export async function applyDerive(sql, cultivarId = null) {
  const cropTypes = await sql`SELECT slug, display_name, default_lifecycle FROM public.crop_types WHERE deleted_at IS NULL`;
  const cropTypesBySlug = {};
  for (const c of cropTypes) cropTypesBySlug[c.slug] = c;

  const cultivars = cultivarId
    ? await sql`SELECT id, crop_type_slug, lifecycle, scoville_max, growth_habit, species, determinacy, day_length_response FROM public.plant_varieties WHERE id = ${cultivarId} AND deleted_at IS NULL`
    : await sql`SELECT id, crop_type_slug, lifecycle, scoville_max, growth_habit, species, determinacy, day_length_response FROM public.plant_varieties WHERE deleted_at IS NULL`;

  const totals = { tags_upserted: 0, links_added: 0, links_removed: 0, cultivars: 0, failures: [] };
  for (const cv of cultivars) {
    try {
      const r = await deriveForCultivar(sql, cv, cropTypesBySlug);
      totals.tags_upserted += r.tags_upserted;
      totals.links_added += r.links_added;
      totals.links_removed += r.links_removed;
      totals.cultivars += 1;
    } catch (err) {
      totals.failures.push({ cultivar_id: cv.id, error: err?.message ?? String(err) });
    }
  }
  return totals;
}
