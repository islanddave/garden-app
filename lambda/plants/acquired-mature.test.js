// V4-ACQMATURE-001 — the acquired-mature flag, end to end at source level.
//
// Two things are proven here and they are different in kind:
//
//  1. WRITE->READ ROUND TRIP through public.garden_node. The plants Lambda binds the VIEW, never
//     the base table, so a column that reaches `plants` but not the view is written by nobody and
//     read by nobody while every gate about `plants` still passes. That failure is silent, which is
//     why it gets its own assertions rather than being folded into select-columns.test.js.
//  2. THE MIGRATION'S VIEW WIDEN IS ADDITIVE. CREATE OR REPLACE VIEW can only append; reordering or
//     dropping any of the 50 existing columns makes the statement fail on apply, or worse, silently
//     changes what an alias-back means. The 0a and 0r column lists are diffed against each other,
//     which is exactly the byte-for-byte property the migration header claims.
//
// Static-source, like select-columns.test.js and assignee.test.js: index.js imports
// @neondatabase/serverless + @clerk/backend + @aws-sdk/* at module load, so it cannot be imported
// under vitest. validate.js is dependency-free by design and IS imported.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAcquiredMature, CLEARABLE_SET } from './validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — same decommenter, same reason, as its
// two sibling guards.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const MIG = resolve(__dirname, '../../migrations/v4-acqmature-001');
const DDL = readFileSync(resolve(MIG, '0a-additive-ddl.sql'), 'utf8');
const BACKFILL = readFileSync(resolve(MIG, '0b-backfill.sql'), 'utf8');
const ROLLBACK = readFileSync(resolve(MIG, '0r-rollback.sql'), 'utf8');

const COLUMNS = ['acquired_mature', 'acquired_mature_source', 'acquired_mature_set_at'];

// Pull the column list out of a `CREATE OR REPLACE VIEW public.garden_node AS SELECT ... FROM plants;`
// block. Returns the bare projected names, alias-backs resolved to the alias (which is what a view
// consumer actually sees).
function viewColumns(sql) {
  const m = sql.match(/CREATE OR REPLACE VIEW public\.garden_node AS\s+SELECT\s+([\s\S]*?)\s+FROM plants;/);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/\s*--.*$/, '').trim())
    .filter(Boolean)
    .map((s) => {
      const alias = s.match(/\bAS\s+([a-z_][a-z0-9_]*)$/i);
      return alias ? alias[1] : s;
    });
}

describe('V4-ACQMATURE-001 — write path', () => {
  it('POST inserts all three columns through public.garden_node, not the base table', () => {
    const insert = SRC.match(/INSERT INTO public\.garden_node\s+\(([\s\S]*?)\)\s+VALUES/);
    expect(insert, 'INSERT INTO public.garden_node column list not found').toBeTruthy();
    for (const col of COLUMNS) {
      expect(new RegExp(`\\b${col}\\b`).test(insert[1]), `INSERT column list missing ${col}`).toBe(true);
    }
    expect(SRC).not.toMatch(/INSERT INTO (public\.)?plants\b/);
  });

  it('POST derives provenance and stamp from the verdict — it never reads them off the body', () => {
    expect(SRC).toMatch(/CASE WHEN \$\{body\.acquired_mature \?\? null\}::boolean IS NULL THEN NULL ELSE 'user' END/);
    expect(SRC).toMatch(/CASE WHEN \$\{body\.acquired_mature \?\? null\}::boolean IS NULL THEN NULL ELSE now\(\) END/);
    // The hazard this closes: a client naming its own source could write 'backfill' over Dave's
    // word and make a guess indistinguishable from an answer.
    expect(SRC).not.toMatch(/body\.acquired_mature_source/);
    expect(SRC).not.toMatch(/body\.acquired_mature_set_at/);
  });

  it('PUT can set true, set false AND return to NULL via the presence sentinel', () => {
    expect(SRC).toMatch(/const hasAcquiredMature = Object\.prototype\.hasOwnProperty\.call\(body, 'acquired_mature'\)/);
    expect(SRC).toMatch(/acquired_mature\s+= CASE/);
    expect(SRC).toMatch(/WHEN \$\{hasAcquiredMature\} THEN \$\{body\.acquired_mature \?\? null\}/);
    // A plain COALESCE merge would make NULL unreachable once anything is written, collapsing the
    // tri-state to a boolean and losing "never asked" — the state the whole design rests on.
    expect(SRC).not.toMatch(/acquired_mature\s+= COALESCE/);
  });

  it('all three PUT columns are gated on the SAME sentinel, so provenance cannot orphan', () => {
    const gated = (SRC.match(/WHEN \$\{hasAcquiredMature\}/g) || []).length;
    expect(gated, 'expected one hasAcquiredMature gate per column').toBe(3);
  });

  it('acquired_mature stays OFF the clear allowlist — the sentinel already covers NULL', () => {
    expect(CLEARABLE_SET.has('acquired_mature')).toBe(false);
  });
});

describe('V4-ACQMATURE-001 — read path (round trip through the view)', () => {
  it('every column written is read back by the by-id GET, the 2 lists and the deleted list', () => {
    const blocks = [...SRC.matchAll(/SELECT\s+((?:(?!\bFROM\b)[\s\S])*?)\s+FROM\s+public\.garden_node\s+p/g)];
    expect(blocks.length, 'expected the 4 client-facing plant reads').toBe(4);
    for (const col of COLUMNS) {
      for (const [idx, b] of blocks.entries()) {
        expect(new RegExp(`\\bp\\.${col}\\b`).test(b[1]), `read block #${idx} missing p.${col}`).toBe(true);
      }
    }
  });

  it('both write verbs return the columns they just wrote', () => {
    // PUT RETURNING is p.-prefixed; INSERT + succession RETURNING are bare. Asserting the count
    // rather than mere presence catches an edit that widens one RETURNING and forgets the other,
    // which is how a create response and an update response start disagreeing.
    for (const col of COLUMNS) {
      expect((SRC.match(new RegExp(`(?<!\\.)\\b${col}(?=,)`, 'g')) || []).length,
        `expected 2 unprefixed RETURNING refs to ${col}`).toBeGreaterThanOrEqual(2);
      expect(new RegExp(`RETURNING p\\.[\\s\\S]*?\\bp\\.${col}\\b`).test(SRC),
        `PUT RETURNING missing p.${col}`).toBe(true);
    }
  });
});

describe('V4-ACQMATURE-001 — validation', () => {
  it('accepts the three real states and nothing else', () => {
    expect(validateAcquiredMature({ acquired_mature: true })).toBeNull();
    expect(validateAcquiredMature({ acquired_mature: false })).toBeNull();
    expect(validateAcquiredMature({ acquired_mature: null })).toBeNull();
    expect(validateAcquiredMature({})).toBeNull();
  });

  it('rejects truthy look-alikes rather than coercing them', () => {
    // A coerced 'false' string is how a client bug becomes a permanent wrong assertion about a
    // real plant, and this column's whole value is that its contents were asserted, not inferred.
    for (const bad of ['true', 'false', 1, 0, 'yes', {}, []]) {
      expect(validateAcquiredMature({ acquired_mature: bad })).toMatch(/must be true, false or null/);
    }
  });

  it('both verbs run the shared validator, so they cannot drift apart', () => {
    expect((SRC.match(/validateAcquiredMature\(body\)/g) || []).length).toBe(2);
  });
});

describe('V4-ACQMATURE-001 — migration shape', () => {
  it('adds all three columns nullable, with NO DEFAULT on any of them', () => {
    for (const col of COLUMNS) {
      expect(DDL).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\s`));
    }
    const alter = DDL.match(/ALTER TABLE public\.plants\s+ADD COLUMN[\s\S]*?;/)[0];
    // A DEFAULT would fabricate a verdict for all 261 live plantings and silently re-admit the two
    // rows the flag exists to exclude. NULL must keep meaning "never asked".
    expect(alter).not.toMatch(/DEFAULT/);
    expect(alter).not.toMatch(/NOT NULL/);
  });

  it('arms no CHECK over acquired_mature itself — only over its provenance tag', () => {
    const checks = DDL.match(/CHECK \([\s\S]*?\)/g) || [];
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatch(/acquired_mature_source/);
    expect(checks[0]).not.toMatch(/acquired_mature\s+(IS|IN|=)/);
    expect(DDL).toMatch(/NOT VALID/);
  });

  it('widens the view ADDITIVELY: the 50 existing columns are preserved in order', () => {
    const after = viewColumns(DDL);
    const before = viewColumns(ROLLBACK);
    expect(before, '0r must restore the pre-migration view').toBeTruthy();
    expect(after, '0a must replace the view').toBeTruthy();
    expect(before).toHaveLength(50);
    expect(after).toHaveLength(53);
    // The load-bearing assertion: identical up to 50, appended after. A reorder or a dropped
    // alias-back would break the wire contract while the DDL still applied cleanly.
    expect(after.slice(0, 50)).toEqual(before);
    expect(after.slice(50)).toEqual(COLUMNS);
  });

  it('the view exposes exactly what the base table gained', () => {
    const added = [...DDL.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(added).toEqual(COLUMNS);
    expect(viewColumns(DDL).slice(50)).toEqual(added);
  });

  it('backfills exactly two rows, by id, and infers nothing in bulk', () => {
    const ids = [...BACKFILL.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'::uuid/g)]
      .map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set([
      '1bbfe326-5a99-4124-8bbe-b25de49e4dde', // Ghost    — ratio 0.100
      '9cd590d4-05d9-4f68-9b71-b881130653d7', // Shallots — ratio 0.122
    ]));
    // No predicate-shaped backfill. source_type is ANTI-correlated with this class (nursery
    // transplants average 0.763 against a cohort 0.717), so a WHERE over it would bake a measured
    // -wrong proxy into a column future readers will trust.
    expect(BACKFILL).not.toMatch(/WHERE[\s\S]*source_type/);
    expect(BACKFILL).not.toMatch(/WHERE[\s\S]*sown_at IS NULL/);
    // Idempotent AND deferential: re-running must not clobber a human's later `false`.
    expect(BACKFILL).toMatch(/AND acquired_mature IS NULL/);
  });
});
