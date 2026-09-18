// 0b-derive.mjs — v5-frostband-001 apply step 2 of 2: re-derive the two re-typed cultivars' tags.
//
// 0a-data.sql re-types two cultivars in SQL. The API does not stop at the column: every cultivar write
// through lambda/varieties is followed by applyDerive, which reconciles the SYSTEM-owned derived
// `type` and `lifecycle` tags. Skipping it leaves `type:sedum` / `type:sage` on the moved cultivars, so
// the Garden by-type view files them under the old type — the "direct DB write skips the Lambda side
// effects" failure. So this runs the REAL engine (the module the Lambda imports, not a
// reimplementation), scoped to the two cultivars, exactly as v4-cropsplit-001/0b-redrive.mjs and
// v4-croptypedogwood-001/0c-derive.mjs do.
//
// Usage — pick the environment explicitly; the URL is read from the environment by KEY NAME, never
// passed on the command line (L-067):
//   NEON_STAGING_URL=...  node migrations/v5-frostband-001/0b-derive.mjs --env staging
//   NEON_DATABASE_URL=... node migrations/v5-frostband-001/0b-derive.mjs --env prod
// After 0r-rollback.sql, add --reconcile-only: the pre-flight below then stops insisting the cultivars
// are on the NEW slugs, and applyDerive swaps the tags back to whatever they are typed as now.
//
// Idempotent: applyDerive reconciles desired against actual, so a re-run is a no-op.
// Exits 0 with "absent" for a cultivar the environment does not have (staging may not); exits 1 on any
// pre-flight or post-check failure.
import { createRequire } from 'node:module';
import { applyDerive } from '../../lambda/varieties/crop-derive.js';

const MOVED = [
  ['44907632-80f4-4f8d-bbdd-e7143e0bea7a', 'hylotelephium',  'Sedum spectabile (Autumn Fire)'],
  ['6b75492d-b08c-4f66-9de9-18157fc1bdaa', 'pineapple_sage', 'Pineapple Sage'],
];

const args = process.argv.slice(2);
const envIdx = args.indexOf('--env');
const env = envIdx >= 0 ? args[envIdx + 1] : null;
const reconcileOnly = args.includes('--reconcile-only');
const KEY = env === 'prod' ? 'NEON_DATABASE_URL' : env === 'staging' ? 'NEON_STAGING_URL' : null;
if (!KEY) { console.error('usage: node 0b-derive.mjs --env staging|prod [--reconcile-only]'); process.exit(1); }
const url = process.env[KEY];
if (!url) { console.error(`${KEY} is not set (read by key name; never pass a URL on the command line)`); process.exit(1); }

// The driver lives in each Lambda's own node_modules, not the repo root's. Resolve it from the
// varieties Lambda, the same package the engine above ships in.
async function loadNeon() {
  try { return (await import('@neondatabase/serverless')).neon; } catch (_) { /* fall through */ }
  const req = createRequire(new URL('../../lambda/varieties/package.json', import.meta.url));
  return req('@neondatabase/serverless').neon;
}
const sql = (await loadNeon())(url);

// Pre-flight 1: a target crop type that is missing or soft-deleted makes computeDerivedTags emit NO
// type tag at all, silently, hiding the cultivar from the by-type view (v4-cropsplit-001).
const targets = [...new Set(MOVED.map(([, slug]) => slug))];
const live = await sql`SELECT slug FROM public.crop_types WHERE slug = ANY(${targets}) AND deleted_at IS NULL`;
const liveSet = new Set(live.map((r) => r.slug));
if (!reconcileOnly) {
  const missing = targets.filter((s) => !liveSet.has(s));
  if (missing.length) { console.error(`crop type(s) missing or soft-deleted: ${missing.join(', ')} — apply 0a-data.sql first`); process.exit(1); }
}

const ids = MOVED.map(([id]) => id);
const rows = await sql`SELECT id, name, crop_type_slug FROM public.plant_varieties WHERE id = ANY(${ids})`;
const byId = new Map(rows.map((r) => [r.id, r]));

let failed = false;
for (const [id, want, label] of MOVED) {
  const cv = byId.get(id);
  if (!cv) { console.log(`${label} (${id}): absent in ${env} — nothing to derive`); continue; }
  // Pre-flight 2: 0a must have committed. This is what makes the 0a -> 0b order enforceable.
  if (!reconcileOnly && cv.crop_type_slug !== want) {
    console.error(`${label} (${id}): expected crop_type_slug=${want}, found ${cv.crop_type_slug} — apply 0a-data.sql first`);
    failed = true;
    continue;
  }
  const r = await applyDerive(sql, id);
  console.log(`${label}: ${cv.crop_type_slug} -> ${JSON.stringify(r)}`);
  if (r.failures && r.failures.length) failed = true;
}

// Post-check: no moved cultivar may keep a LIVE derived type link to anything but its current slug.
// check-cultivar-faceting.mjs only asserts the desired tag exists, never that the stale link went.
const stale = await sql`
  SELECT v.name, t.slug AS tag_slug, v.crop_type_slug
    FROM public.entity_tag et
    JOIN public.tag t ON t.id = et.tag_id
    JOIN public.plant_varieties v ON v.id = et.entity_id
   WHERE et.entity_id = ANY(${ids}) AND et.deleted_at IS NULL AND et.entity_type = 'cultivar'
     AND t.facet = 'type' AND t.source = 'derived' AND t.deleted_at IS NULL
     AND t.slug IS DISTINCT FROM v.crop_type_slug`;
if (stale.length) { console.error('STALE derived type links remain:', JSON.stringify(stale)); failed = true; }

if (failed) process.exit(1);
console.log('OK — derived type tags match crop_type_slug on every present cultivar');
