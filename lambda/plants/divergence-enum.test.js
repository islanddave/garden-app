// BUG-DIVERGENCEVOCAB-001 — divergence_type vocabulary drift guard.
//
// THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE: plants.divergence_type carried two disjoint
// vocabularies for 15 months. The Lambda admitted mutation|cross|selection|unknown; the live CHECK
// plants_divergence_type_check admits division|cutting|saved_seed_from. Zero overlap, so every
// accepted value was rejected 23514 -> 400 and the field was unwritable in BOTH directions. The
// pre-existing test (tests/integration/plants.int.test.js) probed 'spore' — a value invalid in
// both vocabularies — so it passed while the feature was dead. It asserted nothing.
//
// WHY THIS TEST IS SHAPED THE WAY IT IS: the sibling guard for container_type
// (container-enum.test.js, BUG-CONTVAL-001, same L-091 drift class) hand-copies the expected values
// into a REQUIRED array. That catches a Lambda edit but not the case that actually happened here —
// the two lists drifting because there was no single place the vocabulary lived. So this one PARSES
// the CHECK out of the migration and compares SETS. There is exactly one literal in the repo; the
// Lambda's two copies are compared against it, never against a third hand-copied list here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const LAMBDA_SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const MIGRATION = resolve(__dirname, '../../migrations/v4-divergencevocab-001/0a-additive-ddl.sql');
const MIGRATION_SRC = readFileSync(MIGRATION, 'utf8');

// The dead set, kept only so its ABSENCE can be asserted. Never used as an expectation.
const DEAD_VOCABULARY = ['mutation', 'cross', 'selection'];

// Strip SQL line comments first: the migration's header quotes the vocabulary in prose, and a
// regex that matched prose would happily "pass" against a file whose actual DDL had drifted.
const strippedSql = MIGRATION_SRC.replace(/--[^\n]*/g, '');

/** The one canonical vocabulary in the repo: parsed from the CHECK the migration actually adds. */
function canonicalVocabulary() {
  const m = strippedSql.match(
    /ADD CONSTRAINT plants_divergence_type_check[\s\S]*?ARRAY\[([^\]]*)\]/,
  );
  expect(m, `no ADD CONSTRAINT plants_divergence_type_check ... ARRAY[...] found in ${MIGRATION}`).toBeTruthy();
  const values = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  expect(values.length, 'CHECK vocabulary parsed as empty').toBeGreaterThan(0);
  return values;
}

/** Every ALLOWED_DIVERGENCE literal in the Lambda, as arrays of strings. */
function lambdaAllowlists() {
  return [...LAMBDA_SRC.matchAll(/ALLOWED_DIVERGENCE\s*=\s*\[([^\]]*)\]/g)]
    .map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

const CANONICAL = canonicalVocabulary();

describe('BUG-DIVERGENCEVOCAB-001 divergence_type vocabulary parity', () => {
  it('the migration is the single source of truth and still declares a vocabulary', () => {
    // Sanity on the parse itself: a guard driven from a file it cannot read is worse than none.
    expect(CANONICAL.length).toBe(3);
    expect([...CANONICAL].sort()).toEqual(['cutting', 'division', 'saved_seed_from']);
  });

  it('both Lambda paths (POST and PUT) define ALLOWED_DIVERGENCE', () => {
    expect(lambdaAllowlists()).toHaveLength(2);
  });

  it('every ALLOWED_DIVERGENCE is the SAME SET as the DB CHECK — not a superset, not a subset', () => {
    const want = [...CANONICAL].sort();
    for (const [i, list] of lambdaAllowlists().entries()) {
      // Set equality in both directions is the whole point. A superset re-creates the original bug
      // (the API accepts what the DB will 23514 on); a subset silently makes a legal value
      // unreachable, which is how source_type lost 'rescued'.
      expect([...list].sort(), `ALLOWED_DIVERGENCE occurrence #${i + 1} drifted from the CHECK in ${MIGRATION}`)
        .toEqual(want);
    }
  });

  it('the two Lambda copies agree with each other', () => {
    const [post, put] = lambdaAllowlists();
    expect([...post].sort()).toEqual([...put].sort());
  });

  it('no member of the dead mutation/cross/selection vocabulary survives in either allowlist', () => {
    for (const list of lambdaAllowlists()) {
      for (const dead of DEAD_VOCABULARY) expect(list).not.toContain(dead);
    }
  });

  it('the CHECK admits NULL, so no explicit unknown sentinel is needed', () => {
    // Two spellings of "not recorded" is the defect one layer down. NULL is the sentinel; if a
    // future edit adds 'unknown' to the vocabulary it must be a deliberate, argued change, not a
    // silent one — this reds first.
    expect(strippedSql).toMatch(/divergence_type IS NULL/);
    expect(CANONICAL).not.toContain('unknown');
  });

  it('the post-deploy validator sweeps the FULL table, not just live rows', () => {
    // The 2026-08-03 outage class: a pre-VALIDATE sweep scoped to `deleted_at IS NULL` passes
    // green and then VALIDATE scans the heap and fails on a soft-deleted row.
    const validate = decomment(readFileSync(
      resolve(__dirname, '../../migrations/v4-divergencevocab-001/0c-validate.sql'), 'utf8',
    ).replace(/--[^\n]*/g, ''));
    expect(validate).toMatch(/VALIDATE CONSTRAINT plants_divergence_type_check/);
    const sweep = validate.slice(0, validate.indexOf('VALIDATE CONSTRAINT'));
    expect(sweep).toMatch(/FROM public\.plants/);
    expect(sweep).not.toMatch(/deleted_at IS NULL/);
  });
});
