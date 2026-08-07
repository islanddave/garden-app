// V4-HARVWEIGHTREAD-001 slice 2 — the harvests read model's WEIGHT wire contract.
//
// Static source assertions, matching the house style of the sibling lambda tests
// (events/harvest-weight-preserve.test.js, batch-order.test.js): index.js imports neon/clerk/aws,
// which are deliberately absent from the root package.json, so it cannot be imported under the root
// vitest run at all — the falsifiable property is the SHAPE of the statements. Behavioural coverage
// of the sums belongs to tests/integration/harvests.int.test.js against real Postgres.
//
// Two classes of bug are pinned here, and the first one SHIPPED:
//   1. a column that is SELECTed but never projected onto the wire (silent — nothing 500s, the page
//      just renders the wrong thing forever)
//   2. a weight total that adds measured and estimated grams into one unlabelled number
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { projectEntry } from './aggregate.js';

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const WEIGHT_COLS = ['weight_grams', 'weight_estimated', 'weight_basis'];

// The weight-sums statement, isolated from the entries/aggregates SELECTs above it so these
// assertions cannot accidentally pass on a different query in the same file.
const WEIGHT_QUERY = (() => {
  const start = SRC.indexOf('GROUPING(');
  expect(start, 'no GROUPING() query — the weight sums are not grouped in SQL').toBeGreaterThan(-1);
  const from = SRC.lastIndexOf('SELECT', start);
  const end = SRC.indexOf('GROUP BY GROUPING SETS', start);
  expect(end, 'the weight query has no GROUPING SETS clause').toBeGreaterThan(-1);
  return SRC.slice(from, SRC.indexOf('`', end));
})();

describe('BUG-HARVWEIGHTWIRE-001 — the SELECTed weight actually reaches the wire', () => {
  // BEHAVIOURAL, not a source regex: aggregate.js is pure (no neon/clerk/aws), so the projector can
  // be called for real. That matters — a regex asserting "some wrapper mentions weight_grams" stays
  // green through any refactor that moves the projection somewhere it is no longer applied, which is
  // the exact failure mode that shipped. These call the function and read its output.
  it.each(WEIGHT_COLS)('projectEntry carries %s onto the wire', (col) => {
    const e = projectEntry({
      event_id: 'e1', event_type: 'harvest', event_date: '2026-07-20T12:00:00.000Z',
      day_key: '2026-07-20', plant_id: 'p', gn_id: 'p', project_id: 'pr1',
      weight_grams: '337', weight_estimated: false, weight_basis: 'measured',
    });
    expect(Object.keys(e)).toContain(col);
  });

  it('weight_grams is coerced to a number — the numeric column arrives as a string', () => {
    const e = projectEntry({ event_id: 'e1', project_id: 'pr1', weight_grams: '337' });
    expect(e.weight_grams).toBe(337);
    expect(typeof e.weight_grams).toBe('number');
  });

  it('an unweighed row keeps null, never 0', () => {
    // "no weight yet" is the ratchet state. Number(null) is 0, which the client would render as a
    // real measurement of nothing rather than as an absence.
    const e = projectEntry({ event_id: 'e2', project_id: 'pr1', weight_grams: null });
    expect(e.weight_grams).toBeNull();
    expect(e.weight_estimated).toBeNull();
    expect(e.weight_basis).toBeNull();
  });

  it('the entries page is projected through projectEntry — the one shared projector', () => {
    // Pairs with the behavioural assertions above: they prove the projector is correct, this proves
    // the entries path actually uses it. Neither alone would have caught the shipped bug.
    expect(SRC).toMatch(/out\.entries\s*=\s*page\.map\(projectEntry\)/);
  });
});

describe('weight totals are summed in SQL, split by provenance', () => {
  it('measured and estimated grams are summed SEPARATELY via FILTER', () => {
    expect(WEIGHT_QUERY).toMatch(/SUM\(h\.weight_grams\) FILTER \([\s\S]*?\)[\s\S]{0,20}AS measured_grams/);
    expect(WEIGHT_QUERY).toMatch(/SUM\(h\.weight_grams\) FILTER \([\s\S]*?\)[\s\S]{0,20}AS estimated_grams/);
    // COALESCE to 0: SUM over an empty filtered set is NULL, and a null total would reach the client
    // as "no data" rather than "nothing weighed yet".
    expect(WEIGHT_QUERY).toMatch(/COALESCE\(SUM\(h\.weight_grams\) FILTER/);
  });

  it('measured is `weight_estimated IS FALSE` and estimated is its exact complement', () => {
    // IS TRUE instead of IS NOT FALSE would silently drop any row with a NULL discriminator out of
    // BOTH buckets, so the parts would stop adding up to the whole with no error anywhere.
    expect(WEIGHT_QUERY).toMatch(/h\.weight_estimated IS FALSE\)::int AS measured_count/);
    expect(WEIGHT_QUERY).toMatch(/h\.weight_estimated IS NOT FALSE\)::int AS estimated_count/);
    expect(WEIGHT_QUERY).not.toMatch(/h\.weight_estimated IS TRUE/);
  });

  it('presence is `weight_grams > 0`, mirroring formatGrams — not IS NOT NULL', () => {
    // formatGrams() returns null for <= 0, so a 0-gram row is UNWEIGHED on the client. An
    // `IS NOT NULL` predicate here would count it as weighed and the counts would disagree.
    const filters = WEIGHT_QUERY.match(/WHERE h\.weight_grams[^)]*/g) ?? [];
    expect(filters.length).toBe(5);
    for (const f of filters.slice(0, 4)) expect(f).toMatch(/h\.weight_grams > 0/);
    expect(WEIGHT_QUERY).toMatch(/WHERE h\.weight_grams IS NULL OR h\.weight_grams <= 0\)::int AS unweighed_count/);
  });

  it('the grand total is distinguished from the unattributed bucket by GROUPING()', () => {
    // Both come back with a NULL crop_slug. Without the GROUPING bit the merge below would either
    // overwrite the season total with the no-crop bucket or vice versa.
    expect(WEIGHT_QUERY).toMatch(/GROUPING\(cv\.crop_type_slug\)::int AS is_total/);
    expect(WEIGHT_QUERY).toMatch(/GROUP BY GROUPING SETS \(\(\), \(cv\.crop_type_slug\)\)/);
    expect(SRC).toMatch(/Number\(r\.is_total\) === 1/);
  });

  it('grams is the SUM of the two halves, never one of them', () => {
    const fn = SRC.match(/function shapeWeightRow\(r\)\s*\{[\s\S]*?\n\}/);
    expect(fn, 'shapeWeightRow is not defined').not.toBeNull();
    expect(fn[0]).toMatch(/grams:\s*measuredGrams \+ estimatedGrams/);
    // The split and the counts travel WITH the total — a caller cannot receive the number alone.
    for (const k of ['measured_grams', 'estimated_grams', 'measured:', 'estimated:', 'unweighed:']) {
      expect(fn[0]).toContain(k);
    }
  });

  it('every crop row gets a weight object, zeroed rather than absent', () => {
    // An absent key makes a surface branch on undefined and print nothing; a zeroed object with
    // unweighed > 0 says the true thing ("nothing here is weighed yet").
    expect(SRC).toMatch(/out\.aggregates\.weight\s*=\s*weightTotal \?\? shapeWeightRow\(null\)/);
    expect(SRC).toMatch(/c\.weight\s*=\s*weightByCrop\.get\(c\.crop_type_slug\) \?\? shapeWeightRow\(null\)/);
  });
});

describe('?plant scoping is applied to every query that feeds one page', () => {
  it('the plant filter is read from the query string', () => {
    expect(SRC).toMatch(/const plant = qp\.plant \|\| null;/);
  });

  it('all THREE queries carry the same plant predicate', () => {
    // Entries, aggregates and weight sums feed one screen. A filter on some of them is how a total
    // ends up disagreeing with the rows printed underneath it.
    const preds = SRC.match(/AND \(\$\{plant\}::uuid IS NULL OR e\.plant_id = \$\{plant\}::uuid\)/g) ?? [];
    expect(preds.length).toBe(3);
  });
});
