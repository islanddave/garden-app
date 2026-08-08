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

// EXEMPT — "carries the shape, not yet triaged". Every entry carries its own reason; an empty or
// reason-less entry is a bug in this file. These are NOT "handlers we gave up on" — each is a
// deliberate, dated decision to look later.
//
// CURRENTLY EMPTY, and that is the finished state rather than an oversight. projects and locations
// sat here while their channels were in flight and left when they landed (BUG-COALESCECLEAR-001).
// preservation, storage-location and tags sat here as BUG-COALESCECLEAR-002's untriaged three, and
// all three have now been audited to a verdict and moved to AUDITED_NOTHING_CLEARABLE below. An
// entry reappears here only when a NEW handler grows a COALESCE-on-body arm — which is precisely
// what the must-declare-a-channel assertion at the bottom of this file forces.
const EXEMPT = {};

// AUDITED, NOTHING CLEARABLE — the third state, and the reason this file needed amending.
//
// The ratchet was built on a binary: a handler either has a clear channel or is EXEMPT pending
// triage. That has no way to say "triaged, and the correct answer is that NOTHING here is
// clearable" — which is the outcome for two of BUG-COALESCECLEAR-002's three handlers. All three
// exits were closed: writing `CLEARABLE_FIELDS = []` reds the empty-allowlist assertion below,
// removing the EXEMPT entry reds the must-declare-a-channel assertion, and leaving the entry in
// place keeps the ticket open forever while the reason string says "untriaged", which is a lie
// the moment the audit is done. The tempting fourth exit — adding a token clear arm to satisfy
// the regex — is the worst one, and this file's header already warns against exactly that.
//
// An entry here is a STRONGER claim than EXEMPT, not a weaker one: it asserts the columns were
// audited and the answer is that no channel should ever be built. Two grounds qualify, and the
// entry must say which: UN-CLEARABLE AT THE DB LAYER (NOT NULL / CHECK — clearing is an error,
// not a choice), or DECLINED AS A PRODUCT CALL (clearing is legal and the answer is still no).
// The second needs a dated decision, because unlike a NOT NULL it can be revisited.
//
// Held to the same staleness rules as EXEMPT (real dir, real reason, still carries a COALESCE
// arm) plus two more: it may not also be EXEMPT, and it may not declare a SERVER_CLEARABLE key on
// the client — an empty array there would be a channel with nothing in it.
const AUDITED_NOTHING_CLEARABLE = {
  preservation:
    'BUG-COALESCECLEAR-002 / BUG-PRESERVCLEARPAIR-001. DECLINED AS A PRODUCT CALL, Dave 2026-08-08: ' +
    'the provenance pair stays CREATE-ONLY. source_kind IS nullable and NULL is meaningful, so unlike ' +
    'the two below this is a choice, not a constraint — which is exactly why it needed the call. It ' +
    'cannot be a plain allowlist entry regardless: source_kind owns a pair, and the source_label CASE ' +
    'keys on the REQUEST kind, so a clear:["source_kind"] leaves source_label set and provenance.js ' +
    'then refuses that row on every later save — un-re-saveable, the projects.location_id ordering ' +
    'hazard again. Shipping it would also mean building a RowEditor provenance field, since the pair ' +
    'is create-only and there is no box to empty. 1 live prod row and it already reads NULL. Reopen ' +
    'only if a put-up provenance EDIT surface is ever wanted, and then do the pair-clear resolver first.',
  'storage-location':
    'BUG-COALESCECLEAR-002, audited 2026-08-07 against live prod. Both arms are NOT NULL, so a ' +
    'clear is a 23502, not a judgment call. kind is additionally CHECK-constrained to a six-value ' +
    'vocabulary (chk_storage_location_kind), so NULL is outside the taxonomy rather than a member ' +
    'of it; label is the display string joined into preservation rows as storage_label. 1 live ' +
    'row. No PUT caller exists in src/ either, so the emptied-box symptom cannot occur today.',
  tags:
    'BUG-COALESCECLEAR-002, audited 2026-08-07 against live prod. label, slug and visibility are ' +
    'all NOT NULL. label cannot be cleared without slug, its derived shadow, and slug participates ' +
    'in the partial unique index uq_tag_facet_slug_owner. visibility is the one worth writing ' +
    'down: the scope predicate matches visibility = private OR shared, and a NULL falls out of ' +
    'EVERY branch, so the tag would vanish from every list surface while its entity_tag rows stayed ' +
    'live behind an ON DELETE RESTRICT FK. The NOT NULL is load-bearing; do not relax it. The ' +
    'PATCH also requires source = user and prod has 0 such rows (all 149 live tags are derived), ' +
    'so this is reasoning for the future, not a live exposure.',
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

  it('every AUDITED_NOTHING_CLEARABLE entry names a real handler, carries a reason, and is not stale', () => {
    for (const [d, reason] of Object.entries(AUDITED_NOTHING_CLEARABLE)) {
      expect(dirs, `AUDITED_NOTHING_CLEARABLE names ${d}, which is not a lambda handler dir`)
        .toContain(d);
      // Held to a higher bar than EXEMPT's 20 chars: this entry replaces a fix, so it has to carry
      // the evidence that no fix is wanted. A one-liner here is how "audited" becomes a rubber stamp.
      expect(typeof reason === 'string' && reason.trim().length > 120,
        `AUDITED_NOTHING_CLEARABLE['${d}'] must record WHAT was checked and WHY nothing is ` +
        'clearable — schema facts, not a verdict').toBe(true);
      expect(withCoalesce,
        `AUDITED_NOTHING_CLEARABLE['${d}'] is stale — that handler has no COALESCE-on-body arm ` +
        'any more, so the audit it records no longer describes the code').toContain(d);
    }
  });

  it('no handler is both EXEMPT and AUDITED_NOTHING_CLEARABLE', () => {
    // The two states mean opposite things — "not yet looked at" vs "looked at, nothing to do". A
    // handler in both would let a real triage debt hide behind a finished-looking entry.
    for (const d of Object.keys(AUDITED_NOTHING_CLEARABLE)) {
      expect(EXEMPT[d], `${d} is in both EXEMPT and AUDITED_NOTHING_CLEARABLE — pick one`)
        .toBeUndefined();
    }
  });

  it('a handler with nothing clearable declares no client-side clear channel either', () => {
    // The client mirror must have NO key for these handlers — not an empty array. An empty array
    // reads as "a channel exists and currently clears nothing", which invites a later editor to
    // add the first entry without redoing the audit that says there should never be one.
    const clearKeys = readFileSync(join(here, '..', 'src', 'lib', 'clearKeys.js'), 'utf8');
    const block = clearKeys.match(/SERVER_CLEARABLE\s*=\s*\{([\s\S]*?)\}/);
    expect(block, 'src/lib/clearKeys.js no longer declares SERVER_CLEARABLE — this guard has gone blind')
      .not.toBeNull();
    for (const d of Object.keys(AUDITED_NOTHING_CLEARABLE)) {
      expect(new RegExp(`['"\`]?${d}['"\`]?\\s*:`).test(block[1]),
        `SERVER_CLEARABLE declares a '${d}' key, but ${d} was audited as having nothing clearable`)
        .toBe(false);
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
      // An empty allowlist is only legitimate as the recorded outcome of an audit. Anywhere else
      // it is a half-built channel: validateClear accepts keys the SQL will never act on.
      if (declared.length === 0) {
        expect(AUDITED_NOTHING_CLEARABLE[d],
          `${d}/validate.js declares an empty CLEARABLE_FIELDS. If that is the audited outcome, ` +
          'record it in AUDITED_NOTHING_CLEARABLE with the schema evidence; otherwise the ' +
          'allowlist is simply unfinished.').toBeDefined();
        return;
      }
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
    if (AUDITED_NOTHING_CLEARABLE[d]) continue;

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
