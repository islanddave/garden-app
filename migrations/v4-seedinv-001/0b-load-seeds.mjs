// 0b-load-seeds.mjs — V4-SEEDINV-001 seed-packet loader. Run AFTER 0a, BEFORE 0c-validate.
//   Loads seed-load-dataset-V1.json (105 packets) into inventory_items (category='seeds') and
//   creates/enriches plant_varieties rows with the typed sow profile.
//
//   Usage (DRY RUN is the default — prints the per-packet decision table, writes NOTHING):
//     DATABASE_URL=<neon-url> node migrations/v4-seedinv-001/0b-load-seeds.mjs
//   Apply (Dave-gated; confirm the DATABASE_URL target host printed at startup first):
//     DATABASE_URL=<neon-url> node migrations/v4-seedinv-001/0b-load-seeds.mjs --apply
//
//   Dependency: @neondatabase/serverless (same import approach as migrations/v4-classify/0b-backfill.mjs —
//   bare specifier resolved from the nearest node_modules). Either run
//     cd migrations/v4-seedinv-001 && npm i @neondatabase/serverless
//   once, or run from a lambda dir that already has it installed, e.g.
//     cd lambda/varieties && DATABASE_URL=... node ../../migrations/v4-seedinv-001/0b-load-seeds.mjs
//
//   Semantics (panel-locked):
//   - Variety matches are re-resolved FRESH at run time against live plant_varieties:
//     exact-lower name match first, then name+crop contains; ambiguous/multiple -> SKIP + report, never guess.
//   - EXISTING varieties: fill-if-null ONLY (COALESCE(col, incoming)) for dtm/sun_requirements/lifecycle/
//     grown_as + the 11 sow columns. Never overwrites a non-null value.
//   - NEW varieties: full sow profile + crop_type_slug only when packetToVarietyCols judged the guess valid.
//     The 15 null-sow_profile packets create the variety with sow columns null and preserve
//     metadata.needs_confirmation on the inventory row (both handled inside the shared parse lib).
//   - --apply executes per-packet batches transactionally: MATCH = [fill-update, inventory INSERT] via
//     sql.transaction; CREATE = a single atomic CTE statement (variety INSERT ... RETURNING id feeding the
//     inventory INSERT).
//   - Re-run guard: packets whose inventory row already exists (name match on live seed items) SKIP as
//     'already loaded', so a re-run is a no-op instead of duplicating rows.
//   - NUMERIC-as-string: the driver returns numeric columns as strings — Number() coercion when comparing.

import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { packetToVarietyCols, packetToInventoryPayload, parseRange } from '../../src/lib/parseSowProfile.js';
// L-239 guard: reuse the app's own derive engine so seed-loaded varieties get their facet tags
// (the CREATE branch below inserts plant_varieties directly, bypassing the /api/varieties applyDerive site).
import { applyDerive } from '../../lambda/varieties/crop-derive.js';

const CREATED_BY = 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI'; // Dave's clerk sub (spec ground truth)
const DATASET_URL = new URL('./seed-load-dataset-V1.json', import.meta.url);
const METADATA_BYTE_CAP = 8192; // inventory_items metadata CHECK (live ground truth)

// Columns eligible for fill-if-null on EXISTING varieties (panel delta: dtm, sun, lifecycle, grown_as, sow cols).
const FILL_COLS = [
  'lifecycle', 'grown_as', 'sun_requirements',
  'days_to_maturity_min', 'days_to_maturity_max',
  'start_method', 'start_indoor_weeks_min', 'start_indoor_weeks_max',
  'direct_sow_timing', 'sow_depth_in', 'seed_spacing_in', 'row_spacing_in',
  'days_to_germ_min', 'days_to_germ_max', 'sow_season', 'sow_notes',
];

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
const apply = process.argv.includes('--apply');
const sql = neon(url);

console.log(`mode=${apply ? 'APPLY' : 'DRY-RUN'} target=${new URL(url).host} created_by=${CREATED_BY}`);

// ---- Preflight: 0a must have landed (sow columns present) --------------------------------------------------
const pre = await sql`
  SELECT 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='plant_varieties' AND column_name='start_method'`;
if (pre.length === 0) {
  console.error('plant_varieties.start_method is missing — apply 0a-additive-ddl.sql before running the loader.');
  process.exit(1);
}

// ---- Load dataset + live state ------------------------------------------------------------------------------
const dataset = JSON.parse(readFileSync(DATASET_URL, 'utf8'));
const packets = dataset.packets ?? [];

const live = await sql`
  SELECT id, name, crop_type_slug, lifecycle, grown_as, sun_requirements,
         days_to_maturity_min, days_to_maturity_max,
         start_method, start_indoor_weeks_min, start_indoor_weeks_max,
         direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in,
         days_to_germ_min, days_to_germ_max, sow_season, sow_notes
    FROM public.plant_varieties
   WHERE deleted_at IS NULL`;

const liveSeedItems = await sql`
  SELECT lower(name) AS lname FROM public.inventory_items
   WHERE category='seeds' AND created_by=${CREATED_BY} AND deleted_at IS NULL`;
const alreadyLoaded = new Set(liveSeedItems.map((r) => r.lname));

console.log(`packets=${packets.length} live_varieties=${live.length} live_seed_items=${alreadyLoaded.size}`);

// ---- Match resolution (fresh, at run time) ------------------------------------------------------------------
function matchVariety(packet) {
  // 1. Exact-lower name match (matched_variety_name hint first, then the packet's own variety name).
  const candidates = [packet.matched_variety_name, packet.variety]
    .filter(Boolean).map((s) => s.toLowerCase());
  for (const cand of candidates) {
    const exact = live.filter((v) => v.name.toLowerCase() === cand);
    if (exact.length === 1) return { kind: 'exact', variety: exact[0] };
    if (exact.length > 1) {
      const byCrop = packet.crop_type_slug_guess
        ? exact.filter((v) => v.crop_type_slug === packet.crop_type_slug_guess) : [];
      if (byCrop.length === 1) return { kind: 'exact', variety: byCrop[0] };
      return { kind: 'ambiguous', candidates: exact };
    }
  }
  // 2. name+crop contains.
  const vname = (packet.variety ?? '').toLowerCase();
  if (!vname) return { kind: 'none' };
  const cropTok = (packet.crop ?? '').split(',')[0].trim().toLowerCase();
  const contains = live.filter((v) => {
    const n = v.name.toLowerCase();
    if (!n.includes(vname)) return false;
    if (packet.crop_type_slug_guess && v.crop_type_slug) return v.crop_type_slug === packet.crop_type_slug_guess;
    return cropTok ? n.includes(cropTok) : true;
  });
  if (contains.length === 1) return { kind: 'contains', variety: contains[0] };
  if (contains.length > 1) return { kind: 'ambiguous', candidates: contains };
  return { kind: 'none' };
}

// Fill-if-null plan for an EXISTING variety. Driver returns numerics as strings -> Number() when comparing.
function computeFills(existing, cols) {
  const fills = []; const kept = [];
  for (const col of FILL_COLS) {
    const incoming = cols?.[col];
    if (incoming == null) continue;
    const cur = existing[col];
    if (cur == null) { fills.push(col); continue; }
    const differs = (typeof incoming === 'number')
      ? Number(cur) !== Number(incoming)
      : String(cur) !== String(incoming);
    if (differs) kept.push(col); // non-null live value wins; report the divergence, never clobber
  }
  return { fills, kept };
}

// ---- Build the per-packet plan ------------------------------------------------------------------------------
const plan = [];
for (const packet of packets) {
  const cols = packetToVarietyCols(packet);
  const wk = parseRange(packet.sow_profile?.start_indoor_weeks_before_lastfrost ?? null);
  const weeksLabel = wk.min == null ? '-' : (wk.min === wk.max ? `${wk.min}w` : `${wk.min}-${wk.max}w`);
  const entry = { packet, cols, weeksLabel };

  const m = matchVariety(packet);
  if (m.kind === 'ambiguous') {
    entry.action = 'SKIP';
    entry.detail = `ambiguous match (${m.candidates.length}): ${m.candidates.map((c) => `${c.id}:${c.name}`).join(' | ')}`;
    plan.push(entry); continue;
  }

  const varietyId = m.kind === 'none' ? null : m.variety.id;
  const payload = packetToInventoryPayload(packet, { variety_id: varietyId, created_by: CREATED_BY });
  entry.payload = payload;

  if (alreadyLoaded.has((payload.name ?? packet.name).toLowerCase())) {
    entry.action = 'SKIP';
    entry.detail = 'already loaded (live seed inventory row with same name)';
    plan.push(entry); continue;
  }
  const metaBytes = Buffer.byteLength(JSON.stringify(payload.metadata ?? {}), 'utf8');
  if (metaBytes >= METADATA_BYTE_CAP) {
    entry.action = 'SKIP';
    entry.detail = `metadata too large (${metaBytes}B >= ${METADATA_BYTE_CAP}B cap)`;
    plan.push(entry); continue;
  }

  if (m.kind === 'none') {
    entry.action = 'CREATE';
    entry.detail = `new variety "${cols.name}"${cols.crop_type_slug ? ` [${cols.crop_type_slug}]` : ''}${packet.sow_profile ? '' : ' (null sow profile; needs_confirmation preserved)'}`;
  } else {
    const { fills, kept } = computeFills(m.variety, cols);
    entry.action = 'MATCH';
    entry.varietyId = m.variety.id;
    entry.fills = fills;
    entry.detail = `-> ${m.variety.id}:${m.variety.name} (${m.kind});`
      + ` fill-if-null: ${fills.length ? fills.join(',') : 'none'}`
      + (kept.length ? `; kept non-null: ${kept.join(',')}` : '');
  }
  plan.push(entry);
}

// ---- Decision table -----------------------------------------------------------------------------------------
console.log('\n#    action  weeks  packet');
console.log('---  ------  -----  ' + '-'.repeat(90));
plan.forEach((e, i) => {
  const name = `${e.packet.crop} / ${e.packet.variety ?? '?'}`;
  console.log(`${String(i + 1).padStart(3)}  ${e.action.padEnd(6)}  ${e.weeksLabel.padEnd(5)}  ${name}`);
  console.log(`${' '.repeat(20)}${e.detail}`);
});

const counts = plan.reduce((a, e) => { a[e.action] = (a[e.action] ?? 0) + 1; return a; }, {});
console.log(`\nplan: MATCH=${counts.MATCH ?? 0} CREATE=${counts.CREATE ?? 0} SKIP=${counts.SKIP ?? 0} (of ${plan.length})`);

if (!apply) {
  console.log('DRY-RUN complete — no writes. Re-run with --apply to execute.');
  process.exit(0);
}

// ---- APPLY --------------------------------------------------------------------------------------------------
let matched = 0; let created = 0; let inserted = 0; let fillsApplied = 0; const failures = [];

for (const [i, e] of plan.entries()) {
  if (e.action === 'SKIP') continue;
  const c = e.cols; const p = e.payload;
  const meta = JSON.stringify(p.metadata ?? {});
  try {
    if (e.action === 'MATCH') {
      // One transaction per packet: fill-if-null enrich + inventory INSERT (both or neither).
      await sql.transaction([
        sql`
          UPDATE public.plant_varieties SET
            lifecycle              = COALESCE(lifecycle,              ${c.lifecycle ?? null}),
            grown_as               = COALESCE(grown_as,               ${c.grown_as ?? null}),
            sun_requirements       = COALESCE(sun_requirements,       ${c.sun_requirements ?? null}),
            days_to_maturity_min   = COALESCE(days_to_maturity_min,   ${c.days_to_maturity_min ?? null}),
            days_to_maturity_max   = COALESCE(days_to_maturity_max,   ${c.days_to_maturity_max ?? null}),
            start_method           = COALESCE(start_method,           ${c.start_method ?? null}),
            start_indoor_weeks_min = COALESCE(start_indoor_weeks_min, ${c.start_indoor_weeks_min ?? null}),
            start_indoor_weeks_max = COALESCE(start_indoor_weeks_max, ${c.start_indoor_weeks_max ?? null}),
            direct_sow_timing      = COALESCE(direct_sow_timing,      ${c.direct_sow_timing ?? null}),
            sow_depth_in           = COALESCE(sow_depth_in,           ${c.sow_depth_in ?? null}),
            seed_spacing_in        = COALESCE(seed_spacing_in,        ${c.seed_spacing_in ?? null}),
            row_spacing_in         = COALESCE(row_spacing_in,         ${c.row_spacing_in ?? null}),
            days_to_germ_min       = COALESCE(days_to_germ_min,       ${c.days_to_germ_min ?? null}),
            days_to_germ_max       = COALESCE(days_to_germ_max,       ${c.days_to_germ_max ?? null}),
            sow_season             = COALESCE(sow_season,             ${c.sow_season ?? null}),
            sow_notes              = COALESCE(sow_notes,              ${c.sow_notes ?? null})
          WHERE id = ${e.varietyId} AND deleted_at IS NULL`,
        sql`
          INSERT INTO public.inventory_items (
            user_id, created_by, type, category, unit, status, name,
            quantity_on_hand, source, source_url, purchase_date, unit_cost,
            notes, variety_id, metadata
          ) VALUES (
            ${CREATED_BY}, ${CREATED_BY}, ${p.type}, ${p.category}, ${p.unit}, ${p.status}, ${p.name},
            ${p.quantity_on_hand ?? 1}, ${p.source ?? null}, ${p.source_url ?? null}, ${p.purchase_date ?? null}, ${p.unit_cost ?? null},
            ${p.notes ?? null}, ${e.varietyId}, ${meta}::jsonb
          )`,
      ]);
      matched++; inserted++; fillsApplied += e.fills.length;
    } else { // CREATE — single atomic CTE statement (variety id feeds the inventory row).
      await sql`
        WITH v AS (
          INSERT INTO public.plant_varieties (
            name, species, crop_type_slug, lifecycle, grown_as,
            days_to_maturity_min, days_to_maturity_max, sun_requirements,
            start_method, start_indoor_weeks_min, start_indoor_weeks_max,
            direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in,
            days_to_germ_min, days_to_germ_max, sow_season, sow_notes, created_by
          ) VALUES (
            ${c.name}, ${c.species ?? null}, ${c.crop_type_slug ?? null}, ${c.lifecycle ?? null}, ${c.grown_as ?? null},
            ${c.days_to_maturity_min ?? null}, ${c.days_to_maturity_max ?? null}, ${c.sun_requirements ?? null},
            ${c.start_method ?? null}, ${c.start_indoor_weeks_min ?? null}, ${c.start_indoor_weeks_max ?? null},
            ${c.direct_sow_timing ?? null}, ${c.sow_depth_in ?? null}, ${c.seed_spacing_in ?? null}, ${c.row_spacing_in ?? null},
            ${c.days_to_germ_min ?? null}, ${c.days_to_germ_max ?? null}, ${c.sow_season ?? null}, ${c.sow_notes ?? null}, ${CREATED_BY}
          ) RETURNING id
        )
        INSERT INTO public.inventory_items (
          user_id, created_by, type, category, unit, status, name,
          quantity_on_hand, source, source_url, purchase_date, unit_cost,
          notes, variety_id, metadata
        )
        SELECT ${CREATED_BY}, ${CREATED_BY}, ${p.type}, ${p.category}, ${p.unit}, ${p.status}, ${p.name},
               ${p.quantity_on_hand ?? 1}, ${p.source ?? null}, ${p.source_url ?? null}, ${p.purchase_date ?? null}, ${p.unit_cost ?? null},
               ${p.notes ?? null}, v.id, ${meta}::jsonb
          FROM v`;
      created++; inserted++;
    }
  } catch (err) {
    failures.push({ packet: i + 1, name: p?.name ?? e.packet.name, error: err?.message ?? String(err) });
    console.error(`FAILED packet ${i + 1} (${p?.name ?? e.packet.name}): ${err?.message ?? err}`);
  }
}

// V4-SEEDINV-001 / L-239 facet-tag guard: the CREATE branch above inserts plant_varieties directly,
// bypassing the /api/varieties post-commit applyDerive call site (lambda/varieties/index.js). Without
// this, seed-loaded varieties carry NO derived type:/lifecycle:/... tags and vanish from the Garden
// by-type (faceted) view (root cause of the 2026-07-10 Black Krim bug). Run the idempotent full-fleet
// drift-heal after the load so every variety (created or matched) gets its facet tags. Best-effort;
// never fails the load. Backfill-safe: applyDerive is revive-or-insert against the soft-delete unique.
if (apply) {
  try {
    const d = await applyDerive(sql, null);
    console.log(`derive reconcile: cultivars=${d.cultivars} tags_upserted=${d.tags_upserted} `
      + `links_added=${d.links_added} links_removed=${d.links_removed} failures=${d.failures.length}`);
    if (d.failures.length) console.error('derive reconcile failures:', JSON.stringify(d.failures, null, 2));
  } catch (err) {
    console.error(`derive reconcile FAILED (non-fatal, tags may be missing): ${err?.message ?? err}`);
  }
}

console.log(`\napply summary: varieties_matched=${matched} varieties_created=${created} `
  + `inventory_inserted=${inserted} fill_if_null_cols_applied=${fillsApplied} `
  + `skipped=${counts.SKIP ?? 0} failures=${failures.length}`);
if (failures.length) {
  console.error('FAILURES:', JSON.stringify(failures, null, 2));
  process.exit(2);
}
