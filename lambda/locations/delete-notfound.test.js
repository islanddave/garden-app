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

// Bounded to the DELETE's own arm so a match cannot be satisfied from the PUT above it, which
// legitimately carries both a resolve step and a 404 gate. Anchored on the JS guard rather than on
// the UPDATE, because BUG-LOCDELSLUG-001 put a resolve step AHEAD of the statement and a slice that
// starts at the UPDATE cannot see it.
const start = SRC.indexOf("if (method === 'DELETE') {");
const branch = start < 0 ? null : SRC.slice(start, SRC.indexOf("return resp(405", start));

describe('BUG-DELNOOPOK-001 — locations DELETE is RETURNING-gated on the slug-or-uuid key', () => {
  it('the DELETE statement is findable and bounded', () => {
    expect(branch, 'locations DELETE not found').toBeTruthy();
    expect(branch.length).toBeGreaterThan(200);
  });

  // MUTATION: drop `RETURNING id` or the 404 line -> RED. That is the unconditional {ok:true}
  // returning, and with it the reason authz-matrix cannot use DELETE as its write axis. The
  // `!rows.length` 404 is reachable only by a delete racing the pre-resolve, so no integration case
  // can red on it: this is its only guard.
  it('404s when nothing matched', () => {
    expect(branch).toMatch(/RETURNING id/);
    expect(branch).toMatch(/if \(!rows\.length\) return resp\(404, \{ error: 'Not found' \}\)/);
    const okIdx = branch.indexOf("return resp(200, { ok: true })");
    const gateIdx = branch.indexOf('return resp(404');
    expect(okIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx, 'the 404 gate must precede the 200').toBeLessThan(okIdx);
  });

  // MUTATION: drop either predicate from the UPDATE -> RED here and nowhere else. loadLocationRef
  // (ref.js) applies both first, so locations.int.test.js "DELETE another user's location" reds only
  // if ref.js loses its copy too, and household-mode.test.js counts file-wide, so one lost copy stays
  // above its floor. This pin is the only guard of the UPDATE's own copy.
  it('still carries the household ownership predicate and the soft-delete guard', () => {
    expect(branch).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
    expect(branch).toMatch(/deleted_at IS NULL/);
  });

  // All three verbs on /api/locations/:id must agree on the key space — the asymmetry this fix
  // closed existed for months precisely because nothing compared them. They now agree by sharing
  // ONE resolver rather than by carrying three copies of one predicate, which is what let the
  // copies drift in the first place: the count-the-arms assertion this replaces would have stayed
  // green through BUG-LOCDELSLUG-001, because four identical multi-row predicates satisfy it just
  // as well as four correct ones.
  it('GET, PUT and DELETE all resolve through the same rule', () => {
    expect(SRC).toMatch(/resolveLocationRow\(rows, locId\)/);          // GET, on rows already fetched
    const preflights = SRC.match(/await loadLocationRef\(sql, locId, householdIds\)/g) ?? [];
    expect(preflights.length, 'PUT and DELETE must each pre-resolve').toBe(2);
    const ambiguousGates = SRC.match(/picked\.ambiguous/g) ?? [];
    expect(ambiguousGates.length, 'all three verbs must gate ambiguity').toBe(3);
  });

  // The rule itself is arithmetic on rows, so it is tested BEHAVIOURALLY in ref.test.js rather than
  // as source text. This only pins that the handler has not grown a second, divergent copy of it.
  // The zero count is also the guard against re-inlining the predicate on the DELETE's UPDATE in
  // place of `id = ${picked.row.id}`: the multi-row soft-delete.
  it('carries no second copy of the slug-or-uuid predicate outside the resolver', () => {
    const arms = SRC.match(/slug = \$\{locId\} OR id::text = \$\{locId\}/g) ?? [];
    expect(arms.length, 'the mutating verbs must not re-derive the key space inline').toBe(0);
    const getArm = SRC.match(/l\.slug = \$\{locId\} OR l\.id::text = \$\{locId\}/g) ?? [];
    expect(getArm.length, 'GET fetches every match, then applies the rule').toBe(1);
  });
});
