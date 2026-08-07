// V4-VARIETYHOUSEHOLD-001 — authz tests for PUT/DELETE /api/varieties/:id.
//
// This is an AUTHORIZATION WIDENING, so the tests that matter are the ones proving what is STILL
// REFUSED. Every assertion below was mutation-checked: the thing it guards was actually broken in
// source, the test was confirmed RED, and the source restored byte-identically (shasum). A test that
// stays green when you delete the predicate it guards is worse than no test at all.
//
// TWO LAYERS, because neither alone is sufficient:
//   1. PURE — householdScope + managedPrincipalPatterns composed exactly as the handler composes
//      them. This IS the authorization decision: whether a given caller gets the household arm and
//      the managed-principal arm at all. A foreign caller is refused HERE.
//   2. STATIC-SOURCE — that index.js actually performs that composition and threads both values into
//      BOTH write predicates, that DELETE is still a soft delete, and that nothing else widened.
//
// WHY NO HANDLER-LEVEL TEST: no lambda test in this repo imports a handler. The Lambda runtime deps
// (@neondatabase/serverless, @clerk/backend, @aws-sdk/client-secrets-manager) are declared in each
// lambda's own package.json and are NOT installed at the repo root, so `import './index.js'` fails at
// Vite transform time — before vi.mock can intercept. Fixing that means installing runtime deps at
// the root or adding vitest resolve aliases, both of which change the whole repo's test infra and are
// out of scope for this change. Layer 2 covers the wiring instead.
//
// SQL SEMANTICS ARE NOT RE-IMPLEMENTED HERE — they were verified read-only against live prod
// 2026-08-07, for the live 2-id household:
//   · member editable set   = 408 of 408 live cultivars (383 household + 25 managed principals)
//   · non-member editable set = 0
//   · 'system' LIKE ANY(ARRAY[]::text[])  =>  FALSE, not NULL   (the empty arm collapses, fail-closed)
//   · 0 of the `user_%` created_by values match any managed pattern (no human/script collision)

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedPrincipalPatterns, MANAGED_PRINCIPAL_PATTERNS } from './authz.js';
import { householdScope } from './household.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

const DAVE = 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI';
const JEN = 'user_3E2xA85kQhr1vSZhiv4W1GLudJV';
const STRANGER = 'user_MALLORY000000000000000000';
const ENV_KEY = 'GARDEN_HOUSEHOLD_IDS';
const ORIG = process.env[ENV_KEY];

afterEach(() => {
  if (ORIG === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIG;
});

// The handler's composition, mirrored exactly. Layer 2 asserts index.js really does this.
function writeScope(userId) {
  const household = householdScope(userId);
  return { household, managedPatterns: managedPrincipalPatterns(household) };
}

// ── Layer 1 — the authorization decision ──────────────────────────────────────────────────────────

describe('managedPrincipalPatterns — the membership gate', () => {
  it('hands the managed patterns to a proven household member', () => {
    expect(managedPrincipalPatterns([DAVE, JEN])).toEqual(MANAGED_PRINCIPAL_PATTERNS);
  });

  // NEGATIVE CONTROL (1), unit layer. householdScope hands a non-member [their-own-id], so a
  // 1-element scope IS the stranger signal. If this ever returns a non-empty list, every
  // authenticated Clerk user on the internet can edit the 25 script-owned cultivars.
  it('hands an EMPTY list to a non-member (1-element scope)', () => {
    expect(managedPrincipalPatterns([STRANGER])).toEqual([]);
  });

  it('fail-closed on an absent or malformed scope', () => {
    expect(managedPrincipalPatterns([])).toEqual([]);
    expect(managedPrincipalPatterns(undefined)).toEqual([]);
    expect(managedPrincipalPatterns(null)).toEqual([]);
    expect(managedPrincipalPatterns('not-an-array')).toEqual([]);
  });

  it('patterns cover all 4 live principals as PREFIXES and can never admit a Clerk sub', () => {
    expect(MANAGED_PRINCIPAL_PATTERNS).toEqual(['system', 'rescue-intake-%', 'data-audit-%', 'data-correction-%']);
    // A Clerk sub is `user_<base58>`; no pattern may ever match one.
    for (const p of MANAGED_PRINCIPAL_PATTERNS) expect(p.startsWith('user_')).toBe(false);
    // Prefix-shaped so the NEXT intake batch is editable on arrival, not re-filing this same bug.
    expect(MANAGED_PRINCIPAL_PATTERNS.filter(p => p.endsWith('%'))).toHaveLength(3);
  });
});

describe('write scope per caller class — the whole decision, end to end', () => {
  // NEGATIVE CONTROL (3): a household caller CAN now reach a `system`-owned row. The managed arm
  // arriving non-empty is exactly what makes those 25 rows editable, and 'system' is in it.
  it('household member: full household AND the managed arm (system row becomes editable)', () => {
    process.env[ENV_KEY] = `${DAVE},${JEN}`;
    const s = writeScope(DAVE);
    expect(s.household).toEqual([DAVE, JEN]);
    expect(s.managedPatterns).toEqual(MANAGED_PRINCIPAL_PATTERNS);
    expect(s.managedPatterns).toContain('system');
    expect(s.managedPatterns).toContain('rescue-intake-%');
  });

  it('the second household member gets the identical scope', () => {
    process.env[ENV_KEY] = `${DAVE},${JEN}`;
    expect(writeScope(JEN)).toEqual(writeScope(DAVE));
  });

  // NEGATIVE CONTROL (1): THE most important test in this file. A foreign-household caller must
  // reach neither the household's rows nor the managed principals' rows.
  it('foreign household: own id only, and NO managed arm', () => {
    process.env[ENV_KEY] = `${DAVE},${JEN}`;
    const s = writeScope(STRANGER);
    expect(s.household).toEqual([STRANGER]);
    expect(s.household).not.toContain(DAVE);
    expect(s.household).not.toContain(JEN);
    expect(s.managedPatterns).toEqual([]);
  });

  it('unset env degrades to byte-exact old owner-only behaviour', () => {
    delete process.env[ENV_KEY];
    expect(writeScope(DAVE)).toEqual({ household: [DAVE], managedPatterns: [] });
  });

  it('empty / whitespace / comma-only env is fail-closed for everyone', () => {
    for (const v of ['', '   ', ',, ,']) {
      process.env[ENV_KEY] = v;
      expect(writeScope(DAVE), `env=${JSON.stringify(v)}`).toEqual({ household: [DAVE], managedPatterns: [] });
    }
  });

  // A single-id household cannot be distinguished from a stranger by householdScope's return value.
  // That imprecision is deliberate and fail-CLOSED: no managed arm rather than a wrongly-granted one.
  it('single-id household is fail-closed (no managed arm)', () => {
    process.env[ENV_KEY] = DAVE;
    expect(writeScope(DAVE)).toEqual({ household: [DAVE], managedPatterns: [] });
  });
});

// ── Layer 2 — static-source: the handler actually does the above ──────────────────────────────────

describe('varieties write predicates — source-level invariants', () => {
  const putIdx = SRC.indexOf("if (method === 'PUT')");
  const delIdx = SRC.indexOf("if (method === 'DELETE')");
  const putBlock = SRC.slice(putIdx, delIdx);
  const delBlock = SRC.slice(delIdx, SRC.indexOf('return resp(405', delIdx));

  it('PUT and DELETE blocks are both present and correctly ordered', () => {
    expect(putIdx).toBeGreaterThan(-1);
    expect(delIdx).toBeGreaterThan(putIdx);
  });

  // Guards the composition Layer 1 tests. Without this, Layer 1 could be verifying a composition
  // the handler never performs.
  it('handler composes householdScope -> managedPrincipalPatterns exactly as tested above', () => {
    expect(SRC).toMatch(/import \{ householdScope \} from '\.\/household\.js'/);
    expect(SRC).toMatch(/import \{ managedPrincipalPatterns \} from '\.\/authz\.js'/);
    expect(SRC).toMatch(/const household = householdScope\(userId\)/);
    expect(SRC).toMatch(/const managedPatterns = managedPrincipalPatterns\(household\)/);
  });

  // The gate must be applied. Passing the raw constant would hand the managed arm to strangers.
  it('the managed arm is the GATED value, never the raw constant', () => {
    expect(SRC).not.toMatch(/\$\{MANAGED_PRINCIPAL_PATTERNS\}/);
    expect(SRC).not.toMatch(/managedPrincipalPatterns\(\s*\[/);
  });

  for (const [label, block] of [['PUT', putBlock], ['DELETE', delBlock]]) {
    it(`${label} scopes on the household array, not a bare created_by = userId`, () => {
      expect(block).toMatch(/created_by = ANY\(\$\{household\}\)/);
      expect(block).not.toMatch(/created_by = \$\{userId\}/);
    });

    it(`${label} carries the membership-gated managed-principal arm`, () => {
      expect(block).toMatch(/created_by LIKE ANY\(\$\{managedPatterns\}::text\[\]\)/);
    });

    // The ::text[] cast is load-bearing, not decoration: without it Postgres cannot infer the
    // element type of the EMPTY array a non-member is given, and the query errors instead of
    // cleanly matching nothing.
    it(`${label} casts the managed arm to text[] so the empty (non-member) case types`, () => {
      expect(block).toMatch(/\$\{managedPatterns\}::text\[\]/);
    });

    it(`${label} still excludes already-soft-deleted rows`, () => {
      expect(block).toMatch(/deleted_at IS NULL/);
    });

    // Both arms must sit inside one parenthesised group ANDed with the id, never ORed at top level —
    // a stray precedence slip would make the managed arm match rows of ANY id.
    it(`${label} keeps both arms grouped under the id predicate`, () => {
      expect(block).toMatch(/id = \$\{varietyId\}\s*\n\s*AND \(\s*created_by = ANY\(\$\{household\}\)\s*\n\s*OR created_by LIKE ANY\(\$\{managedPatterns\}::text\[\]\) \)/);
    });
  }

  // NEGATIVE CONTROL (4). SOFT-DELETE-ONLY. A hard delete of a cultivar attached to live plantings
  // would cascade or orphan them — and 24 of the 25 newly-editable rows ARE attached to live
  // plantings, so this rule gets strictly more load-bearing with this change, not less.
  it('DELETE is a soft delete — sets deleted_at, never removes the row', () => {
    expect(delBlock).toMatch(/UPDATE public\.cultivar\s*\n\s*SET deleted_at = NOW\(\)/);
    expect(delBlock).not.toMatch(/DELETE\s+FROM/i);
  });

  it('no hard DELETE FROM anywhere in the varieties Lambda', () => {
    expect(SRC).not.toMatch(/DELETE\s+FROM/i);
  });

  // NEGATIVE CONTROL (2). Auth is proven before any route runs: verifyToken's catch returns 401,
  // and it sits ahead of the DB client and every route branch. Offset-anchored so a future edit
  // that moves routing above the auth gate fails here.
  it('unauthenticated callers are refused 401 before any route or query is reached', () => {
    const catchIdx = SRC.indexOf('return resp(401, { error: \'Unauthorized\' })');
    expect(catchIdx, 'expected a 401 return in the verifyToken catch').toBeGreaterThan(-1);
    expect(catchIdx).toBeLessThan(SRC.indexOf('const sql = neon('));
    expect(catchIdx).toBeLessThan(SRC.indexOf('const household = householdScope(userId)'));
    expect(catchIdx).toBeLessThan(putIdx);
    expect(catchIdx).toBeLessThan(delIdx);
  });

  // NEGATIVE CONTROL (2b), and the sharpest edge of this whole change. householdScope('') returns
  // [''] and `'' = ANY(ARRAY[''])` is TRUE in Postgres — so an empty JWT subject stops being a
  // no-match and becomes a live ownership value the moment this handler starts scoping by an array.
  // Owner-only `created_by = ${userId}` never had this exposure; the widening creates it. The guard
  // must therefore run BEFORE householdScope, not merely somewhere in the function.
  // (Independently enforced fleet-wide by lambda/authz-write-fk.test.js, which auto-detects any dir
  // shipping a household.js copy — that is what caught this gap here.)
  it('an empty JWT sub is 401d BEFORE it can become an ownership array', () => {
    expect(SRC).toMatch(/if \(!userId\) return resp\(401, \{ error: 'Unauthorized' \}\);/);
    const guard = SRC.indexOf("if (!userId) return resp(401");
    const use = SRC.search(/householdScope\s*\(\s*userId\s*\)/);
    expect(guard).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(-1);
    expect(guard, 'the empty-sub guard must precede householdScope(userId)').toBeLessThan(use);
    expect(guard).toBeLessThan(SRC.indexOf('const sql = neon('));
  });

  // userId comes from the verified JWT sub and nowhere else — never a header or body field.
  it('userId is taken only from the verified token payload', () => {
    expect(SRC).toMatch(/userId = payload\.sub/);
    expect(SRC).not.toMatch(/userId = (?:event|body|headers)/);
  });

  // The response must not distinguish "does not exist" from "not yours" — that difference is an
  // existence oracle over a globally-readable table.
  it('both writes answer a scope miss with the same generic 404', () => {
    expect(putBlock).toMatch(/return resp\(404, \{ error: 'Not found or not owner' \}\)/);
    expect(delBlock).toMatch(/return resp\(404, \{ error: 'Not found or not owner' \}\)/);
  });

  // Widening WHO MAY EDIT must not blur WHO DID EDIT.
  it('the audit actor is still the calling human, not a household id', () => {
    expect(SRC).toMatch(/set_config\('app\.actor_clerk_sub', \$\{userId\}, true\)/);
    expect(SRC).not.toMatch(/set_config\('app\.actor_clerk_sub', \$\{household\}/);
  });

  it('POST still stamps created_by from the JWT sub only (no widening on create)', () => {
    const postIdx = SRC.lastIndexOf("if (method === 'POST')");
    const postBlock = SRC.slice(postIdx);
    expect(postBlock).toMatch(/\$\{userId\}/);
    expect(postBlock).not.toMatch(/\$\{household\}|\$\{managedPatterns\}/);
  });

  it('the GET read paths are untouched (still global, no scope predicate)', () => {
    const listIdx = SRC.indexOf('// List + search');
    const listBlock = SRC.slice(listIdx, SRC.lastIndexOf("if (method === 'POST')"));
    expect(listBlock).not.toMatch(/household|managedPatterns/);
  });

  // Exactly two write predicates gained the arm. A third occurrence means something else widened.
  it('exactly two scoped write predicates exist — PUT and DELETE, nothing else', () => {
    expect(SRC.match(/created_by = ANY\(\$\{household\}\)/g)).toHaveLength(2);
    expect(SRC.match(/created_by LIKE ANY\(\$\{managedPatterns\}::text\[\]\)/g)).toHaveLength(2);
  });
});
