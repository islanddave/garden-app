// V4-ICON-001 (Pass B V101 §14) — optical-weight golden gate.
// Hard gate: every migrated (isSvg) glyph's live-area ink-coverage must stay within
// ±tolerance of its approved baseline (drift guard — catches a glyph accidentally
// getting heavier/lighter when re-tuned). Advisory: intra-class uniformity report,
// excluding documented opticalExceptions (e.g. care.pause — §9 rest-state is lighter
// by design). Run `node scripts/icon-ci/optical-weight.mjs --update` to (re)bake the
// baseline after an approved design change. Engine = resvg (CI + local).
// NOTE: absolute coverage % is empirical (resvg, 1.75 stroke, 20x20 live) — the V101
// §14 nominal "7.5%" was a pre-measurement estimate; this baseline supersedes it.
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { GLYPHS, isSvg } from '../../src/lib/iconRegistry.js'
import { liveCoverage } from './_render.mjs'

const BASE = join(dirname(fileURLToPath(import.meta.url)), 'icon-golden-baseline.json')
const update = process.argv.includes('--update')
const measured = {}
for (const [k, e] of Object.entries(GLYPHS)) if (isSvg(e)) measured[k] = liveCoverage(e.svg24)

if (update) {
  const out = { _doc: 'V4-ICON-001 optical-weight baselines (live-area ink-coverage %, resvg). Regenerate with --update only after an APPROVED design change.', tolerance: 1.5, opticalExceptions: ['care.pause', 'nav.back', 'media.pause', 'media.play', 'media.stop', 'status.failed', 'status.dead', 'status.ended', 'severity.low', 'care.sun', 'lifecycle.sprout', 'lifecycle.bud', 'lifecycle.bloom', 'lifecycle.fruit'], glyphs: measured }
  writeFileSync(BASE, JSON.stringify(out, null, 2) + '\n')
  console.log('baseline written:', Object.keys(measured).length, 'glyphs'); process.exit(0)
}

const base = JSON.parse(readFileSync(BASE, 'utf8'))
const TOL = base.tolerance
let fail = 0
for (const [k, cov] of Object.entries(measured)) {
  const exp = base.glyphs[k]
  if (exp == null) { console.log(`✗ ${k}: no baseline (run --update if newly approved)`); fail++; continue }
  const d = +(cov - exp).toFixed(2)
  if (Math.abs(d) > TOL) { console.log(`✗ ${k}: ${cov}% drifted ${d >= 0 ? '+' : ''}${d}pp from baseline ${exp}% (±${TOL})`); fail++ }
}
// advisory uniformity (non-exception line glyphs)
const ex = new Set(base.opticalExceptions || [])
const vals = Object.entries(measured).filter(([k]) => !ex.has(k)).map(([, v]) => v)
const mean = vals.reduce((a, b) => a + b, 0) / vals.length
const spread = Math.max(...vals) - Math.min(...vals)
console.log(`\nuniformity (excl. ${[...ex].join(',') || 'none'}): mean=${mean.toFixed(2)}% spread=${spread.toFixed(2)}pp  [advisory]`)
console.log(fail ? `\nOPTICAL-WEIGHT GOLDEN: FAIL (${fail})` : `OPTICAL-WEIGHT GOLDEN: PASS (${Object.keys(measured).length} glyphs within ±${TOL}pp)`)
process.exit(fail ? 1 : 0)
