// 0b-backfill.mjs — V4-CLASSIFY-001 data backfill. Run AFTER 0a, BEFORE 0c-validate, on prod AND staging.
//   Usage: DATABASE_URL=<neon-url> node migrations/v4-classify/0b-backfill.mjs
// Steps (all idempotent):
//   1. determinacy column <- parseDeterminacy(growth_habit) for tomatoes (2 have no prose -> left NULL,
//      manual: 'Cherry Bombs', 'Megatron').
//   2. day_length_response='long_day' for the two named long-day onions (name-sourced; prose lacks the
//      literal token for one of them).
//   3. Santa Fe Grande scoville_min/max <- 5000/8000 (locked design fact -> heat band = Medium) if unset.
//   4. applyDerive(sql, null): materialize/reconcile ALL derived facet tags over every live cultivar.
import { neon } from '@neondatabase/serverless';
import { applyDerive, parseDeterminacy } from '../../lambda/tags/crop-derive.js';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
const sql = neon(url);

const toms = await sql`SELECT id, growth_habit FROM public.plant_varieties WHERE crop_type_slug='tomato' AND deleted_at IS NULL AND determinacy IS NULL`;
let d=0; for (const t of toms) { const v=parseDeterminacy(t.growth_habit); if (v) { await sql`UPDATE public.plant_varieties SET determinacy=${v} WHERE id=${t.id}`; d++; } }
const dl = await sql`UPDATE public.plant_varieties SET day_length_response='long_day' WHERE crop_type_slug='onion' AND deleted_at IS NULL AND name ILIKE '%long-day%' AND day_length_response IS NULL RETURNING id`;
const sfg = await sql`UPDATE public.plant_varieties SET scoville_min=COALESCE(scoville_min,5000), scoville_max=COALESCE(scoville_max,8000) WHERE crop_type_slug='pepper' AND name ILIKE 'Santa Fe Grande%' AND deleted_at IS NULL AND scoville_max IS NULL RETURNING id`;
const res = await applyDerive(sql, null);
console.log(JSON.stringify({ determinacy_set:d, onion_long_day_set:dl.length, santa_fe_scoville_set:sfg.length,
  derive:{ tags_upserted:res.tags_upserted, links_added:res.links_added, links_removed:res.links_removed, cultivars:res.cultivars, failures:res.failures.length } }));
if (res.failures.length) { console.error('DERIVE FAILURES:', JSON.stringify(res.failures.slice(0,10))); process.exit(2); }
