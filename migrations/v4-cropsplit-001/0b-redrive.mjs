// V4-CROPSPLIT-001 post-SQL step: re-derive facet tags for every repointed cultivar so the
// system-owned `type:` tag follows crop_type_slug across all three splits. Run AFTER 0a-data.sql.
//   DATABASE_URL=<neon-url> node migrations/v4-cropsplit-001/0b-redrive.mjs
//
// Generalized from migrations/v4-radicchio-croptype/redrive.mjs (one hardcoded cultivar) to a list
// of (id, expected_slug) pairs, keeping that file's pre-flight assert: it REFUSES to run unless the
// cultivar is already on its new slug. That assert is what makes the 0a -> 0b order enforceable
// rather than merely documented.
//
// ADDED vs the precedent — a guard it lacked: verify each TARGET crop_types row is LIVE before
// deriving. applyDerive() reads `crop_types WHERE deleted_at IS NULL`, and computeDerivedTags
// guards `if (cropSlug && ct)`. A missing or soft-deleted target row therefore emits NO type tag at
// all, SILENTLY — which would hide every moved cultivar from the Garden by-type view. That is the
// L-239 unfaceted-intake bug class, and it is exactly the shape a split can re-arm.
//
// Idempotent: applyDerive reconciles desired-vs-actual, so re-running is a no-op.
import { neon } from '@neondatabase/serverless';
import { applyDerive } from '../../lambda/varieties/crop-derive.js';

const MOVED = [
  // winter_squash (from squash)
  ['b6ffab33-afb9-4354-80a1-bfb8f61a76dd', 'winter_squash',   'Cinderella (Rouge Vif d\'Etampes)'],
  ['83b3195b-8be3-4806-94c5-c5dc85a7cb58', 'winter_squash',   'Howden'],
  ['f1bbb5be-d48a-45d2-b536-b75d36860eec', 'winter_squash',   'Pennsylvania Dutch Crookneck'],
  ['feb6719d-5d8e-45a8-b7fe-0cb5a6dd1121', 'winter_squash',   'Pink Banana'],
  ['c7d0aee5-6983-4220-9b25-db9a19f88ab5', 'winter_squash',   'Red Kuri'],
  ['a0f88678-9c47-4aed-899b-141448c06ca7', 'winter_squash',   'Waltham Butternut'],
  // bunching_onion (from onion)
  ['3d6fdd43-6fce-4c62-862c-d58f66b2845c', 'bunching_onion',  'Onion (scallion-type)'],
  ['3127a432-af9b-405d-8144-6a3c3470956e', 'bunching_onion',  'Scallion'],
  ['0b640bff-ad0a-446f-92b9-993afb5cf2c0', 'bunching_onion',  'Tokyo Long White'],
  // rat_tail_radish (from radish)
  ['a53f78ae-aa0f-47ca-bff8-f6633048cdb8', 'rat_tail_radish', 'Rat\'s Tail'],
];

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
const sql = neon(url);

// Pre-flight 1: every target slug must exist AND be live, or derive silently emits no type tag.
const targets = [...new Set(MOVED.map(([, slug]) => slug))];
const live = await sql`SELECT slug FROM crop_types WHERE slug = ANY(${targets}) AND deleted_at IS NULL`;
const liveSet = new Set(live.map(r => r.slug));
const missing = targets.filter(s => !liveSet.has(s));
if (missing.length) {
  console.error(`target crop_types row(s) missing or soft-deleted: ${missing.join(', ')} — apply 0a-data.sql first`);
  process.exit(1);
}

// Pre-flight 2: every cultivar must ALREADY be on its new slug (0a committed).
const ids = MOVED.map(([id]) => id);
const rows = await sql`SELECT id, name, crop_type_slug FROM plant_varieties WHERE id = ANY(${ids})`;
const bySlug = new Map(rows.map(r => [r.id, r.crop_type_slug]));
const wrong = MOVED.filter(([id, want]) => bySlug.get(id) !== want);
if (rows.length !== MOVED.length || wrong.length) {
  for (const [id, want, name] of wrong) {
    console.error(`${name} (${id}): expected crop_type_slug=${want}, got ${bySlug.get(id) ?? '<not found>'}`);
  }
  console.error('apply 0a-data.sql first');
  process.exit(1);
}

let totals = { tags_upserted: 0, links_added: 0, links_removed: 0, cultivars: 0, failures: [] };
for (const [id, want, name] of MOVED) {
  const r = await applyDerive(sql, id);
  totals.tags_upserted += r.tags_upserted;
  totals.links_added += r.links_added;
  totals.links_removed += r.links_removed;
  totals.cultivars += r.cultivars;
  totals.failures.push(...r.failures);
  console.log(`${want.padEnd(16)} ${name} -> ${JSON.stringify(r)}`);
}
console.log('TOTALS', JSON.stringify(totals));

// Post-check: no moved cultivar may retain a LIVE derived type: link pointing at its OLD slug.
// check-cultivar-faceting.mjs only asserts the desired tag EXISTS; it never checks the stale link
// was removed, so this direction has no other detector.
const stale = await sql`
  SELECT v.name, t.slug AS tag_slug, v.crop_type_slug
    FROM entity_tag et
    JOIN tag t ON t.id = et.tag_id
    JOIN plant_varieties v ON v.id = et.entity_id
   WHERE et.entity_id = ANY(${ids}) AND et.deleted_at IS NULL
     AND et.entity_type = 'cultivar'
     AND t.facet = 'type' AND t.source = 'derived' AND t.deleted_at IS NULL
     AND t.slug IS DISTINCT FROM v.crop_type_slug`;
if (stale.length) {
  console.error('STALE derived type: links remain:', JSON.stringify(stale));
  process.exit(1);
}
console.log('OK — no stale derived type: links on any moved cultivar');
if (totals.failures.length) { console.error('FAILURES', JSON.stringify(totals.failures)); process.exit(1); }
