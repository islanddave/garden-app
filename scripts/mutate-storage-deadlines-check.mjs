// Mutation proof for the storageDeadlines guards (2026-08-17, crucible D3/D4).
//
// WHY THIS EXISTS AS A FILE AND NOT A SCRATCH SCRIPT. The guard this replaced —
// `expect((Date.UTC(2026,8,28) - Date.UTC(2026,8,25)) / 86400000).toBe(3)` — was green for five days
// while the date it "guarded" was 15-44 days wrong, because it could not fail. A green suite is not
// evidence that a guard discriminates. This applies each mutation to the real data file, runs the
// real suite, and asserts the suite goes RED, then restores the file. Re-run it after any edit to
// storageDeadlines.json or its tests: `node scripts/mutate-storage-deadlines-check.mjs`.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const DATA = 'src/data/storageDeadlines.json'
const SUITES = ['src/__tests__/storageDeadlines.test.js', 'src/__tests__/StorageDeadlineAlert.test.jsx']

// Each mutation states the DEFECT it simulates, so a future reader can tell whether the guard set
// still covers the failure mode rather than just whether the script exits 0.
const MUTATIONS = [
  ['reverts to the 09-25 date the crucible overturned', d => {
    d.by_crop_type.sweet_potato.deadline_month_day = '09-25'
    d.by_crop_type.sweet_potato.check_from_month_day = '09-11'
  }],
  ['pushes the deadline past the median first frost (no longer a backstop)', d => {
    d.by_crop_type.sweet_potato.deadline_month_day = '11-01'
  }],
  ['drops measured_basis, leaving the date defended by prose alone', d => {
    delete d.by_crop_type.sweet_potato.measured_basis
  }],
  ['claims an earliest first frost its own per-year table contradicts', d => {
    d.by_crop_type.sweet_potato.measured_basis.first_frost_earliest_month_day = '09-20'
  }],
  ['strips the site coordinates from the reproduction query', d => {
    d.by_crop_type.sweet_potato.measured_basis.query = 'GET https://archive-api.open-meteo.com/v1/archive'
  }],
  ['drops the forecast action, leaving the date to read as the trigger', d => {
    delete d.by_crop_type.sweet_potato.on_frost_action
  }],
  ['shrinks the check-window lead below a usable week', d => {
    d.by_crop_type.sweet_potato.check_from_month_day = '10-06'
  }],
  ['keys the deadline to a slug no live crop type has', d => {
    d.by_crop_type.sweetpotato = d.by_crop_type.sweet_potato
    delete d.by_crop_type.sweet_potato
  }],
]

const original = readFileSync(DATA, 'utf8')
let failures = 0

for (const [label, mutate] of MUTATIONS) {
  const doc = JSON.parse(original)
  mutate(doc)
  writeFileSync(DATA, `${JSON.stringify(doc, null, 2)}\n`)
  let red = false
  try {
    execFileSync('npx', ['vitest', 'run', ...SUITES], { stdio: 'pipe' })
  } catch {
    red = true
  } finally {
    writeFileSync(DATA, original)
  }
  console.log(`${red ? 'RED  ' : 'GREEN'}  ${label}`)
  if (!red) failures++
}

// A mutation that leaves the suite green is a guard that cannot fail — the exact defect being fixed.
if (failures > 0) {
  console.error(`\n${failures} mutation(s) did NOT turn the suite red — those guards are vacuous.`)
  process.exit(1)
}
console.log(`\nAll ${MUTATIONS.length} mutations turned the suite red.`)
