// HOUSEHOLD-MODE static-source guard (inventory-items Lambda).
// Asserts widening of LIST/UPDATE/DELETE/trailing-LIST + uploaded_by->created_by switch,
// INSERT integrity (user_id + created_by = userId), and the documented lost-update TODO.
// Static-source (L-072), DB-free.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('inventory-items Lambda — Household Mode scope widening', () => {
  it('imports householdScope + computes householdIds', () => {
    expect(SRC).toMatch(/import \{ householdScope \} from '\.\.\/household\.js'/);
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
    expect(SRC).toMatch(/HOUSEHOLD-MODE TODO: lost-update window on concurrent quantity edits/);
  });

  it('no array spread (42P18 guard)', () => {
    expect(SRC).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });
});
