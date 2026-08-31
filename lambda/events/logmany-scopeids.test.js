// V4-LOGMANYUXREFRESH-001 S4 / BD-073 — scope.type:'ids' and THE COUNT ASSERTION.
//
// BD-073, verbatim, on the surface this route serves: "add an explicit assertion that the number of
// plantings selected equals the number of events written, surfacing a visible warning rather than
// under-writing in silence." That invariant has two seams:
//
//   named → resolved     NEW here. Only expressible on the ids scope, because it is the first
//                        scope where the CLIENT states the set. On all/project/space the server IS
//                        the authority and there is nothing to hold it to.
//   resolved → written   already guarded (missingPlantIds, BUG-LOGMANYPROJECTLESS-001), by
//                        re-reading event_log after the transaction.
//
// TWO KINDS OF TEST IN ONE FILE, and the split is deliberate:
//   - validateBatchBody / normalizeScopeIds are PURE, so they are exercised for real (called,
//     with values, results asserted). That half is not a source-text guard and does not have the
//     weaknesses of one.
//   - the resolver arm and the 409 live inside a 3900-line handler that cannot be imported without
//     a DB (auto-memory: the lambda unit suite proves no DB behaviour), so those are static-source
//     assertions in the house style of logmany-cropslug / logmany-projectless / logmany-zone-scope.
//     What a real unresolvable id does against the real view belongs to the integration suite;
//     what THIS file buys is a guard that runs on every push to dev.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBatchBody, normalizeScopeIds, MAX_SCOPE_IDS } from './validators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — the comments around this code quote the
// hazards verbatim, so an un-decommented assertion would find its own warning and pass. Same
// contract as logmany-cropslug.test.js / logmany-projectless.test.js.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

function slice(startNeedle, endNeedle, from = SRC) {
  const start = from.indexOf(startNeedle);
  if (start < 0) return '';
  const end = from.indexOf(endNeedle, start + startNeedle.length);
  return end > start ? from.slice(start, end) : '';
}

const BATCH = slice("rawPath === '/api/events/batch' && method === 'POST'",
                    "rawPath === '/api/events/batches'");
const RESOLVER = slice('SELECT p.id AS plant_id', 'ORDER BY p.display_name, p.id', BATCH);
// From the projection to the batch id — this window holds the assertion, the dry-run return and
// the 409, and stops before the write so nothing below can satisfy an assertion about the guard.
const GUARD = slice('const capped = resolved.length > 500', 'const batchId = randomUUID()', BATCH);

// HEX LETTERS, not the all-digit UUIDs the sibling test files use. `'1111…'.toUpperCase()` is a
// NO-OP, so a case-insensitivity assertion written against those constants passes whether or not
// the code lower-cases anything — measured: a mutation that deleted the `.toLowerCase()` SURVIVED
// against an all-digit fixture and is killed by this one. A fixture drawn from the happy path
// repeats nothing.
const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const C = 'cafecafe-dead-4bee-8fed-0123456789ab';
const base = (over = {}) => ({ idempotency_key: 'k', event_type: 'watering', scope: { type: 'all' }, ...over });
const ok = (b) => expect(validateBatchBody(b)).toBeNull();
const bad = (b, re) => {
  const r = validateBatchBody(b);
  expect(r, 'expected a rejection, got null').not.toBeNull();
  expect(r.status).toBe(400);
  if (re) expect(r.error).toMatch(re);
};

describe('validateBatchBody — scope.type:"ids" (S4)', () => {
  it('accepts an explicit id list', () => ok(base({ scope: { type: 'ids', plant_ids: [A, B] } })));
  it('accepts a dry run over an id list', () =>
    ok({ dry_run: true, event_type: 'watering', scope: { type: 'ids', plant_ids: [A] } }));

  // EMPTY IS A MALFORMED BODY, not "nothing to do". Admitted, it would resolve to zero rows and
  // fall out as the generic "No plantings matched the scope" — which reads as "your garden is
  // empty" for what is really a client that lost its selection.
  it('rejects an empty list rather than treating it as a no-op', () =>
    bad(base({ scope: { type: 'ids', plant_ids: [] } }), /non-empty array/));
  it('rejects a missing plant_ids', () => bad(base({ scope: { type: 'ids' } }), /non-empty array/));
  it('rejects a non-array plant_ids', () =>
    bad(base({ scope: { type: 'ids', plant_ids: A } }), /non-empty array/));
  it('rejects a malformed id', () =>
    bad(base({ scope: { type: 'ids', plant_ids: [A, 'nope'] } }), /must all be UUIDs/));
  it('rejects a non-string id — a number would pass a lax regex test after coercion', () =>
    bad(base({ scope: { type: 'ids', plant_ids: [A, 7] } }), /must all be UUIDs/));

  // The cap is REJECTED, never truncated. The resolver's LIMIT 501 would otherwise silently drop
  // the tail of a set the user named explicitly — under-writing, which is the whole subject of the
  // row this slice closes.
  it(`rejects more than ${MAX_SCOPE_IDS} distinct ids instead of letting the LIMIT truncate them`, () => {
    const many = Array.from({ length: MAX_SCOPE_IDS + 1 },
      (_, i) => `1111111a-1111-4111-8111-${String(i).padStart(12, '0')}`);
    bad(base({ scope: { type: 'ids', plant_ids: many } }), /at most 500/);
  });
  it('counts DISTINCT ids against the cap — 501 references to 2 plantings is a 2-planting batch', () => {
    ok(base({ scope: { type: 'ids', plant_ids: Array.from({ length: MAX_SCOPE_IDS + 1 }, (_, i) => (i % 2 ? A : B)) } }));
  });

  // The two models are opposites. Reconciling them would break the count assertion in the most
  // confusing possible direction: an id both named and excluded resolves to nothing, the assertion
  // fires, and the user is told a planting is "no longer available" when the client asked for
  // exactly that.
  it('rejects exclude_plant_ids alongside an id scope', () =>
    bad(base({ scope: { type: 'ids', plant_ids: [A] }, exclude_plant_ids: [B] }),
        /cannot be combined with scope.type=ids/));
  it('tolerates an EMPTY exclude array — a client that always sends the key makes no claim', () =>
    ok(base({ scope: { type: 'ids', plant_ids: [A] }, exclude_plant_ids: [] })));
  it('still accepts exclude_plant_ids on the other scopes', () =>
    ok(base({ scope: { type: 'all' }, exclude_plant_ids: [A, B] })));

  it('the three shipped scope types are untouched', () => {
    ok(base({ scope: { type: 'all' } }));
    ok(base({ scope: { type: 'project', project_id: A } }));
    ok(base({ scope: { type: 'space', location_id: A } }));
    bad(base({ scope: { type: 'galaxy' } }), /scope\.type must be/);
  });
});

describe('normalizeScopeIds — the count assertion\'s foundation', () => {
  // BOTH normalizations exist to stop the assertion firing on a CORRECT batch. Postgres compares
  // uuid VALUES, so a case difference or a duplicate makes `requested.length` bigger than anything
  // the resolver can return, and the 409 would reject a batch that was fine.
  it('lower-cases, so a client echoing upper-case UUIDs is not accused of naming missing plantings', () => {
    expect(normalizeScopeIds({ type: 'ids', plant_ids: [A.toUpperCase()] })).toEqual([A]);
  });
  it('de-duplicates, including across case', () => {
    expect(normalizeScopeIds({ type: 'ids', plant_ids: [A, A.toUpperCase(), B, A] })).toEqual([A, B]);
  });
  it('preserves first-seen order (a stable list is a readable error payload)', () => {
    expect(normalizeScopeIds({ type: 'ids', plant_ids: [C, A, B, C] })).toEqual([C, A, B]);
  });
  it('is EMPTY for every non-ids scope — the assertion below is gated on this being []', () => {
    expect(normalizeScopeIds({ type: 'all' })).toEqual([]);
    expect(normalizeScopeIds({ type: 'space', location_id: A, plant_ids: [A, B] })).toEqual([]);
    expect(normalizeScopeIds(null)).toEqual([]);
    expect(normalizeScopeIds(undefined)).toEqual([]);
  });
  it('drops non-strings rather than coercing them into ids', () => {
    expect(normalizeScopeIds({ type: 'ids', plant_ids: [A, 7, null, {}] })).toEqual([A]);
  });
});

describe('events Lambda — the ids scope arm in the resolver', () => {
  it('the slices are still locatable (the foundation these assertions stand on)', () => {
    for (const [name, s] of Object.entries({ BATCH, RESOLVER, GUARD })) {
      expect(s, `${name} slice went empty — its anchor moved or was deleted`).not.toBe('');
    }
  });

  it('the ids arm binds the NORMALIZED list, not body.scope.plant_ids', () => {
    // Binding the raw client array would reintroduce both hazards normalizeScopeIds closes, and it
    // reads as the obvious simplification.
    expect(RESOLVER).toMatch(/WHEN 'ids'\s+THEN p\.id = ANY\(\$\{scopeIds\}\)/);
    expect(RESOLVER).not.toMatch(/ANY\(\$\{scope\.plant_ids\}\)/);
    expect(RESOLVER).not.toMatch(/ANY\(\$\{body\.scope/);
  });

  // THE KEYSTONE OF THE ARM. An id list is a CLIENT-SUPPLIED plant list, and this resolver's
  // opening comment says it must never trust one. The arm sits inside the CASE, so every ownership
  // / soft-delete / archived / live-status term in the WHERE clause still applies to it. A rewrite
  // that "optimised" the ids path into its own SELECT — the natural thing to reach for, since the
  // list is already the answer — would ship a route that writes events onto any planting whose
  // uuid you can guess.
  it('the ids arm is INSIDE the CASE, under every ownership and liveness term', () => {
    const caseIdx = RESOLVER.indexOf('CASE ${scopeType}');
    const idsIdx = RESOLVER.indexOf("WHEN 'ids'");
    const endIdx = RESOLVER.indexOf('END', caseIdx);
    expect(caseIdx).toBeGreaterThan(-1);
    expect(idsIdx).toBeGreaterThan(caseIdx);
    expect(endIdx).toBeGreaterThan(idsIdx);
    // The four terms that must precede the CASE, i.e. must apply to the ids arm too.
    const beforeCase = RESOLVER.slice(0, caseIdx);
    expect(beforeCase).toMatch(/p\.deleted_at IS NULL AND p\.archived_at IS NULL/);
    expect(beforeCase).toMatch(/p\.status IS NULL OR p\.status NOT IN \('failed', 'ended', 'dormant'\)/);
    expect(beforeCase).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
  });

  it('an unrecognised scope type still resolves to NOTHING (the ELSE arm survived a fourth type)', () => {
    const caseIdx = RESOLVER.indexOf('CASE ${scopeType}');
    expect(RESOLVER.slice(caseIdx)).toMatch(/ELSE false\s+END/);
  });

  // BD-073's location half. No new relation: location_id and container_id are columns on rows this
  // statement already has, so the LEFT-JOIN hazard is not re-opened — but the EXPRESSION has to be
  // the same one the 'space' arm filters on, or filtering to a zone in the picker and scoping to
  // that zone would disagree on the same screen.
  it('the preview carries the same location expression the space scope resolves on', () => {
    expect(RESOLVER).toMatch(/COALESCE\(p\.location_id, pp\.location_id\) AS location_id/);
    expect(RESOLVER).toMatch(/WHEN 'space'\s+THEN COALESCE\(p\.location_id, pp\.location_id\) IN \(/);
  });

  it('a planting with no location arrives as an explicit null, never an absent key', () => {
    expect(GUARD).toMatch(/location_id: r\.location_id \?\? null/);
  });

  it('adds NO new join — S4 is a projection, not a relation', () => {
    const joins = [...RESOLVER.matchAll(/\bJOIN\s+public\.(\w+)/g)].map((m) => m[1]).sort();
    expect(joins).toEqual(['container', 'plant_varieties']);
  });
});

describe('events Lambda — the count assertion fails LOUDLY and before any write', () => {
  it('compares the NAMED set against the RESOLVED set, case-insensitively', () => {
    expect(GUARD).toMatch(/resolved\.map\(\(r\) => String\(r\.plant_id\)\.toLowerCase\(\)\)/);
    expect(GUARD).toMatch(/scopeIds\.filter\(\(id\) => !resolvedIdSet\.has\(id\)\)/);
  });

  it('is scoped to the ids path — the other three scopes have no client-stated set to compare', () => {
    expect(GUARD).toMatch(/scopeType === 'ids'\s*\n?\s*\? scopeIds\.filter/);
  });

  // THE ORDERING IS THE GUARANTEE. Every one of these must sit before the batch id is minted, or
  // the "nothing was logged" half of the error message is a lie.
  it('the 409 returns BEFORE the batch id, the metadata plan and the transaction', () => {
    const g = BATCH.indexOf('SCOPE_IDS_UNRESOLVED');
    expect(g).toBeGreaterThan(-1);
    for (const after of ['const batchId = randomUUID()', 'buildBatchMetadataPlan({', 'sql.transaction([']) {
      const idx = BATCH.indexOf(after);
      expect(idx, `${after} must come AFTER the 409`).toBeGreaterThan(g);
    }
  });

  it('the 409 outranks the generic empty-scope 400 — a specific diagnosis beats "no plantings"', () => {
    expect(BATCH.indexOf('SCOPE_IDS_UNRESOLVED'))
      .toBeLessThan(BATCH.indexOf('No plantings matched the scope'));
  });

  // THE CONDITION, not just the body. A source-text test reads a dead branch and a live one
  // identically: neutering the guard to `if (false)` left every other assertion in this describe
  // block green — measured, that mutation SURVIVED until this line existed. The 409 has to be
  // reached BY the divergence, and the only way to say that in a static test is to pin the
  // predicate to the variable the divergence is computed into.
  it('the 409 is guarded by the assertion itself, not by a constant', () => {
    expect(GUARD).toMatch(/if \(unresolvedScopeIds\.length\) \{\s*\n\s*return resp\(409, \{/);
  });

  it('the error names both numbers and says nothing was logged', () => {
    expect(GUARD).toMatch(/\$\{unresolvedScopeIds\.length\} of \$\{scopeIds\.length\} picked plantings/);
    expect(GUARD).toMatch(/nothing was logged/);
    expect(GUARD).toMatch(/resp\(409, \{/);
  });

  it('the payload carries the ids, so a client can say WHICH picks went stale', () => {
    expect(GUARD).toMatch(/unresolved_plant_ids: unresolvedScopeIds/);
    expect(GUARD).toMatch(/requested_count: scopeIds\.length/);
    expect(GUARD).toMatch(/resolved_count: plantIds\.length/);
  });

  // A dry run must still PREVIEW. Failing it here would blank the picker at the exact moment the
  // user needs to see which of their picks survived — the divergence is reported additively
  // instead, on keys that appear only when there IS one.
  it('the dry run reports the divergence instead of failing on it', () => {
    const dry = slice('if (dryRun) return resp(200', ';', GUARD);
    expect(dry).toMatch(/plantings: previewRows/);
    expect(dry).toMatch(/unresolvedScopeIds\.length\s*\n?\s*\? \{ requested_count: scopeIds\.length, unresolved_plant_ids: unresolvedScopeIds \}/);
    expect(dry).not.toMatch(/resp\(409/);
    // Ordering again: the dry-run return must precede the 409, or a preview would 409 too.
    expect(GUARD.indexOf('if (dryRun) return resp(200'))
      .toBeLessThan(GUARD.indexOf('SCOPE_IDS_UNRESOLVED'));
  });

  // The OTHER seam, already shipped — asserted here so the two halves of BD-073's invariant are
  // visible in one place. If this ever disappears, the ids path would still be guarded at the
  // front and unguarded at the back.
  it('the resolved → written seam is still guarded by the event_log re-read', () => {
    expect(BATCH).toMatch(/const missingPlantIds = plantIds\.filter\(\(id\) => !insertedEvents\.some/);
    expect(BATCH).toMatch(/count: insertedEvents\.length/);
    expect(BATCH).toMatch(/warning: `\$\{missingPlantIds\.length\} of \$\{plantIds\.length\}/);
  });
});
