// BUG-FLAGGEDDORMANT-001 — the heads-up `flagged` arm must not alert on a non-actionable planting.
//
// Dave, 2026-08-10: dormant stock is in temp/humidity-controlled bins and "never need that treatment".
//
// THE DEFECT, and it is a narrower-exclusion bug rather than a missing one. The `flagged` arm joined
// the CONTAINER only (`JOIN container pp ON pp.id = el.project_id`) and never touched garden_node, so
// a flagged issue on a dormant planting still lit its container as needing attention. Its `stale`
// sibling twenty lines below carries the full non-actionable predicate THREE times — so this was the
// odd one out, not a deliberate difference. That asymmetry is the tell this file pins.
//
// Gated on the flagged event's OWN planting, not the sibling "container holds any actionable planting"
// EXISTS, because that is the precise claim: the alert is about THIS issue. A project-level issue
// (plant_id NULL) is deliberately unaffected.
//
// Measured on prod before the change: ZERO unresolved flagged rows, so this closed a latent leak at
// zero live blast radius. That is a reason it was SAFE to fix, never a reason it was not real —
// the cold bucket was likewise empty all summer while the frost leak sat armed.
//
// Source-text guard: a lambda test must never import a handler's index.js (per-directory package.json;
// CI installs the ROOT manifest only, so a local-resolving import fails in CI).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SRC = readFileSync(resolve(__dirname, 'handlers.js'), 'utf8');

const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(l => l.replace(/(^|[^:])--.*$/, '$1'))
  .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

// The flagged CTE, isolated so an assertion cannot accidentally be satisfied by the stale arm's
// predicates further down the file — which is exactly how this bug hid in plain sight.
const FLAGGED = (() => {
  const start = CODE.indexOf("'flagged'::text AS reason");
  const end = CODE.indexOf('stale AS (', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return CODE.slice(start, end);
})();

describe('BUG-FLAGGEDDORMANT-001 — the flagged arm gates on planting actionability', () => {
  it('the flagged arm itself references garden_node (it previously never did)', () => {
    expect(FLAGGED).toMatch(/garden_node/);
  });

  it('carries the full non-actionable set, like its stale sibling', () => {
    const m = FLAGGED.match(/status\s+NOT\s+IN\s*\(([^)]*)\)/i);
    expect(m).toBeTruthy();
    for (const s of ['dormant', 'ended', 'failed', 'rooting']) {
      expect(m[1]).toMatch(new RegExp(`'${s}'`));
    }
  });

  it('leaves a project-level issue (plant_id NULL) alone', () => {
    expect(FLAGGED).toMatch(/el\.plant_id\s+IS\s+NULL\s+OR/i);
  });

  it('scopes the guard to the flagged event own planting, not any planting in the container', () => {
    expect(FLAGGED).toMatch(/gn\.id\s*=\s*el\.plant_id/);
  });
});
