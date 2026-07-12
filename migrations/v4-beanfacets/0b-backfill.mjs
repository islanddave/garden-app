// 0b-backfill.mjs — V4-BEANFACET-001. Run AFTER 0a, BEFORE 0c-validate, on prod (and staging if used).
//   Usage: DATABASE_URL=<neon-url> node migrations/v4-beanfacets/0b-backfill.mjs
// No column backfill (bean facets derive from existing name/genus/species/growth_habit). Just runs
// applyDerive over every live cultivar to materialize/reconcile the derived tag set — idempotent, and
// a no-op for the bean facets until bean varieties exist. Safe to re-run.
import { neon } from '@neondatabase/serverless';
import { applyDerive } from '../../lambda/tags/crop-derive.js';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
const sql = neon(url);

const beans = await sql`SELECT count(*)::int AS n FROM public.plant_varieties WHERE crop_type_slug='bean' AND deleted_at IS NULL`;
const res = await applyDerive(sql, null);
console.log(JSON.stringify({ bean_varieties: beans[0].n,
  derive: { tags_upserted: res.tags_upserted, links_added: res.links_added, links_removed: res.links_removed, cultivars: res.cultivars, failures: res.failures.length } }));
if (res.failures.length) { console.error('DERIVE FAILURES:', JSON.stringify(res.failures.slice(0, 10))); process.exit(2); }
