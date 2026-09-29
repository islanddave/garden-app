#!/usr/bin/env node
// mutate-today-shape-v2.mjs — the proof that gate:today-shape:v2 can go RED (V5-TODAYREDESIGN-001 S0).
//
//   node scripts/mutate-today-shape-v2.mjs                 # every ARMED chrome mutant
//   node scripts/mutate-today-shape-v2.mjs prefsClientDark # named ones
//
// scripts/mutate-today-shape-check.mjs's discipline (control first; a mutant that never applied is not
// evidence; ≥ 2 INDEPENDENT killer families per mutant), over the v2 catalogue (tests/harness/todayMutantsV2.mjs)
// and served through tests/harness/vite.harness.v2mutant.mjs. Two differences, both forced by a contract that
// arms slice by slice:
//   · PENDING mutants (their slice has not landed, so there is no source to mutate) and unit-table mutants
//     (§13 Simplify 3) are LISTED AND COUNTED, never scored.
//   · Families are read from the gate's `[family]` tag, not by regex. The ≥ 2 bar counts only families that are
//     ARMED for that mutant today; a mutant with fewer than two armed expected families is reported
//     "UNDER-GUARDED BY SCHEDULE" (loud, named, with the slice that arms the next family) and does not fail the
//     matrix — its slice's DoD re-runs it with both families armed. A mutant that SURVIVES, never APPLIED, or
//     reds only via instrument/crash still fails the matrix.
// COST: one Vite boot + one Chrome + 20 page loads per mutant, plus the control. A command, not a CI step.
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MUTANTS_V2, RETIRED_V2 } from '../tests/harness/todayMutantsV2.mjs'
import { LANDED, isArmed, STATES, SHELL } from '../tests/harness/_todaymeasure/today-v2-contract.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const only = process.argv.slice(2).filter(a => !a.startsWith('-'))
for (const n of only) if (!MUTANTS_V2[n]) { console.error(`unknown mutant '${n}'. Known: ${Object.keys(MUTANTS_V2).join(', ')}`); process.exit(2) }
const all = Object.entries(MUTANTS_V2).filter(([n]) => !only.length || only.includes(n))
const runnable = all.filter(([, m]) => m.kind === 'chrome' && isArmed(m) && m.file && m.find)
const pendingM = all.filter(([, m]) => m.kind === 'chrome' && !(isArmed(m) && m.file && m.find))
const unitCells = all.filter(([, m]) => m.kind === 'unit-table')
for (const [n, m] of all) if (m.kind === 'chrome' && isArmed(m) && !(m.file && m.find)) { console.error(`[mutate-v2] ${n} is armed (${m.armedAt} landed) but carries no source pattern — its slice must fill it in`); process.exit(1) }

// Which of a mutant's expected families are armed today: a family is armed when ANY state carries an armed
// check of it (the instrument family 'prefs-instrument' is armed from S0 on every state) — or, since S3, when the
// SHELL gate carries one (sticky, jump-landing, back-restore: the platform half only today-shell-v2.mjs measures).
const armedFamilies = new Set([...STATES.flatMap(s => s.checks.filter(c => isArmed(c)).map(c => c.family)), ...SHELL.filter(c => isArmed(c)).map(c => c.family)])
// S3: the shell gate runs beside the page gate, for the control and every mutant, once any of its platform checks
// is armed; their `[family]` lines are pooled. Its own instrument ('shell-instrument') can never count as a killer.
const SHELL_ARMED = SHELL.some(c => c.family !== 'shell-instrument' && isArmed(c))
const INSTRUMENT = new Set(['instrument', 'void', 'crash', 'fixture', 'shell-instrument'])
const gate = (script, env) => spawnSync(process.execPath, [resolve(ROOT, script)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } })
const run = (env) => {
  const page = gate('scripts/layout-gate/today-shape-v2.mjs', env)
  if (!SHELL_ARMED) return page
  const shell = gate('scripts/layout-gate/today-shell-v2.mjs', env)
  return { status: page.status || shell.status, stdout: (page.stdout || '') + (shell.stdout || ''), stderr: (page.stderr || '') + (shell.stderr || '') }
}

console.log(`[mutate-v2] LANDED ${LANDED.join(', ')} · ${runnable.length} armed mutant(s) to run · ${pendingM.length} PENDING · ${unitCells.length} moved to the triggers.js unit table · ${Object.keys(RETIRED_V2).length} retired · shell gate ${SHELL_ARMED ? 'runs beside the page gate' : 'not run (no platform check armed)'}`)
console.log('[mutate-v2] control run on the UNMUTATED tree — the gate must be GREEN before any RED below means anything…')
const control = run({})
if (control.status !== 0) {
  console.error('[mutate-v2] ABORT — the gate is RED on the unmutated tree:')
  console.error((control.stdout + control.stderr).split('\n').filter(l => l.includes('· ')).join('\n'))
  process.exit(1)
}
console.log('[mutate-v2] control GREEN.\n')

const rows = []
for (const [name, m] of runnable) {
  const r = run({ TODAY_SHAPE_V2_MUT: name, GATE_HARNESS_CONFIG: 'tests/harness/vite.harness.v2mutant.mjs' })
  const out = (r.stdout || '') + (r.stderr || '')
  const applied = /\[MUTANT APPLIED\]/.test(out)
  const lines = out.split('\n').filter(l => l.trim().startsWith('· '))
  const fams = [...new Set(lines.map(l => (l.match(/: \[([a-z0-9-]+)\] /) || [])[1]).filter(Boolean))]
  const real = fams.filter(f => !INSTRUMENT.has(f))
  const expectArmed = m.killers.filter(k => armedFamilies.has(k))
  rows.push({ name, m, red: r.status !== 0, applied, fams, real, expectArmed })
  console.log(`${!applied ? 'NOT-APPLIED' : r.status !== 0 ? 'RED ' : 'GREEN'}  ${name.padEnd(22)} killers: ${fams.join(', ') || '(none)'}`)
}

console.log('\n── V2 MUTATION MATRIX ─────────────────────────────────────────────────────────')
console.log('| mutant | arms at | defect simulated | result | killers (armed / expected) |')
console.log('|---|---|---|---|---|')
for (const r of rows) console.log(`| \`${r.name}\` | ${r.m.armedAt} | ${r.m.defect} | ${r.applied ? (r.red ? '**RED**' : 'GREEN — SURVIVED') : '**NOT APPLIED**'} | ${r.real.join(' + ') || '—'} / ${r.m.killers.join(' + ')} |`)
for (const [n, m] of pendingM) console.log(`| \`${n}\` | ${m.armedAt} | ${m.defect} | ⏸ PENDING — its slice has not landed | — / ${m.killers.join(' + ')} |`)
for (const [n, m] of unitCells) console.log(`| \`${n}\` | ${m.armedAt} | ${m.defect} | ↳ triggers.js unit-table cell (§13 Simplify 3) | — |`)
for (const [n, why] of Object.entries(RETIRED_V2)) console.log(`| \`${n}\` | — | retired | ✂ ${why} | — |`)

const problems = []
const underGuarded = []
for (const r of rows) {
  if (!r.applied) problems.push(`${r.name}: the mutation never applied — not evidence of anything`)
  else if (!r.red) problems.push(`${r.name}: SURVIVED. The gate does not see "${r.m.defect}"`)
  else if (r.real.length === 0) problems.push(`${r.name}: red only via ${r.fams.join('/')} — the gate caught the page falling over, not the shape`)
  else if (r.real.length < 2) {
    if (r.expectArmed.length < 2) underGuarded.push(`${r.name}: ONE killer (${r.real[0]}) — only ${r.expectArmed.length} of its expected families [${r.m.killers.join(', ')}] is armed at ${LANDED.join('+')}; the next arms with its slice. UNDER-GUARDED BY SCHEDULE, not guarded.`)
    else problems.push(`${r.name}: NOT YET GUARDED — one killer only (${r.real[0]}) although ${r.expectArmed.length} expected families are armed`)
  }
}
console.log(`\n[mutate-v2] ${rows.length} run · ${pendingM.length} PENDING (not scored) · ${unitCells.length} unit-table cells (not scored here)`)
for (const u of underGuarded) console.log('  ⚠ ' + u)
if (problems.length) { console.error(`\n[mutate-v2] ${problems.length} problem(s):`); for (const p of problems) console.error('  · ' + p); process.exit(1) }
console.log(`[mutate-v2] every armed mutant turned the gate RED${underGuarded.length ? ` (${underGuarded.length} under-guarded by schedule, listed above)` : ', each on >=2 independent killers'}.`)
