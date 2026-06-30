#!/usr/bin/env node
// DRG-BACKBONE-001 P0 / G-PARITY — golden snapshot capture.
//
// Regenerates the canonicalized golden daily_plan snapshot for every parity scenario from the CURRENT
// daily-plan engine. In P0 the "shared engine" IS the current rule engine, so these goldens are the
// regression baseline: when the system-of-record cutover later refactors the nightly generator to call
// shared engine code, tests/parity/daily-plan/parity.test.js replays the same frozen fixtures and diffs the
// result against these goldens — a non-allowlisted delta blocks the cutover (§13 G-PARITY exit gate).
//
// Run to (re)seed goldens after an INTENTIONAL engine/data change (review the git diff of golden/*.json):
//   node scripts/parity/capture-daily-plan-golden.mjs            # write goldens
//   node scripts/parity/capture-daily-plan-golden.mjs --check    # CI-style: fail if any golden is stale/missing
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scenarios, planFor } from '../../tests/parity/daily-plan/fixtures.mjs';
import { canonicalize } from '../../tests/parity/daily-plan/canonicalize.mjs';

const GOLDEN_DIR = fileURLToPath(new URL('../../tests/parity/daily-plan/golden/', import.meta.url));
const check = process.argv.includes('--check');

let stale = 0;
for (const s of scenarios) {
  const canon = canonicalize(planFor(s));
  const json = JSON.stringify(canon, null, 2) + '\n';
  const file = GOLDEN_DIR + s.name + '.json';
  if (check) {
    if (!existsSync(file)) { console.error(`MISSING golden: ${s.name}.json`); stale++; continue; }
    if (readFileSync(file, 'utf8') !== json) { console.error(`STALE golden: ${s.name}.json (run capture without --check)`); stale++; continue; }
    console.log(`ok  ${s.name}.json`);
  } else {
    writeFileSync(file, json);
    console.log(`wrote ${s.name}.json`);
  }
}
if (check && stale) { console.error(`\n${stale} golden(s) stale/missing.`); process.exit(1); }
