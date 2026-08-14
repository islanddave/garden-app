// BUG-LOCDELSLUG-001 — behavioural tests for the /api/locations/:id reference resolver.
//
// BEHAVIOURAL, not source-text, and that is the point of extracting ref.js at all. Every other
// guard in this directory reads index.js as characters because the handler imports
// @neondatabase/@clerk/@aws-sdk at module load and cannot be imported in CI (per-dir node_modules
// do not exist there). ref.js imports NOTHING, so the rule that decides how many rows a DELETE may
// touch is exercised for real instead of pattern-matched — a source-text guard would have passed
// on the buggy version too, since the defect was never a missing string.
//
// The fixture shape mirrors the live table (measured 2026-08-14): `slug` has two PARTIAL unique
// indexes and no global one, so 'bed-1' under two different parents is legal data, not corruption.
import { describe, it, expect, vi } from 'vitest';
import {
  resolveLocationRow,
  loadLocationRef,
  AMBIGUOUS_REF_STATUS,
  AMBIGUOUS_REF_BODY,
} from './ref.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

describe('resolveLocationRow — one reference resolves to at most one row', () => {
  it('resolves nothing to not-found, distinctly from ambiguous', () => {
    const out = resolveLocationRow([], 'bed-1');
    expect(out.row).toBeNull();
    expect(out.ambiguous).toBeUndefined();
  });

  it('tolerates a null/undefined row set rather than throwing into the 500 catch', () => {
    expect(resolveLocationRow(null, 'bed-1').row).toBeNull();
    expect(resolveLocationRow(undefined, 'bed-1').row).toBeNull();
  });

  it('resolves a single match, by slug or by id, without needing a tiebreak', () => {
    expect(resolveLocationRow([{ id: UUID_A }], 'bed-1').row.id).toBe(UUID_A);
    expect(resolveLocationRow([{ id: UUID_A }], UUID_A).row.id).toBe(UUID_A);
  });

  // THE DEFECT. Before the fix this shape reached `UPDATE ... WHERE (slug = $1 OR id::text = $1)`
  // and soft-deleted BOTH rows while answering 200 {ok:true}.
  it('refuses to pick when one slug names several locations', () => {
    const out = resolveLocationRow([{ id: UUID_A }, { id: UUID_B }], 'bed-1');
    expect(out.ambiguous).toBe(true);
    expect(out.row).toBeUndefined();
  });

  it('refuses at three and beyond, not just at exactly two', () => {
    const out = resolveLocationRow([{ id: UUID_A }, { id: UUID_B }, { id: UUID_C }], 'bed-1');
    expect(out.ambiguous).toBe(true);
  });

  // An id match is unambiguous BY CONSTRUCTION — id is the primary key — so it wins even against a
  // slug that happens to equal it. Without this arm a caller passing a real uuid could be told its
  // own row was ambiguous, which would turn a correct request into a 409.
  it('lets an exact id match win over co-matching slug rows', () => {
    const out = resolveLocationRow([{ id: UUID_A }, { id: UUID_B }], UUID_A);
    expect(out.ambiguous).toBeUndefined();
    expect(out.row.id).toBe(UUID_A);
  });

  it('picks the id row regardless of the order the database returned', () => {
    const out = resolveLocationRow([{ id: UUID_B }, { id: UUID_C }, { id: UUID_A }], UUID_A);
    expect(out.row.id).toBe(UUID_A);
  });

  // MUTATION: `String(r?.id) === String(ref)` -> `r.id == ref` still passes these; -> dropping the
  // find() entirely and returning list[0] fails 'lets an exact id match win' AND both refusal
  // cases, which is the original bug.
  it('compares by value, not by identity, so a non-string id still matches', () => {
    const out = resolveLocationRow([{ id: 7 }, { id: 8 }], '7');
    expect(out.row.id).toBe(7);
  });

  it('never confuses a partial id prefix for a match', () => {
    const out = resolveLocationRow([{ id: UUID_A }, { id: UUID_B }], UUID_A.slice(0, 8));
    expect(out.ambiguous).toBe(true);
  });
});

describe('loadLocationRef — the pre-flight the mutating verbs run', () => {
  const capture = (rows) => {
    const calls = [];
    const sql = vi.fn((strings, ...vals) => {
      calls.push({ text: strings.join('?'), vals });
      return Promise.resolve(rows);
    });
    return { sql, calls };
  };

  it('scopes the lookup to live, household-owned rows on the slug-or-uuid key', async () => {
    const { sql, calls } = capture([{ id: UUID_A }]);
    const out = await loadLocationRef(sql, 'bed-1', ['user_1']);
    expect(out.row.id).toBe(UUID_A);
    expect(calls).toHaveLength(1);
    // MUTATION: drop either scope from ref.js -> RED. Losing created_by is a cross-household read
    // AND would let a foreign row make a caller's own reference read as ambiguous; losing
    // deleted_at resurrects soft-deleted rows into the key space.
    expect(calls[0].text).toMatch(/slug = \?\s*OR id::text = \?/);
    expect(calls[0].text).toMatch(/deleted_at IS NULL/);
    expect(calls[0].text).toMatch(/created_by = ANY\(/);
    expect(calls[0].vals).toEqual(['bed-1', 'bed-1', ['user_1']]);
  });

  it('passes the ambiguous verdict straight through', async () => {
    const { sql } = capture([{ id: UUID_A }, { id: UUID_B }]);
    expect((await loadLocationRef(sql, 'bed-1', ['user_1'])).ambiguous).toBe(true);
  });

  it('passes not-found straight through', async () => {
    const { sql } = capture([]);
    const out = await loadLocationRef(sql, 'no-such', ['user_1']);
    expect(out.row).toBeNull();
    expect(out.ambiguous).toBeUndefined();
  });

  it('selects the id as text so the caller can key an UPDATE on it', async () => {
    const { sql, calls } = capture([{ id: UUID_A }]);
    await loadLocationRef(sql, UUID_A, ['user_1']);
    expect(calls[0].text).toMatch(/SELECT id::text AS id/);
  });
});

describe('the ambiguous response is typed and distinct from a 404', () => {
  it('is a 409 carrying a machine-readable code', () => {
    expect(AMBIGUOUS_REF_STATUS).toBe(409);
    expect(AMBIGUOUS_REF_BODY.code).toBe('location_ref_ambiguous');
    expect(AMBIGUOUS_REF_BODY.error).toBeTruthy();
  });

  // The handler's catch maps 23505 to a 409 'Slug already exists' for the CREATE collision. Two
  // different 409s on one route is fine, but they must be tellable apart by a client, which is what
  // the code field is for — the restore path already set that precedent (location_slug_conflict).
  it('does not collide with the existing slug-conflict 409', () => {
    expect(AMBIGUOUS_REF_BODY.code).not.toBe('location_slug_conflict');
  });
});
