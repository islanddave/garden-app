// BUG-DELNOOPOK-001 — the projects Lambda's two DELETE routes must observe rows affected.
//
// Both `/api/projects/types/:id` and `/api/projects/:id` used to answer `resp(200, { ok: true })`
// unconditionally: the ownership predicate lives inside the UPDATE's WHERE and nothing gated the
// response, so a not-found, an already-deleted, and a NOT-OWNED delete were indistinguishable
// successes. They now RETURNING-gate and 404. The collapse of those three cases into one status is
// deliberate — separating them would leak existence — and matches the PUT on each same path.
//
// Source-text rather than behavioural: this is the projects handler, not a pure builder, and it
// cannot be imported in CI (per-dir node_modules do not exist there). The house convention for
// handler assertions is to read index.js as text. Runtime proof lives in
// tests/integration/plants|locations|storage-location.int.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — every assertion below runs against
// decommented source, so the handler's own rationale block cannot satisfy a guard.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Bound each DELETE to the statement it owns, so a match cannot be satisfied from the other
// DELETE or from a neighbouring PUT (the extractor-swallows-too-much defect).
function branchAfter(anchor, len = 700) {
  const i = SRC.indexOf(anchor);
  return i < 0 ? null : SRC.slice(i, i + len);
}

describe('BUG-DELNOOPOK-001 — projects DELETE routes are RETURNING-gated', () => {
  const types = branchAfter('UPDATE project_types SET deleted_at = NOW()');
  // `UPDATE public.container` also appears in PATCH and PUT; only the DELETE follows it with a
  // bare `SET deleted_at = NOW()` on its own line, so anchor on that pair.
  const container = branchAfter('UPDATE public.container\n          SET deleted_at = NOW()', 700);

  it('both DELETE statements are findable', () => {
    expect(types, 'project_types DELETE not found').toBeTruthy();
    expect(container, 'container DELETE not found').toBeTruthy();
  });

  // MUTATION: drop `RETURNING id` or the 404 line from the types DELETE -> RED.
  it('/api/projects/types/:id RETURNING-gates and 404s', () => {
    expect(types).toMatch(/RETURNING id/);
    expect(types).toMatch(/if \(!rows\.length\) return resp\(404, \{ error: 'Not found' \}\)/);
  });

  // The ownership predicate on project_types is DELIBERATELY owner-only, not household-widened —
  // household-mode.test.js:60 pins it by name as out of scope. Re-asserted here so the 404 work is
  // not later read as having widened it. ProjectTypes.jsx:147 only renders Delete when
  // `t.created_by === userId`, so the 404 is unreachable for a non-owner through the app.
  it('/api/projects/types/:id predicate is still owner-only (unchanged by this fix)', () => {
    expect(types).toMatch(/created_by = \$\{userId\}/);
    expect(types).not.toMatch(/householdIds/);
  });

  // MUTATION: drop `RETURNING id` or the 404 line from the container DELETE -> RED.
  it('/api/projects/:id RETURNING-gates, 404s, and keeps the household predicate', () => {
    expect(container).toMatch(/UPDATE public\.container/);
    expect(container).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
    expect(container).toMatch(/RETURNING id/);
    expect(container).toMatch(/if \(!rows\.length\) return resp\(404, \{ error: 'Not found' \}\)/);
  });

  // Vacuity floor: neither route may answer 200 before the gate has run.
  it('neither DELETE returns an ungated resp(200, { ok: true })', () => {
    for (const [name, b] of [['types', types], ['container', container]]) {
      const okIdx = b.indexOf("return resp(200, { ok: true })");
      const gateIdx = b.indexOf('return resp(404');
      expect(okIdx, `${name}: no 200 found`).toBeGreaterThan(-1);
      expect(gateIdx, `${name}: 404 gate must precede the 200`).toBeGreaterThan(-1);
      expect(gateIdx, `${name}: 404 gate must precede the 200`).toBeLessThan(okIdx);
    }
  });
});
