// BUG-SOWNAPPROXORPHAN-001 — an `X_approx` flag must never outlive the `X` date it qualifies.
//
// THE DEFECT. `sown_at_approx` says "the date in sown_at is approximate". It is a QUALIFIER, and a
// qualifier with nothing to qualify has no referent — it is not a wrong value, it is a meaningless
// one. All four date/flag pairs on plants are settable independently, so the orphan is reachable
// two ways and neither was closed:
//
//   (1) CLEAR THE DATE, KEEP THE FLAG. The clear channel handles keys one at a time, and
//       clearKeys.js's isBlank() deliberately treats `false` as a VALUE rather than emptiness (so a
//       sort_order of 0 or an is_public of false is never wrongly cleared). A boolean therefore can
//       never enter `clear` on its own, and `clear:['sown_at']` leaves sown_at_approx standing.
//   (2) NEVER SET THE DATE, TICK THE BOX. PlantingEditor.jsx sends `!!form.sown_at_approx`
//       unconditionally beside `form.sown_at || null`, on both its create and edit paths.
//
// WHERE IT IS FIXED, AND WHY NOT ELSEWHERE. On the server, because that is the single point every
// client's write converges on — three forms can violate the invariant and only one handler enforces
// it. NOT as a CHECK constraint: a CHECK would 400 the orphan combination, and the currently
// deployed client sends exactly that combination, so arming it over a still-deployed writer is a
// break rather than a repair.
//
// Live prod at authoring (dev d9afab9): 0 orphans across all four pairs — 0/144 sown, 0/254
// germinated, 0/161 transplanted, 0/264 planted_out. So this is prophylactic. The population it
// prevents is future writes, not existing rows, and NO BACKFILL IS OWED. That measurement is the
// reason this shipped as a guard rather than as a migration.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approxOrNull } from './validate.js';

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

const PAIRS = [
  ['sown_at', 'sown_at_approx'],
  ['germinated_at', 'germinated_at_approx'],
  ['transplanted_at', 'transplanted_at_approx'],
  ['planted_out_at', 'planted_out_at_approx'],
];

describe('approxOrNull — the create-path rule', () => {
  it.each(PAIRS.map(([d]) => d))('%s: a truthy flag with no date resolves to NULL', () => {
    expect(approxOrNull(null, true)).toBeNull();
    expect(approxOrNull(undefined, true)).toBeNull();
  });

  // NULL, not false. `false` would assert "this absent date is EXACT" — a different and equally
  // unfounded claim about a date that does not exist.
  it('returns NULL rather than false when the date is absent', () => {
    expect(approxOrNull(null, false)).toBeNull();
    expect(approxOrNull(null, undefined)).toBeNull();
  });

  it('passes the flag through untouched when a date IS present', () => {
    expect(approxOrNull('2026-02-01', true)).toBe(true);
    expect(approxOrNull('2026-02-01', false)).toBe(false);
    expect(approxOrNull('2026-02-01', undefined)).toBe(false);
  });

  // The empty string is a real hazard here: a date input that the user cleared arrives as '' from
  // the form, not as null. '' is NOT null, so the guard must not treat it as a present date... but
  // the handler binds `body.sown_at ?? null`, which passes '' through to Postgres, where a DATE
  // cast of '' errors. That is pre-existing handler behaviour and out of this ticket's scope —
  // pinned here so the next reader knows it was considered rather than missed.
  it('treats an empty-string date as present (documented, pre-existing handler behaviour)', () => {
    expect(approxOrNull('', true)).toBe(true);
  });
});

// CASE-depth scanner, not `indexOf('END,')`. These assignments now NEST a CASE inside a CASE, so
// the first `END,` after the assignment belongs to the INNER one and a naive slice would cut the
// block in half — and worse, a naive slice that ran the other way would swallow the neighbouring
// column's assignment and let it satisfy this column's requirement. That swallow is the exact
// defect that let a deleted `kind_set_at` pass `projects/select-columns` from the wrong statement.
function caseBlock(src, col) {
  const m = new RegExp(`\\n\\s*${col}\\s*= CASE\\b`).exec(src);
  if (!m) return null;
  const start = m.index;
  let depth = 0;
  const tok = /\bCASE\b|\bEND\b/g;
  tok.lastIndex = start;
  let t;
  while ((t = tok.exec(src)) !== null) {
    depth += t[0] === 'CASE' ? 1 : -1;
    if (depth === 0) return src.slice(start, t.index + 3);
  }
  return null;
}

describe('the PUT path guards every pair in SQL', () => {
  // MUTATION (per pair): delete the `... IS NULL THEN NULL` arm from that pair's _approx CASE
  // -> RED for that pair. The PUT must consult the PRE-update row (a date the caller did not
  // resend must still count as present), which is why this is SQL rather than approxOrNull.
  it.each(PAIRS)('%s / %s: the flag CASE is gated on the date resolving NULL', (dateCol, flagCol) => {
    const block = caseBlock(SRC, flagCol);
    expect(block, `${flagCol} assignment not found as a CASE`).not.toBeNull();
    // The guard arm must reference the DATE column and test IS NULL, and it must come FIRST —
    // a CASE evaluates in order, so a guard placed after the clear arm would let
    // `clear:['sown_at']` fall through to the flag's own COALESCE.
    expect(block).toContain(`${dateCol}`);
    expect(block).toMatch(/IS NULL THEN NULL/);
    const guardPos = block.search(/IS NULL THEN NULL/);
    const clearPos = block.indexOf(`ARRAY['${flagCol}']`);
    if (clearPos >= 0) expect(guardPos).toBeLessThan(clearPos);
  });
});

describe('the POST path routes every pair through approxOrNull', () => {
  // MUTATION (per pair): restore `${body.X_approx ?? false}` in the VALUES list -> RED.
  // A raw bind here is the create-side orphan, which is the path PlantingEditor actually takes.
  it.each(PAIRS)('%s / %s: the VALUES bind is approxOrNull, not a raw body read', (dateCol, flagCol) => {
    expect(SRC).toContain(`approxOrNull(body.${dateCol}, body.${flagCol})`);
    // The raw form must be GONE, not merely accompanied.
    expect(SRC).not.toContain(`\${body.${flagCol} ?? false}`);
  });
});

describe('vacuity floor', () => {
  // Every it.each above derives from PAIRS. If PAIRS were ever emptied or trimmed, those suites
  // would report green having asserted nothing. This is the shape that has already bitten this
  // codebase (a dynamically-derived list going silently empty), so the list gets a floor.
  it('PAIRS covers all four date/flag pairs the plants table carries', () => {
    expect(PAIRS).toHaveLength(4);
    for (const [d, f] of PAIRS) {
      expect(f).toBe(`${d}_approx`);
      expect(SRC).toContain(d);
      expect(SRC).toContain(f);
    }
  });
});
