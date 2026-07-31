#!/usr/bin/env node
// ============================================================
// CAL-1 seed CLI — src/data/harvest-weights-v2.json -> 0d-seed-samples.sql + 0d-coverage.sql
// ============================================================
// V4-CAL1HARV-001 (per-variety, crucible V100). PURE transform — no DB access at generate time; the
// fail-CLOSED cultivar keying happens IN-DATABASE at apply time. The emitted SQL is Dave-gated (apply
// staging first). Also prints an oracle-driven derived preview so the numbers are visible before applying.
//
//   node scripts/cal1/gen-cal1-seed.mjs --batch 20260730-evening
//   (optional: --model <path>  --out <dir>)

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { generateSeedSQL, derivedPreview } from '../../src/lib/cal1Seed.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}

const batch = arg('--batch')
if (!batch) {
  console.error('usage: gen-cal1-seed.mjs --batch <id>   (a run = a seed_batch; e.g. 20260730-evening)')
  process.exit(2)
}
const modelPath = resolve(root, arg('--model', 'src/data/harvest-weights-v2.json'))
const outDir = resolve(root, arg('--out', 'migrations/v4-cal1-pervariety-001'))

const model = JSON.parse(readFileSync(modelPath, 'utf8'))
const { seedSQL, coverageSQL, stats } = generateSeedSQL(model, { batch })
writeFileSync(resolve(outDir, '0d-seed-samples.sql'), seedSQL)
writeFileSync(resolve(outDir, '0d-coverage.sql'), coverageSQL)

console.log(`CAL-1 seed generated (batch ${stats.batch}): ${stats.samples} sample(s), ${stats.distinctKeys} cultivar key(s).`)
console.log('Derived preview (per cultivar,unit) — "no usable samples" => < min-n or none:')
for (const p of derivedPreview(model)) {
  const d = p.derived
  const desc = d
    ? `${d.grams_per_unit.toFixed(1)} g/${p.unit} (n=${d.sample_n}, ${d.confidence}${d.usable_for_comparison ? '' : ', provisional'})`
    : 'no usable samples'
  console.log(`  ${p.slug} / ${p.name} [${p.unit}]: ${desc}`)
}
console.log(`Wrote ${outDir}/0d-seed-samples.sql + 0d-coverage.sql. Apply is Dave-gated (staging first).`)
