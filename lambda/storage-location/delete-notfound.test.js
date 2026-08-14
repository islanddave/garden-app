// BUG-DELNOOPOK-001 — DELETE /api/storage-locations/:id must observe rows affected.
//
// The route answered `resp(200, { ok: true })` unconditionally: the ownership predicate lives
// inside the UPDATE's WHERE and nothing gated the response, so not-found, already-deleted and
// NOT-OWNED were indistinguishable successes — which is why
// tests/integration/storage-location-authz.int.test.js:39 had to pin the DELETE's ownership
// property by reading row state instead of status. It now RETURNING-gates and 404s, matching the
// PUT at :102. Collapsing the three cases into one 404 is deliberate: separating them leaks
// existence.
//
// No slug arm here, unlike locations: `storage_location` has no slug column (verified against the
// live schema — id, user_id, label, kind, created_at, deleted_at) and every verb on this route has
// only ever resolved by uuid.
//
// Source-text rather than behavioural: the handler cannot be imported in CI (per-dir node_modules
// do not exist there). House convention is to read index.js as text; runtime proof lives in
// tests/integration/storage-location.int.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — assertions run against decommented source.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Bounded to the DELETE's own statement so a match cannot be satisfied from the PUT above it,
// which legitimately carries RETURNING and a 404 gate.
const start = SRC.indexOf('UPDATE storage_location\n          SET deleted_at = NOW()');
const branch = start < 0 ? null : SRC.slice(start, start + 600);

describe('BUG-DELNOOPOK-001 — storage-location DELETE is RETURNING-gated', () => {
  it('the DELETE statement is findable and bounded', () => {
    expect(branch, 'storage_location DELETE not found').toBeTruthy();
    expect(branch.length).toBeGreaterThan(150);
  });

  // MUTATION: drop `RETURNING id` or the 404 line -> RED.
  it('404s when nothing matched', () => {
    expect(branch).toMatch(/RETURNING id/);
    expect(branch).toMatch(/if \(!rows\.length\) return resp\(404, \{ error: 'Not found' \}\)/);
    const okIdx = branch.indexOf("return resp(200, { ok: true })");
    const gateIdx = branch.indexOf('return resp(404');
    expect(okIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx, 'the 404 gate must precede the 200').toBeLessThan(okIdx);
  });

  // MUTATION: drop the household predicate -> RED. The 404 makes denial visible; it must still BE
  // a denial. Note this table scopes on user_id, not created_by.
  it('still carries the household ownership predicate and the soft-delete guard', () => {
    expect(branch).toMatch(/user_id = ANY\(\$\{householdIds\}\)/);
    expect(branch).toMatch(/deleted_at IS NULL/);
  });
});
