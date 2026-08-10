// BUG-COALESCECLEAR-001 — the plants clear:[] channel.
//
// Two halves, and BOTH must be asserted: the validator (what the API accepts) and the SQL
// (whether the accepted request actually does anything). The varieties implementation shipped with
// `care_notes` on the allowlist and NO matching SQL arm and the whole suite stayed green — the
// drift was caught by mutation, not by design. The drift guard below is the direct answer to that,
// and it is driven off the IMPORTED allowlist so the two can never be edited apart.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateClear, CLEARABLE_FIELDS, CLEARABLE_SET, MAX_CLEAR_KEYS } from './validate.js';

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

describe('validateClear — legacy callers are untouched', () => {
  // This is what makes the channel shippable without a flag: every request that predates it
  // behaves byte-identically. If any of these starts erroring, the change stopped being additive.
  it('accepts an absent clear', () => expect(validateClear(undefined, {})).toBeNull());
  it('accepts a null clear', () => expect(validateClear(null, {})).toBeNull());
  it('accepts an empty clear', () => expect(validateClear([], {})).toBeNull());
});

describe('validateClear — the allowlist', () => {
  it('accepts every field on the allowlist', () => {
    expect(CLEARABLE_FIELDS.length).toBeGreaterThanOrEqual(21);
    for (const f of CLEARABLE_FIELDS) {
      expect(validateClear([f], {}), `${f} should be clearable`).toBeNull();
    }
  });

  it('refuses a non-array clear', () => {
    expect(validateClear('notes', {})).toMatch(/must be an array/);
    expect(validateClear({ notes: true }, {})).toMatch(/must be an array/);
  });

  it('refuses a non-string member', () => {
    expect(validateClear([42], {})).toMatch(/cannot be cleared/);
    expect(validateClear([null], {})).toMatch(/cannot be cleared/);
  });

  it('refuses a typo rather than silently ignoring it', () => {
    // The failure mode this prevents: `clear:['note']` (singular) silently doing nothing, so the
    // user empties a field, saves, sees success, and the value is still there.
    expect(validateClear(['note'], {})).toMatch(/cannot be cleared: note/);
    expect(validateClear(['sown_date'], {})).toMatch(/cannot be cleared: sown_date/);
  });

  it('refuses a clear that is also a set — never picks a winner', () => {
    expect(validateClear(['notes'], { notes: 'hi' })).toMatch(/both cleared and set/);
  });

  it('allows an explicit null alongside a clear', () => {
    // Load-bearing for the declarative client patch builder, which emits every key as
    // `value || null`. Without this, the natural client shape would 400 on every clear.
    expect(validateClear(['notes'], { notes: null })).toBeNull();
  });

  it('caps the number of keys', () => {
    expect(validateClear(new Array(MAX_CLEAR_KEYS + 1).fill('notes'), {})).toMatch(/at most/);
  });
});

describe('BUG-COALESCECLEAR-001: the columns that must NEVER be clearable', () => {
  // Each of these is a specific, reasoned exclusion, not an oversight. Adding any one to
  // CLEARABLE_FIELDS reds this test — which is the point, because each would be a silent-harm
  // change that no behavioural test on the plants route would catch.
  const FORBIDDEN = {
    // Tier 3 — DB or identity
    display_name: 'NOT NULL, and the cadence-lookup key',
    name: 'wire alias of display_name',
    quantity: 'NOT NULL, DEFAULT 1, CHECK quantity >= 1',
    qty_harvested: 'counter with DEFAULT 0 — clear-to-zero is the correct affordance',
    qty_lost: 'counter with DEFAULT 0 — clear-to-zero is the correct affordance',
    // The ownership-transfer trigger fires on 9 tables and raises on ANY IS DISTINCT FROM
    // change to created_by, including value -> NULL.
    created_by: 'ownership-transfer trigger raises on value -> NULL',
    id: 'identity',
    deleted_at: 'soft-delete state, not an edit surface',
    workspace_id: 'tenancy axis',
    // Tier 2 — nullable and DB-legal, but each changes a care recommendation on clear.
    status: 'clearing skips the status_change audit event AND resumes calendar watering on a dormant plant',
    container_type: 'NULL falls out of likelyInGround -> shorter container cadence -> over-watering',
    transplanted_at: 'substrate freshness coalesces through it -> a fresh plug gets full rain credit',
    planted_out_at: 'same coalesce chain as transplanted_at',
    // Tracked separately — do not fold it into this channel.
    location_id: 'BUG-NOLOCOUTDOOR-001: no location currently resolves to OUTDOOR, enabling rain credit indoors',
  };

  for (const [col, why] of Object.entries(FORBIDDEN)) {
    it(`${col} is not clearable — ${why}`, () => {
      expect(CLEARABLE_SET.has(col), `${col} must stay off CLEARABLE_FIELDS: ${why}`).toBe(false);
      expect(validateClear([col], {})).toMatch(/cannot be cleared/);
    });
  }
});

describe('BUG-COALESCECLEAR-001: allowlist <-> SQL drift guard', () => {
  // THE TEST THAT MATTERS. Driven off the imported allowlist, so a field added to validate.js
  // without a matching SQL arm reds here instead of shipping as an accepted-but-inert clear.
  // This is the exact defect that shipped in varieties and stayed green.
  // The clear arm no longer has to be the FIRST `WHEN` of its CASE. BUG-SOWNAPPROXORPHAN-001 puts a
  // date-is-NULL guard ahead of it on the four `*_at_approx` columns, because a CASE evaluates in
  // order and the orphan guard has to win over the flag's own COALESCE. The assertion still demands
  // the arm verbatim — `WHEN ${clear} @> ARRAY['f'] THEN NULL ELSE COALESCE(` — so deleting or
  // neutering it still reds; only the positional constraint is relaxed.
  //
  // The `(?:(?!= CASE)[\s\S])` tempered repetition is load-bearing and is NOT decoration: a plain
  // `[\s\S]*?` would happily run past the end of this field's assignment and satisfy the match
  // against a NEIGHBOURING field's clear arm — which is the extractor-swallows-too-much defect that
  // let a deleted `kind_set_at` pass `projects/select-columns` from the wrong statement entirely.
  // Refusing to cross another `= CASE` bounds the search to one assignment.
  it('every allowlisted field has a matching CASE arm in the UPDATE', () => {
    expect(CLEARABLE_FIELDS.length).toBeGreaterThanOrEqual(21);
    for (const f of CLEARABLE_FIELDS) {
      const arm = new RegExp(
        `${f}\\s*= CASE(?:(?!= CASE)[\\s\\S])*?WHEN \\$\\{clear\\} @> ARRAY\\['${f}'\\] THEN NULL\\s+ELSE COALESCE\\(`);
      expect(SRC, `${f} is on CLEARABLE_FIELDS but has no CASE WHEN clear @> ARRAY['${f}'] SQL arm`)
        .toMatch(arm);
    }
  });

  it('the validator is called before the statement that consumes ${clear}', () => {
    // Ordering is the substance. A validateClear() placed after the UPDATE has already run is
    // decoration — the constraint violation has happened and the generic catch has 500'd.
    //
    // Anchored on the FIRST clear arm, not on `UPDATE public.garden_node p`: this file contains
    // three such UPDATEs (the seen route, this PUT, and the archive path), so an indexOf on the
    // statement text finds the seen route at line ~168 and the assertion passes or fails for
    // reasons unrelated to the PUT. The arm is unique to the statement under test.
    const v = SRC.indexOf('validateClear(body.clear, body)');
    const firstArm = SRC.search(/@> ARRAY\['[a-z_]+'\] THEN NULL ELSE COALESCE\(/);
    expect(v, 'validateClear must be called').toBeGreaterThan(-1);
    expect(firstArm, 'at least one clear arm must exist').toBeGreaterThan(-1);
    expect(v, 'validateClear must run before the statement that consumes ${clear}')
      .toBeLessThan(firstArm);
    // And the binding it validates must be the one the SQL reads.
    expect(SRC).toMatch(/const clear = Array\.isArray\(body\.clear\) \? body\.clear : \[\]/);
  });

  it('no forbidden column acquired a clear arm in the SQL', () => {
    // The inverse of the drift guard: pin the ABSENCE of the broken form, not just the presence
    // of the fixed one. A clear arm on `status` would be live even if the allowlist refused the
    // key today, and would arm the moment someone widened the allowlist.
    for (const col of ['display_name', 'quantity', 'status', 'container_type',
                       'transplanted_at', 'planted_out_at', 'created_by']) {
      expect(SRC, `${col} must not have a clear arm`)
        .not.toMatch(new RegExp(`@> ARRAY\\['${col}'\\]`));
    }
  });

  it('SQL comments in the templates use -- and never //', () => {
    // A // inside a sql`` template is a syntax error in Postgres, not JS, so it surfaces at
    // runtime rather than at build. Guarded fleet-wide by sql-comment-hygiene.test.js; asserted
    // here too because this change added SQL text.
    const tpl = SRC.match(/sql`[\s\S]*?`/g) || [];
    expect(tpl.length).toBeGreaterThan(0);
    for (const t of tpl) expect(t).not.toMatch(/^\s*\/\//m);
  });
});
