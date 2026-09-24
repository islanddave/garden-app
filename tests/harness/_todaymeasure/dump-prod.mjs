#!/usr/bin/env node
// dump-prod.mjs — regenerate the Today-shape fixtures from LIVE PROD, strictly read-only.
//
//   export NEON_DATABASE_URL=$(grep -m1 '^NEON_DATABASE_URL=' <garden-app>/.env.local | cut -d= -f2-)
//   export GARDEN_HOUSEHOLD_IDS=$(aws lambda get-function-configuration --region us-east-1 \
//     --function-name garden-harvests --query 'Environment.Variables.GARDEN_HOUSEHOLD_IDS' --output text)
//   node tests/harness/_todaymeasure/dump-prod.mjs            # -> tests/harness/_todaymeasure/out/raw/
//   node scripts/layout-gate/todayshape-fixture-scrub.mjs --from tests/harness/_todaymeasure/out/raw
//   node scripts/layout-gate/todayshape-fixture-preflight.mjs
//
// Select the URL by KEY NAME, never by pattern: .env.local also carries a staging URL on the same
// user/database names, and nothing in a read proves which branch answered. The URL is split into PG*
// environment variables for psql and is never printed or passed on a command line.
//
// WHY A SCRIPT. The 2026-09-08 dump was done by hand in a session scratchpad and its SQL was lost;
// bands-notes.md kept a recipe. This is that recipe made executable, so the next refresh produces
// the same transforms instead of somebody's recollection of them.
//
// READ-ONLY, THREE WAYS: every statement runs inside `BEGIN TRANSACTION READ ONLY ... ROLLBACK`; the
// tagged-template `sql` handed to the real handlers REFUSES anything that is not a SELECT/WITH before
// it reaches psql (the watch route's two impression writers are non-fatal by design, so they log a
// warning and the GET body is unaffected — the same outcome the 09-08 run documented); and nothing
// here opens a write-capable path at all.
//
// DRIVER FIDELITY. The Lambdas read through @neondatabase/serverless, which returns numeric and int8
// as STRINGS and date/timestamp columns as Date objects (Lambdas run TZ=UTC). psql's json_agg returns
// numbers and ISO-ish strings instead. Each query's column types are read with \gdesc and every row is
// re-shaped to what the driver would have handed the handler, so the handler's own projectors run on
// driver-shaped input. TZ is forced to UTC below for the same reason: a zone-less timestamp parsed on
// a New York laptop would otherwise land four hours off.
//
// OUTPUTS are RAW (they carry Clerk subs and the site's real coordinates) and land in out/raw/, which
// is gitignored. The scrub is what makes them trackable; the preflight is what refuses them if not.
process.env.TZ = 'UTC'

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const require = createRequire(import.meta.url)
const argOf = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : dflt }
const OUT = resolve(argOf('--out', join(HERE, 'out/raw')))
const TZ_ET = 'America/New_York'

// ── inputs ──────────────────────────────────────────────────────────────────────────────────────
const RAW_URL = process.env.NEON_DATABASE_URL || ''
if (!RAW_URL) { console.error('[dump] NEON_DATABASE_URL is not set (select it from .env.local by KEY NAME).'); process.exit(2) }
const HOUSEHOLD = (process.env.GARDEN_HOUSEHOLD_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
if (HOUSEHOLD.length === 0) { console.error('[dump] GARDEN_HOUSEHOLD_IDS is not set — read it off the garden-harvests Lambda config (see header).'); process.exit(2) }
// The viewer. Defaults to the first household id, which is the order the Lambda env carries.
const VIEWER = process.env.TODAY_VIEWER_ID || HOUSEHOLD[0]
if (!HOUSEHOLD.includes(VIEWER)) { console.error('[dump] TODAY_VIEWER_ID is not a member of GARDEN_HOUSEHOLD_IDS.'); process.exit(2) }
const OTHERS = HOUSEHOLD.filter(id => id !== VIEWER)

// psql connection via PG* env, never argv.
const u = new URL(RAW_URL)
const PGENV = {
  ...process.env,
  PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.replace(/^\//, ''),
  PGSSLMODE: u.searchParams.get('sslmode') || 'require',
  ...(u.searchParams.get('channel_binding') ? { PGCHANNELBINDING: u.searchParams.get('channel_binding') } : {}),
  PGAPPNAME: 'todayshape-fixture-dump-readonly',
}
delete PGENV.NEON_DATABASE_URL

function psql(script) {
  const r = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], { input: script, env: PGENV, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${(r.stderr || '').trim().slice(0, 800)}`)
  return r.stdout
}

const WRITE_SHAPED = /^\s*(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|begin|commit|rollback|set)\b/i
function stripComments(q) { return q.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '') }
function assertReadOnly(q) {
  const body = stripComments(q).trim()
  if (!/^(select|with)\b/i.test(body) || WRITE_SHAPED.test(body)) throw new Error(`refused a non-SELECT statement: ${body.slice(0, 80)}…`)
}

// Column types via \gdesc — the one question json_agg cannot answer.
function typesOf(q) {
  const out = psql(`BEGIN TRANSACTION READ ONLY;\n${q.replace(/;\s*$/, '')}\n\\gdesc\nROLLBACK;\n`)
  const types = {}
  for (const line of out.split('\n')) { const i = line.lastIndexOf('|'); if (i > 0) types[line.slice(0, i)] = line.slice(i + 1) }
  return types
}
// \gdesc reports `numeric(10,3)`, `character varying(80)` — the modifier is not the type.
const baseType = (t) => String(t || '').replace(/\(.*\)$/, '').trim()
const TEXT_ON_WIRE = new Set(['numeric', 'bigint', 'money'])
const qid = (k) => '"' + k.replace(/"/g, '""') + '"'
// numeric/int8 are selected ::text, so the fixture carries the driver's exact string ("2.000", not
// the JSON number 2 that json_agg would print and JSON.parse would keep).
function rowsOf(q, types) {
  const cols = Object.keys(types)
  const list = cols.length
    ? cols.map(k => TEXT_ON_WIRE.has(baseType(types[k])) ? `t.${qid(k)}::text AS ${qid(k)}` : `t.${qid(k)}`).join(', ')
    : 't.*'
  const out = psql(`BEGIN TRANSACTION READ ONLY;\nSELECT COALESCE(json_agg(r), '[]'::json) FROM (SELECT ${list} FROM (\n${q.replace(/;\s*$/, '')}\n) t) r;\nROLLBACK;\n`)
  return JSON.parse(out.trim() || '[]')
}
// Re-shape one json_agg row into what @neondatabase/serverless hands a handler.
function driverShape(rows, types) {
  return rows.map(r => {
    const o = {}
    for (const [k, v] of Object.entries(r)) {
      const t = baseType(types[k])
      if (v == null) { o[k] = v; continue }
      if (TEXT_ON_WIRE.has(t)) o[k] = String(v)
      else if (t === 'date') o[k] = new Date(`${String(v).slice(0, 10)}T00:00:00.000Z`)
      else if (t.startsWith('timestamp')) o[k] = new Date(v)
      else o[k] = v
    }
    return o
  })
}
function query(q) { assertReadOnly(q); const types = typesOf(q); return driverShape(rowsOf(q, types), types) }

// A literal for inlining a tagged-template parameter. Strings are standard_conforming_strings
// literals ('' doubling); arrays become ARRAY[...] of the same.
function lit(v) {
  if (v == null) return 'NULL'
  if (Array.isArray(v)) return v.length ? `ARRAY[${v.map(lit).join(',')}]` : `'{}'`
  if (v instanceof Date) return `'${v.toISOString()}'`
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('non-finite param'); return String(v) }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return `'${String(v).replace(/'/g, "''")}'`
}
// The tagged template the real handlers are called with.
function sql(strings, ...vals) {
  let q = strings[0]
  for (let i = 0; i < vals.length; i++) q += lit(vals[i]) + strings[i + 1]
  const body = stripComments(q).trim()
  if (!/^(select|with)\b/i.test(body)) return Promise.reject(new Error('[dump] read-only: refused a write the handler attempted (non-fatal writers log and continue)'))
  return Promise.resolve(query(q))
}

const write = (name, doc) => { writeFileSync(join(OUT, name), JSON.stringify(doc)); console.log(`[dump] ${name}  ${Buffer.byteLength(JSON.stringify(doc))} bytes`) }
mkdirSync(OUT, { recursive: true })

// ── 1. the daily plans (daily-plan-read's SELECT, verbatim predicate) ──────────────────────────
// annotateDone is deliberately NOT applied: the fixture is the plan as the engine wrote it, i.e. the
// list before anything was logged today. The harness has no event log to check items off against.
const planFor = (id) => query(`
  SELECT to_char((now() AT TIME ZONE '${TZ_ET}')::date, 'YYYY-MM-DD') AS plan_date,
         dp.items AS items, dp.generated_at AS generated_at
  FROM (SELECT 1) _seed
  LEFT JOIN daily_plan dp
    ON dp.user_id = ${lit(id)}
   AND dp.plan_date = (now() AT TIME ZONE '${TZ_ET}')::date
   AND dp.deleted_at IS NULL
  ORDER BY dp.generated_at DESC NULLS LAST
  LIMIT 1`)[0]
const dave = planFor(VIEWER)
if (!dave?.items) { console.error('[dump] the viewer has no daily_plan row for today — nothing to measure. Re-run after the next engine run.'); process.exit(1) }
write('dailyplan.dave.json', { plan: dave.items, plan_date: dave.plan_date, generated_at: dave.generated_at.toISOString(), has_plan: true })
const jen = OTHERS.length ? planFor(OTHERS[0]) : null
write('dailyplan.jen.json', jen?.items ?? {})

// ── 2. /api/plants — the columns Today reads, under the list read's own predicates ─────────────
// lambda/plants/index.js ?view=grid predicate (same ownership arms, deleted/archived gates and the
// archived-container gate as the default list). Photo URLs are presigned and expire, so only their
// PRESENCE is kept; the harness swaps any non-null URL for a 4x4 PNG.
const plants = query(`
  SELECT gp.id, gp.display_name AS name, gp.status, gp.location_id, gp.container_type,
         COALESCE(fp.id, fb.id) AS featured_photo_id,
         COALESCE(fp.storage_path, fb.storage_path) IS NOT NULL AS has_photo,
         pv.crop_type_slug AS crop_type_slug
  FROM public.garden_node gp
  LEFT JOIN public.container pp ON pp.id = gp.container_id
  LEFT JOIN public.cultivar pv ON pv.id = gp.cultivar_id AND pv.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT ph.id, ph.storage_path FROM photos ph LEFT JOIN public.event_log e ON e.id = ph.event_id
     WHERE ph.id = gp.featured_photo_id AND ph.deleted_at IS NULL AND ph.created_by = ANY(${lit(HOUSEHOLD)})
       AND (ph.plant_id = gp.id OR e.plant_id = gp.id) LIMIT 1) fp ON TRUE
  LEFT JOIN LATERAL (
    SELECT x.id, x.storage_path FROM (
      ( SELECT ph.id, ph.storage_path, ph.created_at FROM photos ph
         WHERE fp.storage_path IS NULL AND ph.plant_id = gp.id AND ph.deleted_at IS NULL AND ph.created_by = ANY(${lit(HOUSEHOLD)})
         ORDER BY ph.created_at DESC, ph.id DESC LIMIT 1 )
      UNION ALL
      ( SELECT ph.id, ph.storage_path, ph.created_at FROM photos ph JOIN public.event_log e ON e.id = ph.event_id
         WHERE fp.storage_path IS NULL AND e.plant_id = gp.id AND ph.deleted_at IS NULL AND ph.created_by = ANY(${lit(HOUSEHOLD)})
         ORDER BY ph.created_at DESC, ph.id DESC LIMIT 1 )
    ) x ORDER BY x.created_at DESC, x.id DESC LIMIT 1) fb ON TRUE
  WHERE (( pp.created_by = ANY(${lit(HOUSEHOLD)}) AND pp.deleted_at IS NULL )
         OR (gp.container_id IS NULL AND gp.created_by = ANY(${lit(HOUSEHOLD)})))
    AND gp.deleted_at IS NULL AND gp.archived_at IS NULL AND pp.archived_at IS NULL
  ORDER BY gp.created_at DESC`)
write('plants.json', plants.map(p => ({
  id: p.id, name: p.name, status: p.status, location_id: p.location_id, container_type: p.container_type,
  featured_photo_id: p.featured_photo_id,
  featured_photo_view_url: p.has_photo ? 'presigned-url-elided' : null,
  featured_photo_thumb_url: p.has_photo ? 'presigned-url-elided' : null,
  variety_ref: p.crop_type_slug ? { crop_type_slug: p.crop_type_slug } : null,
})))

// ── 3. /api/locations/with-path — verbatim (lambda/locations/index.js GET) ─────────────────────
const locs = query(`
  SELECT id, full_path, level, is_active FROM locations_with_path
  WHERE deleted_at IS NULL
    AND id IN (SELECT id FROM locations WHERE deleted_at IS NULL AND created_by = ANY(${lit(HOUSEHOLD)}))
  ORDER BY full_path`)
write('locations.json', locs)

// ── 4. /api/harvests/watch?limit=200 — the REAL handler, injected read-only sql ────────────────
const { handleWatchGet } = await import(join(ROOT, 'lambda/harvests/watch-route.js'))
const watch = await handleWatchGet({ sql, householdIds: HOUSEHOLD, userId: VIEWER, tz: TZ_ET, query: { limit: '200' } })
if (watch.statusCode !== 200) { console.error('[dump] watch handler returned', watch.statusCode, watch.body); process.exit(1) }
write('harvestwatch.json', JSON.parse(JSON.stringify(watch.body)))

// ── 5. /api/inventory-items/sow-candidates — `SELECT *`, no post-processing (per the handler) ──
const sow = query(`SELECT * FROM v_sow_candidates WHERE created_by = ANY(${lit(HOUSEHOLD)})`)
write('sowcandidates.json', JSON.parse(JSON.stringify({ items: sow })))

// ── 6. /api/preservation/use-soon — SQL verbatim + the real classifier ────────────────────────
// projectRow is module-private to lambda/preservation/index.js. It is only needed for a row that
// classifies use_soon/past_use_by; if one ever does, this refuses rather than inventing the shape.
const { classifyUseBy } = await import(join(ROOT, 'lambda/preservation/useBy.js'))
const pres = query(`
  SELECT p.*, s.label AS storage_label, s.kind AS storage_kind, ct.display_name AS crop_display_name,
         gn.display_name AS planting_name, gn.sown_at AS planting_sown_at,
         gn.succession_order AS planting_succession_order, cv.display_name AS planting_variety_name
  FROM preservation_log p
  LEFT JOIN storage_location s ON s.id = p.storage_location_id
  LEFT JOIN crop_types ct ON ct.slug = p.crop_type_slug
  LEFT JOIN garden_node gn ON gn.id = p.plant_id AND gn.deleted_at IS NULL
  LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
  WHERE p.user_id = ANY(${lit(HOUSEHOLD)}) AND p.deleted_at IS NULL AND p.use_by_target IS NOT NULL
    AND (p.remaining_count IS NULL OR p.remaining_count > 0)
  ORDER BY p.use_by_target ASC`)
const soon = pres.filter(r => { const s = classifyUseBy(r.preserved_at, r.use_by_target); return s === 'use_soon' || s === 'past_use_by' })
if (soon.length) { console.error(`[dump] ${soon.length} preservation row(s) classify use_soon/past_use_by — extend this script with projectRow before dumping use-soon.`); process.exit(1) }
write('usesoon.json', { items: [] })
console.log(`[dump] use-soon: ${pres.length} stored row(s) with a use_by_target, 0 in the use-soon window`)

// ── 7. busyfull grafts — real payload fragments from the most recent prod day each one occurred ──
// Today is an ambient page: most of its lines render on few days. `busy` is today verbatim; `busyfull`
// is today PLUS each conditional line, taken from the latest real plan that carried it, so every
// region can be measured at once. Each graft records where it came from.
const lastWith = (predicate) => query(`
  SELECT to_char(dp.plan_date, 'YYYY-MM-DD') AS plan_date, dp.items AS items FROM daily_plan dp
  WHERE dp.user_id = ${lit(VIEWER)} AND dp.deleted_at IS NULL AND ${predicate}
  ORDER BY dp.plan_date DESC, dp.generated_at DESC LIMIT 1`)[0] || null
const gAlerts = lastWith(`jsonb_array_length(COALESCE(dp.items->'alerts_sent','[]'::jsonb)) > 0`)
const gCue = lastWith(`jsonb_typeof(dp.items->'weather'->'callout') = 'object'`)
const gLeaf = lastWith(`dp.items ? 'leaf_wetness'`)
const gRain = lastWith(`jsonb_array_length(COALESCE(dp.items->'rain_skipped','[]'::jsonb)) > 0`)
const gDrought = lastWith(`dp.items ? 'drought'`)

// DROUGHT HAS NEVER FIRED ON PROD (0 plan rows with a `drought` key and 0 dormancy_suppressed items
// carrying one, all time, as of 2026-09-24). So the drought graft is SYNTHETIC — but it is produced by
// the engine's own functions rather than typed: DRY_DAYS+1 zero-rain days ending the day before the
// plan date, preceded by one deep-soak day, evaluated by droughtSignal.evaluateDrought and worded by
// gardenDrought (the smallest run that fires, so the sentence is the ordinary one rather than the
// "at least N" truncated form), with the per-item shape copied from engine.js's dormancy_suppressed
// spread. It is labelled synthetic in the fixture.
const dr = require(join(ROOT, 'lambda/daily-plan/droughtSignal.js'))
const DAY_MS = 86400000
const asOf = new Date(Date.parse(`${dave.plan_date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)
const dryRun = dr.DRY_DAYS + 1
const series = Array.from({ length: dryRun + 1 }, (_, i) => ({
  date: new Date(Date.parse(`${asOf}T00:00:00Z`) - i * DAY_MS).toISOString().slice(0, 10),
  precip_in: i < dryRun ? '0.00' : (dr.DEEP_SOAK_IN + 0.15).toFixed(2),
}))
const drState = dr.evaluateDrought(series, { asOfDate: asOf })
if (drState.status !== 'dry') { console.error('[dump] the synthetic drought series did not evaluate dry:', drState.status); process.exit(1) }
const synthDrought = gDrought ? null : {
  synthetic: true,
  why: `prod has never emitted drought; payload produced by lambda/daily-plan/droughtSignal.js on ${dryRun} zero-rain days after one deep soak`,
  plan_level: dr.gardenDrought(drState),
  per_item: { dry_days: drState.dryDays, deep_soak_in: drState.deepSoakIn, last_deep_soak: drState.lastDeepSoakDate, truncated: drState.truncated },
}
write('busyfull-grafts.json', {
  _: 'Real payload fragments grafted onto today\'s plan to build the busyfull state (see bands-notes.md). source_plan_date says where each came from.',
  alerts_sent: gAlerts ? { source_plan_date: gAlerts.plan_date, value: gAlerts.items.alerts_sent } : null,
  weather_callout: gCue ? { source_plan_date: gCue.plan_date, value: gCue.items.weather.callout } : null,
  leaf_wetness: gLeaf ? { source_plan_date: gLeaf.plan_date, value: gLeaf.items.leaf_wetness } : null,
  rain_skipped: gRain ? { source_plan_date: gRain.plan_date, value: gRain.items.rain_skipped } : null,
  drought: gDrought
    ? { source_plan_date: gDrought.plan_date, plan_level: gDrought.items.drought, per_item: null }
    : { source_plan_date: null, ...synthDrought },
})
console.log('[dump] done. Scrub next: node scripts/layout-gate/todayshape-fixture-scrub.mjs --from ' + OUT)
