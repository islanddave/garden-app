// load.mjs — V4-SEEDINV-002 July-2026 intake loader (BI #350019 + Mary's Heirloom, 74 packets).
//   Reuses the panel-locked semantics of v4-seedinv-001/0b-load-seeds.mjs (fresh live variety match;
//   ambiguous -> SKIP never guess; EXISTING = fill-if-null only; NEW = full sow profile; re-run guard;
//   applyDerive facet-tag heal after apply). Two deltas vs 0b:
//     (1) V4-SEEDLOAD-001 fix — crop_type_slug is gated on the LIVE crop_types catalog (passed into
//         packetToVarietyCols as {validSlugs}) instead of the static CROP_TYPE_SLUGS list that had
//         drifted behind the table, so carrot/radish/four_o_clock/etc. no longer drop to null.
//     (2) Creates the 7 crop_types rows this intake needs but the catalog lacks (parsnip, artichoke,
//         brussels_sprouts, viola, morning_glory, stock, delphinium) BEFORE loading — required because
//         plant_varieties.crop_type_slug is an FK to crop_types (a missing row would hard-fail the insert).
//
//   Usage (DRY RUN is the default — prints the decision table, writes NOTHING):
//     DATABASE_URL=<neon-url> node migrations/v4-seedinv-002-jul-intake/load.mjs
//   Apply (Dave-gated; confirm the target host printed at startup):
//     DATABASE_URL=<neon-url> node migrations/v4-seedinv-002-jul-intake/load.mjs --apply
//   Run from a dir that can resolve @neondatabase/serverless (repo root node_modules does).

import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { packetToVarietyCols, packetToInventoryPayload, parseRange } from '../../src/lib/parseSowProfile.js';
import { applyDerive } from '../../lambda/varieties/crop-derive.js';

const CREATED_BY = 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI'; // Dave's clerk sub (spec ground truth)
const CT_CREATED_BY = 'seed-intake-2026-07-20';
const DATASET_URL = new URL('./dataset.json', import.meta.url);
const METADATA_BYTE_CAP = 8192;

// crop_types rows this intake needs that the live catalog lacks (FK target for new varieties).
const NEW_CROP_TYPES = [
  { slug: 'parsnip',          display_name: 'Parsnip',          category: 'vegetable', default_lifecycle: 'biennial' },
  { slug: 'artichoke',        display_name: 'Artichoke',        category: 'vegetable', default_lifecycle: 'perennial' },
  { slug: 'brussels_sprouts', display_name: 'Brussels Sprouts', category: 'vegetable', default_lifecycle: 'biennial' },
  { slug: 'viola',            display_name: 'Viola',            category: 'flower',    default_lifecycle: 'perennial' },
  { slug: 'morning_glory',    display_name: 'Morning Glory',    category: 'flower',    default_lifecycle: 'annual' },
  { slug: 'stock',            display_name: 'Stock',            category: 'flower',    default_lifecycle: 'annual' },
  { slug: 'delphinium',       display_name: 'Delphinium',       category: 'flower',    default_lifecycle: 'perennial' },
];

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

// ---- Preflight: 0a sow columns present ---------------------------------------------------------------------
const pre = await sql`SELECT 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='plant_varieties' AND column_name='start_method'`;
if (pre.length === 0) { console.error('plant_varieties.start_method missing — apply v4-seedinv-001/0a first.'); process.exit(1); }

// ---- crop_types: report gaps; create on --apply (idempotent) ------------------------------------------------
const ctBefore = new Set((await sql`SELECT slug FROM crop_types WHERE deleted_at IS NULL`).map((r) => r.slug));
const missing = NEW_CROP_TYPES.filter((c) => !ctBefore.has(c.slug));
console.log(`crop_types: live=${ctBefore.size}; this intake needs created=${missing.map((c) => c.slug).join(',') || 'none'}`);
if (apply && missing.length) {
  for (const c of missing) {
    await sql`INSERT INTO crop_types (slug, display_name, category, default_lifecycle, sort_order, created_by)
              VALUES (${c.slug}, ${c.display_name}, ${c.category}, ${c.default_lifecycle}, 0, ${CT_CREATED_BY})
              ON CONFLICT (slug) DO NOTHING`;
  }
  console.log(`crop_types: created ${missing.length} rows`);
}
// validSlugs reflects the catalog AS IT WILL BE after create, so the dry-run plan shows the true post-create slug.
const validSlugs = new Set([...ctBefore, ...NEW_CROP_TYPES.map((c) => c.slug)]);

// ---- Load dataset + live state ------------------------------------------------------------------------------
const dataset = JSON.parse(readFileSync(DATASET_URL, 'utf8'));
const packets = dataset.packets ?? [];
const live = await sql`
  SELECT id, name, crop_type_slug, lifecycle, grown_as, sun_requirements,
         days_to_maturity_min, days_to_maturity_max, start_method, start_indoor_weeks_min, start_indoor_weeks_max,
         direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in,
         days_to_germ_min, days_to_germ_max, sow_season, sow_notes
    FROM public.plant_varieties WHERE deleted_at IS NULL`;
const liveSeedItems = await sql`
  SELECT lower(name) AS lname, COALESCE(metadata->>'origin','') AS origin FROM public.inventory_items
   WHERE category='seeds' AND created_by=${CREATED_BY} AND deleted_at IS NULL`;
// Idempotency is keyed on PACKET identity (name + order origin), NOT name alone. A genuinely new packet
// — a restock, or the same variety from a different vendor/order — ALWAYS gets its own inventory listing;
// only re-running THIS exact order dedupes. (Dave: seeds from different vendors stay separate, tracked
// separately; sharing the underlying variety is fine, merging the packets is not.)
const alreadyLoaded = new Set(liveSeedItems.map((r) => `${r.lname}|${r.origin}`));
console.log(`packets=${packets.length} live_varieties=${live.length} live_seed_items=${alreadyLoaded.size}`);

function matchVariety(packet) {
  const candidates = [packet.matched_variety_name, packet.variety].filter(Boolean).map((s) => s.toLowerCase());
  for (const cand of candidates) {
    const exact = live.filter((v) => v.name.toLowerCase() === cand);
    if (exact.length === 1) return { kind: 'exact', variety: exact[0] };
    if (exact.length > 1) {
      const byCrop = packet.crop_type_slug_guess ? exact.filter((v) => v.crop_type_slug === packet.crop_type_slug_guess) : [];
      if (byCrop.length === 1) return { kind: 'exact', variety: byCrop[0] };
      return { kind: 'ambiguous', candidates: exact };
    }
  }
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

function computeFills(existing, cols) {
  const fills = []; const kept = [];
  for (const col of FILL_COLS) {
    const incoming = cols?.[col];
    if (incoming == null) continue;
    const cur = existing[col];
    if (cur == null) { fills.push(col); continue; }
    const differs = (typeof incoming === 'number') ? Number(cur) !== Number(incoming) : String(cur) !== String(incoming);
    if (differs) kept.push(col);
  }
  return { fills, kept };
}

// ---- Build the per-packet plan ------------------------------------------------------------------------------
// Intra-run dup guard: a NEW variety name appearing in >1 packet (e.g. "Thai Hot" in both the BI and Mary's
// orders) must CREATE the variety once and LINK the later packets' inventory to it — else the second CREATE
// violates uq_plant_varieties_name_species. Keyed on lower(name)|lower(species) to match that constraint.
const plannedCreates = new Map();
const nameKey = (c) => `${(c.name || '').toLowerCase()}|${(c.species || '').toLowerCase()}`;
const plan = [];
for (const packet of packets) {
  // V4-SEEDLOAD-001: live-catalog gate (is the slug real?).
  // V4-CROPGUESS-001: cross-check (does the slug MATCH THIS PACKET'S OWN CROP?). The catalog
  // gate cannot answer the second question — `endive` was a perfectly valid slug for a radicchio
  // packet. An unresolved guess yields no crop_type_slug and is refused below, same as untyped.
  const cols = packetToVarietyCols(packet, { validSlugs, crossCheck: true });
  const wk = parseRange(packet.sow_profile?.start_indoor_weeks_before_lastfrost ?? null);
  const weeksLabel = wk.min == null ? '-' : (wk.min === wk.max ? `${wk.min}w` : `${wk.min}-${wk.max}w`);
  const entry = { packet, cols, weeksLabel };
  let m = matchVariety(packet);
  if (m.kind === 'ambiguous') {
    // Dave: don't guess-merge a packet into one of several same-named varieties. Create a DISTINCT
    // variety for this packet instead of dropping it — keeps vendor seeds separate & tracked.
    entry.ambiguousNote = `ambiguous vs ${m.candidates.length} existing (${m.candidates.map((c) => c.name).join(', ')}) — creating a distinct variety, not merging`;
    m = { kind: 'none' };
  }
  const varietyId = m.kind === 'none' ? null : m.variety.id;
  const payload = packetToInventoryPayload(packet, { variety_id: varietyId, created_by: CREATED_BY });
  entry.payload = payload;
  const packetKey = `${(payload.name ?? packet.name).toLowerCase()}|${packet.origin ?? ''}`;
  if (alreadyLoaded.has(packetKey)) {
    entry.action = 'SKIP'; entry.detail = `already loaded (this exact packet from ${packet.origin})`; plan.push(entry); continue;
  }
  const metaBytes = Buffer.byteLength(JSON.stringify(payload.metadata ?? {}), 'utf8');
  if (metaBytes >= METADATA_BYTE_CAP) {
    entry.action = 'SKIP'; entry.detail = `metadata too large (${metaBytes}B)`; plan.push(entry); continue;
  }
  if (m.kind === 'none') {
    if (cols.crop_type_slug == null) {
      // Two distinct causes, deliberately reported apart: an UNTYPED packet has no valid slug at
      // all; a MISTYPED one has a slug that is valid but disagrees with the packet's own crop name
      // (the Radicchio->endive class). Collapsing them would send the reader to the wrong fix —
      // untyped means "create the crop type", mistyped means "correct the guess, or add a reviewed
      // synonym". Both refuse to load.
      const cg = cols.crop_guess;
      if (cg && cg.status === 'unresolved') {
        entry.action = 'WARN-MISTYPED';
        entry.detail = `new variety "${cols.name}" has a WRONG-BUT-VALID crop guess: crop "${packet.crop}" slugifies to '${cg.cropSlug}' but guess is '${cg.guess}' — correct the guess or add a reviewed CROP_GUESS_SYNONYMS entry; NOT loading`;
      } else {
        entry.action = 'WARN-UNTYPED';
        entry.detail = `new variety "${cols.name}" would be UNTYPED (guess=${packet.crop_type_slug_guess ?? 'null'} not in crop_types) — would vanish from by-type; NOT loading`;
      }
    } else {
      const k = nameKey(cols);
      if (plannedCreates.has(k)) {
        entry.action = 'LINK-NEW'; entry.linkKey = k;
        entry.detail = `2nd packet of new variety "${cols.name}" [${cols.crop_type_slug}] — links to the CREATE above (one variety, two packets)`;
      } else {
        plannedCreates.set(k, entry);
        entry.action = 'CREATE';
        entry.detail = `new variety "${cols.name}" [${cols.crop_type_slug}]`
          + (entry.ambiguousNote ? ` (${entry.ambiguousNote})` : '');
      }
    }
  } else {
    const { fills, kept } = computeFills(m.variety, cols);
    entry.action = 'MATCH'; entry.varietyId = m.variety.id; entry.fills = fills;
    entry.detail = `-> ${m.variety.id}:${m.variety.name} (${m.kind}); fill-if-null: ${fills.length ? fills.join(',') : 'none'}`
      + (kept.length ? `; kept non-null: ${kept.join(',')}` : '');
  }
  plan.push(entry);
}

console.log('\n#    action        weeks  packet');
console.log('---  ------------  -----  ' + '-'.repeat(80));
plan.forEach((e, i) => {
  console.log(`${String(i + 1).padStart(3)}  ${e.action.padEnd(12)}  ${e.weeksLabel.padEnd(5)}  ${e.packet.crop} / ${e.packet.variety ?? '?'}`);
  console.log(`${' '.repeat(24)}${e.detail}`);
});
const counts = plan.reduce((a, e) => { a[e.action] = (a[e.action] ?? 0) + 1; return a; }, {});
console.log(`\nplan: MATCH=${counts.MATCH ?? 0} CREATE=${counts.CREATE ?? 0} LINK-NEW=${counts['LINK-NEW'] ?? 0} SKIP=${counts.SKIP ?? 0} WARN-UNTYPED=${counts['WARN-UNTYPED'] ?? 0} WARN-MISTYPED=${counts['WARN-MISTYPED'] ?? 0} (of ${plan.length})`);
if (counts['WARN-UNTYPED']) console.error('REFUSING to load untyped varieties — fix crop_types/slug gate first.');
if (counts['WARN-MISTYPED']) console.error('REFUSING to load mistyped varieties — a guess is valid but disagrees with its packet crop (V4-CROPGUESS-001). Correct the guess, or add a reviewed CROP_GUESS_SYNONYMS entry.');

if (!apply) { console.log('\nDRY-RUN complete — no writes. Re-run with --apply to execute.'); process.exit(0); }

// ---- APPLY --------------------------------------------------------------------------------------------------
let matched = 0; let created = 0; let linked = 0; let inserted = 0; let fillsApplied = 0; const failures = [];
const createdIds = new Map(); // nameKey -> variety id created this run (for LINK-NEW dup packets)
for (const [i, e] of plan.entries()) {
  if (e.action === 'SKIP' || e.action === 'WARN-UNTYPED' || e.action === 'WARN-MISTYPED') continue;
  const c = e.cols; const p = e.payload; const meta = JSON.stringify(p.metadata ?? {});
  try {
    if (e.action === 'MATCH') {
      await sql.transaction([
        sql`UPDATE public.plant_varieties SET
            lifecycle=COALESCE(lifecycle,${c.lifecycle ?? null}), grown_as=COALESCE(grown_as,${c.grown_as ?? null}),
            sun_requirements=COALESCE(sun_requirements,${c.sun_requirements ?? null}),
            days_to_maturity_min=COALESCE(days_to_maturity_min,${c.days_to_maturity_min ?? null}),
            days_to_maturity_max=COALESCE(days_to_maturity_max,${c.days_to_maturity_max ?? null}),
            start_method=COALESCE(start_method,${c.start_method ?? null}),
            start_indoor_weeks_min=COALESCE(start_indoor_weeks_min,${c.start_indoor_weeks_min ?? null}),
            start_indoor_weeks_max=COALESCE(start_indoor_weeks_max,${c.start_indoor_weeks_max ?? null}),
            direct_sow_timing=COALESCE(direct_sow_timing,${c.direct_sow_timing ?? null}),
            sow_depth_in=COALESCE(sow_depth_in,${c.sow_depth_in ?? null}),
            seed_spacing_in=COALESCE(seed_spacing_in,${c.seed_spacing_in ?? null}),
            row_spacing_in=COALESCE(row_spacing_in,${c.row_spacing_in ?? null}),
            days_to_germ_min=COALESCE(days_to_germ_min,${c.days_to_germ_min ?? null}),
            days_to_germ_max=COALESCE(days_to_germ_max,${c.days_to_germ_max ?? null}),
            sow_season=COALESCE(sow_season,${c.sow_season ?? null}), sow_notes=COALESCE(sow_notes,${c.sow_notes ?? null})
          WHERE id=${e.varietyId} AND deleted_at IS NULL`,
        sql`INSERT INTO public.inventory_items (user_id, created_by, type, category, unit, status, name,
            quantity_on_hand, source, source_url, purchase_date, unit_cost, notes, variety_id, metadata)
          VALUES (${CREATED_BY},${CREATED_BY},${p.type},${p.category},${p.unit},${p.status},${p.name},
            ${p.quantity_on_hand ?? 1},${p.source ?? null},${p.source_url ?? null},${p.purchase_date ?? null},${p.unit_cost ?? null},
            ${p.notes ?? null},${e.varietyId},${meta}::jsonb)`,
      ]);
      matched++; inserted++; fillsApplied += e.fills.length;
    } else if (e.action === 'CREATE') {
      const rows = await sql`
        WITH v AS (
          INSERT INTO public.plant_varieties (name, species, crop_type_slug, lifecycle, grown_as,
            days_to_maturity_min, days_to_maturity_max, sun_requirements, start_method, start_indoor_weeks_min,
            start_indoor_weeks_max, direct_sow_timing, sow_depth_in, seed_spacing_in, row_spacing_in,
            days_to_germ_min, days_to_germ_max, sow_season, sow_notes, created_by)
          VALUES (${c.name},${c.species ?? null},${c.crop_type_slug ?? null},${c.lifecycle ?? null},${c.grown_as ?? null},
            ${c.days_to_maturity_min ?? null},${c.days_to_maturity_max ?? null},${c.sun_requirements ?? null},
            ${c.start_method ?? null},${c.start_indoor_weeks_min ?? null},${c.start_indoor_weeks_max ?? null},
            ${c.direct_sow_timing ?? null},${c.sow_depth_in ?? null},${c.seed_spacing_in ?? null},${c.row_spacing_in ?? null},
            ${c.days_to_germ_min ?? null},${c.days_to_germ_max ?? null},${c.sow_season ?? null},${c.sow_notes ?? null},${CREATED_BY})
          RETURNING id)
        INSERT INTO public.inventory_items (user_id, created_by, type, category, unit, status, name,
            quantity_on_hand, source, source_url, purchase_date, unit_cost, notes, variety_id, metadata)
        SELECT ${CREATED_BY},${CREATED_BY},${p.type},${p.category},${p.unit},${p.status},${p.name},
            ${p.quantity_on_hand ?? 1},${p.source ?? null},${p.source_url ?? null},${p.purchase_date ?? null},${p.unit_cost ?? null},
            ${p.notes ?? null}, v.id, ${meta}::jsonb FROM v
        RETURNING variety_id`;
      if (rows[0]?.variety_id) createdIds.set(nameKey(c), rows[0].variety_id);
      created++; inserted++;
    } else { // LINK-NEW — second+ packet of a variety created earlier this run; link, don't re-create
      const vid = createdIds.get(e.linkKey);
      if (!vid) { failures.push({ packet: i + 1, name: p.name, error: 'LINK-NEW: primary CREATE id not found (primary may have failed)' }); continue; }
      await sql`INSERT INTO public.inventory_items (user_id, created_by, type, category, unit, status, name,
            quantity_on_hand, source, source_url, purchase_date, unit_cost, notes, variety_id, metadata)
          VALUES (${CREATED_BY},${CREATED_BY},${p.type},${p.category},${p.unit},${p.status},${p.name},
            ${p.quantity_on_hand ?? 1},${p.source ?? null},${p.source_url ?? null},${p.purchase_date ?? null},${p.unit_cost ?? null},
            ${p.notes ?? null},${vid},${meta}::jsonb)`;
      linked++; inserted++;
    }
  } catch (err) {
    failures.push({ packet: i + 1, name: p?.name ?? e.packet.name, error: err?.message ?? String(err) });
    console.error(`FAILED packet ${i + 1} (${p?.name ?? e.packet.name}): ${err?.message ?? err}`);
  }
}

// L-239 facet-tag heal: CREATE inserts plant_varieties directly, bypassing the /api/varieties applyDerive
// call site. Run the idempotent full-fleet derive so every variety gets its type:/lifecycle:/heat tags.
try {
  const d = await applyDerive(sql, null);
  console.log(`derive reconcile: cultivars=${d.cultivars} tags_upserted=${d.tags_upserted} links_added=${d.links_added} links_removed=${d.links_removed} failures=${d.failures.length}`);
  if (d.failures.length) console.error('derive reconcile failures:', JSON.stringify(d.failures, null, 2));
} catch (err) { console.error(`derive reconcile FAILED (non-fatal): ${err?.message ?? err}`); }

console.log(`\napply summary: matched=${matched} created=${created} linked=${linked} inserted=${inserted} fills=${fillsApplied} skipped=${counts.SKIP ?? 0} failures=${failures.length}`);
if (failures.length) { console.error('FAILURES:', JSON.stringify(failures, null, 2)); process.exit(2); }
