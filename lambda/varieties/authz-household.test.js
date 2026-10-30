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
// WHY NO HANDLER-LEVEL TEST IN THIS FILE: when it was written no lambda test imported a handler, so
// Layer 2 covers the wiring by reading source. That is no longer true of this directory: several
// files here now `await import('./index.js')` with the runtime deps mocked (can-edit-route,
// source-routes, facts-edit, blend-route among them), and can-edit-route.test.js runs the handler's
// GET, PUT and DELETE over the same rows this file reasons about. Layer 2 stays because it pins
// things a driven handler does not show: ordering, the cast, the count of scoped predicates.
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
import { managedPrincipalPatterns, MANAGED_PRINCIPAL_PATTERNS, canEditVariety, sqlLike } from './authz.js';
import { householdScope } from './household.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const AUTHZ_SRC = decomment(readFileSync(resolve(__dirname, 'authz.js'), 'utf8'));
// index.js signs in through this dir's copy of the D2 kit (held byte-equal to lambda/request-context.js by
// lambda/household-isolation.test.js), so the sign-in pins below read the code that runs in this zip.
const KIT_SRC = decomment(readFileSync(resolve(__dirname, 'request-context.js'), 'utf8'));
const KIT_FN = KIT_SRC.slice(KIT_SRC.indexOf('export async function requestContext('));
const KIT_CALL = /const ctx = await requestContext\(event\b[\s\S]*?\);\n\s*if \(ctx\.response\) return ctx\.response;/;

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

// ── BUG-VARIETYEDITHOUSEHOLDMIRROR-001 — the same decision, answered per ROW for the edit form ─────
//
// GET /api/varieties/:id now tells VarietyEditor whether the PUT would take the row (can_edit), so
// the form stops guessing at a household roster it cannot see. That answer is canEditVariety, and it
// is only worth sending while it agrees with the write predicate:
//     created_by = ANY(household)  OR  created_by LIKE ANY(managedPatterns::text[])
// The direction that matters most is the one a wrong TRUE takes: a form that opens, takes the
// typing, and is then refused. So the LIKE arm gets its own table below (sqlLike), read off the
// Postgres manual (9.7.1) and src/backend/utils/adt/like_match.c rather than off this file's author,
// and can-edit-route.test.js runs the handler's GET, PUT and DELETE side by side over the same rows.

describe('sqlLike — Postgres LIKE with the default backslash escape', () => {
  // The four examples the Postgres manual gives for LIKE, verbatim.
  it.each([
    ['abc', 'abc', true],
    ['abc', 'a%', true],
    ['abc', '_b_', true],
    ['abc', 'c', false],
  ])('manual: %j LIKE %j is %s', (text, pattern, expected) => {
    expect(sqlLike(text, pattern)).toBe(expected);
  });

  it('covers the WHOLE string, not a substring', () => {
    expect(sqlLike('abc', 'ab')).toBe(false);
    expect(sqlLike('abc', 'bc')).toBe(false);
    expect(sqlLike('abc', '%b%')).toBe(true);
    expect(sqlLike('a', '')).toBe(false);
    expect(sqlLike('', '')).toBe(true);
  });

  it('% matches zero or more characters, line breaks included', () => {
    expect(sqlLike('rescue-intake-', 'rescue-intake-%')).toBe(true);
    expect(sqlLike('', '%')).toBe(true);
    expect(sqlLike('', '%%')).toBe(true);
    expect(sqlLike('rescue-intake-a\nb', 'rescue-intake-%')).toBe(true);
    expect(sqlLike('a-x-b-y-c', 'a%b%c')).toBe(true);
    expect(sqlLike('a-x-c', 'a%b%c')).toBe(false);
  });

  it('_ matches exactly one CHARACTER — never zero, never two, never half an astral one', () => {
    expect(sqlLike('ab', 'a_')).toBe(true);
    expect(sqlLike('a', 'a_')).toBe(false);
    expect(sqlLike('abc', 'a_')).toBe(false);
    expect(sqlLike('', '_')).toBe(false);
    expect(sqlLike('a\u{1F331}b', 'a_b')).toBe(true);
    expect(sqlLike('a\u{1F331}b', 'a__b')).toBe(false);
    expect(sqlLike('abc', '%_')).toBe(true);
    expect(sqlLike('', '%_')).toBe(false);
  });

  it('a backslash makes the next pattern character literal, itself included', () => {
    expect(sqlLike('a%b', 'a\\%b')).toBe(true);
    expect(sqlLike('axb', 'a\\%b')).toBe(false);
    expect(sqlLike('a_b', 'a\\_b')).toBe(true);
    expect(sqlLike('axb', 'a\\_b')).toBe(false);
    expect(sqlLike('a\\b', 'a\\\\b')).toBe(true);
    expect(sqlLike('ab', 'a\\b')).toBe(true);
    // The trap a prefix/equality emulation walks into: `\_` is a literal underscore to Postgres, so
    // the value `a\_bX` does NOT match — a startsWith on the raw pattern text would say it does.
    expect(sqlLike('a\\_bX', 'a\\_b%')).toBe(false);
    expect(sqlLike('a_bX', 'a\\_b%')).toBe(true);
  });

  // Postgres RAISES on a pattern that ends in a lone escape once the match reaches it ("LIKE pattern
  // must not end with escape character"), and answers FALSE when it does not get that far. Either
  // way the statement admits no row, so the mirror never answers true.
  it('a pattern ending in a lone escape matches nothing', () => {
    expect(sqlLike('a\\', 'a\\')).toBe(false);
    expect(sqlLike('a', 'a\\')).toBe(false);
    expect(sqlLike('a', '%\\')).toBe(false);
    expect(sqlLike('', '\\')).toBe(false);
  });

  it('is case-sensitive, and nothing but % _ \\ is special', () => {
    expect(sqlLike('System', 'system')).toBe(false);
    expect(sqlLike('abc', 'a.c')).toBe(false);
    expect(sqlLike('a.c', 'a.c')).toBe(true);
    expect(sqlLike('aXc', 'a[X]c')).toBe(false);
    expect(sqlLike('a[X]c', 'a[X]c')).toBe(true);
    expect(sqlLike('ab', 'a*')).toBe(false);
    expect(sqlLike('a+(b)|{c}^$?/-', 'a+(b)|{c}^$?/-')).toBe(true);
  });

  it('wildcards in the VALUE are plain text — only the pattern side is a pattern', () => {
    expect(sqlLike('%', 'system')).toBe(false);
    expect(sqlLike('syste_', 'system')).toBe(false);
    expect(sqlLike('rescue-intake-%', 'rescue-intake-%')).toBe(true);
  });

  it('refuses anything that is not two strings', () => {
    expect(sqlLike(null, '%')).toBe(false);
    expect(sqlLike(undefined, '%')).toBe(false);
    expect(sqlLike(7, '%')).toBe(false);
    expect(sqlLike('a', null)).toBe(false);
  });

  // Today's four patterns are literal text plus at most one trailing % — the shape VarietyEditor's
  // prefix/equality fallback assumes. sqlLike must read them the same way that fallback does.
  it('reads today\'s managed patterns exactly as prefix/equality does', () => {
    const naive = (v, p) => (p.endsWith('%') ? v.startsWith(p.slice(0, -1)) : v === p);
    const values = [
      'system', 'systematic-scraper', 'System', 'system ', ' system', 'system%',
      'rescue-intake-longriver-20260712', 'rescue-intake-', 'rescue-intake', 'x-rescue-intake-1',
      'data-audit-20260706', 'data_audit-20260706', 'data-correction-2026-07-07', DAVE, '',
    ];
    for (const p of MANAGED_PRINCIPAL_PATTERNS) {
      expect(p, `${p} is no longer plain text plus one trailing %`).toMatch(/^[^%_\\]+%?$/);
      for (const v of values) expect(sqlLike(v, p), `${JSON.stringify(v)} LIKE ${p}`).toBe(naive(v, p));
    }
  });
});

describe('canEditVariety — the PUT/DELETE row predicate, per row', () => {
  const HH = [DAVE, JEN];

  // THE BUG. 472 of 497 live cultivars sat read-only for the second member (2026-09-23) because the
  // form compared created_by to her own id; the PUT compares it to the household.
  it('a household member may edit a row the OTHER member created', () => {
    expect(canEditVariety(HH, DAVE)).toBe(true);
    expect(canEditVariety(HH, JEN)).toBe(true);
    expect(canEditVariety([JEN, DAVE], DAVE)).toBe(true);
  });

  it.each([
    ['system'],
    ['rescue-intake-longriver-20260712'],
    ['data-audit-20260706'],
    ['data-correction-2026-07-07'],
    // The next intake batch, and the shortest value the prefix admits (% matches zero characters).
    ['rescue-intake-eastfield-20271130'],
    ['rescue-intake-'],
  ])('a household member may edit the managed-principal row %s', (createdBy) => {
    expect(canEditVariety(HH, createdBy)).toBe(true);
  });

  it.each([
    [STRANGER],
    ['systematic-scraper'],
    ['System'],
    ['system '],
    ['x-rescue-intake-1'],
    ['rescue-intake'],
    ['data_audit-20260706'],
  ])('a household member may NOT edit %j — neither arm admits it', (createdBy) => {
    expect(canEditVariety(HH, createdBy)).toBe(false);
  });

  // NEGATIVE CONTROL. householdScope hands a non-member [their-own-id]: own rows only, and no
  // managed arm — the same collapse managedPrincipalPatterns gives the SQL.
  it('a non-member may edit only a row they created', () => {
    expect(canEditVariety([STRANGER], STRANGER)).toBe(true);
    expect(canEditVariety([STRANGER], DAVE)).toBe(false);
    expect(canEditVariety([STRANGER], JEN)).toBe(false);
    for (const p of ['system', 'rescue-intake-longriver-20260712', 'data-audit-20260706', 'data-correction-2026-07-07']) {
      expect(canEditVariety([STRANGER], p), p).toBe(false);
    }
  });

  // Same fail-closed imprecision as the SQL: a single-id household is indistinguishable from a
  // stranger, so the PUT binds an empty pattern list and this must not answer for a wider one.
  it('a household of one: own rows, and no managed arm', () => {
    expect(canEditVariety([DAVE], DAVE)).toBe(true);
    expect(canEditVariety([DAVE], JEN)).toBe(false);
    expect(canEditVariety([DAVE], 'system')).toBe(false);
    expect(canEditVariety([DAVE], 'rescue-intake-longriver-20260712')).toBe(false);
  });

  // SQL: NULL = ANY(...) and NULL LIKE ANY(...) are both NULL, and a NULL predicate admits no row.
  it('a row with no created_by is editable by nobody', () => {
    for (const hh of [HH, [STRANGER], [DAVE]]) {
      expect(canEditVariety(hh, null)).toBe(false);
      expect(canEditVariety(hh, undefined)).toBe(false);
      expect(canEditVariety(hh, '')).toBe(false);
      expect(canEditVariety(hh, 0)).toBe(false);
      expect(canEditVariety(hh, { toString: () => DAVE })).toBe(false);
    }
  });

  // The one place this is STRICTER than the SQL text: '' = ANY(ARRAY['']) is TRUE in Postgres. The
  // handler 401s an empty subject before householdScope runs, so [''] never reaches either side.
  it('an empty created_by stays refused even against an empty-id scope', () => {
    expect(canEditVariety([''], '')).toBe(false);
    expect(canEditVariety(['', DAVE], '')).toBe(false);
  });

  it('wildcards in created_by are text: they match no pattern they merely resemble', () => {
    expect(canEditVariety(HH, '%')).toBe(false);
    expect(canEditVariety(HH, '_')).toBe(false);
    expect(canEditVariety(HH, 'system%')).toBe(false);
    expect(canEditVariety(HH, 'syste_')).toBe(false);
    expect(canEditVariety(HH, 'user_%')).toBe(false);
    // …and a created_by that IS a pattern's own text matches it the way any other tail would.
    expect(canEditVariety(HH, 'rescue-intake-%')).toBe(true);
    expect(canEditVariety(HH, 'rescue-intake-_')).toBe(true);
  });

  // The household arm is `=`, never LIKE: an id that happens to hold a wildcard admits only itself.
  it('a household id is compared whole, never as a pattern', () => {
    expect(canEditVariety(['user_%', DAVE], 'user_anyone')).toBe(false);
    expect(canEditVariety(['user_%', DAVE], 'user_%')).toBe(true);
    expect(canEditVariety(['user_____', DAVE], 'user_abcd')).toBe(false);
    expect(canEditVariety([DAVE.toLowerCase(), JEN], DAVE)).toBe(false);
    expect(canEditVariety([`${DAVE} `, JEN], DAVE)).toBe(false);
  });

  it('fail-closed on an absent or malformed scope', () => {
    for (const hh of [undefined, null, [], 'not-an-array', DAVE, { 0: DAVE, length: 1 }]) {
      expect(canEditVariety(hh, DAVE)).toBe(false);
      expect(canEditVariety(hh, 'system')).toBe(false);
    }
  });

  // Composed the way the handler composes it: householdScope(userId) is the ONE input both the SQL
  // binds and this function are derived from.
  it('end to end from the env: member, second member, stranger, unset', () => {
    process.env[ENV_KEY] = `${DAVE},${JEN}`;
    expect(canEditVariety(householdScope(JEN), DAVE)).toBe(true);
    expect(canEditVariety(householdScope(DAVE), JEN)).toBe(true);
    expect(canEditVariety(householdScope(JEN), 'system')).toBe(true);
    expect(canEditVariety(householdScope(STRANGER), DAVE)).toBe(false);
    expect(canEditVariety(householdScope(STRANGER), 'system')).toBe(false);
    expect(canEditVariety(householdScope(STRANGER), STRANGER)).toBe(true);
    delete process.env[ENV_KEY];
    expect(canEditVariety(householdScope(JEN), DAVE)).toBe(false);
    expect(canEditVariety(householdScope(JEN), JEN)).toBe(true);
    expect(canEditVariety(householdScope(JEN), 'system')).toBe(false);
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
    // BUG-AUTHZFKENUM-001 added loadOwnedPhoto + warnRejectedFk to this import for the photo_id and
    // source_proj_rescope_project_id gates, so the assertion pins the SYMBOL and the MODULE rather
    // than the exact one-symbol import line it used to be.
    expect(SRC).toMatch(/import \{[^}]*\bhouseholdScope\b[^}]*\} from '\.\/household\.js'/);
    // V5-SOURCECONTACT-001 added canEditSource to this import; pinned by symbol + module, as above.
    expect(SRC).toMatch(/import \{[^}]*\bmanagedPrincipalPatterns\b[^}]*\} from '\.\/authz\.js'/);
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
    expect(KIT_SRC).toMatch(/if \(!userId\) return resp\(401, \{ error: 'Unauthorized' \}\);/);
    const guard = KIT_FN.indexOf("if (!userId) return resp(401");
    expect(guard).toBeGreaterThan(-1);
    expect(guard, 'the empty-sub guard must precede the household gate').toBeLessThan(KIT_FN.indexOf('householdGate(userId)'));
    expect(guard).toBeLessThan(KIT_FN.indexOf('neon('));
    expect(guard).toBeLessThan(KIT_FN.indexOf('scope('));
    const call = SRC.search(KIT_CALL);
    const use = SRC.search(/householdScope\s*\(\s*userId\s*\)/);
    expect(call).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(-1);
    expect(call, 'the kit call must precede householdScope(userId)').toBeLessThan(use);
    expect(call).toBeLessThan(SRC.indexOf('const sql = neon('));
  });

  // userId comes from the verified JWT sub and nowhere else — never a header or body field.
  it('userId is taken only from the verified token payload', () => {
    expect(KIT_SRC).toMatch(/userId = payload\.sub/);
    expect(SRC).toMatch(KIT_CALL);
    expect(SRC).toMatch(/const \{[^}]*\buserId\b[^}]*\} = ctx;/);
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
    // BUG-VARIETYACTOREMPTY-001 wrapped the bind in auditActor(); the property under test is
    // unchanged — the actor derives from the JWT sub and from nothing else. Now asserted over EVERY
    // bind instead of "some line matches", so a further write path cannot slip in on a household id.
    // The count is a REVIEW GATE, not a ceiling: it goes up in the same change that adds an audited
    // write, and the for-loop below is the invariant. 4 -> 5 on 2026-09-04 (V4-SOURCEREG-001), the
    // restore arm of POST /api/varieties/sources — public.source carries trg_audit_source_upd, so
    // that UPDATE is audited and must name the human who asked for it rather than 'system'. 5 -> 6 on
    // 2026-09-29 (V5-SOURCECONTACT-001), PATCH /api/varieties/sources/:id, same table, same reason.
    // D2 W1: every bind is now a withActor call (its helper checks the actor through auditActor), so the
    // actor argument is what is asserted, over every call; no raw bind is left in this file.
    const actors = [...SRC.matchAll(/\bwithActor\(sql, ([^,]+),/g)].map((m) => m[1]);
    expect(actors).toHaveLength(6);
    for (const a of actors) expect(a).toBe('userId');
    expect(SRC).not.toMatch(/set_config\('app\.actor_clerk_sub', \$\{/);
    expect(SRC).not.toMatch(/withActor\(sql, [^,]*household/);
  });

  it('POST still stamps created_by from the JWT sub only (no widening on create)', () => {
    const postIdx = SRC.lastIndexOf("if (method === 'POST')");
    const postBlock = SRC.slice(postIdx);
    // BUG-AUTHZFKENUM-001 changed this assertion's TARGET, not its meaning. The POST block now
    // legitimately mentions ${household} — the household-scoped source-project idempotency lookup
    // and the loadOwnedProject/loadOwnedPhoto FK gates — and none of those stamps ownership. What
    // must never widen is the INSERT's created_by, so the assertion moved onto the INSERT itself
    // (which is strictly tighter than the old block-wide scan, not a relaxation).
    const insIdx = postBlock.indexOf('INSERT INTO public.cultivar');
    expect(insIdx, 'expected the create INSERT in the POST block').toBeGreaterThan(-1);
    const insStmt = postBlock.slice(insIdx, postBlock.indexOf('RETURNING', insIdx));
    expect(insStmt).toMatch(/created_by,/);
    expect(insStmt).toMatch(/\$\{userId\}/);
    expect(insStmt).not.toMatch(/\$\{household\}|\$\{managedPatterns\}/);
  });

  // Anchored on CODE: SRC is decommented, so an anchor on a comment finds nothing and the block it
  // slices is empty (this test was vacuous that way). The list is the last GET in the handler, after
  // the :id route's 405 and before the create POST; the by-id GET is pinned in the describe below.
  it('the GET read paths are untouched (still global, no scope predicate)', () => {
    const listIdx = SRC.lastIndexOf("if (method === 'GET')");
    const postIdx = SRC.lastIndexOf("if (method === 'POST')");
    expect(listIdx, 'expected the list GET after the :id route').toBeGreaterThan(SRC.indexOf('return resp(405', delIdx));
    expect(postIdx).toBeGreaterThan(listIdx);
    const listBlock = SRC.slice(listIdx, postIdx);
    // Both branches (searched and unsearched) read every live cultivar and nothing narrower.
    expect(listBlock.match(/FROM public\.cultivar\s*\n\s*WHERE deleted_at IS NULL/g)).toHaveLength(2);
    expect(listBlock).not.toMatch(/household|managedPatterns|userId/);
    expect(listBlock).not.toMatch(/created_by\s*(?:=|<>|!=|LIKE|IN|IS)\s/);
  });

  // Exactly three scoped predicates carry the arm. A fourth means something else widened.
  //
  // WAS TWO (PUT + DELETE). The third is the POST source-project idempotency SELECT, NARROWED by
  // BUG-AUTHZFKENUM-001 — it previously read `WHERE source_proj_rescope_project_id = $1 AND
  // deleted_at IS NULL LIMIT 1` with no owner predicate at all, which let an attacker pre-squat the
  // key so an admin's /admin/classify inline-create returned the ATTACKER's cultivar with a 200.
  // It reuses this exact arm rather than a fourth dialect precisely so it stays countable here: the
  // set of rows the idempotency lookup may return is now identical to the set PUT/DELETE may edit.
  // 3 -> 6 (V4-RESTORESURFACE-001): the recovery surface adds three more uses of this SAME arm —
  // the /deleted list, the restore preflight and the restore UPDATE. They REUSE the arm rather than
  // inventing a fourth dialect, for exactly the reason the note above gives: the set of rows the
  // recovery surface may show and restore is identical to the set PUT/DELETE may edit.
  // 6 -> 7 (V5-VARIETYFACTSEDIT-001): the PUT's breeding-pairing preflight, a READ of the very row
  // the PUT's UPDATE may edit, so it reuses this SAME arm for the same reason — a row the caller
  // cannot edit must answer the PUT's generic 404, never a pairing 400 about someone else's row.
  // An eighth still means something widened.
  it('exactly seven scoped predicates exist — PUT, its pairing preflight, DELETE, POST idempotency, and the three recovery reads', () => {
    expect(SRC.match(/created_by = ANY\(\$\{household\}\)/g)).toHaveLength(7);
    expect(SRC.match(/created_by LIKE ANY\(\$\{managedPatterns\}::text\[\]\)/g)).toHaveLength(7);
    // …and the new one is a READ, not a write: it must sit inside a SELECT.
    expect(SRC).toMatch(/FROM public\.cultivar\s*\n\s*WHERE source_proj_rescope_project_id/);
  });
});

// BUG-VARIETYEDITHOUSEHOLDMIRROR-001 — can_edit is a PREDICTION of the write predicates above, so it
// is pinned to them term by term. Each assertion names one way the two could drift apart:
// a different scope variable, a different patterns helper, a third arm on one side only, or a read
// that could return a row the writes exclude (soft-deleted, another id).
describe('GET /api/varieties/:id can_edit — pinned to the PUT/DELETE predicate', () => {
  const idIdx = SRC.indexOf('const idMatch = rawPath.match');
  const getIdx = SRC.indexOf("if (method === 'GET')", idIdx);
  const putIdx = SRC.indexOf("if (method === 'PUT')", getIdx);
  const delIdx = SRC.indexOf("if (method === 'DELETE')", putIdx);
  const endIdx = SRC.indexOf('return resp(405', delIdx);
  const getBlock = SRC.slice(getIdx, putIdx);
  const fnIdx = AUTHZ_SRC.indexOf('export function canEditVariety(');
  const fnBody = AUTHZ_SRC.slice(fnIdx, AUTHZ_SRC.indexOf('\n}', fnIdx));

  it('the by-id GET, PUT and DELETE are found, in that order, under the :id route', () => {
    expect(idIdx).toBeGreaterThan(-1);
    expect(getIdx).toBeGreaterThan(idIdx);
    expect(putIdx).toBeGreaterThan(getIdx);
    expect(delIdx).toBeGreaterThan(putIdx);
    expect(endIdx).toBeGreaterThan(delIdx);
    expect(fnIdx, 'authz.js no longer exports canEditVariety').toBeGreaterThan(-1);
  });

  // `household` is the very variable both write arms bind; a userId or a fresh householdScope()
  // here would be a second derivation that could come apart from the first.
  it('answers from canEditVariety over the SAME household the write predicates bind', () => {
    expect(SRC).toMatch(/import \{[^}]*\bcanEditVariety\b[^}]*\} from '\.\/authz\.js'/);
    expect(getBlock).toMatch(/return resp\(200, \{ \.\.\.rows\[0\], can_edit: canEditVariety\(household, rows\[0\]\.created_by\) \}\);/);
    expect(getBlock).not.toMatch(/userId/);
  });

  // The decision is taken on the row's own created_by, read by the same statement, and only for a
  // row the writes could reach at all: this id, not soft-deleted.
  it('the read it rides on carries created_by and the writes\' id + liveness terms', () => {
    expect(getBlock).toMatch(/\bcreated_by, created_at, updated_at\b/);
    expect(getBlock).toMatch(/FROM public\.cultivar\s*\n\s*WHERE id = \$\{varietyId\}\s*\n\s*AND deleted_at IS NULL/);
    expect(getBlock).toMatch(/if \(!rows\.length\) return resp\(404, \{ error: 'Not found' \}\);/);
  });

  // The read stays GLOBAL: the flag is computed in JS after it, never a scope predicate on it.
  it('the by-id read is still unscoped — a non-member gets the row, with can_edit false', () => {
    expect(getBlock).not.toMatch(/created_by\s*(?:=|LIKE)\s/);
    expect(getBlock).not.toMatch(/managedPatterns/);
  });

  // Arm for arm. PUT (its preflight included) and DELETE carry exactly these two conditions on
  // created_by, ORed in one group; canEditVariety carries exactly their two JS counterparts.
  it('canEditVariety has one counterpart for each SQL arm, and the writes have no third', () => {
    for (const [verb, block] of [['PUT', SRC.slice(putIdx, delIdx)], ['DELETE', SRC.slice(delIdx, endIdx)]]) {
      const arms = [...block.matchAll(/created_by\s+(?:=|LIKE)\s+ANY\([^)]*\)(?:::text\[\])?/g)].map((m) => m[0]);
      expect([...new Set(arms)].sort(), verb).toEqual([
        'created_by = ANY(${household})',
        'created_by LIKE ANY(${managedPatterns}::text[])',
      ]);
      expect(block.match(/created_by\s*(?:=|<>|!=|LIKE|IN|IS)\s/g), verb).toHaveLength(arms.length);
      expect(block.match(/created_by = ANY\(\$\{household\}\)\s*\n\s*OR created_by LIKE ANY\(\$\{managedPatterns\}::text\[\]\) \)/g), verb)
        .toHaveLength(arms.length / 2);
    }
    // `= ANY(household)` -> includes; `LIKE ANY(managedPatterns)` -> some(sqlLike) over the list the
    // SAME helper returns for the SAME scope (index.js: managedPatterns = managedPrincipalPatterns(household)).
    // Pinned as the function's whole answer, so a third `||` arm cannot be added on this side alone.
    expect(fnBody.slice(fnBody.lastIndexOf('return ')).replace(/\s+/g, ' ').trim()).toBe(
      'return household.includes(createdBy) || managedPrincipalPatterns(household).some((p) => sqlLike(createdBy, p));',
    );
    expect(fnBody).not.toMatch(/MANAGED_PRINCIPAL_PATTERNS/);
    // Every other exit is a refusal: nothing above that return can answer true.
    expect(fnBody.match(/return /g).length).toBeGreaterThan(1);
    for (const early of fnBody.split('\n').filter((l) => /return /.test(l)).slice(0, -1)) {
      expect(early.trim(), 'an early exit that is not a refusal').toMatch(/return false;$/);
    }
  });

  // The flag is only worth its bytes where VarietyEditor is seeded, and that is this one read
  // (src/pages/VarietyEdit.jsx). The list feeds pickers and search, which never open the form on it.
  it('only the by-id GET carries the flag — not the list, the create, the PUT reply or the blend', () => {
    expect(SRC.match(/can_edit/g)).toHaveLength(1);
    expect(SRC.match(/canEditVariety\(/g)).toHaveLength(1);
  });
});
