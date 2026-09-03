#!/usr/bin/env node
// BUG-LOGMANYWARNFLAKE-001 — test the load hypothesis by measuring DURATION, not failure.
//
// Why duration: the failure is the tail of a distribution, so proving it by waiting for reds needs
// many runs. The ledger already records the shape — 404ms in isolation, 5055ms in CI before it blew
// its waitFor budget. If the mechanism really is contention, the test's DURATION should rise with
// concurrent suite load, and that is observable in a handful of runs instead of dozens.
//
// The 969 -> 998 file-count claim is a proxy for the same thing. This varies load directly (worker
// count and file count) rather than trying to reconstruct a historical file set, which cannot be done
// faithfully anyway.
//
// Emits TSV: condition, run, durationMs, status
import { execFileSync } from 'node:child_process';

const TARGET = 'renders the server warning on the success card when fewer rows were written';
const RUNS = Number(process.env.RUNS ?? 3);

function measure(label, args) {
  for (let i = 1; i <= RUNS; i++) {
    let json = '';
    try {
      json = execFileSync('npx', ['vitest', 'run', '--reporter=json', ...args],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      json = e.stdout ?? '';           // non-zero exit still carries the report
    }
    const start = json.indexOf('{');
    let rec = null;
    try {
      const report = JSON.parse(json.slice(start));
      for (const f of report.testResults ?? []) {
        for (const a of f.assertionResults ?? []) {
          if (a.title === TARGET || (a.fullName ?? '').includes(TARGET)) rec = a;
        }
      }
    } catch { /* fall through to the unknown row below */ }
    console.log([label, i, rec?.duration ?? 'NA', rec?.status ?? 'NOT_FOUND'].join('\t'));
  }
}

console.log(['condition', 'run', 'durationMs', 'status'].join('\t'));
measure('isolated', ['src/__tests__/LogManyScopeIds.test.jsx']);
measure('full_1worker', ['--poolOptions.threads.maxThreads=1', '--poolOptions.threads.minThreads=1']);
measure('full_default', []);
