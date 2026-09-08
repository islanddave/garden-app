#!/usr/bin/env node
// mutate-today-shape-check.mjs — the proof that scripts/layout-gate/today-shape.mjs can go RED.
//
//   node scripts/mutate-today-shape-check.mjs                       # every mutant
//   node scripts/mutate-today-shape-check.mjs clipRowPanel dropRainNote
//
// WHY THIS EXISTS AS A FILE. Modelled on scripts/mutate-storage-deadlines-check.mjs, deliberately:
// that one exists because a guard was green for five days while the date it "guarded" was 15-44 days
// wrong, and it could not fail. This project has since shipped a gate that read GREEN while masking
// the very loss it existed to catch. A gate that has not been SHOWN to fail on the specific defect
// it was built for is a claim, not a guard — so this applies each defect to the real page, runs the
// real gate, and asserts the gate goes RED.
//
// It also reports WHICH assertion killed each mutant, and refuses to call a region guarded on fewer
// than two INDEPENDENT killers — two assertions that die to the same defect for the same reason are
// one guard with two names, and one careless rename from vacuous.
//
// COST: ~35s per mutant (one Vite boot + one Chrome + four page loads). The full matrix is ~10min,
// which is why it is a command rather than a per-push CI step. Run it after any edit to the gate,
// the region anchors, or the Today composition.
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// From the data file, NOT from vite.harness.mutant.mjs: importing the config evaluates its default
// export, which builds the mutation plugin, which throws when no TODAY_SHAPE_MUT is set. This runner
// would crash before running anything — and the shell wrapper reported exit 0 while it did.
import { MUTANTS } from '../tests/harness/todayMutants.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const only = process.argv.slice(2).filter(a => !a.startsWith('-'))
const NAMES = only.length ? only : Object.keys(MUTANTS)
for (const n of NAMES) if (!MUTANTS[n]) { console.error(`unknown mutant '${n}'. Known: ${Object.keys(MUTANTS).join(', ')}`); process.exit(2) }

// Which assertion families each failure line belongs to. Classifying the OUTPUT rather than
// pre-declaring which assertion "should" fire is the point: it is how a mutant that reds for an
// unrelated reason (a crash, a timeout, a fixture miss) is told apart from one the gate actually
// caught — that distinction is exactly what makes a RED meaningful.
const KILLERS = [
  ['census-count', /rendered \d+x, expected|care rows, expected exactly|group cards, expected exactly|EXPANDED group panel|is not in the census at all/],
  // Deliberately its own family, not folded into census-count: it is keyed on a DIFFERENT budget
  // field (`regionsPresent`, one number for the whole page) and therefore survives the edit that
  // would silently remove a per-region entry. That is what makes it an independent second killer
  // for the small regions rather than a restatement of the first.
  ['region-headcount', /regions render in this state/],
  ['budget-integrity', /UNGUARDED here/],
  ['visibility', /occupies NO SPACE|present but renders h=|panel holding \d+ children renders/],
  ['row-height-floor', /under the \d+px floor — present, non-zero/],
  ['region-floor', /under its \d+px floor/],
  ['region-top', /paints at y=\d+, \d+px (lower|higher)/],
  ['scroll-floor', /BELOW the \d+px floor/],
  ['content-bottom-floor', /last painted pixel/],
  ['ink-floor', /whole-page ink is/],
  ['controls-floor', /visible controls, under the/],
  ['first-control-ceiling', /first control on the page is at/],
  ['visual-order', /VISUAL order broken/],
  ['scroll-ceiling', /over the \d+px ceiling/],
  ['hscroll', /scrolls sideways/],
  ['instrument', /VOID|clock is NOT pinned|Open-Meteo was NOT stubbed|fixture .* is unusable|raised ".*" while mounting|every one of \d+ measured boxes is 0px/],
  ['crash', /gate could not complete/],
]
const classify = (line) => (KILLERS.find(([, re]) => re.test(line)) || ['other'])[0]

const run = (env) => spawnSync(process.execPath, [resolve(ROOT, 'scripts/layout-gate/today-shape.mjs')], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, ...env },
})

// THE UNMUTATED CONTROL, FIRST. "The gate went red under a mutant" means nothing if the gate is red
// on the clean tree too — that is a broken gate reporting as a working one, and it is the single
// result here that would invert the whole matrix.
console.log('[mutate] control run on the UNMUTATED tree — the gate must be GREEN before any RED below means anything…')
const control = run({})
if (control.status !== 0) {
  console.error('[mutate] ABORT — the gate is RED on the unmutated tree, so every "RED" below would be meaningless:')
  console.error(control.stdout.split('\n').filter(l => l.includes('·')).join('\n'))
  console.error(control.stderr)
  process.exit(1)
}
console.log('[mutate] control GREEN.\n')

const rows = []
for (const name of NAMES) {
  const [file, , , defect] = MUTANTS[name]
  const r = run({ TODAY_SHAPE_MUT: name, GATE_HARNESS_CONFIG: 'tests/harness/vite.harness.mutant.mjs' })
  const out = (r.stdout || '') + (r.stderr || '')
  const applied = /\[MUTANT APPLIED\]/.test(out)
  const lines = out.split('\n').filter(l => l.trim().startsWith('· '))
  const killers = [...new Set(lines.map(classify))].filter(k => k !== 'other')
  const red = r.status !== 0
  rows.push({ name, file, defect, red, applied, killers, sample: lines.slice(0, 2).map(l => l.trim().replace(/^· /, '')) })
  const verdict = !applied ? 'NOT-APPLIED' : red ? 'RED ' : 'GREEN'
  console.log(`${verdict}  ${name.padEnd(20)} killers: ${killers.join(', ') || '(none)'}`)
  for (const s of rows[rows.length - 1].sample) console.log(`         ${s.slice(0, 190)}`)
}

console.log('\n── MUTATION MATRIX ─────────────────────────────────────────────────────────────')
console.log('| mutant | defect simulated | result | killers |')
console.log('|---|---|---|---|')
for (const r of rows) console.log(`| \`${r.name}\` | ${r.defect} | ${r.applied ? (r.red ? '**RED**' : 'GREEN — SURVIVED') : '**NOT APPLIED**'} | ${r.killers.join(' + ') || '—'} |`)

const problems = []
for (const r of rows) {
  if (!r.applied) problems.push(`${r.name}: the mutation never applied — this row is not evidence of anything`)
  else if (!r.red) problems.push(`${r.name}: SURVIVED. The gate does not see "${r.defect}"`)
  // The ">=2 independent killers" bar. `crash` and `instrument` are excluded from the count on
  // purpose: a mutant that crashed the page proves the page broke, not that the gate can see the
  // shape being simulated.
  else {
    const real = r.killers.filter(k => k !== 'crash' && k !== 'instrument')
    if (real.length === 0) problems.push(`${r.name}: red, but only via ${r.killers.join('/')} — the gate did not catch the SHAPE, it caught the page falling over`)
    else if (real.length < 2) problems.push(`${r.name}: NOT YET GUARDED — one killer only (${real[0]}). One careless rename from vacuous.`)
  }
}
if (problems.length) {
  console.error(`\n[mutate] ${problems.length} problem(s):`)
  for (const p of problems) console.error('  · ' + p)
  process.exit(1)
}
console.log(`\n[mutate] all ${rows.length} mutant(s) turned the gate RED, each on >=2 independent killers.`)
