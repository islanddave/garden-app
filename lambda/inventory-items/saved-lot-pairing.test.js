// BUG-INVREFSTRAND-001 — the delete preflight's `saved_lot` SQL and isSavedLot are ONE predicate.
//
// The refusal calls a saved lot "This seed lot" and any other seed row "This packet". Which one is
// decided in SQL, inside the preflight (delete-guard.js), because the Lambda cannot import
// src/components/seed/seedLots.js — each Lambda is zipped from its own directory. Every Seeds page
// decides the same question with isSavedLot. Two copies of a predicate drift; this file holds them
// together, three ways:
//   1. SHAPE — every OR'd term of the SQL is exactly `COALESCE(i.<fact>[::text], '') <> ''`, i.e.
//      "non-null and non-empty", the test isSavedLot applies to each fact. Any other spelling fails
//      here rather than being interpreted.
//   2. FACTS — the columns the SQL tests are exactly the fields isSavedLot's body reads, no more and
//      no fewer. A fourth fact added to either side reds.
//   3. VERDICTS — on the same fixtures (one row per fact, plus a bought packet, plus a client-shaped
//      row of empty strings), the SQL's verdict and isSavedLot's agree, and both equal the expected one.
// Step 3 evaluates the SQL by the meaning step 1 pins (Postgres: COALESCE(NULL, '') = '', and
// '' <> '' is false), since the unit suite has no database. The same fixtures run through the REAL
// preflight on real Postgres in tests/integration/inventory-delete-guard.int.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSavedLot } from '../../src/components/seed/seedLots.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD_SRC = readFileSync(resolve(__dirname, 'delete-guard.js'), 'utf8');
const PREFLIGHT = GUARD_SRC.match(/sql`([\s\S]*?)`/)[1];
const LOTS_SRC = readFileSync(resolve(__dirname, '../../src/components/seed/seedLots.js'), 'utf8');

// The saved_lot expression, split into its OR'd terms.
const EXPR = PREFLIGHT.match(/\((COALESCE[\s\S]*?)\)\s+AS saved_lot\b/)?.[1] ?? null;
const TERM = /^COALESCE\(i\.(\w+)(?:::text)?, ''\) <> ''$/;
const TERMS = EXPR ? EXPR.split(/\bOR\b/).map((t) => t.replace(/\s+/g, ' ').trim()) : [];
const SQL_FACTS = TERMS.map((t) => t.match(TERM)?.[1] ?? null);

// isSavedLot's facts, read off its own body: every field of `i` it tests.
const LOT_BODY = LOTS_SRC.match(/export function isSavedLot\(i\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
const JS_FACTS = [...new Set([...LOT_BODY.matchAll(/\bi\??\.(\w+)/g)].map((m) => m[1]))];

// The SQL's verdict for a row, by the meaning TERM pins: any fact non-null and non-empty.
const sqlVerdict = (row) => SQL_FACTS.some((f) => row[f] != null && String(row[f]) !== '');

const PARENT = '26afb9e8-56e8-4e67-80b9-61138dccf357';
const none = { source_plant_id: null, source_kind: null, seed_stage: null };
const FIXTURES = [
  ['saved off a planting — parent only', true, { ...none, source_plant_id: PARENT }],
  ['recorded origin — origin kind only', true, { ...none, source_kind: 'farm_stand' }],
  ['in process — stage only', true, { ...none, seed_stage: 'fermenting' }],
  ['a bought packet — none of the three', false, { ...none }],
  // The columns cannot hold '' (uuid; CHECKed value sets), but a client row can: both sides must
  // read an empty string as absent.
  ['a client-shaped row of empty strings', false, { source_plant_id: '', source_kind: '', seed_stage: '' }],
];

describe('saved lot — the preflight\'s SQL and isSavedLot agree', () => {
  it('the preflight carries a saved_lot expression, and every term is "non-null and non-empty"', () => {
    expect(EXPR, 'no `(...) AS saved_lot` in the preflight').not.toBeNull();
    expect(TERMS.length).toBeGreaterThan(0);
    TERMS.forEach((t, n) => expect(SQL_FACTS[n], `term ${n + 1} is not COALESCE(i.<fact>, '') <> '': ${t}`).not.toBeNull());
    // OR'd, never AND'd: any one fact is enough.
    expect(EXPR).not.toMatch(/\bAND\b/i);
  });

  it('the SQL tests exactly isSavedLot\'s facts — no more, no fewer', () => {
    expect(LOT_BODY, 'isSavedLot not found in seedLots.js').not.toBe('');
    expect(JS_FACTS.sort()).toEqual(['seed_stage', 'source_kind', 'source_plant_id']);
    expect([...SQL_FACTS].sort()).toEqual([...JS_FACTS].sort());
  });

  it.each(FIXTURES)('%s: both say %s', (_label, expected, row) => {
    expect(isSavedLot(row)).toBe(expected);
    expect(sqlVerdict(row)).toBe(expected);
  });
});
