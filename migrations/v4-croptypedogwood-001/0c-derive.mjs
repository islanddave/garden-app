// 0c-derive.mjs — V4-CROPTYPEDOGWOOD-001 apply-time step 3 of 3.
//
// 0a-data.sql retypes the Kousa cultivar in SQL. The API does NOT stop there: every cultivar write
// is followed by applyDerive (lambda/varieties/index.js:395), which reconciles the SYSTEM-owned
// derived tags for that cultivar — here the `type` facet (dogwood/"Dogwood") and the `lifecycle`
// facet (perennial/"Perennial"). That reconciliation is a multi-statement revive-or-insert CTE plus
// a soft-delete of stale links; it is not expressible as part of the data SQL, and skipping it is
// exactly the "direct DB write skips the Lambda side effects" failure mode.
//
// So this runs the REAL engine — the same module the Lambda imports, not a reimplementation —
// scoped to the one cultivar this migration touched.
//
// Usage (never pass a URL on the command line, L-067):
//   export NEON_DATABASE_URL=...   # or NEON_STAGING_URL for staging
//   node migrations/v4-croptypedogwood-001/0c-derive.mjs
//
// Idempotent: applyDerive is a reconciliation, so a re-run is a no-op. Safe after a 0r rollback too
// — rerun it there to clear the now-dangling facets.
import { neon } from '@neondatabase/serverless';
import { applyDerive } from '../../lambda/tags/crop-derive.js';

const url = process.env.NEON_DATABASE_URL ?? process.env.NEON_STAGING_URL;
if (!url) { console.error('set NEON_DATABASE_URL (or NEON_STAGING_URL)'); process.exit(1); }
const sql = neon(url);

const CULTIVAR = '0189f4cd-aa30-47b7-81cc-f467ab767f6b';

const [cv] = await sql`
  SELECT id, name, crop_type_slug, lifecycle FROM public.plant_varieties WHERE id = ${CULTIVAR}::uuid
`;
if (!cv) {
  // Staging has no Kousa cultivar — the crop type applies there, the retype does not. Not an error.
  console.log('cultivar absent in this environment — nothing to derive (expected on staging)');
  process.exit(0);
}
console.log(`before: ${cv.name} crop_type_slug=${cv.crop_type_slug} lifecycle=${cv.lifecycle}`);

const totals = await applyDerive(sql, CULTIVAR);
console.log('applyDerive:', JSON.stringify(totals));

const tags = await sql`
  SELECT t.facet, t.slug, t.label, t.source
  FROM public.entity_tag et JOIN public.tag t ON t.id = et.tag_id
  WHERE et.entity_id = ${CULTIVAR}::uuid AND et.deleted_at IS NULL
  ORDER BY t.facet, t.slug
`;
console.log('live tags now:', tags.map(t => `${t.facet}:${t.slug}(${t.source})`).join(', ') || '(none)');

const bad = tags.filter(t => t.facet === 'type' && t.slug !== 'dogwood');
if (bad.length) { console.error('FAIL: stale type facet survived:', bad); process.exit(1); }
if (!tags.some(t => t.facet === 'type' && t.slug === 'dogwood')) {
  console.error('FAIL: dogwood type facet was not derived'); process.exit(1);
}
console.log('OK');
