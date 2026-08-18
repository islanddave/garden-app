// BUG-LOSSCAUSE-001 / V4-HARVDISPOSITION-001 — loss_cause + disposition vocabulary parity.
//
// THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE, and it is the divergence_type story one table over.
// migrations/v4-losscapture-001/0b-arm-checks.sql arms chk_plants_loss_cause over a five-value
// ARRAY and its header calls that ARRAY "byte-comparable with lambda/plants/index.js's
// ALLOWED_LOSS". Nothing asserted it. index.js carries the allowlist as TWO independent literals
// (one on the PUT path, one on the POST path), so there were three hand-maintained copies of one
// vocabulary and no guard between any of them — the exact shape that left divergence_type with two
// disjoint vocabularies for 15 months (BUG-DIVERGENCEVOCAB-001). Modelled on divergence-enum.test.js
// for that reason: parse the CHECK, never hand-copy a fourth expectation into this file.
//
// AND A FOURTH COPY THAT DID NOT EXIST WHEN THAT PRECEDENT WAS WRITTEN: gates.yml's
// post_loss_cause_vocab_exact / post_disposition_vocab_exact now assert SET EQUALITY against a
// hard-coded ARRAY of their own (they used to be a conjunction of `LIKE '%value%'` substring tests,
// which passed against any superset — measured, see that file's comment). Set equality is only worth
// having if the set it compares to is the migration's. An edit to 0b that gates.yml did not follow
// would leave the gate confidently asserting a vocabulary the database no longer has, so the gate's
// literal is checked here against the same canonical source as the Lambda's.
//
// A NOTE ON WHAT IS NOT HERE. There is no ALLOWED_LOSS_CAUSES in lambda/events/ — 0b's header
// claimed one and no such constant has ever existed in this repo (the string appears in exactly one
// place: that comment). The header is corrected; nothing is asserted about a file that has nothing
// in it. harvest_log.disposition likewise has no writer anywhere yet, so its vocabulary is pinned
// between the migration and the gate only. When a disposition writer ships it must be added to the
// parity set below — it will not appear on its own.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — same decommenter the sibling vocabulary
// guards use, so `// was: 'transplant_shock'` cannot satisfy a parity assertion.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const LAMBDA_SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const BUNDLE = resolve(__dirname, '../../migrations/v4-losscapture-001');
// SQL comments stripped before any match: 0b's header quotes both vocabularies in prose, and a
// regex that matched prose would "pass" against a file whose actual DDL had drifted.
const ARM_SQL = readFileSync(resolve(BUNDLE, '0b-arm-checks.sql'), 'utf8').replace(/--[^\n]*/g, '');
const GATES_SRC = readFileSync(resolve(BUNDLE, 'gates.yml'), 'utf8')
  .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** The one canonical vocabulary per column: parsed from the CHECK 0b actually arms. */
function canonicalVocabulary(conname) {
  const m = ARM_SQL.match(new RegExp(`ADD CONSTRAINT ${conname}[\\s\\S]*?ARRAY\\[([^\\]]*)\\]`));
  expect(m, `no ADD CONSTRAINT ${conname} ... ARRAY[...] found in 0b-arm-checks.sql`).toBeTruthy();
  const values = quoted(m[1]);
  expect(values.length, `${conname} vocabulary parsed as empty`).toBeGreaterThan(0);
  return values;
}

/** Every ALLOWED_LOSS literal in the Lambda, as arrays of strings. */
const lambdaAllowlists = () => [...LAMBDA_SRC.matchAll(/ALLOWED_LOSS\s*=\s*\[([^\]]*)\]/g)]
  .map((m) => quoted(m[1]));

/** The ARRAY literals a named gate compares against, one per containment direction. */
function gateExpectations(gateName) {
  const start = GATES_SRC.indexOf(`name: ${gateName}`);
  expect(start, `gate ${gateName} not found in gates.yml`).toBeGreaterThan(-1);
  const rest = GATES_SRC.slice(start + 1);
  const end = rest.indexOf('- name:');
  const block = end === -1 ? rest : rest.slice(0, end);
  return [...block.matchAll(/ARRAY\[([^\]]*)\]/g)].map((m) => quoted(m[1]));
}

const LOSS_CAUSE = canonicalVocabulary('chk_plants_loss_cause');
const DISPOSITION = canonicalVocabulary('chk_harvest_log_disposition');
const sorted = (a) => [...a].sort();

describe('BUG-LOSSCAUSE-001 loss_cause vocabulary parity', () => {
  it('the migration still declares the five-value vocabulary', () => {
    // Sanity on the parse itself: a guard driven from a file it cannot read is worse than none.
    expect(sorted(LOSS_CAUSE)).toEqual(['disease', 'pest', 'transplant_shock', 'unknown', 'weather']);
  });

  it('both Lambda write paths (PUT and POST) define ALLOWED_LOSS', () => {
    expect(lambdaAllowlists()).toHaveLength(2);
  });

  it('every ALLOWED_LOSS is the SAME SET as the armed CHECK — not a superset, not a subset', () => {
    // A superset is the original divergence_type bug: the API accepts what the DB 23514s on. A
    // subset silently makes a legal stored value unreachable through the app.
    for (const [i, list] of lambdaAllowlists().entries()) {
      expect(sorted(list), `ALLOWED_LOSS occurrence #${i + 1} drifted from chk_plants_loss_cause`)
        .toEqual(sorted(LOSS_CAUSE));
    }
  });

  it("the gate's set-equality expectation is the migration's vocabulary", () => {
    // Two ARRAY literals, one per containment direction (`@>` and `<@`). Both must be the canonical
    // set: an asymmetric pair would silently degrade the gate back to a one-directional test.
    const arrays = gateExpectations('post_loss_cause_vocab_exact');
    expect(arrays, 'expected @> and <@ to compare against the same vocabulary').toHaveLength(2);
    for (const a of arrays) expect(sorted(a)).toEqual(sorted(LOSS_CAUSE));
  });

  it("'unknown' survives as a real vocabulary member and is not folded into NULL", () => {
    // The inverse of divergence_type's call, and deliberate: 0a's header records that loss_cause's
    // 'unknown' means "asked, and nobody could say", which is a different claim from NULL's "never
    // recorded". Both spellings are load-bearing here, so a future edit that drops one reds first.
    expect(LOSS_CAUSE).toContain('unknown');
    expect(ARM_SQL).toMatch(/loss_cause IS NULL/);
  });
});

describe('V4-HARVDISPOSITION-001 disposition vocabulary parity', () => {
  it('the migration declares the four outcome values and nothing else', () => {
    expect(sorted(DISPOSITION)).toEqual(['aborted', 'culled', 'damaged', 'dropped']);
  });

  it("the gate's set-equality expectation is the migration's vocabulary", () => {
    const arrays = gateExpectations('post_disposition_vocab_exact');
    expect(arrays, 'expected @> and <@ to compare against the same vocabulary').toHaveLength(2);
    for (const a of arrays) expect(sorted(a)).toEqual(sorted(DISPOSITION));
  });

  it('has no code twin yet — the writer is the open half of this ticket', () => {
    // NOT a passive observation. The bundle is DDL only: applying it gives a disposition column
    // that is 100% NULL, which is the V4-EVENTSOURCE-001 shape (DDL landed, nothing ever wrote the
    // data). This assertion is the tripwire — the moment a writer defines an allowlist, this reds
    // and whoever added it has to extend the parity set above rather than start a fourth copy.
    expect(LAMBDA_SRC).not.toMatch(/ALLOWED_DISPOSITION/);
  });

  it('NULL stays legal, so a normal pick is never nagged for a value', () => {
    expect(ARM_SQL).toMatch(/disposition IS NULL/);
  });
});
