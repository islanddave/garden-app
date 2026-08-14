// BUG-DELNOOPOK-001 — DELETE /api/locations/:id must observe rows affected, and must resolve the
// same key space as GET and PUT.
//
// TWO defects, one statement:
//
// 1. The route answered `resp(200, { ok: true })` unconditionally. The ownership predicate lives
//    inside the UPDATE's WHERE and nothing gated the response, so not-found, already-deleted and
//    NOT-OWNED were indistinguishable successes. `authz-matrix.int.test.js` had to route the
//    locations write axis through PUT for exactly this reason. It now RETURNING-gates and 404s,
//    matching GET (:220) and PUT (:308). Collapsing the three cases into one 404 is deliberate:
//    separating them leaks existence.
//
// 2. The route matcher is `/^\/api\/locations\/([^/]+)$/` and GET/PUT both resolve
//    `(slug = ${locId} OR id::text = ${locId})`, but DELETE compared the raw path segment against
//    the `uuid` column. MEASURED against live Neon (2026-08-13), not assumed: a prepared
//    `WHERE id = $1` bound with 'raised-bed' raises `22P02 invalid input syntax for type uuid`,
//    which this file's catch turns into a 500 — a DELETE by slug was never a silent no-op, it was
//    an unhandled error. `(slug = $1 OR id::text = $1)` bound with the same value returns 0 rows
//    cleanly. Nothing ships a slug here today (Locations.jsx:132 passes loc.id), so this closed a
//    latent trap — but with (1) landing, a slug caller would otherwise have read the 500 as a 404.
//
// Source-text rather than behavioural: the locations handler cannot be imported in CI (per-dir
// node_modules do not exist there). House convention is to read index.js as text; runtime proof
// lives in tests/integration/locations.int.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — assertions run against decommented
// source so the handler's own rationale block cannot satisfy a guard.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Bounded to the DELETE's own statement so a match cannot be satisfied from the PUT above it,
// which legitimately carries both the slug-or-uuid arm and a 404 gate.
const start = SRC.indexOf('UPDATE locations\n          SET deleted_at = NOW()');
const branch = start < 0 ? null : SRC.slice(start, start + 700);

describe('BUG-DELNOOPOK-001 — locations DELETE is RETURNING-gated on the slug-or-uuid key', () => {
  it('the DELETE statement is findable and bounded', () => {
    expect(branch, 'locations DELETE not found').toBeTruthy();
    expect(branch.length).toBeGreaterThan(200);
  });

  // MUTATION: drop `RETURNING id` or the 404 line -> RED. That is the unconditional {ok:true}
  // returning, and with it the reason authz-matrix cannot use DELETE as its write axis.
  it('404s when nothing matched', () => {
    expect(branch).toMatch(/RETURNING id/);
    expect(branch).toMatch(/if \(!rows\.length\) return resp\(404, \{ error: 'Not found' \}\)/);
    const okIdx = branch.indexOf("return resp(200, { ok: true })");
    const gateIdx = branch.indexOf('return resp(404');
    expect(okIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx, 'the 404 gate must precede the 200').toBeLessThan(okIdx);
  });

  // MUTATION: narrow back to `WHERE id = ${locId}` -> RED. Measured: that form 22P02s on a slug.
  it('resolves slug OR uuid, exactly as GET and PUT do', () => {
    expect(branch).toMatch(/\(slug = \$\{locId\} OR id::text = \$\{locId\}\)/);
    expect(branch).not.toMatch(/WHERE id = \$\{locId\}/);
  });

  // MUTATION: drop the household predicate -> RED. The 404 makes denial visible; it must still BE
  // a denial. storage-location-authz's DELETE block asserts the same property at runtime.
  it('still carries the household ownership predicate and the soft-delete guard', () => {
    expect(branch).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
    expect(branch).toMatch(/deleted_at IS NULL/);
  });

  // All three verbs on /api/locations/:id must agree on the key space — the asymmetry this fix
  // closed existed for months precisely because nothing compared them.
  it('GET, PUT and DELETE all resolve the same slug-or-uuid key', () => {
    const arms = SRC.match(/\(slug = \$\{locId\} OR id::text = \$\{locId\}\)|\(l\.slug = \$\{locId\} OR l\.id::text = \$\{locId\}\)/g) ?? [];
    expect(arms.length).toBeGreaterThanOrEqual(4); // GET, PUT id-resolve, PUT UPDATE, DELETE
  });
});
