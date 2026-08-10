// HOUSEHOLD-MODE static-source guard (plants Lambda).
// Plants scope via parent project pp.created_by. Asserts widening, INSERT integrity,
// import presence, and uploaded_by->created_by switch. Static-source (L-072), DB-free.

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

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('plants Lambda — Household Mode scope widening', () => {
  it('imports householdScope + computes householdIds', () => {
    // V4-AUTHZSWEEP-001: match householdScope among a NAMED-IMPORT LIST, not as the sole import —
    // these handlers now also pull the write-FK ownership loaders from the same module. Mirrors the
    // IMPORT_RE pattern already used by household-isolation.test.js.
    expect(SRC).toMatch(/import \{[^}]*\bhouseholdScope\b[^}]*\} from '\.\/household\.js'/);
    expect(SRC).toMatch(/const householdIds = householdScope\(userId\)/);
  });

  it('ownership reads/guards via pp.created_by use = ANY(${householdIds})', () => {
    // EXACT, not >=. The floor was `>= 5` against a real population of 8, so three container
    // ownership predicates could be deleted and this stayed green — proven by mutation
    // (rewrite 3 of the 8 to `TRUE`; all 7 tests in this file passed). Bump deliberately when a
    // new scoped site is added; a DROP must never be silent.
    const matches = SRC.match(/pp\.created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
    expect(matches.length,
      'plants/index.js container-ownership site count changed — a DROP is a cross-tenant read/write')
      .toBe(8); // 8 at d9afab95
  });

  it('featured-photo subquery SWITCHED uploaded_by -> created_by = ANY(${householdIds})', () => {
    // SCOPED to the featured-photo link check. The old assertion was a whole-file
    // `toMatch(/created_by = ANY\(\$\{householdIds\}\)/)`, which any of the 20+ occurrences
    // elsewhere in the handler satisfied — so this `it` could not fail for the subquery it names,
    // and it stacked with the loose floor above to hide the same deletions twice.
    const i = SRC.indexOf('SELECT 1 FROM photos ph');
    expect(i, 'featured-photo link subquery not found').toBeGreaterThan(-1);
    const block = SRC.slice(i, SRC.indexOf('`', i));
    expect(block).toMatch(/ph\.created_by = ANY\(\$\{householdIds\}\)/);
    // No remaining uploaded_by scope filter (plants has no uploaded_by INSERT column).
    expect(SRC).not.toMatch(/uploaded_by = \$\{userId\}/);
  });

  it('no array spread (42P18 guard)', () => {
    expect(SRC).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });

  it('INSERT still binds created_by = ${userId}', () => {
    const insIdx = SRC.indexOf('INSERT INTO public.garden_node');
    // window widened 800->1000 for the V3-PLANTLOC-001 location_id column (shifted ${userId} offset)
    const block = SRC.slice(insIdx, insIdx + 1000);
    expect(block).toMatch(/\$\{userId\}/);
    expect(block).not.toMatch(/householdIds/);
  });
});
