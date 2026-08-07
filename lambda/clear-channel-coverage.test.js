// BUG-COALESCECLEAR-001 — the fleet guard.
//
// THE CLASS: a PUT/PATCH that binds an optional column as `COALESCE(${body.x ?? null}, x)` makes
// that column WRITE-ONCE-SETTABLE. `null` and `absent` are the same token on the wire, so once the
// column holds a value there is no request body that returns it to NULL. An edit form rendering
// such a field either omits it (incomplete) or renders a box the user can empty and save with no
// effect (worse). Measured on prod at authoring time: plants 29 such arms, projects 8, locations 5.
//
// THE FIX is the `clear:[...]` channel — `CASE WHEN ${clear} @> ARRAY['x'] THEN NULL ELSE
// COALESCE(...) END` — shipped first in lambda/varieties (V4-EDITCOMPLETE-001).
//
// THIS FILE IS THE RATCHET, and it is deliberately worth more than the fix. The fix retires today's
// three handlers; this stops the pattern being re-introduced by the next one. It is derived FROM
// DISK, not from a hand-maintained list, so a newly added Lambda is covered the day it lands rather
// than the day someone remembers to add a row — the lambdaDirs() posture from
// authz-write-fk.test.js's V4-AUTHZRESIDUE-001 residue guards.
//
// WHY A GUARD AND NOT JUST THE FIX: the varieties implementation shipped with `care_notes` on the
// allowlist and NO matching SQL arm, and the entire suite stayed green. That drift was found by
// mutation, not by design (varieties/select-columns.test.js:135-141). A per-handler test cannot see
// a handler that does not exist yet; only a fleet sweep can.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const lambdaDirs = () => readdirSync(here, { withFileTypes: true })
  .filter(e => e.isDirectory() && existsSync(join(here, e.name, 'index.js')))
  .map(e => e.name)
  .sort();

// Comments are stripped before matching so a COALESCE quoted inside an explanatory `--` block does
// not count as a live arm, and so a handler cannot satisfy the guard by mentioning `@> ARRAY[` in
// prose. Line comments only; the SQL here is a JS template literal and block comments do not appear
// inside one (lambda/sql-comment-hygiene.test.js enforces `--` over `//` in the templates).
const strip = src => src.split('\n').map(l => l.replace(/--.*$/, '').replace(/\/\/.*$/, '')).join('\n');

// A "COALESCE-on-a-body-field" arm: the exact shape that conflates null with absent.
const COALESCE_BODY = /COALESCE\(\s*\$\{[^}]*\bbody\.[A-Za-z_][A-Za-z0-9_]*/g;
// The clear channel's two halves: the validator call and at least one SQL arm.
const HAS_VALIDATOR = /validateClear\s*\(/;
const HAS_CLEAR_ARM = /@>\s*ARRAY\[/;

// EXEMPT — every entry carries its own reason. An empty or reason-less entry is a bug in this file.
// These are NOT "handlers we gave up on"; each is a deliberate, dated decision.
const EXEMPT = {
  // projects and locations WERE listed here while their channels were in flight. Both landed
  // (BUG-COALESCECLEAR-001, 2026-08-07) and their entries are removed, which is the point of the
  // "no handler is EXEMPT that does not carry a COALESCE arm" assertion below — a stale exemption
  // silently pre-authorizes a handler that has since been fixed. plants/projects/locations/
  // varieties/events are now all swept live.

  // Scoped OUT of BUG-COALESCECLEAR-001 at authoring time and not yet triaged. Named here so they
  // are visible rather than silently uncovered — the ledger item measured plants/projects/locations
  // only, and this sweep is what revealed that three more handlers carry the same shape.
  // Each needs its own nullable-column + CHECK audit before an allowlist can be written.
  // REMOVE each entry as its handler is triaged; file a ticket per handler, do not bulk-fix.
  preservation: 'BUG-COALESCECLEAR-002 (untriaged): 1 arm, needs a nullable/CHECK audit first',
  'storage-location': 'BUG-COALESCECLEAR-002 (untriaged): 2 arms, needs a nullable/CHECK audit first',
  tags: 'BUG-COALESCECLEAR-002 (untriaged): 2 arms, needs a nullable/CHECK audit first',
};

describe('BUG-COALESCECLEAR-001: every handler with a COALESCE-on-body arm declares a clear channel', () => {
  const dirs = lambdaDirs();
  const withCoalesce = dirs.filter(d => {
    const src = strip(readFileSync(join(here, d, 'index.js'), 'utf8'));
    return (src.match(COALESCE_BODY) || []).length > 0;
  });

  // THE NON-EMPTY SANITY ASSERTION. Without it a regex that silently stops matching — a refactor to
  // a helper, a rename of `body`, a formatting change that breaks the pattern across lines — turns
  // this entire file into a vacuous pass that still reports green. Assert the shape of the world
  // before asserting anything about it.
  it('finds the COALESCE-on-body handler set (guards against an empty match)', () => {
    expect(dirs.length).toBeGreaterThanOrEqual(20);
    expect(withCoalesce.length).toBeGreaterThanOrEqual(6);
    // The three the ledger item names. If any of these stops matching, the sweep has gone blind
    // rather than the bug having been fixed — a fixed handler still carries its COALESCE arms,
    // wrapped in a CASE.
    expect(withCoalesce).toContain('plants');
    expect(withCoalesce).toContain('projects');
    expect(withCoalesce).toContain('locations');
    // varieties is the reference implementation and must remain in the swept set.
    expect(withCoalesce).toContain('varieties');
  });

  it('every EXEMPT entry names a real handler and carries a reason', () => {
    for (const [d, reason] of Object.entries(EXEMPT)) {
      expect(dirs, `EXEMPT names ${d}, which is not a lambda handler dir`).toContain(d);
      expect(typeof reason === 'string' && reason.trim().length > 20,
        `EXEMPT['${d}'] needs a real reason, not a placeholder`).toBe(true);
    }
  });

  it('no handler is EXEMPT that does not actually carry a COALESCE-on-body arm', () => {
    // A stale exemption is worse than none: it silently pre-authorizes a handler that has since
    // been fixed or rewritten, so the guard stops covering it without anyone noticing.
    for (const d of Object.keys(EXEMPT)) {
      expect(withCoalesce, `EXEMPT['${d}'] is stale — that handler has no COALESCE-on-body arm any more`)
        .toContain(d);
    }
  });

  // PER-COLUMN COVERAGE. The assertions below check that a handler declares *a* validator and *at
  // least one* clear arm. That is coarser than this file's own header claims: it would pass a
  // handler whose allowlist names five columns and whose SQL clears one — which is EXACTLY the
  // drift that shipped in varieties (`care_notes` on the allowlist, no matching SQL arm, entire
  // suite green, found by mutation rather than by design). Close it at column granularity: every
  // name in CLEARABLE_FIELDS must appear inside an `@> ARRAY[...]` arm in the sibling index.js.
  for (const d of lambdaDirs()) {
    const vPath = join(here, d, 'validate.js');
    if (!existsSync(vPath)) continue;
    const vSrc = strip(readFileSync(vPath, 'utf8'));
    const listMatch = vSrc.match(/CLEARABLE_FIELDS\s*=\s*\[([\s\S]*?)\]/);
    if (!listMatch) continue;
    const declared = [...listMatch[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map(m => m[1]);
    const idxSrc = strip(readFileSync(join(here, d, 'index.js'), 'utf8'));
    const armed = new Set(
      [...idxSrc.matchAll(/@>\s*ARRAY\[\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)].map(m => m[1]));

    it(`${d}: every column on the allowlist has a matching SQL clear arm`, () => {
      expect(declared.length, `${d}/validate.js declares an empty CLEARABLE_FIELDS`)
        .toBeGreaterThan(0);
      for (const col of declared) {
        expect(armed.has(col),
          `${d}/validate.js lists '${col}' as clearable but ${d}/index.js has no ` +
          `CASE WHEN \${clear} @> ARRAY['${col}'] arm. The validator accepts the key, the SQL ` +
          'ignores it: the PUT returns 200 and the column keeps its old value — the exact bug ' +
          'this channel exists to fix, now with a 200 that looks like success.').toBe(true);
      }
    });
  }

  for (const d of lambdaDirs()) {
    const src = strip(readFileSync(join(here, d, 'index.js'), 'utf8'));
    const arms = (src.match(COALESCE_BODY) || []).length;
    if (arms === 0) continue;
    if (EXEMPT[d]) continue;

    it(`${d}/index.js has ${arms} COALESCE-on-body arm(s) and must declare a clear channel`, () => {
      expect(src, `${d} binds body fields through COALESCE but never calls validateClear — ` +
        'null and absent are conflated, so those columns cannot be returned to NULL. Either add ' +
        'the clear:[] channel (see lambda/varieties) or add a reasoned EXEMPT entry.')
        .toMatch(HAS_VALIDATOR);
      expect(src, `${d} calls validateClear but has no CASE WHEN \${clear} @> ARRAY[...] SQL arm — ` +
        'the validator without the SQL is the exact drift that shipped in varieties and stayed ' +
        'green (select-columns.test.js:135-141).')
        .toMatch(HAS_CLEAR_ARM);
    });
  }
});
