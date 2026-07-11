// healthcheck-cultivar-facets.mjs — L-239 belt-and-suspenders DETECTOR (read-only companion to
// reconcile-cultivar-facets.mjs). Fails (exit 1) if any live cultivar is missing a DERIVED facet tag
// it should have per computeDerivedTags — most importantly the facet='type' tag whose absence hides a
// planting from the Garden by-type (faceted) view (the 2026-07-10 Black Krim bug class). Covers every
// derived facet (type, lifecycle, heat, determinacy, day_length, allium_type, basil_use). Writes NOTHING.
// Run on demand or from the weekly garden-project-state-audit task.
//   Usage: DATABASE_URL=<neon-url> node scripts/healthcheck-cultivar-facets.mjs
import { neon } from '@neondatabase/serverless';
import { computeDerivedTags } from '../lambda/tags/crop-derive.js';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
const sql = neon(url);

const crops = await sql`SELECT slug, display_name, default_lifecycle FROM public.crop_types WHERE deleted_at IS NULL`;
const bySlug = {};
for (const c of crops) bySlug[c.slug] = c;

const cvs = await sql`
  SELECT id, name, crop_type_slug, lifecycle, scoville_max, growth_habit, species, determinacy, day_length_response
  FROM public.plant_varieties WHERE deleted_at IS NULL`;

const links = await sql`
  SELECT et.entity_id, t.facet, t.slug
  FROM public.entity_tag et JOIN public.tag t ON t.id = et.tag_id
  WHERE et.entity_type='cultivar' AND et.deleted_at IS NULL AND t.deleted_at IS NULL AND t.source='derived'`;
const liveByCv = new Map();
for (const l of links) {
  if (!liveByCv.has(l.entity_id)) liveByCv.set(l.entity_id, new Set());
  liveByCv.get(l.entity_id).add(`${l.facet}:${l.slug}`);
}

const gaps = [];
for (const cv of cvs) {
  const desired = computeDerivedTags(cv, bySlug);
  const live = liveByCv.get(cv.id) ?? new Set();
  for (const d of desired) {
    if (!live.has(`${d.facet}:${d.slug}`)) {
      gaps.push({ id: cv.id, name: cv.name, missing: `${d.facet}:${d.slug}`, is_type: d.facet === 'type' });
    }
  }
}

const typeGaps = gaps.filter(g => g.is_type);
console.log(JSON.stringify({ cultivars: cvs.length, derived_links: links.length, gaps: gaps.length, type_gaps: typeGaps.length }));
if (gaps.length) {
  for (const g of gaps.slice(0, 50)) console.error(`GAP ${g.is_type ? '[TYPE-HIDES-PLANTING] ' : ''}${g.name} (${g.id}) missing ${g.missing}`);
  console.error(`FAIL: ${gaps.length} missing derived facet link(s), ${typeGaps.length} of them facet=type. Run: node scripts/reconcile-cultivar-facets.mjs`);
  process.exit(1);
}
console.log('OK: every live cultivar has all its derived facet tags.');
