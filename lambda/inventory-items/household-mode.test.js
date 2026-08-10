// HOUSEHOLD-MODE static-source guard (inventory-items Lambda).
// Asserts widening of LIST/UPDATE/DELETE/trailing-LIST + uploaded_by->created_by switch,
// INSERT integrity (user_id + created_by = userId), and the documented lost-update TODO.
// Static-source (L-072), DB-free.

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

const RAW = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const SRC = decomment(RAW);

describe('inventory-items Lambda — Household Mode scope widening', () => {
  it('imports householdScope + computes householdIds', () => {
    // V4-AUTHZSWEEP-001: match householdScope among a NAMED-IMPORT LIST, not as the sole import —
    // these handlers now also pull the write-FK ownership loaders from the same module. Mirrors the
    // IMPORT_RE pattern already used by household-isolation.test.js.
    expect(SRC).toMatch(/import \{[^}]*\bhouseholdScope\b[^}]*\} from '\.\/household\.js'/);
    expect(SRC).toMatch(/const householdIds = householdScope\(userId\)/);
  });

  it('ownership reads/guards use created_by = ANY(${householdIds})', () => {
    // LIST (i.created_by) + featured-photo switch + UPDATE + DELETE + trailing LIST = 5.
    const matches = SRC.match(/created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  it('featured-photo subquery SWITCHED uploaded_by -> created_by (no uploaded_by scope filter remains)', () => {
    expect(SRC).not.toMatch(/uploaded_by = \$\{userId\}/);
  });

  it('INSERT still binds user_id + created_by = ${userId}', () => {
    const insIdx = SRC.indexOf('INSERT INTO inventory_items');
    const block = SRC.slice(insIdx, insIdx + 600);
    expect(block).toMatch(/user_id, created_by/);
    expect(block).toMatch(/\$\{userId\}, \$\{userId\}/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('documents the concurrent-quantity lost-update window as a fast-follow TODO', () => {
    // The COMMENT is the subject here (this asserts the TODO is documented, not that code exists),
    // so it is the one assertion in this file that legitimately reads RAW.
    expect(RAW).toMatch(/HOUSEHOLD-MODE TODO:[\s\S]*lost-update window/);
  });

  it('no array spread (42P18 guard)', () => {
    expect(SRC).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });
});
