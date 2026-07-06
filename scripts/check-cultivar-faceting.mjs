// check-cultivar-faceting.mjs — L-239 health check. FAILS (exit 1) if any live cultivar carries a
// crop_type_slug but is MISSING its derived type:<slug> tag link — the tell of unfaceted intake that
// bypassed the derive hook. Intended for the weekly garden-project-state-audit (or a manual run);
// remediate by running scripts/reconcile-cultivar-facets.mjs.
// Usage: DATABASE_URL=<neon-url> node scripts/check-cultivar-faceting.mjs
import { neon } from '@neondatabase/serverless';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
const sql = neon(url);
const gaps = await sql`
  SELECT v.id, v.name, v.crop_type_slug
  FROM public.plant_varieties v
  WHERE v.deleted_at IS NULL AND v.crop_type_slug IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.entity_tag et JOIN public.tag t ON t.id = et.tag_id
      WHERE et.entity_type='cultivar' AND et.entity_id = v.id AND et.deleted_at IS NULL
        AND t.source='derived' AND t.facet='type' AND t.slug = v.crop_type_slug AND t.deleted_at IS NULL
    )
  ORDER BY v.name`;
if (gaps.length) {
  console.error(`L-239 FACETING GAP: ${gaps.length} cultivar(s) have a crop_type_slug but no derived type tag:`);
  for (const g of gaps) console.error(`  - ${g.name} (${g.crop_type_slug}) ${g.id}`);
  console.error('Remediate: DATABASE_URL=<url> node scripts/reconcile-cultivar-facets.mjs');
  process.exit(1);
}
console.log('OK: every live cultivar with a crop_type_slug has its derived type tag.');
