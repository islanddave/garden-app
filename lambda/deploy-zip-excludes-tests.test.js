// OPS-LAMBDATESTZIP-001 — the deploy bundle must not contain test files.
//
// `zip -r ../<fn>.zip .` shipped every *.test.js in the function directory to production across all
// 26 Lambdas: wasted bytes on a cold-start-sensitive path (garden-daily-plan-read was measured at a
// 42.9% cold-start rate, so package size is not free), plus internal fixtures and mock shapes handed
// to prod. Measured on the real dirs at the time of the fix: lambda/photos 21 entries -> 9,
// lambda/findings 25 -> 17, both to ZERO test files, with engine/persist.js retained and only
// engine/persist.test.js dropped.
//
// deploy-lambda.yml carries the runtime backstop (it unzips and hard-fails if a test file survived,
// which is the assertion that proves the BUNDLE rather than the command). This test is the
// PR-time half: the workflow assert cannot catch its own deletion, and a regression found at deploy
// time has already cost a promote. Raw-text over the YAML, matching
// src/__tests__/harvestWeightRatchet.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WF = readFileSync(join(ROOT, '.github/workflows/deploy-lambda.yml'), 'utf8');

// Command lines only — a `zip -r` NAMED IN A COMMENT is not a zip step, and matching one would let
// this guard pass against a workflow that no longer zips anything the way it claims.
const zipLines = WF.split('\n')
  .map((l) => l.trim())
  .filter((l) => l.startsWith('zip -r'));

describe('deploy-lambda.yml — test files are excluded from every bundle', () => {
  it('found the zip steps (anti-vacuity: an empty list would pass every assertion below)', () => {
    // Two today: the generic 25-function step and photocdn-derivative's arm64 step.
    expect(zipLines.length).toBeGreaterThanOrEqual(2);
  });

  it('EVERY zip step excludes *.test.js', () => {
    // Enumerated, not spot-checked: a NEW zip step that forgets the exclude fails here, which is the
    // whole reason photocdn-derivative's separate step was in scope alongside the generic one.
    for (const line of zipLines) {
      expect(line, `zip step ships test files:\n  ${line}`).toContain("-x '*.test.js'");
    }
  });

  it('the generic step hard-fails if a test file survives into the bundle', () => {
    // The exclude proves the COMMAND; this proves the ARTIFACT. Without it, a pattern that silently
    // stopped matching (a reworded glob, a new test suffix) would ship tests with a green build.
    expect(WF).toContain('FATAL: test files present in');
    // ANCHORED (`$`). The original pin required the unanchored `grep -q '\.test\.js'`, and that is
    // exactly what broke the first real deploy of this guard: `pg` vendors
    // pg-protocol/dist/*.test.js.map, the unanchored grep matched those .map files, and since `pg`
    // is a dependency of every function all 26 Lambda jobs failed identically. The check was BROADER
    // than its own exclude, so it could never pass. Pin the anchored form so the assertion stays a
    // strict subset of what the zip removes.
    expect(WF).toMatch(/unzip -l [^\n|]*\| grep -qE '\\\.test\\\.js\$'/);
  });
});
