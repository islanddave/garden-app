#!/usr/bin/env node
// Generates 0b-data.sql from the researched backfill payload.
//
// WHY A GENERATOR AND NOT A HAND-WRITTEN SQL FILE. 79 rows each carry a named source and a
// per-row epistemic state, and the mapping from that free text onto the four enums is the part
// most likely to be wrong. A generator makes the mapping ONE auditable function instead of 79
// hand-decisions, makes a re-run after a payload correction free, and lets the SQL it emits be
// reviewed as data rather than trusted as prose.
//
// SOURCE OF TRUTH for the payload (NOT in this repo — it is research output, versioned in
// gardening-docs):
//   Projects/Gardening/project-state/_seedvault-20260902/breeding-status-backfill.json
//
// Usage:
//   node gen-0b-data.mjs <path-to-breeding-status-backfill.json> > 0b-data.sql

import { readFileSync } from 'node:fs'

const payloadPath = process.argv[2]
if (!payloadPath) {
  console.error('usage: gen-0b-data.mjs <breeding-status-backfill.json>')
  process.exit(2)
}
const rows = JSON.parse(readFileSync(payloadPath, 'utf8'))

// ── EVIDENCE MAPPING ────────────────────────────────────────────────────────────────────────
// breeding_source is an ARTIFACT axis: what KIND of record established the call. Order matters —
// first match wins, strongest evidence first. Anything that falls through to inference is
// explicitly a derivation, not a citation.
const BREEDER = /\b(Tozer|Bejo|Sakata|Enza|Rijk Zwaan|PanAmerican|Ball (Seed|Horticultural)|Syngenta|Vilmorin|Takii)\b/i
const REFERENCE = /\b(Wikipedia|TOMATOBase|NMSU|Bosland|extension|univ|university|All-America Selections|AAS|USDA|GRIN|Specialty Produce)\b/i
const VENDOR = /\b(Johnny'?s|Botanical Interests|Baker Creek|Burpee|Territorial|Fedco|High Mowing|Pinetree|Totally Tomatoes|Seed Savers|John Scheepers|Park Seed|Harris|True Leaf Market|Everwilde|Reimer|Trade Winds|Urban Farmer|Sandia|Victory Seeds|Thresh|Experimental Farm Network|Kitazawa|Adaptive|Uprising|Wild Boar)\b/i
// Dave's own record. 23 rows say this verbatim and it is exactly what 'grower_record' names.
const GROWER = /the source in the garden's own record/i

function breedingSource (r) {
  const raw = r.raw || ''
  const src = r.source || ''
  // An unresolved identification is a derivation no matter what was consulted to make it.
  if (/^(ID\?|AMBIGUOUS)/i.test(raw) || /by strong inference|most likely/i.test(raw)) return 'inference'
  if (BREEDER.test(src)) return 'breeder'
  if (REFERENCE.test(src)) return 'reference_work'
  if (VENDOR.test(src)) return 'vendor_catalog'
  if (GROWER.test(src)) return 'grower_record'
  return 'inference'
}

// ── SYSTEM + RANK ───────────────────────────────────────────────────────────────────────────
// Returns null system to mean "write nothing for this row".
function classify (r) {
  const raw = r.raw || ''
  const st = r.breeding_status

  if (st === 'f1') {
    // A named F1 is a specific cultivar by construction.
    return { system: 'f1', rank: 'cultivar' }
  }

  if (st === 'open_pollinated') {
    // A deliberate seed MIXTURE is not a cultivar and its breeding system is undefined at this
    // grain. chk_..._op_requires_cultivar would reject an OP claim here, correctly — the payload
    // itself flagged it and the constraint agrees.
    if (/MIXTURE/i.test(raw)) return { system: 'unknown', rank: 'blend' }
    // MCPD SAMPSTAT 300. 'open_pollinated' would assert a uniformity a landrace does not have.
    if (/landrace/i.test(raw)) return { system: 'landrace', rank: 'cultivar' }
    return { system: 'open_pollinated', rank: 'cultivar' }
  }

  if (st === 'unclassifiable') {
    // Pod types and market classes (Habanero, Serrano, Ancho, Scotch Bonnet, Piri Piri...).
    // 'unknown' rather than NULL deliberately: NULL means never asked, 'unknown' means asked and
    // unanswerable, and only the second lets the roster be triaged.
    return { system: 'unknown', rank: 'market_class' }
  }

  if (st === 'disputed') {
    // A stopping condition, not a to-do. Two reputable sources conflict (Cherry Falls: Botanical
    // Interests says hybrid, John Scheepers says OP), so the honest value is 'unknown' — asked and
    // unanswerable FROM HERE. Rank is left NULL unless the name itself is ambiguous.
    return { system: 'unknown', rank: r.name_ambiguous ? 'market_class' : null }
  }

  return { system: null, rank: null }
}

const q = v => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)

const emitted = []
const skipped = []
for (const r of rows) {
  if (!r.variety_id) { skipped.push({ r, why: 'no variety_id — unmatched against the live roster' }); continue }
  const { system, rank } = classify(r)
  if (!system) { skipped.push({ r, why: `unmapped breeding_status '${r.breeding_status}'` }); continue }
  emitted.push({ r, system, rank, source: breedingSource(r), confidence: r.confidence || null })
}

const counts = emitted.reduce((a, e) => { a[e.system] = (a[e.system] || 0) + 1; return a }, {})
const srcCounts = emitted.reduce((a, e) => { a[e.source] = (a[e.source] || 0) + 1; return a }, {})

const out = []
out.push(`-- V5-VARIETYHYBRIDFLAG-001 — 0b-data.sql`)
out.push(`-- GENERATED by gen-0b-data.mjs. Do not hand-edit: fix the payload or the mapping and re-run.`)
out.push(`--`)
out.push(`-- ${emitted.length} rows written, ${skipped.length} skipped.`)
out.push(`-- breeding_system: ${JSON.stringify(counts)}`)
out.push(`-- breeding_source: ${JSON.stringify(srcCounts)}`)
out.push(`--`)
out.push(`-- Every UPDATE is guarded on deleted_at IS NULL. A soft-deleted variety is not repaired by`)
out.push(`-- a backfill: it is out of the app's world, and writing to it would make the post-gate`)
out.push(`-- counts disagree with what any user-facing surface can see.`)
out.push(`--`)
out.push(`-- NOT LOADED, deliberately: inventory_items.metadata heirloom / open_pollinated / hybrid_f1.`)
out.push(`-- They partition by vendor and Mary's Heirloom Seeds is 36-for-36 'heirloom: true' including`)
out.push(`-- a variety named 'Biquinho Yellow F1'. This payload is independent research with a named`)
out.push(`-- source per row.`)
if (skipped.length) {
  out.push(`--`)
  out.push(`-- SKIPPED:`)
  for (const s of skipped) out.push(`--   ${s.r.cultivar} — ${s.why}`)
}
out.push(``)
out.push(`BEGIN;`)
out.push(``)
for (const e of emitted) {
  const { r } = e
  out.push(`-- ${r.cultivar}${r.db_name && r.db_name !== r.cultivar ? ` (db: ${r.db_name})` : ''} — ${r.raw}`)
  out.push(`--   src: ${(r.source || '').replace(/\s+/g, ' ').slice(0, 150)}`)
  out.push(`UPDATE public.plant_varieties SET`)
  out.push(`    breeding_system = ${q(e.system)},`)
  out.push(`    breeding_source = ${q(e.source)},`)
  out.push(`    breeding_confidence = ${q(e.confidence)},`)
  out.push(`    variety_rank = ${q(e.rank)}`)
  out.push(`  WHERE id = ${q(r.variety_id)} AND deleted_at IS NULL;`)
  out.push(``)
}
out.push(`INSERT INTO public.schema_version (version, description, applied_at)`)
out.push(`VALUES ('4.101.0-varietyhybridflag-001-data',`)
out.push(`        'VARIETYHYBRIDFLAG backfill: ${emitted.length} live cultivars given a researched breeding call with a named source per row. ${JSON.stringify(counts).replace(/'/g, '')}. Generated by gen-0b-data.mjs from breeding-status-backfill.json; no vendor metadata loaded.',`)
out.push(`        now())`)
out.push(`ON CONFLICT (version) DO UPDATE SET applied_at = now(), description = EXCLUDED.description;`)
out.push(``)
out.push(`COMMIT;`)

process.stdout.write(out.join('\n') + '\n')
console.error(`[gen-0b-data] ${emitted.length} emitted, ${skipped.length} skipped`)
console.error(`[gen-0b-data] system: ${JSON.stringify(counts)}`)
console.error(`[gen-0b-data] source: ${JSON.stringify(srcCounts)}`)
